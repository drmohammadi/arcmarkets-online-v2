'use client';

import Link from 'next/link';
import { MarketAvatar, Badge, ProbabilityBar } from './ui';
import { categoryLabel } from '@/lib/marketMeta';
import { formatProbPctCompact, formatProbPct } from '@/lib/pricing';
import { formatUsdcCompact } from '@/lib/format';
import { formatCountdown } from '@/lib/time';
import type { EventGroup, MarketView } from '@/lib/eventGroups';
import type { Pool } from '@/hooks/useMarketPools';

/** Resolves a market's shared on-chain image, if the caller has loaded them. */
export type ImageUrlFor = (questionId: bigint) => string | null;

/**
 * Compact card for a standalone binary market.
 *
 * Density target: the whole card fits in ~150px so a 4-up grid shows many
 * markets without scrolling. Question is clamped to 2 lines.
 *
 * ── WHY THE ROOT IS A DIV, NOT A LINK ────────────────────────────────────────
 * The whole card used to BE the <Link>. That is the cleanest way to make a card
 * clickable, but it cannot contain the YES/NO buttons: an <a> inside an <a> is
 * invalid HTML, and browsers recover by splitting the outer anchor, which
 * breaks both the card link and the buttons.
 *
 * So the card is a positioned div with a stretched overlay link covering it,
 * and the buttons sit above that overlay on the z-axis. Screen readers get one
 * labelled link for the card plus two clearly-labelled trade links, rather than
 * a nested mess. This is the same shape EventGroupCard already uses.
 */
