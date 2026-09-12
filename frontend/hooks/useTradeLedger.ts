'use client';

/**
 * Every market's Buy/Sell trades, shared by the profile page and the leaderboard.
 *
 * ── THE TRADES NOW COME FROM THE INDEXER, NOT FROM `eth_getLogs` ─────────────
 * `GET /api/trades` serves them out of `market_events`, the same table the price
 * chart reads. That table already stores `actor`, `outcome`, `collateral`,
 * `shares`, `question_id` and `fpmm` per event, which is exactly what
 * `lib/ledger.ts` needs — so this needed no second indexer and no schema change,
 * only a query.
 *
 * WHAT THIS REPLACED, and why it had to go. The sweep below covered ~1.7M blocks
 * (Arc testnet's head is past 57,000,000 while the factory sits at 55,632,013)
 * on a 48-request budget, and — unlike the chart — it deliberately had NO early
 * stop, because an aggregate cannot know whether the trader or position it needs
 * lies deeper in history. So it spent its entire budget on every single load of
 * /profile and /leaderboard. Server-side that work is paid once for all visitors.
 *
 * ── WHAT IS *NOT* SERVED FROM THE DATABASE, DELIBERATELY ─────────────────────
 * POSITION BALANCES stay on RPC. `PortfolioPanel` reads holdings from one
 * `balanceOfBatch` call and they are exact regardless of how far the index has
 * reached, whereas anything ledger-derived is only as complete as the sweep
 * behind it. CLAUDE.md records that holdings render ABOVE the PnL tiles for that
 * reason; serving them from SQL would make them less correct, not faster.
 *
 * PnL AND VOLUME are still computed in the browser by `lib/ledger.ts`, unchanged.
 * This hook changed where the trades come from, not what is computed from them,
 * so the figures are identical to what the sweep produced. `lib/ledger.ts`'s
 * execution-price definition does NOT flip NO trades to the YES side and must
 * stay distinct from the chart's marginal price — see the note at the top of that
 * file. Reimplementing the lot-matching fold in SQL would have duplicated a
 * subtle accounting model in two languages for no gain.
 *
 * ── THE SWEEP BELOW IS A PERMANENT FALLBACK, NOT DEAD CODE ───────────────────
 * `NEXT_PUBLIC_CHART_SOURCE` picks the path: `api` (default), `rpc`, or `auto`
 * (the API, then the sweep if it fails). One flag governs both indexer-backed
 * reads so there is a single rollback lever. Neon's free tier suspends on quota
 * and the daily cron lets it sleep, so a leaderboard that degrades to
 * slow-but-working beats one that shows nothing. Do not delete `loadLedger`,
 * `sweepLogs`, `toTrade` or the event definitions.
 *
 * ── NEVER FAILS VISIBLY ──────────────────────────────────────────────────────
 * This hook does not surface errors. A failed read returns whatever it has and
 * sets `partial`, which the pages label. A truncated leaderboard is honest; an
 * empty one that reads as "nobody has traded" is not — that was the original bug
 * and the reason `partial` exists.
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
 * Which path runs, fixed at build time.
 *
 * A LITERAL `process.env.NEXT_PUBLIC_CHART_SOURCE` access, never a computed one.
 * Next inlines only static property accesses; anything else reaches the browser
 * as `undefined` and this would silently pin itself to the default forever.
 * `lib/links.ts:15` documents the same trap.
 */
const LEDGER_SOURCE: 'api' | 'rpc' | 'auto' =
  process.env.NEXT_PUBLIC_CHART_SOURCE === 'rpc'
    ? 'rpc'
    : process.env.NEXT_PUBLIC_CHART_SOURCE === 'auto'
      ? 'auto'
      : 'api';

/**
 * Rows asked of the API.
 *
 * Matches `lib/logScan.ts`'s own `maxEvents` default, so the indexed path returns
 * at least as much history as the sweep it replaces.
 */
const API_LIMIT = 5000;


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
  /**
   * Trades from the API, already carrying their `questionId` from the database.
   *
   * `null` means the API path did not produce them — either it was skipped or it
   * failed — and `events` below is the source instead. The two are kept separate
   * rather than merged because the RPC path has no questionId and must be joined
   * against the caller's market list, which is NOT part of the query key.
   */
  trades: LedgerTrade[] | null;
  events: CachedEvent[];
  /** True when a range could not be read, so coverage has a hole. */
  incomplete: boolean;
  /** True when the sweep reached block 0 — nothing older exists to find. */
  reachedFloor: boolean;
  /** Blocks actually covered, for an honest "covers the last N blocks" note. */
  covered: bigint;
}

/** The subset of `/api/trades` this hook relies on. */
interface ApiTrade {
  blockNumber: string;
  logIndex: number;
  fpmm: string;
  questionId: string;
  trader: string;
  side: 'buy' | 'sell';
  outcome: 0 | 1;
  collateral: string;
  shares: string;
}

