/**
 * The chart's x-axis scale: where each point sits horizontally, and what the tick
 * labels say.
 *
 * ZERO IMPORTS, deliberately (the same constraint as `lib/indexer/replay.ts`,
 * `lib/indexer/chunking.ts` and `lib/chart/buckets.ts`). This module is compiled
 * both by the Next.js app (ESM, `@/` aliases) and by the mocha suite in
 * `contracts/` (CommonJS, no aliases) via a relative path. Any import at all — a
 * node builtin, an `@/`-aliased sibling, viem — breaks one of those two consumers.
 * There is no frontend test runner in this repo, so that is the only way the
 * arithmetic below gets asserted at all.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES IN `PriceChart`. It fails SILENTLY
 * when it is wrong. A time scale built from points whose timestamps are all equal
 * divides by zero and every point lands on NaN — an empty plot, no error. A
 * sequence scale applied to timestamped points draws trades evenly spaced, which
 * looks completely normal and lies about when they happened. Neither raises, so
 * only `contracts/test/ChartScale.test.ts` catches them.
 *
 * ── WHY THERE ARE TWO MODES ──────────────────────────────────────────────────
 * `TradePoint.t` is OPTIONAL, and that is load-bearing rather than convenient.
 * History from the indexer API carries indexed block timestamps; the RPC fallback
 * in `useTradeHistory` does not, because `CachedEvent` stores only `blockNumber`
 * and `logIndex` and filling that in means a `getBlock` per block FROM THE
 * BROWSER — the exact cost the indexer exists to remove.
 *
 * So sequence spacing survives as the DEGENERATE CASE OF ONE RENDERER, not as a
 * second renderer to keep in sync: `PriceChart` asks for a scale once per render
 * and draws the same SVG either way. Deleting it would leave the fallback path
 * with nothing to draw with.
 *
 *   | Condition                                                | Mode       |
 *   |----------------------------------------------------------|------------|
 *   | ≥2 points, EVERY point has a finite `t`, and `tMax > tMin`| `time`     |
 *   | anything else                                            | `sequence` |
 *
 * `Intl.DateTimeFormat` formats the labels. No date library: `DEPENDENCIES.md`
 * rejects `date-fns`/`dayjs` and `lib/time.ts` already establishes `Intl` as the
 * convention here.
 *
 * TOTAL BY CONSTRUCTION. `xAt` returns a finite number for every input,
 * including an empty series and an out-of-range index, because it feeds an SVG
 * `d` attribute — where NaN does not throw, it just silently draws nothing.
 */

/** The only fields of a chart point this module reads. */
export interface ScalePoint {
  bps: number;
  /** Unix SECONDS, absent on the RPC fallback path. */
  t?: number;
}

/** One axis label, already positioned in pixels. */
export interface XTick {
  x: number;
  label: string;
}

export interface XScale {
  mode: 'time' | 'sequence';
  /** Pixel x for the point at index `i`. Always finite. */
  xAt(i: number): number;
  /** Axis labels, left to right. EMPTY in `sequence` mode, as today. */
  ticks: XTick[];
}

/** Labels when the caller does not say. Four fits a phone width without collision. */
const DEFAULT_TICKS = 4;

/** More than this and labels overlap at any realistic plot width. */
const MAX_TICKS = 12;

const DAY_SECONDS = 86400;

/** 365 days. The boundary where a label needs a year rather than a day. */
const YEAR_SECONDS = 365 * DAY_SECONDS;

/** A usable number, or `fallback`. Guards a measured width mid-layout. */
function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True when this point can carry a time scale. */
function hasTime(point: ScalePoint | undefined): boolean {
  return (
    !!point && typeof point.t === 'number' && Number.isFinite(point.t)
  );
}

/**
 * Label granularity from the span, per the design: time-of-day within a day,
 * day+month within a year, month+year beyond.
 *
 * Built ONCE per scale rather than once per tick — constructing an
 * `Intl.DateTimeFormat` is markedly more expensive than formatting with one, and
 * this runs on every render of every market page.
 *
 * Returns null when `Intl` is unavailable or refuses the options, so the caller
 * can fall back rather than throwing inside a render.
 */
