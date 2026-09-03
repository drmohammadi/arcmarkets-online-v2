/**
 * Bucket policy for the chart API: how a request's `from`/`to`/`interval`/`limit`
 * become a window and a bucket width.
 *
 * ZERO IMPORTS, deliberately (the same constraint as `lib/indexer/replay.ts` and
 * `lib/indexer/chunking.ts`). This module is compiled both by the Next.js app
 * (ESM, `@/` aliases) and by the mocha suite in `contracts/` (CommonJS, no
 * aliases) via a relative path. Any import at all — a node builtin, an
 * `@/`-aliased sibling, viem — breaks one of those two consumers.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ROUTE HANDLER. Every function
 * here fails silently when it is wrong. A step that is too narrow returns
 * thousands of points and a slow chart; a `from` misparsed as an absolute unix
 * second returns an empty one; an interval name that is not in the allowlist
 * reaches Postgres as a NULL divisor. None of them raise, so the only thing that
 * catches them is `contracts/test/ChartBuckets.test.ts`.
 *
 * NOTHING HERE IS EVER INTERPOLATED INTO SQL. `resolveInterval` returns an
 * integer that travels to Postgres as a BOUND PARAMETER, and `clampLimit`
 * likewise. That is the whole reason the interval arrives as a name from a fixed
 * allowlist rather than as a number the caller chooses.
 */

/** The interval names the API accepts. `auto` derives one from the span. */
export type IntervalName = 'auto' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

/**
 * THE ALLOWLIST. A request's `interval` selects one of these values by NAME;
 * the number itself never comes from the request.
 */
export const INTERVAL_SECONDS: Readonly<Record<Exclude<IntervalName, 'auto'>, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/**
 * The same widths, ascending, as the ladder `auto` widens along. Derived by hand
 * rather than from `Object.values` so the ORDER is stated: widening depends on
 * it, and object key order is a weaker promise than a literal array.
 */
const STEPS_ASCENDING: readonly number[] = [60, 300, 900, 1800, 3600, 14400, 86400];

const MINUTE = 60;
const DAY = 86400;

/** Points per response when the caller does not say. */
const DEFAULT_LIMIT = 300;

/**
 * Hard ceiling on points per response.
 *
 * Not politeness: `PriceChart` draws an SVG polyline and `useTradeHistory` asks
 * for 200, so anything past a few hundred is bytes on the wire that no pixel
 * shows. It also bounds the work one anonymous request can ask Postgres for,
 * which matters more on Neon's free tier than it would on a dedicated instance.
 */
const MAX_LIMIT = 2000;

/** A finite non-negative integer, or `fallback`. */
function toWholeSeconds(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * A caller-supplied point budget as a positive integer.
 *
 * Separate from `clampLimit` because that one parses a query STRING and this one
 * sanitizes an already-numeric argument: `resolveInterval` is exported and must
 * be total, whatever a future caller hands it.
 */
function sanitizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_LIMIT;
}

/**
 * The window's lower bound, in unix seconds.
 *
 * Accepts the three documented relative spans, `all`, and an absolute unix
 * second. Anything else — including a malformed number, a future spec's
 * `90d`, or a probe — falls back to 24h rather than erroring, matching
 * `clampLimit`: a chart request is a read with sane defaults, not a form
 * submission, and a 400 on a cosmetic query param would push the frontend onto
 * its RPC fallback for no reason.
 *
 * `all` is 0, not the factory's deploy block: `market_events` cannot contain a
 * row below it, so 0 is an exact bound with nothing to look up. (This is the
 * read-side counterpart of the anchor rule in `lib/contracts.ts:getStartBlock` —
 * a floor that is too LOW costs nothing here, while one that is too high hides
 * trades.)
 *
 * The digits-only test is deliberate: `Number.parseInt('7days')` is 7, which
 * would silently read a mistyped relative span as an absolute timestamp in 1970
 * and return the whole history instead of a week of it.
 */
export function parseFrom(from: string | null, nowSec: number): number {
  const now = toWholeSeconds(nowSec, 0);
  const dayAgo = now > DAY ? now - DAY : 0;
  if (from === null) return dayAgo;

  const raw = from.trim().toLowerCase();
  if (raw === 'all') return 0;
  if (raw === '24h') return dayAgo;
  if (raw === '7d') return now > 7 * DAY ? now - 7 * DAY : 0;
  if (raw === '30d') return now > 30 * DAY ? now - 30 * DAY : 0;
  if (!/^[0-9]+$/.test(raw)) return dayAgo;

  const absolute = Number.parseInt(raw, 10);
  return Number.isSafeInteger(absolute) ? absolute : dayAgo;
}

