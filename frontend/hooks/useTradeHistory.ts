'use client';

/**
 * Price history for one market: the indexer API first, the RPC log sweep as the
 * permanent fallback.
 *
 * ── HISTORY COMES FROM THE INDEXER, NOT FROM THE BROWSER ─────────────────────
 * `GET /api/markets/[questionId]/chart` serves the line out of Neon Postgres.
 * The server has already paid all three of the expensive costs, once, for every
 * visitor rather than once per visitor:
 *
 *   1. the `eth_getLogs` sweep forward from the factory's deploy block;
 *   2. ONE `getBlock` per event-bearing block, EVER, cached in `blocks` forever —
 *      which is what makes a real time x-axis affordable. **The browser must
 *      never call `getBlock` for a chart point**; per-block header fetches from
 *      here are what made a time axis impossible before;
 *   3. the reserve replay — reconstructing pool reserves exactly from the four
 *      FPMM events and storing the marginal price per event.
 *
 * (3) MUST NOT COME BACK HERE. A browser-side replay was correct but so
 * RPC-hungry it caused the 429s it then reported; server-side it is nearly free.
 * The replay is not forbidden, only its location is.
 *
 * So `bps` from the API is the MARGINAL implied probability
 * `reserveNo / (reserveYes + reserveNo)`, the same quantity as the live `'now'`
 * point. One quantity end to end: the chart used to mix fee-inclusive execution
 * prices for history with a marginal price for the live point, which put a fake
 * jump of up to ±fee at the right-hand edge.
 *
 * ── THE SWEEP BELOW IS THE PERMANENT FALLBACK, NOT DEAD CODE ─────────────────
 * `loadTrades`, `priceBps`, `EV_BUY`/`EV_SELL` and `lib/logScan.ts` stay for
 * good. Neon's free tier suspends on quota and the daily cron lets it sleep, so a
 * chart that degrades to slow-but-working beats one that shows nothing.
 * `NEXT_PUBLIC_CHART_SOURCE` picks the path: `api` (default), `rpc`, or `auto`
 * (the API, then the sweep if it fails).
 *
 * Two things the fallback cannot do, both accepted rather than worked around:
 *
 *  - It prices each trade from the event's OWN arguments, which is a
 *    fee-INCLUSIVE execution price rather than the marginal one. The
 *    alternative is a browser replay, which is exactly what is forbidden above.
 *  - It has NO TIMESTAMPS. `CachedEvent` stores `blockNumber` and `logIndex`
 *    only, and filling that in means the header fetches this hook exists to
 *    stop. That is why `TradePoint.t` is OPTIONAL and why `PriceChart` keeps
 *    even sequence spacing as the degenerate case of one renderer
 *    (`lib/chartScale.ts`), not as a second renderer.
 *
 * ── WHY THE SWEEP CAN ONLY EVER BE THE FALLBACK ──────────────────────────────
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
 * What none of that fixes is the ARITHMETIC OF THE BUDGET, and that is why the
 * sweep is now second choice rather than the primary path: it is capped at 40
 * requests per load against a 1.7M-block window on a rate-limited public node, so
 * it is a GROWING window over the history rather than the whole of it. It never
 * reports `complete` on a cold load, which is also why `logCache` has to exist.
 *
 * ── NEVER FAILS VISIBLY ──────────────────────────────────────────────────────
 * This hook does not surface errors. If the API is unreachable, or the log query
 * is rate-limited, or anything else fails, it returns whatever it has (often
 * nothing) and sets `degraded`. The chart then draws the live contract price
 * alone — labelled, not hidden. A chart showing one true point beats an error
 * message, and the current price comes from the contract, so it never depended on
 * either history path.
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

/**
 * Which history path runs, fixed at build time.
 *
 * A LITERAL `process.env.NEXT_PUBLIC_CHART_SOURCE` access, never a computed one
 * (`process.env[name]`, destructuring, a helper taking the name as an argument).
 * Next inlines only static property accesses; anything else reaches the browser
 * as `undefined` and this would silently pin itself to the default forever.
 * `lib/links.ts:15` documents the same trap.
 *
 * It is the only new public variable in this change and it carries no secret —
 * `DATABASE_URL`, `INDEXER_RPC_URL` and `CRON_SECRET` are server-only and must
 * never acquire a `NEXT_PUBLIC_` name.
 */
const CHART_SOURCE: 'api' | 'rpc' | 'auto' =
  process.env.NEXT_PUBLIC_CHART_SOURCE === 'rpc'
    ? 'rpc'
    : process.env.NEXT_PUBLIC_CHART_SOURCE === 'auto'
      ? 'auto'
      : 'api';