const EMPTY_LEDGER: LedgerData = {
  trades: null,
  events: [],
  incomplete: false,
  reachedFloor: false,
  covered: BigInt(0),
};


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

  /*
   * The indexed path needs neither a client nor a non-empty market list, so it
   * stays enabled where the sweep could not run at all. That is a real
   * behavioural gain rather than a technicality: on a cold load `useMarketsData`
   * has not resolved yet, `addresses` is empty, and the old hook sat disabled
   * until it did.
   */
  const enabled = LEDGER_SOURCE !== 'rpc' || (!!client && addresses.length > 0);


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
      /*
       * The API path first, and it does NOT need a wallet client or the market
       * address list — the database already joins `question_id` onto every row.
       * So it runs even when `addresses` is empty, which the sweep cannot do.
       */
      if (LEDGER_SOURCE !== 'rpc') {
        const fromApi = await loadLedgerFromApi();
        if (fromApi) return fromApi;
        // `api` is strict: no silent fall-through to the expensive path. Only
        // `auto` degrades, and only after the API has actually failed.
        if (LEDGER_SOURCE === 'api') {
          return { ...EMPTY_LEDGER, incomplete: true };
        }
      }

      if (!client || addresses.length === 0) return EMPTY_LEDGER;
      return loadLedger(client, chainId, addresses, addressKey);
    },
  });

  const trades = useMemo(() => {
    // The API already carries `questionId` per row, so its trades are used as
    // they are. Only the sweep's raw events need the fpmm -> questionId join.
    if (data?.trades) return data.trades;

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

/**
 * Read trades from `/api/trades`.
 *
 * Returns `null` when the indexed path could not serve them, which is the signal
 * for `auto` to fall back to the sweep. Total: never throws.
 *
 * `degraded: true` in the response means the API reached us but Postgres did not
 * answer it, so it counts as a failure here even though the HTTP status was 200 —
 * that route deliberately degrades rather than 5xx'ing, and treating its 200 as
 * success would strand the caller with an empty leaderboard.
 */
async function loadLedgerFromApi(): Promise<LedgerData | null> {
  try {
    const res = await fetch(`/api/trades?limit=${API_LIMIT}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;

    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return null;

    const meta = (body as { meta?: unknown }).meta;
    const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    if (metaObj.degraded === true) return null;

    const raw = (body as { trades?: unknown }).trades;
    if (!Array.isArray(raw)) return null;

    const trades: LedgerTrade[] = [];
    for (const item of raw) {
      const trade = fromApiTrade(item);
      if (trade) trades.push(trade);
    }

    /*
     * Coverage comes from the INDEX's own range, not from a browser sweep: the
     * anchored floor through the checkpoint. That is strictly more honest than
     * what the sweep could report, which was only the window one tab had managed
     * to crawl.
     */
    const fromBlock = toBig(metaObj.fromBlock);
    const toBlock = toBig(metaObj.toBlock);
    const covered =
      fromBlock !== null && toBlock !== null && toBlock >= fromBlock
        ? toBlock - fromBlock + BigInt(1)
        : BigInt(0);

    return {
      trades,
      events: [],
      // `truncated` is the row cap binding, which leaves the tail of history out
      // of this response — the same fact `partial` has always described.
      incomplete: metaObj.truncated === true,
      reachedFloor: metaObj.complete === true,
      covered,
    };
  } catch {
    return null;
  }
}

/** One API row into a `LedgerTrade`, or null when it is not usable. */
function fromApiTrade(item: unknown): LedgerTrade | null {
  try {
    if (!item || typeof item !== 'object') return null;
    const t = item as Partial<ApiTrade>;

    const fpmm = safeAddress(t.fpmm);
    const trader = safeAddress(t.trader);
    if (!fpmm || !trader) return null;
    if (t.side !== 'buy' && t.side !== 'sell') return null;
    if (t.outcome !== 0 && t.outcome !== 1) return null;
    if (typeof t.blockNumber !== 'string' || typeof t.questionId !== 'string') return null;
    if (typeof t.logIndex !== 'number' || !Number.isSafeInteger(t.logIndex)) return null;
    if (typeof t.collateral !== 'string' || typeof t.shares !== 'string') return null;

    const collateral = BigInt(t.collateral);
    const shares = BigInt(t.shares);
    // The same guard the sweep applies: a zero-amount fill has no price and
    // would divide by zero in `lib/ledger.ts`.
    if (collateral <= BigInt(0) || shares <= BigInt(0)) return null;

    return {
      blockNumber: BigInt(t.blockNumber),
      logIndex: t.logIndex,
      fpmm,
      questionId: BigInt(t.questionId),
      trader,
      side: t.side,
      outcome: t.outcome,
      collateral,
      shares,
    };
  } catch {
    // BigInt() throws on a non-numeric string; one bad row must not lose the rest.
    return null;
  }
}

/** A JSON block number — a number when it fits one, else a decimal string. */
function toBig(value: unknown): bigint | null {
  try {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

/** Decode one cached event into a ledger trade, or null if it is unusable. */
function toTrade(ev: CachedEvent, byFpmm: Map<string, bigint>): LedgerTrade | null {  try {
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
    return { ...EMPTY_LEDGER, incomplete: true };
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
    // Null, not an empty array: the sweep produces raw events and the caller must
    // join them against its market list. An empty array here would read as
    // "the API returned no trades" and skip that join.
    trades: null,
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
