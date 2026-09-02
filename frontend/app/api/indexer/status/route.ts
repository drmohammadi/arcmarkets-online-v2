/**
 * `GET /api/indexer/status` — is the index healthy, and how far behind is it?
 *
 * NO AUTHENTICATION, on purpose. It returns block numbers, a checkpoint, a lease
 * state and the last error — no secret, nothing that costs money to serve, and
 * nothing an attacker learns from that the chain does not already publish. Being
 * able to check health without a token is the point: a status endpoint you need a
 * credential for is one nobody checks.
 *
 * IT DOES NOT INDEX. Reading status must never start work; that is the tick
 * route's job and the chart route's stale-catch-up. A health check that mutates
 * the thing it measures is how "checking the dashboard" becomes the reason the
 * quota is gone.
 *
 * EVERY STRING HERE IS UNTRUSTED TO A RENDERER. `lastError` is server-generated
 * text that can quote a Postgres or RPC message, and this response is JSON rather
 * than HTML — so a consumer that renders it must sanitize it (`lib/sanitize.ts`),
 * exactly as it must for `markets.question`. Storing a string in Postgres does
 * not launder it, and neither does returning it from a route handler.
 */

import { NextResponse } from 'next/server';
import { ensurePoolReachable } from '@/lib/db/pool';
import { readIndexerState } from '@/lib/db/queries';
import { getIndexerConfig } from '@/lib/indexer/config';
import { blocksBehindOf, jsonNumber, readChainHead } from '@/lib/indexer/report';

/** `pg` speaks TCP, which the edge runtime has no sockets for. */
export const runtime = 'nodejs';

/** A health report is never a cached document. */
export const dynamic = 'force-dynamic';

/** Headroom for a Neon wake-up; see the chart route's identical ceiling. */
export const maxDuration = 30;

/**
 * Slack above `confirmations` before "behind" stops meaning "healthy".
 *
 * `confirmations` (12) is the finality window the indexer deliberately leaves
 * unindexed, so the checkpoint is ALWAYS at least that far back and a threshold
 * of exactly `confirmations` would report a perfectly caught-up chain as unwell.
 * The 50 blocks on top absorb the gap between the head read here and the head the
 * last run saw — Arc produces blocks quickly, and a status endpoint that flickers
 * is one people learn to ignore.
 */
const HEALTHY_SLACK_BLOCKS = 50;

/**
 * How old a successful tick may be before the indexer is `stalled`: 48 hours,
 * twice the daily cron interval.
 *
 * Twice, so ONE missed run is not an alarm. Daily cron is a deliberate choice
 * (per-minute cron keeps Neon's compute awake and exhausts the free tier's
 * monthly CU-hours, which suspends the database for the rest of the billing
 * month), and the chart's live final point comes from the contract, so a day of
 * lag degrades history alone.
 */
const STALE_TICK_SECONDS = 48 * 3600;

type IndexerStatus = 'healthy' | 'syncing' | 'degraded' | 'stalled';

/**
 * WORST-FIRST PRECEDENCE, because these conditions overlap constantly and the
 * one an operator needs to see is the most serious.
 *
 *  - `stalled` outranks everything: nothing has ticked for two cron intervals, so
 *    every other field is describing a snapshot that stopped moving.
 *  - `degraded` next. `last_error` carries genuine failures AND the notes
 *    `run.ts` writes for a reorg, replay checksum drift, and — the reason it must
 *    outrank `syncing` — a run that had a range to cover and moved the checkpoint
 *    ZERO blocks (`IndexRunResult.noProgress`). That signal has no column of its
 *    own, so `last_error` is its only durable channel; the per-run boolean is
 *    returned by `/api/indexer/tick`. A stuck indexer must not read as a busy one.
 *  - `syncing` while the backfill is incomplete, or while the index is further
 *    behind than the slack allows. A chain with no state row at all lands here
 *    too, which is right: never indexed is the start of syncing, not a fault.
 *  - `healthy` only with a whole backfill, no error, a recent tick and a small
 *    gap. An unreadable chain head does not by itself make the index unhealthy —
 *    `latestBlockchainBlock: null` is the visible caveat.
 */
