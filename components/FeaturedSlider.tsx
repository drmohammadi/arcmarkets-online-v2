'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MarketAvatar, Badge, ProbabilityBar } from './ui';
import type { ImageUrlFor } from './MarketCard';
import { categoryLabel } from '@/lib/marketMeta';
import { formatProbPctCompact, formatProbPct } from '@/lib/pricing';
import { formatUsdcCompact } from '@/lib/format';
import { formatCountdown } from '@/lib/time';
import type { EventGroup } from '@/lib/eventGroups';
import type { Pool } from '@/hooks/useMarketPools';

/**
 * Featured markets carousel.
 *
 * Large, prominent cards in a horizontal slideshow, in the spirit of
 * Polymarket's featured rail but using this app's own tokens and typography.
 *
 * Built on native CSS scroll-snap rather than a carousel library:
 *  - Touch swipe, trackpad, momentum scrolling and keyboard arrow-scroll all
 *    work for free, and correctly, on every platform.
 *  - It degrades to a plain scrollable row before hydration.
 *  - No dependency, per the repo's per-dependency justification rule.
 *
 * The prev/next buttons and dots are a progressive enhancement layered over
 * real scroll: they scroll to a card's measured offset, so the control state and
 * the scroll position can never disagree.
 *
 * Sliding is smooth via `scroll-smooth`, which globals.css already disables
 * under `prefers-reduced-motion`.
 */
