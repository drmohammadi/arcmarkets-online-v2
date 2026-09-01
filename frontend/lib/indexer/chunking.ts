/**
 * Range-size policy for `eth_getLogs` sweeps: how to react to a refused range,
 * what to remember about the size that worked, and how to lay out a sweep.
 *
 * This is the server-side (indexer) counterpart of policy the browser code
 * already learned the hard way in `lib/rpcQueue.ts` and `lib/logScan.ts`. It is
 * deliberately PURE — no clock, no storage, no RPC — so the indexer's retry
 * behaviour is testable without a node, and so both consumers can share one
 * definition of "this failure means ask for less" instead of drifting apart.
 *
 * ZERO IMPORTS, deliberately (same constraint as `./replay.ts`). This module is
 * compiled both by the Next.js app (ESM, `@/` aliases) and by the Hardhat/mocha
 * suite in `contracts/` (CommonJS, no aliases) via a relative path. Any import
 * at all — viem, a node builtin, an `@/`-aliased sibling — breaks one of those
 * two consumers.
 *
 * ── THE THREE RULES, AND THE BUG BEHIND EACH ─────────────────────────────────
 *
 * 1. **A refused range is NOT a rate limit.** Arc testnet answers
 *    `-32012 requested range too large` (it refuses at 1,048,576 blocks).
 *    Backing off in time does nothing for it: the identical request will be
 *    refused again forever, and only asking for FEWER BLOCKS helps. A 429 is the
 *    opposite — the request was fine, there were too many of them, and splitting
 *    it into two makes things worse at the exact moment the endpoint asked for
 *    less traffic. Conflating the two is how the old chart burned its whole
 *    per-load request budget without advancing. `isRateLimit` here mirrors
 *    `lib/rpcQueue.ts:76-92` so the two never disagree about what a 429 is.
 *
 * 2. **The learned ceiling only ever RISES.** `lib/logCache.ts:220-241` paid for
 *    this: `eth_getLogs` can be refused for RESULT COUNT as well as for range
 *    width, so one unusually dense 250k-block range can be rejected at a size
 *    that is otherwise perfectly acceptable. Letting that lower a persisted
 *    ceiling would throttle every later scan of every pool, permanently, over a
 *    one-off. Halving inside a single sweep already handles the dense range with
 *    current information; the remembered value is for the endpoint's constant
 *    property, not for a moment's density.
 *
 * 3. **A plan is forward-only, contiguous and inclusive.** Every range is
 *    `[from, to]` with `from <= to`, ranges abut exactly (no gap, no overlap),
 *    and the last `to` is clamped at the requested `to` so a sweep never queries
 *    past the head it was given. A gap would be worse than a short plan: the
 *    caller records what it covered, so a hole becomes permanent silent data
 *    loss rather than work still to do.
 */

