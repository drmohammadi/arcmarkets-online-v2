/**
 * `GET /api/trades` — every indexed Buy/Sell across all markets, out of Postgres.
 *
 * THIS REPLACES THE `eth_getLogs` SWEEP that `/profile` and `/leaderboard` paid
 * on every load. That sweep covered ~1.7M blocks with a 48-request budget and no
 * early stop (an aggregate cannot know whether the trader it needs is deeper in
 * history), so it spent its whole budget every time. The rows it was reconstructing
 * are already in `market_events`; this route just reads them.
 *
 * SAME CONTRACT AS THE CHART ROUTE, for the same reasons:
 *  - it never blocks on indexing, and starts a bounded catch-up it does not await;
 *  - a database failure is a 200 with `degraded: true`, NOT a 5xx, because
 *    `useTradeLedger` falls back to the RPC sweep on a non-OK response and a
 *    suspended Neon endpoint (the normal state on daily cron) must not look like
 *    an outage;
 *  - no SQL lives here. Every statement is in `lib/db/queries.ts`.
 *
 * WHAT IT DOES NOT SERVE, deliberately:
 *  - POSITION BALANCES. `PortfolioPanel` reads holdings from one `balanceOfBatch`
 *    and they are exact regardless of how far the index has reached. Serving them
 *    from SQL would make them LESS correct, and CLAUDE.md records that holdings
 *    render above the ledger tiles precisely because of that asymmetry.
 *  - PnL. `lib/ledger.ts` folds trades into lots in the browser and stays
 *    untouched, so the figures are identical to what the sweep produced. This
 *    route changes where the trades come from, not what is computed from them.
 *
 * AMOUNTS ARE STRINGS. `collateral` and `shares` are `numeric(78,0)` — uint256 on
 * chain. JSON numbers would silently corrupt them above 2^53, so they cross the
 * wire as decimal strings and the client calls `BigInt` on them.
 */

import { NextResponse } from 'next/server';
import { ensurePoolReachable } from '@/lib/db/pool';
import { readIndexerState, selectLedgerTrades } from '@/lib/db/queries';
import { scheduleBackgroundIndex } from '@/lib/indexer/background';
import { getIndexerConfig } from '@/lib/indexer/config';
import { blocksBehindOf, jsonNumber, readChainHead } from '@/lib/indexer/report';

/** `pg` speaks TCP, which the edge runtime has no sockets for. */
export const runtime = 'nodejs';

/** Trades change with every block; a build-time snapshot would be a lie. */
export const dynamic = 'force-dynamic';

/** Headroom for a Neon wake-up, matching the chart route. */
export const maxDuration = 30;

/**
 * Default rows. Matches `lib/logScan.ts`'s own `maxEvents` default of 5000, so a
 * warm index returns at least as much history as the sweep it replaces — anything
 * less would be a regression dressed as an optimization.
 */
const DEFAULT_LIMIT = 5000;

/**
 * Hard ceiling on rows an anonymous caller can ask for.
 *
 * API-abuse protection, not a correctness bound: without it one request could ask
 * for the whole table and make Neon serialize a multi-megabyte response on the
 * free tier. 20k is four times the default and far above any realistic trade
 * count on this chain.
 */
const MAX_LIMIT = 20_000;

/** A lowercase 0x address is 42 characters. */
const CACHE_OK = 'public, s-maxage=15, stale-while-revalidate=60';

/**
 * A degraded answer must not be cached: the next visitor arrives after Neon has
 * woken, and caching the empty result would extend one cold start across every
 * reader.
 */
const CACHE_NONE = 'no-store';

interface LedgerMeta {
  /** `indexer_state.backfill_complete`: is this chain's history whole yet? */
  complete: boolean;
  /** True when the row cap bound, so the caller must report partial coverage. */
  truncated: boolean;
  /** The anchored floor and the checkpoint: the range these trades come from. */
  fromBlock: number | string | null;
  toBlock: number | string | null;
  lastIndexedBlock: number | string | null;
  blocksBehind: number | null;
  /** Present ONLY when the database could not be read. */
  degraded?: true;
}

