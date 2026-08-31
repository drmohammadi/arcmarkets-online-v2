'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TradePoint } from '@/hooks/useTradeHistory';
import { formatProbPct } from '@/lib/pricing';
import { Skeleton } from './ui';

/**
 * Price line: one small dot per trade, joined oldest-to-newest by a continuous
 * line. No candlesticks, no indicators, no drawing tools, no time-range tabs.
 *
 * The x-axis is trade SEQUENCE, not time, which is what lets the whole thing
 * avoid fetching a timestamp for every block (the old chart's single largest
 * source of RPC traffic). The last point is always the live contract price, so
 * the right-hand edge is correct even when no trade logs could be loaded at all.
 *
 * Still hand-rolled SVG: a polyline and some circles do not justify a charting
 * library in the bundle.
 *
 * ── TWO RENDERING BUGS THIS FIXES ────────────────────────────────────────────
 * Reported as "the chart only shows a single large blue dot". Both causes were
 * here, on top of the data problem fixed in `hooks/useTradeHistory.ts`:
 *
 *  1. **Only ONE point was ever drawn.** A circle was emitted for the last point
 *     alone, so the intermediate trades existed in the path but had no markers.
 *
 *  2. **`preserveAspectRatio="none"` on a square viewBox stretched it.** The
 *     viewBox was 100x100 rendered into a box roughly 900x200, so x scaled ~9x
 *     and y ~2x. `vectorEffect="non-scaling-stroke"` compensates for the STROKE
 *     but does nothing for geometry, so `r={3}` painted as a ~54x12px ellipse —
 *     a single large blue blob. With no trades loaded, that lone stretched
 *     marker sitting at the centre was the entire chart.
 *
 * The fix for (2) is to stop using a synthetic coordinate system: the viewBox is
 * now the element's ACTUAL pixel size, so the scale is exactly 1 and a circle is
 * a circle. That is also why the radii below can be stated in real pixels and
 * trusted.
 *
 * ── A THIRD REPORT: "SOME MARKETS SHOW ONE POINT, OTHERS SHOW A LINE" ────────
 * That one was not a bug. Those markets had genuinely never been traded — only
 * `LiquidityAdded` from seeding, no Buy/Sell at all — so there was exactly one
 * real price to draw. Verified against the chain: of 18 markets, 9 had zero
 * trade events and 9 had between 2 and 13, which is precisely the split that was
 * being reported.
 *
 * The data was right and the presentation was wrong: a lone dot parked in the
 * middle of an empty plot looks identical to a chart that failed to load. So an
 * untraded market now draws a FLAT DASHED line at its seeded price with the dot
 * at the right-hand edge. An FPMM's price only moves when someone trades it, so a
 * horizontal line is the honest shape of "never traded", not a filler — and the
 * dashes plus the caption keep it distinguishable from real flat trading.
 */

/** Plot height in px. Matches the previous h-[200px] so the layout is unchanged. */
const PLOT_H = 200;
/** Fallback width for the first paint, before the container is measured. */
const DEFAULT_W = 640;

/** Room for the y-axis labels, which sit outside the plot at the left. */
const PAD_LEFT = 26;
const PAD_RIGHT = 8;
/** Vertical breathing room so a dot at 0% or 100% is not clipped in half. */
const PAD_Y = 7;

/**
 * Y-axis levels, top to bottom. These are the LABELS.
 *
 * 0 and 100 are labelled but not drawn as gridlines: they sit on the plot's top
 * and bottom edges, where a guide reads as a border rather than a reference.
 */
const AXIS_LEVELS = [100, 75, 50, 25, 0] as const;

/**
 * Levels drawn as horizontal guides.
 *
 * 50% is emphasized because it is the only level with intrinsic meaning — even
 * odds, the point the market is undecided. The quartiles are reading aids, so
 * they are drawn fainter and must not compete with the price line.
 */
const GRID_LEVELS = [
  { pct: 75, emphasis: false },
  { pct: 50, emphasis: true },
  { pct: 25, emphasis: false },
] as const;

/**
 * Dot radius in px, shrinking as the series gets denser.
 *
 * Every point is always drawn — the series is the data, and silently dropping
 * markers would misrepresent how much trading happened. But at 200 points a
 * fixed radius merges into one opaque band and hides the line it is meant to
 * annotate, so the radius scales down instead of the count.
 */