/** An inclusive block range, `from <= to`. */
export interface BlockRange {
  from: bigint;
  to: bigint;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/**
 * Backoff ladder for rate limits, in ms; its length also caps the retry count.
 *
 * Kept numerically identical to `lib/rpcQueue.ts:46`. The browser and the
 * indexer talk to the same endpoint, so a different ladder here would mean two
 * components disagreeing about how hard to push the same rate limit.
 */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * How many `cause`/`error` links to follow.
 *
 * Bounded because these predicates must be TOTAL — never throw, whatever they
 * are handed. A cyclic cause chain (`a.cause = b; b.cause = a`) would otherwise
 * recurse until the stack overflows, and a RangeError thrown out of error
 * CLASSIFICATION would turn a retryable failure into a crashed indexer run.
 * Real wrappers nest two or three deep; five is slack.
 */
const MAX_CAUSE_DEPTH = 5;

/** Lower-cased text of every message-ish field, or '' — never throws. */
function messageOf(err: unknown): string {
  try {
    if (typeof err === 'string') return err.toLowerCase();
    if (!err || typeof err !== 'object') return '';
    const rec = err as Record<string, unknown>;
    const parts: string[] = [];
    // `message` covers Error and plain objects; the other two are viem's, where
    // the RPC's own text often lives in `details` rather than `message`.
    for (const key of ['message', 'shortMessage', 'details']) {
      const value = rec[key];
      if (typeof value === 'string') parts.push(value);
    }
    return parts.join(' ').toLowerCase();
  } catch {
    // A getter that throws (exotic proxy, revoked object) must not take the run
    // down: an unclassifiable error is simply "not this kind of error".
    return '';
  }
}

/** True when any numeric code field on `err` equals one of `codes`. */
function hasCode(err: unknown, codes: readonly number[]): boolean {
  try {
    if (!err || typeof err !== 'object') return false;
    const rec = err as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'code']) {
      const value = rec[key];
      if (typeof value === 'number' && codes.indexOf(value) !== -1) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Test `err` and its wrapped causes, depth-bounded.
 *
 * Recursion is load-bearing, not defensive: viem wraps a transport failure
 * several layers deep, so the HTTP 429 that matters is routinely only visible as
 * `err.cause.status`. `error` is followed as well as `cause` because JSON-RPC
 * clients commonly hang the server's payload there.
 */
function chainHas(err: unknown, test: (e: unknown) => boolean, depth = 0): boolean {
  if (test(err)) return true;
  if (depth >= MAX_CAUSE_DEPTH || !err || typeof err !== 'object') return false;

  const rec = err as Record<string, unknown>;
  for (const key of ['cause', 'error']) {
    let nested: unknown;
    try {
      nested = rec[key];
    } catch {
      continue;
    }
    if (!nested || nested === err) continue;
    if (chainHas(nested, test, depth + 1)) return true;
  }
  return false;
}

/**
 * Detect "your block range is too wide / returned too many results".
 *
 * MUST be disjoint from `isRateLimit` for the values either one recognizes: the
 * only useful response to this is a NARROWER range, and the only useful response
 * to a 429 is a LATER request. A caller that gets both wrong at once retries the
 * same refused range until its budget is gone.
 *
 * Broad on substrings because endpoints word this differently (`-32012` on Arc,
 * "query returned more than N results" on others) and a missed range refusal
 * means the sweep stops at its first dense chunk instead of subdividing.
 */
export function isRangeTooLarge(err: unknown): boolean {
  return chainHas(err, (e) => {
    // -32012 is Arc's; -32701 is seen from some Geth-family gateways.
    if (hasCode(e, [-32012, -32701])) return true;
    const msg = messageOf(e);
    if (!msg) return false;
    return (
      msg.includes('range too large') ||
      msg.includes('range is too large') ||
      msg.includes('range too wide') ||
      msg.includes('requested range') ||
      msg.includes('too many blocks') ||
      msg.includes('returned more than') ||
      msg.includes('response size exceeded') ||
      msg.includes('query timeout exceeded') ||
      msg.includes('block range')
    );
  });
}

/**
 * Detect a rate-limit rejection. Kept behaviourally identical to
 * `lib/rpcQueue.ts:76-92`, extended only to accept a bare string and to walk a
 * bounded chain, so the indexer and the browser back off on the same signals.
 *
 * Note what is NOT here: nothing about ranges or result counts. -32005 ("limit
 * exceeded") is a request-rate signal; a range refusal reports -32012 instead.
 */
export function isRateLimit(err: unknown): boolean {
  return chainHas(err, (e) => {
    if (hasCode(e, [429, -32005])) return true;
    const msg = messageOf(e);
    if (!msg) return false;
    return (
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('rate limit') ||
      msg.includes('limit exceeded')
    );
  });
}

/**
 * The next size to try after a range of `span` blocks was refused, or null when
 * subdividing is no longer worth it.
 *
 * Returning null is a real answer, not an error: at some point the range is so
 * narrow that the refusal cannot be about width, and halving further just spends
 * requests to be refused again. The caller should then treat the chunk as failed
 * and stop that direction — the same decision `logScan.ts:264` makes.
 *
 * Floor division matches the halving in `lib/logScan.ts:263`, so an odd span
 * yields a slightly smaller lower half rather than overshooting.
 */
export function halve(span: bigint, minChunk: bigint): bigint | null {
  if (span <= ONE) return null;
  const floor = minChunk > ONE ? minChunk : ONE;
  const half = span / TWO;
  if (half < floor) return null;
  return half;
}

/**
 * Fold an accepted range size into the remembered ceiling. MONOTONIC: it only
 * ever raises (see rule 2 at the top of this file, and `logCache.ts:220-241`).
 *
 * `accepted` is expected to be a span the endpoint actually served at full
 * requested size. A non-positive value carries no information, so it is ignored;
 * with no prior ceiling that leaves ONE, because every caller uses the result as
 * a loop step and a zero step is an infinite loop issuing invalid queries — the
 * same clamp as `logScan.ts:213`.
 */
export function nextChunkCeiling(current: bigint | null, accepted: bigint): bigint {
  if (accepted <= ZERO) {
    if (current === null) return ONE;
    return current > ZERO ? current : ONE;
  }
  if (current === null || current < accepted) return accepted;
  return current;
}

/**
 * Lay out an inclusive, contiguous, ascending sweep of `[from, to]` in steps of
 * `chunk`, at most `maxRequests` ranges.
 *
 * Guarantees, each one a thing a caller would otherwise get wrong:
 *  - **No inverted or empty range.** `to < from` yields `[]` rather than a
 *    single backwards query the node would reject.
 *  - **Inclusive bounds**, so a single-block sweep is `{from: n, to: n}` and
 *    consecutive ranges abut at `prev.to + 1` with no block queried twice.
 *  - **The tail is clamped at `to`**, never extended past it. Querying above the
 *    known head invites a different error class for no coverage gained.
 *  - **Capped at `maxRequests`.** The plan is then a PREFIX of the full sweep:
 *    contiguous from `from`, just stopping early. The caller resumes at
 *    `last.to + 1`, which is why stopping short must never be disguised as
 *    completion (`budgetStopped` vs `incomplete` in `logScan.ts:126-162`).
 *
 * `chunk` is clamped to at least one block for the loop-step reason above, and a
 * negative `from` is clamped to block 0; both are impossible inputs on-chain, and
 * silently correcting them beats emitting a plan no node will answer.
 */
export function planRanges(
  from: bigint,
  to: bigint,
  chunk: bigint,
  maxRequests: number
): BlockRange[] {
  const out: BlockRange[] = [];
  if (!Number.isFinite(maxRequests) || maxRequests < 1) return out;

  const start = from < ZERO ? ZERO : from;
  if (to < start) return out;

  const step = chunk > ZERO ? chunk : ONE;
  const cap = Math.floor(maxRequests);

  let cursor = start;
  while (cursor <= to && out.length < cap) {
    const end = cursor + step - ONE;
    out.push({ from: cursor, to: end > to ? to : end });
    cursor = end + ONE;
  }
  return out;
}
