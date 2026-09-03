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
 *    per-load request budget without advancing. Because the two predicates below
 *    can both fire on one message, `classifyRpcError` — not the booleans — is the
 *    entry point callers should use; it fixes the precedence once, here.
 *
 *    `isRateLimit` is DERIVED FROM `lib/rpcQueue.ts:76-92`, not a mirror of it and
 *    no longer a superset either. It adds inputs that one does not look at (a bare
 *    string, `statusCode`, viem's `shortMessage`/`details`, the `error` link as
 *    well as `cause`), and it has one KNOWN INTENTIONAL DIVERGENCE: this file
 *    matches `429` on a word boundary, while `rpcQueue.ts:87` still uses a bare
 *    `msg.includes('429')` and therefore still calls
 *    `"requested range too large: 55429000..55700000"` a rate limit in the browser
 *    path. So the drift is BIDIRECTIONAL and deliberate on this side. It is also
 *    unpinned: `rpcQueue`'s predicate and ladder are non-exported module state and
 *    the zero-import rule forbids reading them from here, so nothing in this
 *    module's tests notices a change made over there. Inconvenient, not
 *    impossible — the TEST file has no zero-import rule and could read
 *    `rpcQueue.ts` as text. Until something does, changing one side means
 *    reviewing the other by hand.
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
 * Numerically identical to `lib/rpcQueue.ts:46` — copied, not shared, because
 * this module may not import. Nothing pins the two together: the ladder there is a
 * non-exported `const`, so the test that pins these four numbers cannot see a
 * change made on that side. That is inconvenient rather than impossible (the test
 * file could read `rpcQueue.ts` as text and parse the ladder out), but until
 * something does, edit both by hand together.
 */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * Smallest chunk width any policy here will hand back: 1000 blocks, the same
 * floor as `logScan.ts:193`'s `minChunk` default, so there is ONE floor in the
 * codebase rather than one per module.
 *
 * A floor is not politeness, it is the difference between a backfill that
 * finishes and one that never does. Every caller uses a ceiling as a loop STEP,
 * and the fold in `nextChunkCeiling` only ever raises — so a ceiling of 1 block
 * can only rise if some caller probes ABOVE its own ceiling. A caller that
 * simply steps by it requests one block, succeeds, re-learns 1, and covers
 * `maxRequests` blocks per run against a 1.7M-block history: the silent,
 * progressive emptiness `CLAUDE.md` warns about twice.
 *
 * `logCache.ts:233` avoids the same trap differently — it declines to store
 * a non-positive value at all, leaving the ceiling UNKNOWN so the next sweep
 * uses its own default. A non-nullable `bigint` return cannot express "unknown",
 * so a stated floor is the closest faithful equivalent.
 */
