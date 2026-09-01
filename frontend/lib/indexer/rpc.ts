/**
 * The indexer's RPC access: a block-number/header reader, and an `eth_getLogs`
 * sweep that adapts to whatever range the endpoint will actually serve.
 *
 * ONE REQUEST PER RANGE, NOT PER ADDRESS PER EVENT. `eth_getLogs` takes an array
 * of addresses and (via viem's `events`) a topic0 OR-set, so a single request
 * covers every pool and all four FPMM events at once. That is why the whole
 * 1.7M-block history costs ~14 requests at the default 250k chunk instead of
 * thousands. Looping per address or per event type would multiply the request
 * count by markets x events and rebuild the rate-limit storm described in
 * CLAUDE.md.
 *
 * WHY A DEDICATED CLIENT. This builds its own viem client from a URL and imports
 * neither `lib/wagmi.tsx` nor `lib/chains.ts`: both are browser modules that pull
 * in React, RainbowKit and WalletConnect. A server path must not depend on them,
 * and a `NEXT_PUBLIC_` RPC URL is not the one the indexer should use anyway — the
 * indexer's endpoint is server-only config (`INDEXER_RPC_URL`).
 *
 * ERROR POLICY LIVES IN `./chunking`, not here. `classifyRpcError` is the single
 * dispatch point, deliberately: `isRangeTooLarge` and `isRateLimit` can BOTH be
 * true for one error (`-32005` is a rate-limit code at some providers and a
 * result-count refusal at others), and the classifier settles the tie range-first
 * because the costs are asymmetric — a 429 misread as a range refusal wastes one
 * halving, while a range refusal misread as a 429 burns the entire request budget
 * re-sending a span that will be refused for as long as it is that wide.
 */

import { createPublicClient, http, type Address, type AbiEvent, type PublicClient } from 'viem';
import {
  BACKOFF_MS,
  MIN_CHUNK,
  classifyRpcError,
  halve,
  planRanges,
  type BlockRange,
} from './chunking';

const ONE = BigInt(1);

export interface GetLogsAdaptiveArgs {
  address: string | string[];
  events: AbiEvent[];
  from: bigint;
  to: bigint;
}

export interface GetLogsAdaptiveResult {
  logs: unknown[];
  /**
   * The widest span the endpoint served AT THE FULL CHUNK SIZE ASKED FOR, or null
   * when this sweep never issued a full-size request. Feed it to
   * `nextChunkCeiling` to remember it; never store a null as a small ceiling.
   */
  acceptedSpan: bigint | null;
  requests: number;
}

export interface IndexerRpc {
  getBlockNumber(): Promise<bigint>;
  getBlockHeader(n: bigint): Promise<{ hash: string; timestamp: bigint }>;
  getLogsAdaptive(args: GetLogsAdaptiveArgs): Promise<GetLogsAdaptiveResult>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run `fn`, retrying ONLY a rate limit, on the shared backoff ladder.
 *
 * A range refusal must not enter this loop: waiting changes nothing about a span
 * that is too wide, and the ladder would spend four sleeps and five requests to
 * be refused five times. `classifyRpcError` is range-first, so such an error is
 * rethrown here immediately and handled by the caller's halving. Anything else
 * ('other') is rethrown unretried — a malformed request or a dead endpoint is not
 * improved by repetition.
 *
 * At most `BACKOFF_MS.length` retries follow the initial attempt; after that the
 * rate limit is the caller's problem to report, not to outlast.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, onAttempt: () => void): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      onAttempt();
      return await fn();
    } catch (err) {
      if (classifyRpcError(err) !== 'rate-limit' || attempt >= BACKOFF_MS.length) throw err;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

/**
 * Validate an address filter.
 *
 * Throwing beats dropping: a sweep that silently omitted a malformed pool address
 * would report full coverage of a range whose events it never asked for, and the
 * gap would be recorded as indexed. A bad address here is a caller bug.
 */
function toAddressFilter(address: string | string[]): Address | Address[] {
  const list = Array.isArray(address) ? address : [address];
  const out: Address[] = [];
  for (const a of list) {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
      throw new Error('getLogsAdaptive: malformed address filter');
    }
    out.push(a.toLowerCase() as Address);
  }
  return Array.isArray(address) ? out : out[0];
}

