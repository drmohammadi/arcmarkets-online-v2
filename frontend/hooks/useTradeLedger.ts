'use client';

/**
 * One bounded sweep of every market's Buy/Sell logs, shared by the profile page
 * and the leaderboard.
 *
 * ── WHY ONE GLOBAL SCAN, NOT ONE PER USER ────────────────────────────────────
 * viem's `getLogs` accepts an ARRAY of addresses and an ARRAY of events, which
 * become an address filter and a topic0 OR-set in a single `eth_getLogs`. So one
 * request covers every market and both event types at once:
 *
 *     getLogs({ address: [fpmm1, fpmm2, ...], events: [Buy, Sell], ... })
 *
 * The cost of a scan is therefore driven by how many BLOCKS it covers, not by how
 * many markets exist — which is what makes a leaderboard viable here at all. A
 * per-market loop would have been 2N requests per block range.
 *
 * The per-user view is a client-side filter of the same result. Filtering
 * server-side would actually cost MORE: viem drops `args` when `events`
 * (plural) is used, so a per-user query needs one request per event type.
 *
 * ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
 * The sweep never knew where the markets were, so it could not reach them.
 *
 * First it covered a FIXED 54,000 blocks below the chain head — anchored to the
 * HEAD rather than to the markets, so once the chain grew past it every trade fell
 * outside and the sweep returned nothing.
 *
 * Replacing that with a growing, persisted range fixed the shape but not the
 * reach. It still began at the head and crawled backward with no real floor, at
 * 20,000 blocks per request with a 32-request cap — 640,000 blocks per load. Arc
 * testnet's head is past 57,000,000 while the factory sits at 55,632,013, about
 * 1.7M blocks back, so a load stopped roughly 1M blocks short of the first
 * market. Worse, the cache was sessionStorage, so the partial depth was discarded
 * whenever the tab closed and the crawl restarted from the head forever.
 * /leaderboard therefore reported "no trades in the scanned window" — which reads
 * as "nobody has ever traded" — on a chain with plenty of trades, and /profile
 * said the same. Both were reported as broken, and this was why.
 *
 * Now: `floor` is the factory's DEPLOYMENT BLOCK, an exact bound rather than a
 * guess, so the range is closed at ~1.7M blocks; the chunk opens at the
 * endpoint's real ceiling instead of a sixth of it, so that range costs ~15
 * requests rather than ~85; and the cache is durable, so depth is paid once per
 * browser. `lib/logScan.ts` owns the sweep and is shared with the price chart.
 *
 * Unlike the chart, this sweep does NOT stop early once it has "enough" events:
 * an aggregate cannot know whether the trader or the position it needs is deeper
 * in history, so it spends its whole budget.
 *
 * ── NEVER FAILS VISIBLY ──────────────────────────────────────────────────────
 * Like useTradeHistory, this hook does not surface errors. A failed or
 * rate-limited scan returns whatever it gathered and sets `partial`, which the
 * pages label. A truncated leaderboard is honest; an empty one that reads as
 * "nobody has traded" is not.
 */