export interface TradePoint {
  /** Implied YES probability in basis points (0..10000). */
  bps: number;
  kind: 'buy' | 'sell' | 'now';
  /**
   * Unix SECONDS, when the point's time is known.
   *
   * Present on every point the indexer API serves and on the live `'now'` point.
   * ABSENT on the RPC fallback path, which has no timestamps and must not fetch
   * any (see the header). That is why it is optional rather than required:
   * `buildXScale` selects a time axis only when EVERY point has one, and even
   * sequence spacing otherwise.
   */
  t?: number;
}

export interface TradeHistory {
  points: TradePoint[];
  isLoading: boolean;
  /** True when history could not be loaded, so only the live price is shown. */
  degraded: boolean;
  /**
   * True when history is known to be the market's complete record rather than a
   * recent slice: `meta.complete` (the chain's backfill is whole) on the API
   * path, and "the sweep reached the factory's deploy block" on the fallback.
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

/** What one SWEEP resolves to: the events, plus how far the scan actually got. */
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

/**
 * What one LOAD resolves to, from either source.
 *
 * Both paths converge here so the hook body has no idea which one ran, and the
 * two flags keep exactly the meanings `TradeData` gave them: `incomplete` is a
 * failure, `reachedFloor` is "this is the whole record". On the API path they map
 * to a failed fetch and `meta.complete` respectively.
 */
interface HistoryData {
  /** History oldest-first, WITHOUT the live point, which the hook appends. */
  points: TradePoint[];
  incomplete: boolean;
  reachedFloor: boolean;
}

/** Nothing loaded, nothing wrong: the shape for a disabled query. */
const EMPTY_HISTORY: HistoryData = { points: [], incomplete: false, reachedFloor: false };

/** Nothing loaded, and that IS wrong: only the live point will be drawn. */
const FAILED_HISTORY: HistoryData = { points: [], incomplete: true, reachedFloor: false };

/** One point as the chart API serves it. Everything else in the body is ignored. */
interface ApiPoint {
  t: unknown;
  bps: unknown;
}

/**
 * Fetch history from the indexer, or null when the API did not serve any.
 *
 * NULL IS "ASK THE FALLBACK", not "no trades". An untraded market returns an
 * empty `points` array with `incomplete: false`, which is a successful answer and
 * draws the flat dashed line. Null is returned for a non-OK status, a throw, a
 * body that is not the documented shape, and for `meta.degraded` — that last one
 * arrives as a 200 because the route degrades rather than erroring (its header
 * explains why), and treating it as success would leave `auto` unable to fall
 * back in the one case it exists for: an unreachable database.
 *
 * Total: never throws. Every failure is a null.
 */
async function loadFromApi(questionId: bigint): Promise<HistoryData | null> {
  try {
    /*
     * `from=all` because a price chart's whole point is the record, not a recent
     * slice — CLAUDE.md's twice-bitten rule about head-relative windows applies
     * to a time window exactly as it does to a block window. `interval=auto`
     * lets the server widen buckets to fit, and `limit=200` matches MAX_POINTS,
     * so nothing is fetched that no pixel can show.
     *
     * No `outcome` parameter: the series is always the YES probability, matching
     * `currentBps`, and 0 is the route's default. No client-side timeout either
     * — the route deliberately budgets ~20s for a Neon wake-up and Vercel caps it
     * at 30s, so aborting sooner would abandon a wake-up that was about to
     * succeed and degrade every first visitor after a suspension.
     */
    const res = await fetch(
      `/api/markets/${questionId.toString()}/chart?from=all&interval=auto&limit=${MAX_POINTS}`,
      { headers: { accept: 'application/json' } }
    );
    if (!res.ok) return null;

    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return null;
    const raw = (body as { points?: unknown }).points;
    if (!Array.isArray(raw)) return null;

    const meta = (body as { meta?: { complete?: unknown; degraded?: unknown } }).meta;
    if (meta?.degraded === true) return null;

    const points: TradePoint[] = [];
    for (const item of raw as ApiPoint[]) {
      const t = typeof item?.t === 'number' ? item.t : Number.NaN;
      const bps = typeof item?.bps === 'number' ? item.bps : Number.NaN;
      // A malformed point is dropped, never plotted at 0% or at the epoch. The
      // route clamps both server-side; this is the boundary check that makes the
      // clamp an assertion rather than a hope.
      if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(bps) || bps < 0 || bps > 10000) {
        continue;
      }
      /*
       * `kind: 'buy'` for every API point, deliberately. The response carries no
       * direction — one row per event is what makes a binary market one series —
       * and the chart uses `kind` only to label the live point and to fill the
       * `sr-only` table's Type column. The visible marker is identical either
       * way. DO NOT "fix" this by adding a direction column to the query: the
       * chart has nothing to draw with it. (The honest fix, if the table's
       * wording ever matters, is a neutral kind — not more SQL.)
       */
      points.push({ bps: Math.round(bps), kind: 'buy', t: Math.floor(t) });
    }

    return { points, incomplete: false, reachedFloor: meta?.complete === true };
  } catch {
    // Offline, aborted, a proxy returning HTML, a JSON parse failure: all the
    // same answer. The caller decides whether that means the sweep or a degraded
    // chart, and it is never an exception a render path has to catch.
    return null;
  }
}