/**
 * An RPC facade bound to one endpoint.
 *
 * `startChunk` is the first range width to try — normally the remembered
 * `accepted_chunk` for this chain, else `INDEXER_CHUNK_BLOCKS`. It SHRINKS within
 * the lifetime of this object when the endpoint refuses a width, and is never
 * grown back: re-probing a limit we have already been told about spends a request
 * per chunk to learn nothing. Raising it again is the caller's decision, made
 * through `nextChunkCeiling` on the value it persists.
 */
export function createIndexerRpc(rpcUrl: string, startChunk: bigint): IndexerRpc {
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl) });
  let chunk = startChunk < MIN_CHUNK ? MIN_CHUNK : startChunk;

  async function getLogsAdaptive(args: GetLogsAdaptiveArgs): Promise<GetLogsAdaptiveResult> {
    const address = toAddressFilter(args.address);
    const logs: unknown[] = [];
    let requests = 0;
    let acceptedSpan: bigint | null = null;

    /** One span, atomically: resolves having appended every log in it, or throws. */
    async function fetchSpan(range: BlockRange): Promise<void> {
      const span = range.to - range.from + ONE;
      try {
        const got = await withRateLimitRetry(
          () =>
            client.getLogs({
              address,
              events: args.events,
              fromBlock: range.from,
              toBlock: range.to,
            }),
          () => {
            requests += 1;
          }
        );
        for (const log of got) logs.push(log);
        /*
         * Record the accepted width ONLY for a request issued at the full working
         * chunk (`lib/logScan.ts:240-250` documents the bug this prevents). The
         * last range of any sweep is a remainder, and a catch-up sweep is a
         * handful of blocks: both are small because that is all that was ASKED
         * for, not because the endpoint refused more. Persisting one as the
         * ceiling would teach the indexer that this endpoint only serves 50-block
         * ranges, permanently.
         */
        if (span >= chunk && (acceptedSpan === null || span > acceptedSpan)) acceptedSpan = span;
        return;
      } catch (err) {
        // Rate limits were already retried and are terminal here; 'other' is not
        // retried at all. Only a width refusal is actionable, and the action is
        // to ask for less — never to re-send this same span.
        if (classifyRpcError(err) !== 'range-too-large') throw err;
        const half = halve(span, MIN_CHUNK);
        if (half === null) throw err;
        // Carry the narrower width to every later range in this sweep, so one
        // refusal is a one-off cost rather than a wasted request per chunk.
        if (half < chunk) chunk = half;
        const mid = range.from + half - ONE;
        // Lower half first, so `logs` stays ascending and cheap for replay to sort.
        await fetchSpan({ from: range.from, to: mid });
        await fetchSpan({ from: mid + ONE, to: range.to });
        return;
      }
    }

    /*
     * Re-plan whenever the working chunk shrinks: `planRanges` lays out the sweep
     * at one fixed width, so ranges planned before a refusal would each pay their
     * own refusal. The remainder is re-planned from the first uncovered block, so
     * coverage stays contiguous and forward-only with no gap.
     *
     * The span itself is the request budget — the caller bounds `to - from` (per
     * `INDEXER_TRAFFIC_MAX_BLOCKS` / `INDEXER_CRON_MAX_BLOCKS`) — so `planRanges`
     * is called uncapped and every planned range is actually fetched.
     */
    let cursor = args.from;
    while (cursor <= args.to) {
      const widthAtPlan = chunk;
      const plan = planRanges(cursor, args.to, chunk, Infinity);
      if (plan.length === 0) break;
      for (const range of plan) {
        await fetchSpan(range);
        cursor = range.to + ONE;
        if (chunk < widthAtPlan) break;
      }
    }

    return { logs, acceptedSpan, requests };
  }

  return {
    getBlockNumber: () => withRateLimitRetry(() => client.getBlockNumber(), () => {}),

    /**
     * Hash and timestamp of one block: the reorg witness (`blocks.block_hash`) and
     * the chart's x-axis (`blocks.block_time`). Only blocks that contain indexed
     * events are ever fetched, which is why this is one call and not a sweep.
     */
    getBlockHeader: async (n: bigint) => {
      const block = await withRateLimitRetry(
        () => client.getBlock({ blockNumber: n }),
        () => {}
      );
      // Non-null for any mined block; a null hash means we were handed a pending
      // block, which cannot witness anything and must not be recorded as if it could.
      if (!block.hash) throw new Error(`getBlockHeader: block ${n.toString()} has no hash`);
      return { hash: block.hash.toLowerCase(), timestamp: block.timestamp };
    },

    getLogsAdaptive,
  };
}