function statusOf(args: {
  lastError: string | null;
  backfillComplete: boolean;
  blocksBehind: number | null;
  lastTickAt: Date | null;
  confirmations: number;
  nowMs: number;
}): IndexerStatus {
  const { lastTickAt, nowMs } = args;
  if (lastTickAt !== null && nowMs - lastTickAt.getTime() > STALE_TICK_SECONDS * 1000) {
    return 'stalled';
  }
  if (args.lastError !== null) return 'degraded';
  if (!args.backfillComplete) return 'syncing';
  const slack = Math.max(0, Math.floor(args.confirmations)) + HEALTHY_SLACK_BLOCKS;
  if (args.blocksBehind === null || args.blocksBehind <= slack) return 'healthy';
  return 'syncing';
}

export async function GET(): Promise<NextResponse> {
  const headers = { 'Cache-Control': 'no-store' };

  // Inside the handler, never at module scope: it throws without DATABASE_URL,
  // and `next build` imports this file.
  let config;
  try {
    config = getIndexerConfig();
  } catch (err) {
    console.error(
      '[indexer] status: configuration is incomplete:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'the indexer is not configured on this deployment', status: 'degraded' },
      { status: 503, headers }
    );
  }

  // The head read is not a database call and never rejects, so it overlaps the
  // connect and the query freely.
  const headPromise = readChainHead(config.rpcUrl);

  let state;
  try {
    await ensurePoolReachable();
    state = await readIndexerState(config.chainId);
  } catch (err) {
    // 503 on a health endpoint is the correct answer to "the store this reports
    // on is unreachable" — unlike the chart route, there is nothing to degrade
    // to. The detail is logged rather than returned: a `pg` connect error can
    // name the Neon host, and this endpoint is public.
    console.error(
      '[indexer] status: the index database is unreachable:',
      err instanceof Error ? err.message : 'unknown error'
    );
    const head = await headPromise;
    return NextResponse.json(
      {
        latestBlockchainBlock: head === null ? null : jsonNumber(head),
        latestIndexedBlock: null,
        blocksBehind: null,
        status: 'degraded' satisfies IndexerStatus,
        backfillComplete: false,
        lastTickAt: null,
        leaseHeld: false,
        lastError: 'the index database could not be read',
        chainId: config.chainId,
      },
      { status: 503, headers }
    );
  }

  const head = await headPromise;
  const nowMs = Date.now();
  const lastIndexed = state?.lastIndexedBlock ?? null;
  const lastError = state?.lastError ?? null;
  const lastTickAt = state?.lastTickAt ?? null;
  const backfillComplete = state?.backfillComplete ?? false;
  const blocksBehind = blocksBehindOf(head, lastIndexed);
  const acceptedChunk = state?.acceptedChunk ?? null;

  return NextResponse.json(
    {
      latestBlockchainBlock: head === null ? null : jsonNumber(head),
      latestIndexedBlock: lastIndexed === null ? null : jsonNumber(lastIndexed),
      blocksBehind,
      status: statusOf({
        lastError,
        backfillComplete,
        blocksBehind,
        lastTickAt,
        confirmations: config.confirmations,
        nowMs,
      }),
      backfillComplete,
      lastTickAt: lastTickAt === null ? null : lastTickAt.toISOString(),
      // A lease row that has EXPIRED is not held: expiry by itself is the whole
      // reason this is a lease and not an advisory lock, so reporting a dead
      // run's leftover row as "held" would misdiagnose the state it exists to
      // make visible.
      leaseHeld: state?.leaseUntil instanceof Date && state.leaseUntil.getTime() > nowMs,
      lastError,
      // Diagnostics beyond the required shape. `leaseOwner` names the KIND of run
      // holding the lease (`run.ts:leaseOwner` builds it from the reason), which
      // is the difference between "cron is mid-backfill" and "every visitor is
      // triggering a catch-up".
      chainId: config.chainId,
      confirmations: config.confirmations,
      startBlock: state === null ? null : jsonNumber(state.startBlock),
      acceptedChunk: acceptedChunk === null ? null : jsonNumber(acceptedChunk),
      leaseUntil: state?.leaseUntil instanceof Date ? state.leaseUntil.toISOString() : null,
      leaseOwner: state?.leaseOwner ?? null,
    },
    { status: 200, headers }
  );
}
