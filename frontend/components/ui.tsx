'use client';

/**
 * Shared presentational primitives. Kept in one file because each is small and
 * they are always imported together; splitting them would add churn without
 * improving testability.
 *
 * None of these accept raw HTML — all text goes in as children/props and is
 * rendered as escaped text nodes.
 */

import { useEffect, useState } from 'react';
import { accentFor, monogramFor } from '@/lib/marketMeta';
import { formatProbPct } from '@/lib/pricing';
import { useMarketImage } from '@/hooks/useMarketImage';

const ICON_DIMS = {
  sm: 'h-8 w-8 text-2xs',
  md: 'h-10 w-10 text-xs',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-xl',
  '2xl': 'h-20 w-20 text-2xl',
  // Featured rail. Steps up on wider screens so the hero image reads as a hero
  // rather than a slightly-bigger list icon.
  '3xl': 'h-24 w-24 text-3xl sm:h-28 sm:w-28',
} as const;

export type IconSize = keyof typeof ICON_DIMS;

/**
 * Deterministic monogram icon for a market or event, with an optional image
 * layered on top.
 *
 * `src` may be either:
 *   - a validated data URL from lib/marketImages (re-encoded through a canvas,
 *     re-checked on every read), or
 *   - an https URL from the on-chain metadata registry, validated by
 *     safeImageUrl.
 *
 * A remote URL is fetched by the viewer's browser from a third party, so it is
 * treated as unreliable rather than trusted: `referrerPolicy="no-referrer"`
 * withholds which market is being viewed, the fixed box plus object-cover means
 * a hostile aspect ratio cannot disturb layout, and a load failure falls back to
 * the generated monogram so a dead link never renders as a broken image.
 */
export function MarketIcon({
  seed,
  text,
  size = 'md',
  src = null,
}: {
  seed: string;
  text: unknown;
  size?: IconSize;
  /** Validated data URL or https URL, or null to render the generated monogram. */
  src?: string | null;
}) {
  const dims = ICON_DIMS[size] ?? ICON_DIMS.md;
  // Reset per src so a previously-failed URL doesn't suppress a new, good one.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- src is either a
      // data: URL from our own canvas re-encode or an arbitrary third-party
      // https URL; next/image can optimize neither, and routing untrusted
      // remote URLs through the Next image proxy would make our server fetch
      // them on the viewer's behalf.
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`inline-block shrink-0 rounded-lg border border-edge object-cover object-center ${dims}`}
      />
    );
  }

  const accent = accentFor(seed);
  const mono = monogramFor(text);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ring-1 ${dims} ${accent.bg} ${accent.fg} ${accent.ring}`}
    >
      {mono}
    </span>
  );
}

/**
 * MarketIcon that looks up its own stored image by questionId.
 *
 * Use this inside lists: a row rendered in a `.map()` cannot call a hook
 * itself, so the lookup is encapsulated here instead of threading an image map
 * down through every card component.
 *
 * `imageUrl` (the shared, on-chain one) takes precedence over the per-browser
 * localStorage upload when both exist, because it is the value every visitor
 * sees. The localStorage path is kept as a fallback so images uploaded before
 * the registry existed do not vanish.
 *
 * It is passed in rather than read here on purpose: reading it per row would be
 * one contract call per market. Callers fetch them in a single batch instead.
 */
export function MarketAvatar({
  questionId,
  seed,
  text,
  size = 'md',
  imageUrl = null,
}: {
  questionId: bigint | null;
  seed: string;
  text: unknown;
  size?: IconSize;
  /** Shared on-chain image URL, if the caller has one. */
  imageUrl?: string | null;
}) {
  const stored = useMarketImage(questionId);
  return <MarketIcon seed={seed} text={text} size={size} src={imageUrl ?? stored} />;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'yes' | 'no' | 'brand' | 'warn';
}) {
  const tones = {
    neutral: 'bg-surface-sunken text-content-muted',
    yes: 'bg-yes-soft text-yes',
    no: 'bg-no-soft text-no',
    brand: 'bg-brand-muted text-brand',
    warn: 'bg-surface-sunken text-warn',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Horizontal YES/NO probability bar. The numeric value is always rendered as
 * text next to it, so the bar is decoration and colour is never the only cue.
 */
export function ProbabilityBar({ yesBps, showLabels = false }: { yesBps: number; showLabels?: boolean }) {
  const pct = Math.max(0, Math.min(100, yesBps / 100));
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-no/25"
        role="img"
        aria-label={`YES ${formatProbPct(yesBps)}, NO ${formatProbPct(10000 - yesBps)}`}
      >
        <div className="h-full rounded-full bg-yes transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {showLabels && (
        <div className="mt-1 flex justify-between text-2xs text-content-subtle">
          <span>YES {formatProbPct(yesBps)}</span>
          <span>NO {formatProbPct(10000 - yesBps)}</span>
        </div>
      )}
    </div>
  );
}

/** Neutral loading placeholder that respects reduced-motion via globals.css. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-surface-sunken ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-black/5 to-transparent dark:via-white/5" />
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-edge px-6 py-12 text-center">
      <p className="font-medium text-content">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-content-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Inline error panel. Message is plain text; callers sanitize before passing. */
export function ErrorNote({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-no/30 bg-no-soft px-3 py-2 text-xs text-no"
    >
      {message}
    </p>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-content-muted">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge-strong border-t-brand"
      />
      <span>{label}</span>
    </span>
  );
}