/**
 * Rows requested, clamped.
 *
 * Falls back rather than rejecting, like every other read knob here: a 400 over a
 * cosmetic query parameter would push the frontend onto its RPC sweep for no
 * reason.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const text = raw.trim();
  if (text.length === 0 || text.length > 6 || !/^[0-9]+$/.test(text)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return parsed > MAX_LIMIT ? MAX_LIMIT : parsed;
}

/**
 * An optional trader filter is deliberately NOT supported.
 *
 * Both consumers go through `useTradeStats`, which folds the whole ledger once
 * and answers both `statsFor(address)` and the leaderboard from that one result.
 * A server-side filter would serve the profile page and starve the leaderboard.
 * A per-trader endpoint, if ever wanted, belongs in its own route with its own
 * caller rather than as a parameter nothing sets.
 */
function jsonWith(body: unknown, status: number, cache: string): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': cache } });
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const limit = parseLimit(params.get('limit'));

  const meta: LedgerMeta = {
    complete: false,
    truncated: false,
    fromBlock: null,
    toBlock: null,
    lastIndexedBlock: null,
    blocksBehind: null,
  };

  try {
    // Inside the try: it throws when DATABASE_URL is unset, and never at module
    // scope — `next build` imports this file.
    const config = getIndexerConfig();
    await ensurePoolReachable();

    // Ask for one more than we will return, so truncation is observed rather
    // than inferred from a row count that happens to equal the limit.
    const headPromise = readChainHead(config.rpcUrl);
    const rows = await selectLedgerTrades({
      chainId: config.chainId,
      limit: limit + 1,
    });
    const state = await readIndexerState(config.chainId);
    const head = await headPromise;

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;

    const trades = kept.map((t) => ({
      blockNumber: t.blockNumber.toString(),
      logIndex: t.logIndex,
      fpmm: t.fpmm,
      questionId: t.questionId.toString(),
      trader: t.trader,
      side: t.side,
      outcome: t.outcome,
      collateral: t.collateral.toString(),
      shares: t.shares.toString(),
    }));

    const lastIndexedBlock = state?.lastIndexedBlock ?? null;
    const body = {
      trades,
      meta: {
        ...meta,
        // Truncation makes coverage partial even on a complete backfill: the
        // tail of history is missing from THIS response.
        complete: (state?.backfillComplete ?? false) && !truncated,
        truncated,
        fromBlock: state?.startBlock === undefined ? null : jsonNumber(state.startBlock),
        toBlock: lastIndexedBlock === null ? null : jsonNumber(lastIndexedBlock),
        lastIndexedBlock: lastIndexedBlock === null ? null : jsonNumber(lastIndexedBlock),
        blocksBehind: blocksBehindOf(head, lastIndexedBlock),
      },
    };

    /*
     * The traffic-triggered catch-up: after the response is built, before it is
     * returned, and NEVER awaited. Bounded, lease-serialized and idempotent, so
     * simultaneous visitors cannot double-index and no visitor can start an
     * unbounded scan. A missing state row counts as stale — that is a chain that
     * has never been indexed, which is exactly when a first run is wanted.
     */
    const nowSec = Math.floor(Date.now() / 1000);
    const lastTickSec =
      state?.lastTickAt instanceof Date ? Math.floor(state.lastTickAt.getTime() / 1000) : null;
    if (lastTickSec === null || nowSec - lastTickSec > config.staleSeconds) {
      try {
        scheduleBackgroundIndex({
          maxBlocks: config.trafficMaxBlocks,
          maxRequests: 6,
          reason: 'traffic',
        });
      } catch (err) {
        // Its own guard, so a scheduler hiccup cannot discard a response that is
        // already built and correct.
        console.error(
          '[trades] scheduling the catch-up failed:',
          err instanceof Error ? err.message : 'unknown error'
        );
      }
    }

    return jsonWith(body, 200, CACHE_OK);
  } catch (err) {
    /*
     * 200, not 5xx — see the header. The message is logged, never returned: it
     * can name a host or a statement, and this endpoint is public.
     */
    console.error(
      '[trades] serving from the index failed; degrading:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ trades: [], meta: { ...meta, degraded: true } }, 200, CACHE_NONE);
  }
}