export function FeaturedSlider({
  groups,
  poolFor,
  nowSec,
  imageUrlFor,
}: {
  groups: EventGroup[];
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
  imageUrlFor?: ImageUrlFor;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  /** Derive control state from real scroll position, never from a counter. */
  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;

    // 2px tolerance absorbs sub-pixel rounding at fractional zoom levels.
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);

    // Active = the card whose left edge is nearest the viewport's left edge.
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as HTMLElement;
      const delta = Math.abs(child.offsetLeft - el.offsetLeft - el.scrollLeft);
      if (delta < best) {
        best = delta;
        nearest = i;
      }
    }
    setActive(nearest);
  }, []);

  useEffect(() => {
    sync();
    const el = railRef.current;
    if (!el) return;
    el.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, [sync, groups.length]);

  /**
   * Scroll a card into view by its measured offset.
   *
   * Deliberately not scrollIntoView: that also scrolls ancestors, which yanks
   * the whole page vertically when the rail is partly off-screen.
   */
  const goTo = useCallback((index: number) => {
    const el = railRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(el.children.length - 1, index));
    const child = el.children[clamped] as HTMLElement | undefined;
    if (!child) return;
    el.scrollTo({ left: child.offsetLeft - el.offsetLeft, behavior: 'smooth' });
  }, []);

  if (groups.length === 0) return null;

  return (
    <section aria-labelledby="featured-heading" className="mb-10">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="featured-heading" className="text-lg font-semibold tracking-tight text-content">
            Featured
          </h2>
          <p className="mt-0.5 text-xs text-content-muted">
            The most liquid markets trading right now.
          </p>
        </div>

        {/* Controls are meaningless with a single card, so they're withheld. */}
        {groups.length > 1 && (
          <div className="flex shrink-0 gap-1.5">
            <RailButton dir={-1} disabled={atStart} onClick={() => goTo(active - 1)} />
            <RailButton dir={1} disabled={atEnd} onClick={() => goTo(active + 1)} />
          </div>
        )}
      </div>

      <ul
        ref={railRef}
        tabIndex={0}
        role="region"
        aria-label="Featured markets carousel"
        className="no-scrollbar -mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-1 pb-2"
      >
        {groups.map((g) => (
          <FeaturedCard
            key={g.key}
            group={g}
            poolFor={poolFor}
            nowSec={nowSec}
            imageUrlFor={imageUrlFor}
          />
        ))}
      </ul>

      {groups.length > 1 && (
        <div className="mt-1 flex justify-center gap-1.5">
          {groups.map((g, i) => (
            <button
              key={g.key}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Go to featured market ${i + 1} of ${groups.length}`}
              aria-current={i === active ? 'true' : undefined}
              className={`h-1.5 rounded-full transition-all ${
                i === active ? 'w-5 bg-brand' : 'w-1.5 bg-edge-strong hover:bg-content-subtle'
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RailButton({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === -1 ? 'Previous featured market' : 'Next featured market'}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-surface-raised text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:opacity-35 disabled:hover:border-edge"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
        <path
          d={dir === -1 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Large featured card.
 *
 * Sizing: one card fills most of a phone screen (with a sliver of the next
 * visible to signal swipeability), roughly one on tablet, two side by side on
 * desktop. Widths are percentages of the rail, so the rail scrolls but the page
 * never gains horizontal overflow.
 */
function FeaturedCard({
  group,
  poolFor,
  nowSec,
  imageUrlFor,
}: {
  group: EventGroup;
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
  imageUrlFor?: ImageUrlFor;
}) {
  // Leading outcome = highest implied YES probability among members.
  let lead = group.markets[0];
  let leadPool = poolFor(lead.market.questionId);
  for (const v of group.markets) {
    const p = poolFor(v.market.questionId);
    if (p.yesBps > leadPool.yesBps) {
      lead = v;
      leadPool = p;
    }
  }

  const href = `/market/${lead.market.questionId.toString()}`;
  const totalLiq = group.markets.reduce(
    (sum, v) => sum + poolFor(v.market.questionId).liquidity,
    BigInt(0)
  );

  // Top outcomes for a multi-outcome event, most likely first.
  const ranked = [...group.markets]
    .sort((a, b) => poolFor(b.market.questionId).yesBps - poolFor(a.market.questionId).yesBps)
    .slice(0, 3);

  return (
    <li className="w-[86%] shrink-0 snap-start sm:w-[70%] lg:w-[calc(50%-0.5rem)]">
      <Link
        href={href}
        className="flex h-full flex-col gap-4 rounded-card border border-edge bg-surface-raised p-5 transition-colors hover:border-edge-strong focus-visible:border-brand"
      >
        <div className="flex items-start gap-4">
          <MarketAvatar
            questionId={group.markets[0].market.questionId}
            seed={group.key}
            text={group.title}
            size="3xl"
            imageUrl={imageUrlFor?.(group.markets[0].market.questionId) ?? null}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">{categoryLabel(group.category)}</Badge>
              {group.allResolved && <Badge tone="brand">Resolved</Badge>}
              {group.isMultiOutcome && (
                <span className="text-2xs text-content-subtle">
                  {group.markets.length} outcomes
                </span>
              )}
            </div>
            <p className="mt-2 line-clamp-2 text-base font-semibold leading-snug text-content sm:text-lg">
              {group.title}
            </p>
          </div>

          {/* Single-outcome markets lead with the headline number. */}
          {!group.isMultiOutcome && (
            <div className="shrink-0 text-right">
              <p className="text-3xl font-semibold tabular-nums leading-none text-content">
                {leadPool.hasLiquidity ? formatProbPctCompact(leadPool.yesBps) : '—'}
              </p>
              <p className="mt-1 text-2xs uppercase tracking-wide text-content-subtle">yes</p>
            </div>
          )}
        </div>

        {group.isMultiOutcome ? (
          <ul className="flex flex-col gap-2">
            {ranked.map((v) => {
              const pool = poolFor(v.market.questionId);
              return (
                <li key={v.market.questionId.toString()} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-content-muted">
                    {v.outcomeLabel}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-content">
                    {pool.hasLiquidity ? formatProbPctCompact(pool.yesBps) : '—'}
                  </span>
                  <span className="hidden w-24 shrink-0 sm:block">
                    <ProbabilityBar yesBps={pool.yesBps} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <ProbabilityBar yesBps={leadPool.yesBps} showLabels />
        )}

        <div className="mt-auto flex items-center justify-between border-t border-edge pt-3 text-xs text-content-subtle">
          {/*
           * Liquidity, not "volume": cumulative traded volume is not stored
           * on-chain, and deriving it would need a full event replay per market
           * on the homepage — the exact RPC load this app just removed. Showing
           * pool liquidity is honest and free (it's already multicalled).
           */}
          <span className="tabular-nums">
            {totalLiq > BigInt(0) ? `$${formatUsdcCompact(totalLiq)} liquidity` : 'No liquidity yet'}
          </span>
          {group.allResolved ? (
            <span>Settled</span>
          ) : (
            <span className="tabular-nums">
              {formatCountdown(group.earliestResolution, nowSec)}
            </span>
          )}
        </div>

        {/* Screen readers get the leading price even when it's shown visually
            only inside the outcome list. */}
        <span className="sr-only">
          Leading outcome {lead.outcomeLabel} at {formatProbPct(leadPool.yesBps)}
        </span>
      </Link>
    </li>
  );
}