function formatterFor(spanSec: number): Intl.DateTimeFormat | null {
  const options: Intl.DateTimeFormatOptions =
    spanSec < DAY_SECONDS
      ? { hour: 'numeric', minute: '2-digit' }
      : spanSec < YEAR_SECONDS
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', year: 'numeric' };
  try {
    // `undefined` locale: the visitor's own, matching every helper in lib/time.ts.
    return new Intl.DateTimeFormat(undefined, options);
  } catch {
    return null;
  }
}

/**
 * One tick's text. Never empty, because a blank label reads as a rendering bug.
 */
function labelFor(seconds: number, formatter: Intl.DateTimeFormat | null): string {
  if (formatter !== null) {
    try {
      const text = formatter.format(new Date(seconds * 1000));
      if (text) return text;
    } catch {
      // An out-of-range Date, or a formatter that turned out to be unusable.
    }
  }
  try {
    // A date is still more use than a bare epoch second.
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  } catch {
    return String(Math.floor(seconds));
  }
}

/**
 * The x-scale for one render.
 *
 * `padLeft` is the plot's left edge in pixels and `plotW` its drawable width, so
 * the first point sits at `padLeft` and the last at `padLeft + plotW` in both
 * modes. `tickCount` is the number of labels wanted in `time` mode.
 */
export function buildXScale(
  points: readonly ScalePoint[],
  padLeft: number,
  plotW: number,
  tickCount: number = DEFAULT_TICKS
): XScale {
  const left = finiteOr(padLeft, 0);
  const width = finiteOr(plotW, 0);
  const list = Array.isArray(points) ? points : [];
  const n = list.length;

  /*
   * Fewer than two points cannot describe a line, so there is nothing to space:
   * the point parks at the RIGHT edge. That is not a fallback, it is the untraded
   * market's honest shape — `PriceChart` draws a flat dashed line at the seeded
   * price with the dot at "now", and the previous centre-of-plot placement was
   * reported as a rendering failure. An empty series lands here too, which is why
   * `xAt` is finite even with no points at all.
   */
  if (n < 2) {
    const only = left + width;
    return { mode: 'sequence', xAt: () => only, ticks: [] };
  }

  /** Index clamped into the series, so `xAt` is total. */
  const clampIndex = (i: number): number => {
    const idx = typeof i === 'number' && Number.isFinite(i) ? Math.floor(i) : 0;
    if (idx <= 0) return 0;
    return idx >= n - 1 ? n - 1 : idx;
  };

  const sequence = (): XScale => ({
    mode: 'sequence',
    // Exactly the spacing this chart has always used: even steps by index.
    xAt: (i: number) => left + (clampIndex(i) / (n - 1)) * width,
    ticks: [],
  });

  // EVERY point, not most of them: one missing timestamp makes the whole series
  // unpositionable in time, and mixing the two modes within one line would place
  // some points by time and others by index.
  for (const point of list) {
    if (!hasTime(point)) return sequence();
  }

  let tMin = list[0].t as number;
  let tMax = tMin;
  for (const point of list) {
    const t = point.t as number;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }

  // A zero span is the divide-by-zero case: every event in one block, or a single
  // bucket. Even spacing is the only honest answer, and it is what today draws.
  const span = tMax - tMin;
  if (!(span > 0)) return sequence();

  const xForTime = (t: number): number => left + ((t - tMin) / span) * width;

  const wanted = Number.isFinite(tickCount) ? Math.floor(tickCount) : DEFAULT_TICKS;
  const count = wanted < 1 ? DEFAULT_TICKS : wanted > MAX_TICKS ? MAX_TICKS : wanted;
  const formatter = formatterFor(span);
  const ticks: XTick[] = [];
  if (count === 1) {
    // A single label belongs in the middle of the span, not at one end.
    const mid = tMin + span / 2;
    ticks.push({ x: xForTime(mid), label: labelFor(mid, formatter) });
  } else {
    for (let i = 0; i < count; i += 1) {
      const t = tMin + (span * i) / (count - 1);
      ticks.push({ x: xForTime(t), label: labelFor(t, formatter) });
    }
  }

  return {
    mode: 'time',
    xAt: (i: number) => xForTime(list[clampIndex(i)].t as number),
    ticks,
  };
}
