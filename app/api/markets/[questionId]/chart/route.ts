/**
 * `GET /api/markets/[questionId]/chart` — downsampled price history for one
 * market, out of Postgres.
 *
 * THIS ROUTE NEVER BLOCKS ON INDEXING. It reads what the index already holds and
 * responds; when the index looks stale it starts a bounded catch-up through
 * `scheduleBackgroundIndex` and does NOT await it. A user request must never
 * trigger an unbounded scan, and it must never wait for one either.
 *
 * A DATABASE FAILURE IS A 200 WITH `degraded: true`, NOT A 5xx. `useTradeHistory`
 * falls back to its RPC log sweep on a non-OK response, and that sweep is the
 * expensive, rate-limited path this whole feature exists to replace — so a chart
 * that quietly degrades to slow-but-working beats one that errors, and a
 * suspended Neon endpoint (the normal state on daily cron; see
 * `ensurePoolReachable`) must not look like an outage. The only 4xx here is a
 * malformed `questionId`, which is a caller bug rather than a service state.
 *
 * WHAT IS PLOTTED. `yes_bps` — the MARGINAL implied probability
 * `reserveNo / (reserveYes + reserveNo)` replayed per event by the indexer.
 * `exec_yes_bps` is stored but deliberately not served: mixing fee-inclusive
 * execution prices into a marginal-price series puts a fake jump of up to ±fee
 * at the right edge, which is the exact defect the old chart had.
 *
 * `outcome=1` returns `10000 - bps`. These markets are binary at every layer, so
 * NO is exactly the complement of YES — which is why the indexer stores one row
 * per event rather than two.
 *
 * NOTHING HERE TOUCHES SQL. Every statement lives in `lib/db/queries.ts`; this
 * module's job is to turn query parameters into validated integers and back into
 * JSON.
 */

import { NextResponse } from 'next/server';
import {
  clampLimit,
  intervalNameOf,
  parseFrom,
  parseIntervalName,
  resolveInterval,
} from '@/lib/chart/buckets';
import { ensurePoolReachable } from '@/lib/db/pool';
import { readIndexerState, selectChartRows } from '@/lib/db/queries';
import { scheduleBackgroundIndex } from '@/lib/indexer/background';
import { getIndexerConfig } from '@/lib/indexer/config';
import { blocksBehindOf, jsonNumber, readChainHead } from '@/lib/indexer/report';
import { BPS } from '@/lib/pricing';

/** `pg` speaks TCP, which the edge runtime has no sockets for. */
export const runtime = 'nodejs';

/** Price history changes with every trade; a build-time snapshot would be a lie. */
export const dynamic = 'force-dynamic';

/**
 * Headroom for a Neon wake-up, NOT a licence to be slow.
 *
 * `ensurePoolReachable` spends at most ~2 connect timeouts (about 20s) reaching a
 * suspended endpoint, and being killed at 14s mid-handshake would waste that
 * wait AND still degrade. The warm path is two point reads and returns in
 * milliseconds; this ceiling is only ever reached by the first visitor after a
 * suspension.
 */
export const maxDuration = 30;

/** `bigint`'s ceiling in Postgres: `markets.question_id` cannot exceed it. */
const MAX_QUESTION_ID = BigInt('9223372036854775807');

/** A defensive bound on the path segment before any parsing work happens. */
const MAX_ID_DIGITS = 19;

/** Enough digits for a unix second until the year 33658. */
const MAX_SECOND_DIGITS = 12;

/**
 * Cheap protection against many simultaneous readers of the same market, with no
 * Redis and no revalidation plumbing: 15s of shared cache, and a minute in which
 * a stale copy may be served while one request refreshes it. Short enough that a
 * fresh trade shows up on the next reload — and the LIVE final point comes from
 * the contract in the browser anyway, so the current price is never 15s stale.
 */
const CACHE_OK = 'public, s-maxage=15, stale-while-revalidate=60';

/**
 * A degraded or rejected response must NOT be cached: the next visitor arrives
 * after Neon has woken, and caching the empty answer would extend one cold start
 * across every reader for 15 seconds.
 */
const CACHE_NONE = 'no-store';

interface ChartMeta {
  questionId: number | string;
  outcome: 0 | 1;
  /** The width actually used, resolved from `auto`. Never the literal 'auto'. */
  interval: string;
  /** `indexer_state.backfill_complete`: is this chain's history whole yet? */
  complete: boolean;
  lastIndexedBlock: number | string | null;
  blocksBehind: number | null;
  /** Present ONLY when the database could not be read. */
  degraded?: true;
}

/**
 * The path segment as a question id, or null when it is not one.
 *
 * Validated before ANY database work, and bounded by the column's own type: an
 * id above `bigint` cannot exist in `markets`, so accepting it would buy a round
 * trip and a Postgres range error in exchange for nothing. The digit cap comes
 * first because `/^[0-9]+$/` on a megabyte of digits is work an anonymous caller
 * should not be able to ask for.
 */