/**
 * The bucket width in seconds.
 *
 * An EXPLICIT name is honoured as given — that is what asking for it means, and
 * it is how an operator inspects fine structure the auto policy would smooth
 * over. It is safe to honour even when the span holds far more buckets than
 * `limit`, because `selectChartRows` keeps the NEWEST buckets when its LIMIT
 * binds; the result is a shorter window at the requested resolution, never a
 * chart that stops in the past.
 *
 * `auto` starts from the span — ≤1 day → 5m, ≤7 days → 15m, ≤30 days → 1h, else
 * 1d — and then WIDENS along the ladder until the bucket count fits `limit`, so
 * the response size is bounded by policy rather than by the caller's span. The
 * widening is the load-bearing half: the base steps alone would return 8640
 * points for a 30-day window at 5m if someone changed the thresholds.
 *
 * Total by construction. A non-finite span reads as 0 (the narrowest base step),
 * a non-finite limit as the default, and a name outside the allowlist as `auto`
 * — because the alternative is `undefined` reaching Postgres as the divisor in
 * the bucket expression, which aborts the whole query.
 */
export function resolveInterval(name: IntervalName, spanSec: number, limit: number): number {
  const cap = sanitizeLimit(limit);
  const span = toWholeSeconds(spanSec, 0);

  if (name !== 'auto') {
    const explicit = INTERVAL_SECONDS[name];
    // `typeof` rather than a truthiness or `!== undefined` check: this guards a
    // JS caller passing 'constructor', where the lookup yields a function.
    if (typeof explicit === 'number' && explicit > 0) return explicit;
  }

  let step =
    span <= DAY
      ? INTERVAL_SECONDS['5m']
      : span <= 7 * DAY
        ? INTERVAL_SECONDS['15m']
        : span <= 30 * DAY
          ? INTERVAL_SECONDS['1h']
          : INTERVAL_SECONDS['1d'];

  for (const candidate of STEPS_ASCENDING) {
    if (candidate < step) continue;
    step = candidate;
    if (span / candidate <= cap) break;
  }
  return step;
}

/**
 * The requested point budget, as an integer in [1, MAX_LIMIT].
 *
 * `Number.parseInt` on purpose, so `'12.9'` is 12 rather than rejected: a
 * fractional limit is a caller being loose, not a caller being wrong, and the
 * floor is unambiguous. Zero, negative and unparseable values fall back to the
 * default instead of yielding an empty chart — `limit=0` is far more likely to
 * be a bug in a caller than a request for no data.
 */
export function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_LIMIT;
  return n > MAX_LIMIT ? MAX_LIMIT : n;
}

/**
 * A request's `interval` as an allowlisted name, defaulting to `auto`.
 *
 * THE ALLOWLIST IS ENFORCED HERE, once, so no route handler has to remember to.
 * `hasOwnProperty` rather than `in` or a plain lookup: `INTERVAL_SECONDS['toString']`
 * is a function and `'__proto__'` reaches an inherited slot, and either one
 * returned as a valid name would put a non-number where a bucket width belongs.
 */
export function parseIntervalName(raw: string | null): IntervalName {
  if (raw === null) return 'auto';
  const key = raw.trim().toLowerCase();
  if (key === 'auto') return 'auto';
  if (!Object.prototype.hasOwnProperty.call(INTERVAL_SECONDS, key)) return 'auto';
  const seconds = INTERVAL_SECONDS[key as Exclude<IntervalName, 'auto'>];
  return typeof seconds === 'number' ? (key as IntervalName) : 'auto';
}

/**
 * The name of a resolved step, for `meta.interval` in the response.
 *
 * The response reports the width it actually used, not the one that was asked
 * for: `auto` is not an answer a client can plot against, and a widened step
 * reported as `auto` hides exactly the fact the client would want (that it got
 * hourly points for a 30-day window). Falls back to a plain second count for a
 * step outside the ladder, which cannot happen through `resolveInterval` but is
 * cheaper to handle than to prove impossible at every call site.
 */
export function intervalNameOf(stepSec: number): string {
  for (const name of Object.keys(INTERVAL_SECONDS) as Array<Exclude<IntervalName, 'auto'>>) {
    if (INTERVAL_SECONDS[name] === stepSec) return name;
  }
  return `${Math.max(1, Math.floor(stepSec / MINUTE))}m`;
}