import { useCallback, useMemo } from 'react';
import { parseAbiItem } from 'viem';
import { useChainId, usePublicClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { enqueueRpc, isRateLimit } from '@/lib/rpcQueue';
import {
  readCache,
  writeCache,
  readChunkCeiling,
  writeChunkCeiling,
  type CachedEvent,
} from '@/lib/logCache';
import { sweepLogs } from '@/lib/logScan';
import { getStartBlock } from '@/lib/contracts';
import { safeAddress } from '@/lib/sanitize';
import type { LedgerTrade } from '@/lib/ledger';
import type { Market } from './useMarkets';

const EV_BUY = parseAbiItem(
  'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)'
);
const EV_SELL = parseAbiItem(
  'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)'
);

/**
 * First range size tried per request, halved automatically when refused.
 *
 * Kept below the chart's because this filter spans every pool at once and is
 * correspondingly denser — a range that is comfortable for one market can return
 * too many results across twenty. But 20,000 was far too conservative: it made a
 * 1.7M-block history cost ~85 requests, well past `MAX_REQUESTS`, so the sweep
 * could never finish and the leaderboard stayed empty no matter how many times it
 * was loaded. The endpoint accepts far more; the halving path still covers a
 * stricter one, and the accepted size is remembered across loads.
 */
const START_CHUNK = BigInt(120_000);
/**
 * Smallest chunk we will retry with before giving up on a range.
 *
 * A range refused for returning too many results is NOT a 429, so rpcQueue does
 * not retry it. Halving converts that into a smaller successful query instead of
 * silently ending the scan.
 */
const MIN_CHUNK = BigInt(1000);
/**
 * Blocks one load may newly reach backward.
 *
 * A safety valve now that `floor` is the factory's deployment block: the real
 * bound is that anchored range (~1.7M blocks on Arc testnet), and this must be
 * comfortably above it so a cold load can cover the whole thing and report an
 * honest `reachedFloor` rather than stopping short.
 */
const MAX_NEW_BLOCKS = BigInt(4_000_000);
/** Hard backstop on requests per load. */
const MAX_REQUESTS = 48;
/** Cap on addresses per request; some RPCs limit the filter list. */
const MAX_ADDRESSES = 100;

interface LedgerData {
  events: CachedEvent[];
  /** True when a range could not be read, so coverage has a hole. */
  incomplete: boolean;
  /** True when the sweep reached block 0 — nothing older exists to find. */
  reachedFloor: boolean;
  /** Blocks actually covered, for an honest "covers the last N blocks" note. */
  covered: bigint;
}

export interface TradeLedger {
  /** Every scanned trade, in chain order. */
  trades: LedgerTrade[];
  isLoading: boolean;
  /**
   * True when the scan was cut short. Distinct from "no trades": an untraded
   * chain legitimately has zero events and is NOT partial.
   */
  partial: boolean;
  /**
   * Blocks actually covered by the scan — not a fixed constant.
   *
   * Reported rather than assumed so the disclaimer states the real coverage. It
   * used to be a hardcoded lookback, which stayed reassuringly precise while the
   * window it described had stopped containing any trades.
   */
  lookbackBlocks: bigint;
  /** True when history reaches the start of the chain, so figures are complete. */
  complete: boolean;
  refresh: () => void;
}

export function useTradeLedger(markets: Market[]): TradeLedger {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();

  // Content-addressed identity: the same market set in any order yields the
  // same key, so an unmemoized caller array cannot cause a refetch loop.
  const addressKey = useMemo(() => {
    const seen = new Set<string>();
    for (const m of markets) {
      const addr = safeAddress(m.fpmm);
      if (addr) seen.add(addr);
    }
    return Array.from(seen).sort().join(',');
  }, [markets]);

  const addresses = useMemo(
    () => (addressKey === '' ? [] : (addressKey.split(',') as `0x${string}`[])),
    [addressKey]
  );

  /** fpmm -> questionId. The events carry no questionId, so this is the join. */
  const questionIdByFpmm = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const m of markets) {
      const addr = safeAddress(m.fpmm);
      if (addr) map.set(addr, m.questionId);
    }
    return map;
  }, [markets]);

  const enabled = !!client && addresses.length > 0;

  const queryKey = useMemo(
    () => ['tradeLedger', chainId, addressKey] as const,
    [chainId, addressKey]
  );

  const { data, isLoading, isError } = useQuery<LedgerData, Error>({
    queryKey,
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // rpcQueue already backs off on 429; retrying on top would multiply requests
    // at exactly the moment the RPC is asking us to slow down.
    retry: false,
    queryFn: async () => {
      if (!client || addresses.length === 0) {
        return { events: [], incomplete: false, reachedFloor: false, covered: BigInt(0) };
      }
      return loadLedger(client, chainId, addresses, addressKey);
    },
  });

  const trades = useMemo(() => {
    const out: LedgerTrade[] = [];
    for (const ev of data?.events ?? []) {
      const trade = toTrade(ev, questionIdByFpmm);
      if (trade) out.push(trade);
    }
    return out;
  }, [data, questionIdByFpmm]);

  const refresh = useCallback(() => {
    // Invalidating an ACTIVE query already triggers exactly one refetch, so this
    // must not also call refetch().
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    trades,
    isLoading: enabled && isLoading,
    partial: isError || (data?.incomplete ?? false),
    lookbackBlocks: data?.covered ?? BigInt(0),
    complete: data?.reachedFloor ?? false,
    refresh,
  };
}

