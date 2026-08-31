'use client';

/**
 * Simple trade-price history for one pool.
 *
 * ── PRICE COMES FROM THE EVENT, NOT FROM REPLAYED RESERVES ───────────────────
 * A trade event already carries its own execution price in its arguments:
 *
 *   Buy(outcome, investmentAmount, sharesOut) -> paid investmentAmount for
 *   sharesOut shares, so price per share = investmentAmount / sharesOut.
 *
 *   Sell(outcome, returnAmount, sharesIn)     -> received returnAmount for
 *   sharesIn shares, so price per share = returnAmount / sharesIn.
 *
 * Since a share pays exactly 1 USDC if it wins, that ratio IS the implied
 * probability. One event, one point — no reserve state to reconstruct, nothing to
 * verify against the live pool, and no `getBlock` per block for timestamps (the
 * x-axis is trade SEQUENCE, which is why there are no time-range tabs).
 *
 * That part was right and is unchanged. Do NOT reintroduce a reserve replay.
 *
 * ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
 * Two rounds of the same mistake: the scan had no idea WHERE the market was.
 *
 * First it was a fixed 54,000-block window below the head — anchored to the head
 * rather than to the market, so once the chain grew past it every trade fell
 * outside and the hook returned nothing.
 *
 * Replacing that with a growing, persisted window fixed the shape but not the
 * arithmetic. The window still started at the head and crawled backward with no
 * real floor, on a chain whose head is past 57,000,000 while this factory sits at
 * 55,632,013 — about 1.7M blocks back. A cold load could reach 1.2M of that at
 * best, and the cache lived in sessionStorage, so every new tab threw the partial
 * depth away and started the crawl over. The chart kept drawing only the live
 * price it appends itself: the reported "single dot".
 *
 * Both are now fixed at the source. The sweep is anchored at the factory's
 * DEPLOYMENT BLOCK (`getStartBlock`), which is an exact floor rather than a
 * guess, so the range is closed and a cold load covers all of it. The chunk size
 * opens at the endpoint's known ceiling instead of a fraction of it, and the
 * cache is durable, so the depth is paid once per browser rather than once per
 * tab. See `lib/logScan.ts`, which owns the sweep and is shared with
 * `useTradeLedger`.
 *
 * Also: Buy and Sell are now fetched in ONE `getLogs` per chunk instead of two,
 * because viem accepts an events ARRAY and turns it into a topic0 OR-set. That
 * halves the request count outright.
 *
 * ── NEVER FAILS VISIBLY ──────────────────────────────────────────────────────
 * This hook does not surface errors. If the log query is rate-limited or fails
 * for any reason, it returns whatever it has (often nothing) and sets `degraded`.
 * The chart then draws the live contract price alone. A chart showing one true
 * point beats an error message, and the current price never depended on logs.
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

const EV_BUY = parseAbiItem(
  'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)'
);
const EV_SELL = parseAbiItem(
  'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)'
);

/**
 * First range size tried per request, halved automatically if the endpoint
 * refuses it. A single pool's Buy/Sell logs are sparse, so a wide range is
 * usually accepted and covers a lot of history in very few requests.
 *
 * Raised from 45,000 because that was leaving most of the endpoint's allowance
 * on the table: Arc testnet accepts far wider ranges and only answers
 * `-32012 requested range too large` around the 1,000,000 mark. At 45,000 a
 * 1.7M-block history needed ~38 requests; at 250,000 it needs ~7. The halving
 * path still handles a stricter endpoint, and the size that actually worked is
 * remembered (see `readChunkCeiling`) so the probe is paid once per browser.
 */
const START_CHUNK = BigInt(250_000);
/** Stop subdividing here; below this the request count stops being worth it. */
const MIN_CHUNK = BigInt(1000);
/**
 * Blocks one load may newly reach BACKWARD.
 *
 * With `floor` now anchored to the factory's deployment block this is a safety
 * valve rather than the real bound — the anchored range is only ~1.7M blocks, so
 * a generous allowance lets a cold load cover ALL of it and finish, instead of
 * stopping short and reporting a partial history as complete.
 */
