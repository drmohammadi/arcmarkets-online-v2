/**
 * `POST /api/indexer/tick` (and `GET`) — the cron entry point.
 *
 * GET AS WELL AS POST because Vercel Cron issues GET. Both do the same thing;
 * there is no read-only variant of a tick, and a cron platform that cannot be
 * told to POST would otherwise silently never run the indexer.
 *
 * AUTHENTICATION IS MANDATORY. `CRON_SECRET` absent is a **503**, never an
 * unauthenticated run: this endpoint spends RPC requests and Neon compute, and an
 * open one is a free way for anybody to burn both. The comparison is timing-safe
 * over SHA-256 digests, so it is constant-time AND leaks nothing about the
 * secret's length.
 *
 * THIS PATH MAY AWAIT. Only the user-facing chart route is forbidden from
 * waiting on indexing — cron has nothing to render and no user watching, so it
 * awaits `runIndexer` and returns the whole result for an operator to read.
 *
 * `runIndexer` never throws; it reports failure in `IndexRunResult.error`. So the
 * only shape below is "the run's own report", and the HTTP status is derived from
 * it rather than from an exception.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ensurePoolReachable } from '@/lib/db/pool';
import { getIndexerConfig } from '@/lib/indexer/config';
import { jsonNumber } from '@/lib/indexer/report';
import { runIndexer, type IndexRunResult } from '@/lib/indexer/run';

/** `pg` speaks TCP, which the edge runtime has no sockets for. */
export const runtime = 'nodejs';

/** A tick is an action, never a cached document. */
export const dynamic = 'force-dynamic';

/**
 * The Fluid-compute ceiling on Hobby and Pro's default. A cron tick walks up to
 * `INDEXER_CRON_MAX_BLOCKS` (4M by default) at ~250k blocks per `eth_getLogs`,
 * plus one `getBlock` per event-bearing block, and `LEASE_SECONDS.cron` is 300
 * to match: a lease that outlives the function it protects wedges the indexer,
 * and one that dies first lets a second run start alongside it.
 */
export const maxDuration = 300;

/**
 * Requests per tick. Bigger than the traffic path's 6 because cron is the
 * backfill's engine and has the whole 300s to spend, and it matches
 * `lib/indexer/rpc.ts:DEFAULT_MAX_REQUESTS` so there is one such number.
 */
const CRON_MAX_REQUESTS = 40;

const BEARER = 'Bearer ';

/** A fixed-width digest of a credential, so no comparison can leak its length. */
function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time `Authorization: Bearer <CRON_SECRET>` check.
 *
 * `timingSafeEqual` REJECTS buffers of different lengths, so a naive
 * implementation has to compare lengths first — which leaks the secret's length
 * and reintroduces the early exit the function exists to avoid. Hashing both
 * sides makes every comparison 32 bytes against 32 bytes: the length check can
 * never fail, and the digest of a wrong guess reveals nothing about the right
 * one.
 */
function bearerMatches(header: string | null, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith(BEARER)) return false;
  return timingSafeEqual(digestOf(header.slice(BEARER.length)), digestOf(secret));
}

/**
 * `IndexRunResult` as JSON, field by field.
 *
 * EVERY field is listed, and that is deliberate rather than lazy: `noProgress`,
 * `budgetStopped`, `checksumFailures` and `skippedBecauseLeased` are the signals
 * that distinguish a healthy run from a stuck one, and hand-picking "the
 * interesting fields" is exactly how a zero-progress run comes to look like a
 * successful one. `ranBlocks`/`fromBlock`/`toBlock` are `bigint` and would make
 * `JSON.stringify` throw, so they go through `jsonNumber` — never `Number`.
 */
function serializeResult(result: IndexRunResult) {
  return {
    ranBlocks: jsonNumber(result.ranBlocks),
    fromBlock: jsonNumber(result.fromBlock),
    toBlock: jsonNumber(result.toBlock),
    eventsInserted: result.eventsInserted,
    requests: result.requests,
    skippedBecauseLeased: result.skippedBecauseLeased,
    reorgDepth: result.reorgDepth,
    backfillComplete: result.backfillComplete,
    error: result.error,
    budgetStopped: result.budgetStopped,
    checksumFailures: result.checksumFailures,
    noProgress: result.noProgress,
  };
}

function jsonWith(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function tick(request: Request): Promise<NextResponse> {
  // Inside the handler, never at module scope: it throws without DATABASE_URL,
  // and `next build` imports this file.
  let config;
  try {
    config = getIndexerConfig();
  } catch (err) {
    console.error(
      '[indexer] tick refused: configuration is incomplete:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ error: 'the indexer is not configured on this deployment' }, 503);
  }

  const secret = config.cronSecret;
  if (!secret) {
    // 503, not 401 and certainly not a run: "no secret" is a deployment that is
    // not ready, and running anyway would make the endpoint public.
    console.error('[indexer] tick refused: CRON_SECRET is not set');
    return jsonWith({ error: 'the indexer is not configured on this deployment' }, 503);
  }

  if (!bearerMatches(request.headers.get('authorization'), secret)) {
    return jsonWith({ error: 'unauthorized' }, 401);
  }

  // Best effort, and its failure is deliberately NOT returned: `runIndexer` will
  // fail on its own first statement and report that failure in the shape the
  // caller already expects. Warming here only buys the cold-start retry.
  try {
    await ensurePoolReachable();
  } catch (err) {
    console.error(
      '[indexer] tick: the database was unreachable before the run:',
      err instanceof Error ? err.message : 'unknown error'
    );
  }

  const result = await runIndexer({
    maxBlocks: config.cronMaxBlocks,
    maxRequests: CRON_MAX_REQUESTS,
    reason: 'cron',
  });

  /*
   * 500 when the run FAILED, so a failed tick shows up as a failed invocation in
   * the platform's cron log instead of a 200 nobody reads. `budgetStopped` and
   * `skippedBecauseLeased` are NOT failures — history not fetched yet, and a
   * concurrent run, are both healthy states (`run.ts` property 5), and reporting
   * them as errors would make the dashboard warn about a working system.
   */
  return jsonWith(serializeResult(result), result.error === null ? 200 : 500);
}

export async function GET(request: Request): Promise<NextResponse> {
  return tick(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return tick(request);
}