function dotRadius(count: number): number {
  if (count > 120) return 1.1;
  if (count > 60) return 1.5;
  if (count > 24) return 1.9;
  return 2.3;
}

export function PriceChart({
  points,
  isLoading,
  degraded,
  currentBps,
  complete = false,
}: {
  points: TradePoint[];
  isLoading: boolean;
  /** True when trade history could not be loaded; only the live price is real. */
  degraded: boolean;
  currentBps: number;
  /** True when history reaches the market's start, so the line is the full record. */
  complete?: boolean;
}) {
  /*
   * Measure the container so the viewBox can be stated in real pixels.
   *
   * This is what keeps dots round. Width is the only unknown — height is fixed —
   * so a ResizeObserver on the wrapper is enough, and it needs no dependency.
   */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_W);

  /*
   * useLayoutEffect, not useEffect: this runs BEFORE the browser paints, so the
   * plot is drawn at the real width on the very first frame. With useEffect the
   * fallback width paints once and is then corrected, which reads as the chart
   * visibly snapping into place on every mount.
   *
   * React warns about useLayoutEffect during SSR, so it is only used in the
   * browser. The server render uses the fallback width and is replaced on
   * hydration; nothing here affects markup correctness, only when it is measured.
   */
  const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

  useMeasureEffect(() => {
    const el = wrapRef.current;
    // Absent while the skeleton is showing: the measured container is not
    // rendered yet. `isLoading` is a dependency for exactly this reason — without
    // it the observer would never attach after the first load finished, and the
    // plot would stay stuck at the fallback width for the life of the component.
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      // Ignore a zero/absent measurement (display:none, detached) rather than
      // collapsing the plot to nothing.
      if (w > 0) setWidth(w);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') {
      // Older browsers still get a correct first measurement and reflow on
      // window resize; only live container-only resizes are missed.
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading]);

  if (isLoading) {
    return (
      <div className="rounded-card border border-edge bg-surface-raised p-4">
        <Skeleton className="h-[200px] w-full" />
      </div>
    );
  }

  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const plotH = PLOT_H - PAD_Y * 2;

  /** Probability percentage -> pixel y. Inverted: 100% is the TOP of the plot. */
  const yForPct = (pct: number): number => PAD_Y + (1 - pct / 100) * plotH;

  // `points` always contains at least the live price, so there is no empty state
  // to render — but a single point cannot describe a line.
  const hasHistory = points.length > 1;
  const radius = dotRadius(points.length);

  /*
   * A market with no trades is drawn as a FLAT line at the live price, with the
   * dot at the right-hand edge.
   *
   * This is not decoration, it is the truthful shape. An FPMM's price only moves
   * when someone trades it, so a pool that has been seeded with liquidity and
   * never traded has genuinely held one price for its whole life — a horizontal
   * line is what that history looks like. The line is dashed to distinguish "no
   * trades were recorded" from "trades were recorded and were flat".
   *
   * The previous behaviour put the single point in the MIDDLE of the plot with no
   * line at all, which read as a rendering failure and was reported as one. The
   * data was right; the presentation implied something was missing. Anchoring the
   * dot to the right edge also matches where "now" belongs on every other chart
   * here, so a market's first trade extends the line leftward-to-rightward
   * naturally instead of making the dot jump.
   */
  const coords = points.map((p, i) => ({
    x: hasHistory ? PAD_LEFT + (i / (points.length - 1)) * plotW : PAD_LEFT + plotW,
    y: yForPct(Math.max(0, Math.min(10000, p.bps)) / 100),
    kind: p.kind,
    bps: p.bps,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const last = coords[coords.length - 1];

  return (
    <div className="rounded-card border border-edge bg-surface-raised p-4">
      <div className="mb-3">
        <p className="text-2xs uppercase tracking-wide text-content-subtle">Current</p>
        <p className="text-2xl font-semibold tabular-nums text-content">
          {formatProbPct(currentBps)}
        </p>
        <p className="text-2xs text-content-subtle">chance of YES</p>
      </div>

      <div className="relative" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${width} ${PLOT_H}`}
          width={width}
          height={PLOT_H}
          className="h-[200px] w-full"
          role="img"
          aria-label={
            hasHistory
              ? `YES probability across ${points.length - 1} trades, currently ${formatProbPct(currentBps)}`
              : `YES probability, no trades yet, flat at ${formatProbPct(currentBps)}`
          }
        >
          {/*
            Horizontal guides at 25 / 50 / 75%, so the line has references to
            read against. 50% stays the emphasized one — it is the only level
            with intrinsic meaning (even odds), and flattening all three into
            one weight would lose that. The quartiles are drawn fainter so they
            assist reading without competing with the price line.
          */}
          {GRID_LEVELS.map(({ pct, emphasis }) => (
            <line
              key={pct}
              x1={PAD_LEFT}
              x2={PAD_LEFT + plotW}
              y1={yForPct(pct)}
              y2={yForPct(pct)}
              stroke="rgb(var(--edge))"
              strokeWidth={1}
              strokeOpacity={emphasis ? 1 : 0.5}
              strokeDasharray="3 3"
            />
          ))}

          {/* The continuous price line, through every point in sequence. */}
          {hasHistory && (
            <path
              d={linePath}
              fill="none"
              stroke="rgb(var(--brand))"
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/*
            No trades: the price has been flat since this pool was seeded, so draw
            that as a flat line rather than leaving a lone dot floating. Dashed,
            because nothing here was observed from a trade.
          */}
          {!hasHistory && (
            <path
              d={`M ${PAD_LEFT} ${last.y} L ${PAD_LEFT + plotW} ${last.y}`}
              fill="none"
              stroke="rgb(var(--brand))"
              strokeWidth={1.75}
              strokeDasharray="5 4"
              strokeLinecap="round"
              strokeOpacity={0.75}
            />
          )}

          {/*
            Every point, including the live one. Drawn AFTER the line so the
            markers sit on top of it rather than being half-covered.
          */}
          {coords.map((c, i) => {
            const isLive = i === coords.length - 1;
            return (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={isLive ? radius + 0.9 : radius}
                fill="rgb(var(--brand))"
                // Only the live point gets a ring, so it stays findable at a
                // glance without being the large blob it used to be.
                stroke={isLive ? 'rgb(var(--surface))' : 'none'}
                strokeWidth={isLive ? 1.5 : 0}
              />
            );
          })}

          {/*
            Marks where the live price sits on the y-axis. Skipped when there is
            no history, because the flat line above already IS that level and two
            overlapping dashed lines just look like an artefact.
          */}
          {hasHistory && (
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + plotW}
              y1={last.y}
              y2={last.y}
              stroke="rgb(var(--brand))"
              strokeWidth={1}
              strokeOpacity={0.25}
              strokeDasharray="2 4"
            />
          )}
        </svg>

        {/* Y labels sit outside the plot area, aligned to its padded edges. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between text-2xs tabular-nums text-content-subtle"
          style={{ paddingTop: PAD_Y - 5, paddingBottom: PAD_Y - 5 }}
          aria-hidden="true"
        >
          {AXIS_LEVELS.map((pct) => (
            <span key={pct}>{pct}%</span>
          ))}
        </div>
      </div>

      {/*
        Says what the line actually is in each case. `degraded` is reported even
        when there IS history, because a truncated scan draws a real but partial
        line — presenting that as the full record would overstate it.
      */}
      <p className="mt-2 text-2xs text-content-subtle">
        {hasHistory
          ? `${points.length - 1} ${points.length === 2 ? 'trade' : 'trades'}, oldest to newest.` +
            (degraded
              ? ' Some earlier trades could not be loaded.'
              : complete
                ? ''
                : ' Older trades may still be loading.')
          : degraded
            ? 'Live price from the contract. Trade history could not be loaded right now.'
            : 'Not traded yet — the price has held at its seeded level, shown flat. The line starts building on the first trade.'}
      </p>

      {/* Accessible equivalent of the graphic. */}
      <table className="sr-only">
        <caption>YES probability per trade, oldest to newest</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Type</th>
            <th scope="col">YES probability</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{p.kind === 'now' ? 'Current price' : p.kind}</td>
              <td>{formatProbPct(p.bps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