const MAX_NEW_BLOCKS = BigInt(4_000_000);
/** Hard backstop on requests per load, so a strict endpoint cannot cause a storm. */
const MAX_REQUESTS = 40;
/**
 * Stop digging once this many trades are known.
 *
 * A 200px-wide line cannot show more shape than this, so deeper scanning would
 * be pure cost. Busy markets therefore load in one or two requests.
 */
const ENOUGH_EVENTS = 250;
/** Points beyond this are dropped from the head; a line needs shape, not density. */
const MAX_POINTS = 200;

export interface TradePoint {
  /** Implied YES probability in basis points (0..10000). */
  bps: number;
  kind: 'buy' | 'sell' | 'now';
}

export interface TradeHistory {
  points: TradePoint[];
  isLoading: boolean;
  /** True when trades could not be loaded, so only the live price is shown. */
  degraded: boolean;
  /**
   * True when history is known to reach back to the start of the chain, so the
   * line is the market's complete record rather than a recent slice.
   */
  complete: boolean;
  /**
   * Pull in trades since the last load. Called after a trade confirms.
   *
   * A stable reference: callers pass this into useCallback dependency lists and
   * effects, where a new identity each render would loop and hammer the RPC.
   */
  refresh: () => void;
}

/**
 * Convert one trade event into an implied YES probability.
 *
 * The ratio is computed for the outcome that was actually traded, then flipped
 * to the YES side when the trade was on NO, so a single series stays coherent.
 * Returns null for anything nonsensical (zero shares, a ratio outside 0..1)
 * rather than plotting a misleading point.
 */
function priceBps(name: string, args: Record<string, string>): number | null {
  try {
    const outcome = BigInt(args.outcome ?? '0');
    const numerator = BigInt(name === 'Buy' ? args.investmentAmount ?? '0' : args.returnAmount ?? '0');
    const denominator = BigInt(name === 'Buy' ? args.sharesOut ?? '0' : args.sharesIn ?? '0');
    if (denominator <= BigInt(0) || numerator <= BigInt(0)) return null;

    const bps = Number((numerator * BigInt(10000)) / denominator);
    // A share cannot be worth more than the 1 USDC it pays out. A ratio above
    // that means the args were not what we assumed, so drop the point.
    if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) return null;

    return outcome === BigInt(0) ? bps : 10000 - bps;
  } catch {
    return null;
  }
}

/** What one load resolves to: the events, plus how far the scan actually got. */
interface TradeData {
  events: CachedEvent[];
  /**
   * True when a request failed, so coverage has a hole or stops short of the head.
   *
   * Distinct from "no events found": an untraded market legitimately has zero
   * events and is NOT degraded. Conflating the two would make a brand-new market
   * report that history is unavailable, which is a lie about a working system.
   */
  incomplete: boolean;
  /** True when the scan reached block 0, so nothing older exists to find. */
  reachedFloor: boolean;
}