/** Decode one cached event into a ledger trade, or null if it is unusable. */
function toTrade(ev: CachedEvent, byFpmm: Map<string, bigint>): LedgerTrade | null {
  try {
    const fpmm = safeAddress(ev.address);
    const trader = safeAddress(ev.args.buyer ?? ev.args.seller);
    if (!fpmm || !trader) return null;

    const isBuy = ev.name === 'Buy';
    const collateral = BigInt(
      (isBuy ? ev.args.investmentAmount : ev.args.returnAmount) ?? '0'
    );
    const shares = BigInt((isBuy ? ev.args.sharesOut : ev.args.sharesIn) ?? '0');
    if (collateral <= BigInt(0) || shares <= BigInt(0)) return null;

    const rawOutcome = BigInt(ev.args.outcome ?? '0');
    if (rawOutcome !== BigInt(0) && rawOutcome !== BigInt(1)) return null;

    return {
      blockNumber: BigInt(ev.blockNumber),
      logIndex: ev.logIndex,
      fpmm,
      questionId: byFpmm.get(fpmm) ?? null,
      trader,
      side: isBuy ? 'buy' : 'sell',
      outcome: rawOutcome === BigInt(0) ? 0 : 1,
      collateral,
      shares,
    };
  } catch {
    return null;
  }
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/**
 * Fetch recent Buy/Sell logs across every supplied pool.
 *
 * Total: never throws. Any failure yields whatever was gathered, with
 * `incomplete` set.
 */
async function loadLedger(
  client: Client,
  chainId: number,
  addresses: `0x${string}`[],
  addressKey: string
): Promise<LedgerData> {
  let latest: bigint;
  try {
    latest = await enqueueRpc(() => client.getBlockNumber());
  } catch {
    return { events: [], incomplete: true, reachedFloor: false, covered: BigInt(0) };
  }

  /*
   * The cache slot is keyed by the ADDRESS SET, not just the chain. A cached
   * range was fetched under one address filter; if a new market appears, that
   * filter changes and reusing the range would permanently skip the new
   * market's older logs. Changing the key forces one correct rescan instead.
   */
  const cacheSlot = `ledger:${hashKey(addressKey)}`;

  const result = await sweepLogs({
    latest,
    cached: readCache(chainId, cacheSlot),
    // The factory's deployment block: no trade can predate it. An exact floor,
    // which is what turns this from an open-ended crawl into a range that
    // finishes and can honestly claim to be complete.
    floor: getStartBlock(chainId),
    maxNewBlocks: MAX_NEW_BLOCKS,
    maxRequests: MAX_REQUESTS,
    // Open at the ceiling this endpoint already proved it accepts.
    startChunk: readChunkCeiling(chainId) ?? START_CHUNK,
    minChunk: MIN_CHUNK,
    // Deliberately NO `enough`: unlike the chart, an aggregate cannot know
    // whether the trader or position it needs lies deeper in history, so it
    // spends the full budget rather than stopping at an arbitrary count.
    isFatal: isRateLimit,
    fetchRange: async (from, to) => {
      const events: CachedEvent[] = [];
      // Chunk the address filter too: some RPCs cap the list length.
      for (let i = 0; i < addresses.length; i += MAX_ADDRESSES) {
        const slice = addresses.slice(i, i + MAX_ADDRESSES);
        const logs = await enqueueRpc(() =>
          client.getLogs({
            address: slice,
            events: [EV_BUY, EV_SELL],
            fromBlock: from,
            toBlock: to,
          })
        );
        for (const l of logs) {
          if (l.blockNumber === null || l.logIndex === null) continue;
          const name = (l as { eventName?: string }).eventName;
          if (name !== 'Buy' && name !== 'Sell') continue;
          events.push({
            blockNumber: l.blockNumber.toString(),
            logIndex: l.logIndex,
            name,
            address: (l.address ?? '').toLowerCase(),
            args: stringifyArgs(l.args),
          });
        }
      }
      return events;
    },
  });

  if (result.range) {
    try {
      writeCache(chainId, cacheSlot, {
        fromBlock: result.range.fromBlock.toString(),
        toBlock: result.range.toBlock.toString(),
        events: result.events,
      });
    } catch {
      // Cache is an optimization; failing to persist must not fail the load.
    }
  }

  // Remember the endpoint's real range ceiling, shared with every other sweep.
  if (result.acceptedChunk) writeChunkCeiling(chainId, result.acceptedChunk);

  const covered = result.range
    ? result.range.toBlock - result.range.fromBlock + BigInt(1)
    : BigInt(0);

  return {
    events: result.events,
    incomplete: result.incomplete,
    reachedFloor: result.reachedFloor,
    covered,
  };
}

/** Short stable hash of the address set, for the cache slot name. */
function hashKey(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Normalize decoded args to strings so they survive JSON persistence. */
function stringifyArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (typeof v === 'number' || typeof v === 'string') out[k] = String(v);
    else if (typeof v === 'boolean') out[k] = v ? '1' : '0';
  }
  return out;
}