export const MIN_CHUNK: bigint = BigInt(1000);

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
 * Read this as a REMEDY class, not as a wire message: everything it matches is
 * fixed by asking for FEWER BLOCKS. `query timeout exceeded` is here for that
 * reason — the endpoint did not refuse the shape of the query, it failed to serve
 * the WIDTH of it, and a narrower range is the only thing that helps. (Nothing in
 * the ladder above will: waiting re-runs the same expensive query.) The accurate
 * name would be `shouldNarrowRange`; the name is fixed by the interface Task 5
 * consumes, so the meaning lives in this comment instead.
 *
 * Deliberately broad on substrings because endpoints word the cap differently
 * (`-32012` on Arc, "query returned more than N results" on Infura, "Log
 * response size exceeded … up to a 500 block range" on Alchemy) and a MISSED
 * range refusal stops the sweep dead at its first dense chunk instead of
 * subdividing it.
 *
 * Not disjoint from `isRateLimit` for every input, and it cannot be made so
 * without narrowing one of them: `{code: -32005, message: "query returned more
 * than 10000 results"}` is a real Alchemy/Infura shape that satisfies both. That
 * is what `classifyRpcError` exists to settle — use it rather than calling these
 * two in an order you have to remember.
 *
 * @remarks Answers ONE question in isolation: "would a narrower range help?"
 * Anything dispatching on error KIND must call `classifyRpcError` instead, because
 * this and `isRateLimit` overlap and the order in which you ask decides the
 * outcome. Direct use is legitimate when you genuinely only need this one bit.
 */
export function isRangeTooLarge(err: unknown): boolean {
  return chainHas(err, (e) => {
    // -32012 is Arc's. No other code is listed: the `-32701` this file used to
    // accept has no basis in Geth's or Arc's documented error sets, so it was
    // dropped rather than left as folklore.
    if (hasCode(e, [-32012])) return true;
    const msg = messageOf(e);
    if (!msg) return false;
    // `requested range` used to be in this list and was removed: Arc's own
    // message already matches `range too large`, so its only unique catches were
    // "requested range start is before the pruned block"-style errors — pointless
    // halving with no compensating detection.
    return (
      msg.includes('range too large') ||
      msg.includes('range is too large') ||
      msg.includes('range too wide') ||
      msg.includes('too many blocks') ||
      msg.includes('returned more than') ||
      msg.includes('response size exceeded') ||
      msg.includes('query timeout exceeded') ||
      // Kept knowingly loose: Alchemy/QuickNode state the cap as "up to a 500
      // block range", which none of the phrases above catch. It also matches
      // pruned-node and malformed-parameter wording ("invalid block range"),
      // where halving cannot help — but that costs a BOUNDED handful of requests
      // (log2 of the span down to MIN_CHUNK) before the chunk is reported failed,
      // whereas a missed cap stalls the whole sweep. Accepted with eyes open.
      msg.includes('block range')
    );
  });
}

/**
 * Detect a rate-limit rejection: the request was fine, there were too many.
 *
 * Derived from `lib/rpcQueue.ts:76-92` — see rule 1 at the top for what it adds
 * (bare strings, `statusCode`, viem's `shortMessage`/`details`, the `error` link)
 * and for the one intentional divergence: the `\b429\b` word-boundary match, which
 * `rpcQueue.ts:87` does not have.
 *
 * THIS AND `isRangeTooLarge` CAN BOTH BE TRUE FOR THE SAME ERROR, and that is not
 * a bug to fix here. `-32005` is a rate-limit code at some providers and a
 * RESULT-COUNT refusal at others — Alchemy/Infura send
 * `{code: -32005, message: "query returned more than 10000 results"}`, which this
 * function reports as a rate limit (correctly, by code) and `isRangeTooLarge`
 * reports as a range refusal (correctly, by message). The same goes for wording
 * like "block range limit exceeded", which matches `limit exceeded` here.
 *
 * @remarks Answers ONE question in isolation: "is backing off a plausible remedy?"
 * It does not tell you what KIND of failure this is. Anything dispatching on kind
 * — retry versus narrow versus give up — must call `classifyRpcError`, which fixes
 * the precedence (range-first) that the overlap above makes load-bearing. Direct
 * use is legitimate when you genuinely only need this one bit.
 */
export function isRateLimit(err: unknown): boolean {
  return chainHas(err, (e) => {
    if (hasCode(e, [429, -32005])) return true;
    const msg = messageOf(e);
    if (!msg) return false;
    return (
      // WORD BOUNDARY, not a substring. `msg.includes('429')` classified
      // "requested range too large: 55429000..55700000" as a rate limit, so the
      // caller retried an unchanged range forever — the exact infinite loop this
      // whole split exists to prevent, defeated by three digits inside a block
      // number. Digits are word characters, so `\b429\b` cannot match 55429000
      // while still matching "HTTP 429", "status=429," and a lone "429".
      /\b429\b/.test(msg) ||
      msg.includes('too many requests') ||
      msg.includes('rate limit') ||
      msg.includes('limit exceeded')
    );
  });
}

/**
 * THE ENTRY POINT for error handling in the indexer (Task 5 and later). Prefer
 * this to the two predicates: it is where the precedence between them is fixed,
 * so no call site can get the order wrong.
 *
 * Range-too-large is tested FIRST, and that order is not arbitrary — it is the
 * cost asymmetry of being wrong:
 *  - a 429 misread as a range refusal costs ONE wasted halving, and the narrower
 *    request usually succeeds anyway (it is also less load, which is what the
 *    endpoint asked for);
 *  - a range refusal misread as a 429 costs THE ENTIRE REQUEST BUDGET, because
 *    every retry re-sends a range that will be refused for as long as it is that
 *    wide, and the run ends having covered nothing.
 * Bounded waste versus unbounded waste, so ties go to range-too-large.
 *
 * Total, like the predicates it delegates to: never throws, whatever it is given.
 */
export function classifyRpcError(err: unknown): 'range-too-large' | 'rate-limit' | 'other' {
  if (isRangeTooLarge(err)) return 'range-too-large';
  if (isRateLimit(err)) return 'rate-limit';
  return 'other';
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
 *
 * `minChunk` is honoured AS GIVEN (clamped only at one block), not raised to
 * `MIN_CHUNK`: this is a per-call floor the caller states explicitly — exactly
 * like `logScan`'s `minChunk` option, whose default happens to be `MIN_CHUNK` —
 * and silently overriding it would make `halve(span, 1)` a lie. The `MIN_CHUNK`
 * floor guards the values this module INVENTS, not the ones it is handed.
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
 * requested size. A non-positive value is NO INFORMATION, not evidence of a small
 * limit: `current` is returned untouched when there is one, and `MIN_CHUNK` when
 * there is not. The result never goes below `MIN_CHUNK` — see that constant for
 * why returning `BigInt(1)` here was a ratchet lock that let a backfill cover
 * `maxRequests` blocks per run, and why `logCache.ts:233` expresses the same
 * rule by storing nothing at all.
 */
export function nextChunkCeiling(current: bigint | null, accepted: bigint): bigint {
  const raised =
    accepted <= ZERO
      ? current === null
        ? MIN_CHUNK
        : current
      : current === null || current < accepted
        ? accepted
        : current;
  return raised < MIN_CHUNK ? MIN_CHUNK : raised;
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
 * `chunk` is clamped up to `MIN_CHUNK` if it is non-positive — a zero or negative
 * step is an infinite loop issuing invalid queries, and one block per request is
 * technically a step but not a usable one (see `MIN_CHUNK`). A negative `from` is
 * clamped to block 0. Both are impossible inputs on-chain, and silently
 * correcting them beats emitting a plan no node will answer.
 *
 * `maxRequests` of `Infinity` means UNCAPPED, and yields the whole sweep. It used
 * to yield `[]`, which turned the most plausible reading of that sentinel into
 * zero coverage reported as a finished plan. `NaN` and `-Infinity` still yield
 * `[]`: unlike `+Infinity` they carry no plausible intent, and there is no honest
 * plan for "budget unknown". Uncapped means the caller owns the size of the
 * result — a span of S blocks materialises S/chunk entries.
 */
export function planRanges(
  from: bigint,
  to: bigint,
  chunk: bigint,
  maxRequests: number
): BlockRange[] {
  const out: BlockRange[] = [];
  const uncapped = maxRequests === Infinity;
  if (!uncapped && (!Number.isFinite(maxRequests) || maxRequests < 1)) return out;

  const start = from < ZERO ? ZERO : from;
  if (to < start) return out;

  const step = chunk > ZERO ? chunk : MIN_CHUNK;
  // A request COUNT, never a block number or a span — no precision to lose here.
  const cap = uncapped ? Infinity : Math.floor(maxRequests);

  let cursor = start;
  while (cursor <= to && out.length < cap) {
    const end = cursor + step - ONE;
    out.push({ from: cursor, to: end > to ? to : end });
    cursor = end + ONE;
  }
  return out;
}