/**
 * The sweep's events as plottable points.
 *
 * No `t`: `CachedEvent` has no timestamp and getting one means a `getBlock` per
 * block from the browser, which is the cost this whole change removes. The
 * absence is what selects sequence spacing in `buildXScale`.
 */
function pointsFromEvents(data: TradeData): HistoryData {
  const points: TradePoint[] = [];
  for (const ev of data.events) {
    const bps = priceBps(ev.name, ev.args);
    if (bps === null) continue;
    points.push({ bps, kind: ev.name === 'Buy' ? 'buy' : 'sell' });
  }
  return { points, incomplete: data.incomplete, reachedFloor: data.reachedFloor };
}

export function useTradeHistory(
  fpmm: `0x${string}` | undefined,
  currentBps: number,
  /**
   * The market's question id, which the API is keyed by.
   *
   * Optional so the hook still works without it — `api` degrades to the live
   * point and `auto` goes straight to the sweep, both of which are honest
   * answers rather than a crash. `app/market/[id]/page.tsx` passes it; that one
   * call-site edit is the only change outside this file.
   */
  questionId?: bigint
): TradeHistory {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const enabled = !!client && !!fpmm;

  const queryKey = useMemo(
    () => ['tradeHistory', chainId, fpmm ?? null, questionId?.toString() ?? null] as const,
    [chainId, fpmm, questionId]
  );

  const { data, isLoading, isError } = useQuery<HistoryData, Error>({
    queryKey,
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // No retry on either path. On the sweep, `rpcQueue` already backs off on 429
    // and a retry on top would multiply requests at exactly the moment the RPC is
    // asking us to slow down. On the API path a failure is already handled — the
    // fallback or a degraded label — so a retry would only delay it.
    retry: false,
    queryFn: async () => {
      if (!client || !fpmm) return EMPTY_HISTORY;

      /*
       * `api` and `auto` both try the indexer first. Without a `questionId`
       * there is nothing to ask it for, so that case skips straight to the
       * decision below rather than fetching a URL with `undefined` in it.
       */
      if (CHART_SOURCE !== 'rpc') {
        const fromApi = questionId === undefined ? null : await loadFromApi(questionId);
        if (fromApi !== null) return fromApi;
        // `api` is fetch-only by definition: degrade to the live point rather
        // than quietly spending the 40-request sweep this mode exists to avoid.
        if (CHART_SOURCE === 'api') return FAILED_HISTORY;
      }

      return pointsFromEvents(await loadTrades(client, chainId, fpmm));
    },
  });

  const points = useMemo(() => {
    const history = data?.points ?? [];

    // Keep the most recent points if a very busy market overflows the budget.
    const trimmed = history.length > MAX_POINTS ? history.slice(-MAX_POINTS) : history;

    /*
     * The live price is always the last point, read straight from the contract.
     * This is what guarantees the chart is never empty and never stale at the
     * right-hand edge, regardless of what happened to the API or the log query —
     * indexer lag degrades HISTORY, never the current price.
     *
     * Its `t` is the client clock, the one timestamp here that is not indexed,
     * and it gives the time axis its right-hand anchor. Never allowed BELOW the
     * newest history point: a clock a few seconds slow is our clock being wrong,
     * not the chain's, and it would otherwise draw the line doubling back.
     */
    const nowSec = Math.floor(Date.now() / 1000);
    const newest = trimmed.length > 0 ? trimmed[trimmed.length - 1].t : undefined;
    const t = newest !== undefined && newest > nowSec ? newest : nowSec;

    return [...trimmed, { bps: currentBps, kind: 'now' as const, t }];
  }, [data, currentBps]);

  const refresh = useCallback(() => {
    // Invalidating an ACTIVE query already triggers exactly one refetch, so this
    // must not also call refetch() — that would double the request at the moment
    // we most want to be frugal. It also correctly no-ops when nothing is
    // mounted to observe the result.
    //
    // The underlying load is cheap to repeat: the API answers from Postgres (and
    // schedules its own bounded catch-up), and the sweep resumes from the cached
    // block range, so it covers only blocks since the last one.
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