function parseQuestionId(raw: string): bigint | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ID_DIGITS) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > MAX_QUESTION_ID ? null : id;
}

/** The window's upper bound: a unix second, or now. */
function parseTo(raw: string | null, nowSec: number): number {
  if (raw === null) return nowSec;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_SECOND_DIGITS || !/^[0-9]+$/.test(text)) return nowSec;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : nowSec;
}

function jsonWith(body: unknown, status: number, cache: string): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': cache } });
}

export async function GET(
  request: Request,
  context: { params: { questionId: string } }
): Promise<NextResponse> {
  const questionId = parseQuestionId(context.params.questionId);
  if (questionId === null) {
    return jsonWith(
      { error: 'questionId must be a non-negative integer' },
      400,
      CACHE_NONE
    );
  }

  const params = new URL(request.url).searchParams;
  /*
   * Every knob below FALLS BACK rather than rejecting, matching `parseFrom` and
   * `clampLimit`: this is a read with documented defaults, and a 400 over a
   * cosmetic query parameter would push the frontend onto its RPC sweep for no
   * reason. `outcome` follows the same rule — anything that is not '1' is YES.
   * The path parameter is the one exception above, because a question id has no
   * meaningful default.
   */
  const outcome: 0 | 1 = params.get('outcome') === '1' ? 1 : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = parseFrom(params.get('from'), nowSec);
  const toSec = parseTo(params.get('to'), nowSec);
  const limit = clampLimit(params.get('limit'));
  const stepSec = resolveInterval(
    parseIntervalName(params.get('interval')),
    toSec - fromSec,
    limit
  );

  const meta: ChartMeta = {
    questionId: jsonNumber(questionId),
    outcome,
    interval: intervalNameOf(stepSec),
    complete: false,
    lastIndexedBlock: null,
    blocksBehind: null,
  };

  try {
    // Inside the try: it throws when DATABASE_URL is unset, and never at module
    // scope — `next build` imports this file, and a missing env var must fail a
    // request rather than the build.
    const config = getIndexerConfig();
    await ensurePoolReachable();

    // The head read is not a database call, so it overlaps freely. The two
    // QUERIES are sequential on purpose: the pool holds at most 3 clients, and
    // racing them opens a second cold TLS handshake to Neon — the case that blew
    // the 10s connect timeout in Task 9's proof script. Two point reads on one
    // warm connection cost a round trip each.
    const headPromise = readChainHead(config.rpcUrl);
    const rows = await selectChartRows({
      chainId: config.chainId,
      questionId,
      fromSec,
      toSec,
      stepSec,
      limit,
    });
    const state = await readIndexerState(config.chainId);
    const head = await headPromise;

    const points = rows.map((row) => ({
      t: row.t,
      // Binary market: NO is exactly the complement of YES.
      bps: outcome === 1 ? BPS - row.bps : row.bps,
    }));

    const lastIndexedBlock = state?.lastIndexedBlock ?? null;
    const body = {
      points,
      meta: {
        ...meta,
        complete: state?.backfillComplete ?? false,
        lastIndexedBlock: lastIndexedBlock === null ? null : jsonNumber(lastIndexedBlock),
        blocksBehind: blocksBehindOf(head, lastIndexedBlock),
      },
    };

    /*
     * The traffic-triggered catch-up: after the response is built, before it is
     * returned, and NEVER awaited. Bounded by `trafficMaxBlocks` and a request
     * budget of 6, serialized against every other run by the Postgres lease, and
     * idempotent through `ON CONFLICT DO NOTHING` — so simultaneous visitors
     * cannot double-index and no visitor can start an unbounded scan.
     *
     * A missing state row (`lastTickAt === null`) counts as stale: that is a
     * chain that has never been indexed, which is precisely when a first run is
     * wanted. `runIndexer` bootstraps the row itself.
     */
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
        // already built and correct. Without this the outer catch would turn a
        // good chart into a degraded one.
        console.error(
          '[chart] scheduling the catch-up failed:',
          err instanceof Error ? err.message : 'unknown error'
        );
      }
    }

    return jsonWith(body, 200, CACHE_OK);
  } catch (err) {
    /*
     * 200, not 5xx — see the header. The message is logged, never returned: it
     * can name a host or a statement, and this endpoint is public.
     *
     * No catch-up is scheduled from here, deliberately. A background run's first
     * act is a write to the same database that just refused a read, so it would
     * fail too — and `ensurePoolReachable` has already asked Neon to wake, which
     * is the useful half of what a run would have done.
     */
    console.error(
      '[chart] serving from the index failed; degrading:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ points: [], meta: { ...meta, degraded: true } }, 200, CACHE_NONE);
  }
}