export function MarketCard({
  group,
  pool,
  nowSec,
  imageUrlFor,
}: {
  group: EventGroup;
  pool: Pool;
  nowSec: bigint;
  imageUrlFor?: ImageUrlFor;
}) {
  const view = group.markets[0];
  const m = view.market;
  const href = `/market/${m.questionId.toString()}`;
  const countdown = formatCountdown(m.resolutionTime, nowSec);
  const label = view.fullQuestion || 'Untitled market';

  return (
    <div className="group relative flex h-full flex-col gap-3 rounded-card border border-edge bg-surface-raised p-3 transition-colors hover:border-edge-strong focus-within:border-brand">
      {/*
       * Covers the whole card so any dead space is still clickable. The buttons
       * below opt out with `relative z-10`. aria-label carries the question so
       * the link is not announced as empty.
       */}
      <Link href={href} aria-label={label} className="absolute inset-0 rounded-card" />

      <div className="flex items-start gap-2.5">
        <MarketAvatar
          questionId={m.questionId}
          seed={m.fpmm || group.key}
          text={view.fullQuestion}
          size="md"
          imageUrl={imageUrlFor?.(m.questionId) ?? null}
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-content">{label}</p>
          <p className="mt-1 text-2xs text-content-subtle">{categoryLabel(group.category)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-semibold tabular-nums text-content">
            {pool.hasLiquidity ? formatProbPctCompact(pool.yesBps) : '—'}
          </p>
          <p className="text-2xs text-content-subtle">yes</p>
        </div>
      </div>

      <ProbabilityBar yesBps={pool.yesBps} />

      {/* Quick trade. Resolved markets cannot be traded, so the row is dropped. */}
      {!m.resolved && (
        <div className="relative z-10 grid grid-cols-2 gap-2">
          <SideButton questionId={m.questionId} side="yes" label={label} bps={pool.yesBps} />
          <SideButton questionId={m.questionId} side="no" label={label} bps={10000 - pool.yesBps} />
        </div>
      )}

      <div className="mt-auto flex items-center justify-between text-2xs text-content-subtle">
        <span className="tabular-nums">
          {pool.hasLiquidity ? `$${formatUsdcCompact(pool.liquidity)} liq` : 'No liquidity'}
        </span>
        {m.resolved ? <Badge tone="brand">Resolved</Badge> : <span className="tabular-nums">{countdown}</span>}
      </div>
    </div>
  );
}

/**
 * Full-width YES or NO entry point for a binary card.
 *
 * Shows the side's price in cents, which is the number a trader acts on — a
 * percentage and a price are the same figure here (a share pays $1), but cents
 * read as "what this costs" rather than "how likely this is".
 */
function SideButton({
  questionId,
  side,
  label,
  bps,
}: {
  questionId: bigint;
  side: 'yes' | 'no';
  label: string;
  bps: number;
}) {
  const yes = side === 'yes';
  return (
    <Link
      href={`/market/${questionId.toString()}?side=${side}`}
      aria-label={`Buy ${yes ? 'Yes' : 'No'} on ${label} at ${formatProbPct(bps)}`}
      className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-colors ${
        yes
          ? 'bg-yes-soft text-yes hover:brightness-95'
          : 'bg-no-soft text-no hover:brightness-95'
      }`}
    >
      <span>{yes ? 'Yes' : 'No'}</span>
      <span className="tabular-nums opacity-80">{centsLabel(bps)}</span>
    </Link>
  );
}

/** Price in cents, e.g. 6234 bps -> "62c". Clamped so bad reserves can't overflow. */
function centsLabel(bps: number): string {
  const clamped = Math.max(0, Math.min(10000, bps));
  return `${Math.round(clamped / 100)}c`;
}

/**
 * Card for a multi-outcome event: one row per member market, each row showing
 * that outcome's own probability and its own YES/NO entry points.
 *
 * Rows link to the individual binary market, which is where trading happens.
 * Only the first two outcomes get trade buttons — that keeps the card at a
 * scannable height and matches the leading-outcomes-first convention of other
 * prediction markets. The rest roll into "+N more", which opens the event.
 */
export function EventGroupCard({
  group,
  poolFor,
  nowSec,
  maxRows = 2,
  imageUrlFor,
}: {
  group: EventGroup;
  poolFor: (questionId: bigint) => Pool;
  nowSec: bigint;
  maxRows?: number;
  imageUrlFor?: ImageUrlFor;
}) {
  const rows = group.markets.slice(0, maxRows);
  const hidden = group.markets.length - rows.length;
  const countdown = formatCountdown(group.earliestResolution, nowSec);
  const primaryHref = `/market/${group.markets[0].market.questionId.toString()}`;

  return (
    <div className="flex h-full flex-col gap-3 rounded-card border border-edge bg-surface-raised p-3">
      <div className="flex items-start gap-2.5">
        <MarketAvatar
          questionId={group.markets[0].market.questionId}
          seed={group.key}
          text={group.title}
          size="md"
          imageUrl={imageUrlFor?.(group.markets[0].market.questionId) ?? null}
        />
        <div className="min-w-0 flex-1">
          <Link
            href={primaryHref}
            className="line-clamp-2 text-sm font-medium leading-snug text-content hover:underline"
          >
            {group.title}
          </Link>
          <p className="mt-1 flex items-center gap-1.5 text-2xs text-content-subtle">
            <span>{categoryLabel(group.category)}</span>
            <span aria-hidden="true">·</span>
            <span>{group.markets.length} outcomes</span>
          </p>
        </div>
        {group.allResolved ? (
          <Badge tone="brand">Resolved</Badge>
        ) : (
          <span className="shrink-0 text-2xs tabular-nums text-content-subtle">{countdown}</span>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((view) => (
          <OutcomeRow key={view.market.questionId.toString()} view={view} pool={poolFor(view.market.questionId)} />
        ))}
      </ul>

      {hidden > 0 && (
        <Link
          href={primaryHref}
          className="mt-auto text-2xs font-medium text-brand hover:underline"
        >
          +{hidden} more {hidden === 1 ? 'outcome' : 'outcomes'}
        </Link>
      )}
    </div>
  );
}

/**
 * One outcome inside an event card. The YES/NO buttons are links that preselect
 * the side on the detail page — trading always happens against that outcome's
 * own FPMM, never a shared pool.
 *
 * The outcome's exact on-chain name is shown, truncated rather than abbreviated,
 * with the full question as a tooltip.
 */
function OutcomeRow({ view, pool }: { view: MarketView; pool: Pool }) {
  const id = view.market.questionId;
  const label = view.outcomeLabel || 'Outcome';
  const noBps = 10000 - pool.yesBps;
  const resolved = view.market.resolved;

  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={view.fullQuestion}>
        {label}
      </span>
      <span className="shrink-0 text-xs font-semibold tabular-nums text-content">
        {pool.hasLiquidity ? formatProbPctCompact(pool.yesBps) : '—'}
      </span>
      {resolved ? (
        <Badge tone="brand">Resolved</Badge>
      ) : (
        <span className="flex shrink-0 gap-1">
          <RowSideButton questionId={id} side="yes" label={label} bps={pool.yesBps} />
          <RowSideButton questionId={id} side="no" label={label} bps={noBps} />
        </span>
      )}
    </li>
  );
}

/** Compact YES/NO for an outcome row. Wider tap target than plain text. */
function RowSideButton({
  questionId,
  side,
  label,
  bps,
}: {
  questionId: bigint;
  side: 'yes' | 'no';
  label: string;
  bps: number;
}) {
  const yes = side === 'yes';
  return (
    <Link
      href={`/market/${questionId.toString()}?side=${side}`}
      aria-label={`Buy ${yes ? 'Yes' : 'No'} on ${label} at ${formatProbPct(bps)}`}
      className={`rounded px-2 py-1 text-2xs font-semibold transition-colors ${
        yes ? 'bg-yes-soft text-yes hover:brightness-95' : 'bg-no-soft text-no hover:brightness-95'
      }`}
    >
      {yes ? 'Yes' : 'No'}
    </Link>
  );
}