export function useTradeHistory(
  fpmm: `0x${string}` | undefined,
  currentBps: number
): TradeHistory {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const enabled = !!client && !!fpmm;

  const queryKey = useMemo(
    () => ['tradeHistory', chainId, fpmm ?? null] as const,
    [chainId, fpmm]
  );

  const { data, isLoading, isError } = useQuery<TradeData, Error>({
    queryKey,
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // rpcQueue already backs off on 429; a retry on top would multiply requests
    // at exactly the moment the RPC is asking us to slow down.
    retry: false,
    queryFn: async () => {
      if (!client || !fpmm) return { events: [], incomplete: false, reachedFloor: false };
      return loadTrades(client, chainId, fpmm);
    },
  });

  const points = useMemo(() => {
    const out: TradePoint[] = [];

    for (const ev of data?.events ?? []) {
      const bps = priceBps(ev.name, ev.args);
      if (bps === null) continue;
      out.push({ bps, kind: ev.name === 'Buy' ? 'buy' : 'sell' });
    }

    // Keep the most recent points if a very busy market overflows the budget.
    const trimmed = out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;

    // The live price is always the last point, read straight from the contract.
    // This is what guarantees the chart is never empty and never stale at the
    // right-hand edge, regardless of what happened to the log query.
    return [...trimmed, { bps: currentBps, kind: 'now' as const }];
  }, [data, currentBps]);

  const refresh = useCallback(() => {
    // Invalidating an ACTIVE query already triggers exactly one refetch, so this
    // must not also call refetch() — that would double the request at the moment
    // we most want to be frugal. It also correctly no-ops when nothing is
    // mounted to observe the result.
    //
    // The underlying load resumes from the cached block range, so the new request
    // covers only blocks since the last one, not the whole window again.
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    points,
    isLoading: enabled && isLoading,
    degraded: isError || (data?.incomplete ?? false),
    complete: data?.reachedFloor ?? false,
    refresh,
  };
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/**
 * Fetch Buy/Sell logs for one pool, extending whatever is already cached.
 *
 * Total: never throws. Any failure yields whatever was gathered so far, because
 * a partial line is more useful than an error panel — and the caller adds the
 * live price regardless.
 */
async function loadTrades(
  client: Client,
  chainId: number,
  fpmm: `0x${string}`
): Promise<TradeData> {
  let latest: bigint;
  try {
    latest = await enqueueRpc(() => client.getBlockNumber());
  } catch {
    // Without a head block there is no window to scan at all.
    return { events: [], incomplete: true, reachedFloor: false };
  }

  const result = await sweepLogs({
    latest,
    cached: readCache(chainId, fpmm),
    // The factory's deployment block: no trade can predate it. This is what
    // bounds the scan and lets `reachedFloor` mean "complete history".
    floor: getStartBlock(chainId),
    maxNewBlocks: MAX_NEW_BLOCKS,
    maxRequests: MAX_REQUESTS,
    // Open at the size this endpoint already proved it accepts, so a cold load
    // does not re-pay the halving probe to relearn the same ceiling.
    startChunk: readChunkCeiling(chainId) ?? START_CHUNK,
    minChunk: MIN_CHUNK,
    enough: ENOUGH_EVENTS,
    isFatal: isRateLimit,
    // ONE request for both event types: viem turns an events array into a
    // topic0 OR-set, so asking for Buy and Sell separately doubled the cost.
    fetchRange: async (from, to) => {
      const logs = await enqueueRpc(() =>
        client.getLogs({ address: fpmm, events: [EV_BUY, EV_SELL], fromBlock: from, toBlock: to })
      );
      const out: CachedEvent[] = [];
      for (const l of logs) {
        if (l.blockNumber === null || l.logIndex === null) continue;
        const name = (l as { eventName?: string }).eventName;
        if (name !== 'Buy' && name !== 'Sell') continue;
        out.push({
          address: (l.address ?? fpmm).toLowerCase(),
          blockNumber: l.blockNumber.toString(),
          logIndex: l.logIndex,
          name,
          args: stringifyArgs(l.args),
        });
      }
      return out;
    },
  });

  if (result.range) {
    try {
      writeCache(chainId, fpmm, {
        fromBlock: result.range.fromBlock.toString(),
        toBlock: result.range.toBlock.toString(),
        events: result.events,
      });
    } catch {
      // Cache is an optimization; failing to persist must not fail the load.
    }
  }

  // Remember the endpoint's real range ceiling for every later sweep, on this
  // pool or any other. Only written when a request genuinely succeeded.
  if (result.acceptedChunk) writeChunkCeiling(chainId, result.acceptedChunk);

  return {
    events: result.events,
    incomplete: result.incomplete,
    reachedFloor: result.reachedFloor,
  };
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
