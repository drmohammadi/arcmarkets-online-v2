/**
 * Resolution-time formatting.
 *
 * Chain timestamps are seconds as bigint and are attacker-influenced only
 * within block-timestamp drift, but they can still be absurd (0, or far future),
 * so every helper validates before formatting and never throws.
 */

const SEC = BigInt(1);
const MIN = BigInt(60);
const HOUR = BigInt(3600);
const DAY = BigInt(86400);

/** True when the timestamp is a plausible Unix seconds value we can render. */
export function isPlausibleTimestamp(ts: bigint): boolean {
  // 2000-01-01 .. 2200-01-01, generous but excludes 0 and overflow garbage.
  return ts > BigInt(946684800) && ts < BigInt(7258118400);
}

/** Absolute date, e.g. "Mar 14, 2026". Returns "unknown" when implausible. */
export function formatResolutionDate(ts: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Absolute date + time, for the detail page. */
export function formatResolutionDateTime(ts: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Compact countdown, e.g. "3d", "5h", "12m", or "ended".
 * `nowSec` is injected so callers can keep it in state and avoid
 * server/client hydration mismatches from calling Date.now() during render.
 */
export function formatCountdown(ts: bigint, nowSec: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'unknown';
  if (ts <= nowSec) return 'ended';
  const delta = ts - nowSec;
  if (delta >= DAY) return `${delta / DAY}d`;
  if (delta >= HOUR) return `${delta / HOUR}h`;
  if (delta >= MIN) return `${delta / MIN}m`;
  return `${delta / SEC}s`;
}

/** Longer countdown for the detail page, e.g. "3d 4h left". */
export function formatTimeLeft(ts: bigint, nowSec: bigint): string {
  if (!isPlausibleTimestamp(ts)) return 'Resolution time unknown';
  if (ts <= nowSec) return 'Resolution time reached';
  const delta = ts - nowSec;
  const days = delta / DAY;
  const hours = (delta % DAY) / HOUR;
  const mins = (delta % HOUR) / MIN;
  if (days > BigInt(0)) return `${days}d ${hours}h left`;
  if (hours > BigInt(0)) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/** Short axis label for the chart, e.g. "Mar 14" or "14:30" for intraday. */
export function formatChartTick(ts: number, intraday: boolean): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return intraday
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full tooltip timestamp for a chart point. */
export function formatChartStamp(ts: number): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Relative time for a past event, e.g. "just now", "5m ago", "3d ago".
 *
 * Used for comment timestamps, which come from `block.timestamp` in the Social
 * registry — a storage read, not a `getBlock` call, so this does not
 * reintroduce the per-block timestamp fetching the chart deliberately avoids.
 *
 * Built on Intl.RelativeTimeFormat, which is native in every browser this app
 * supports; no date library is needed (and DEPENDENCIES.md rejects adding one).
 *
 * `nowSec` is injected rather than read from Date.now() so callers can hold it
 * in state and avoid a server/client hydration mismatch, exactly as
 * formatCountdown does.
 *
 * Total: never throws. Implausible or future timestamps degrade to a sensible
 * string rather than producing "in -3 days".
 */
export function formatRelativeTime(ts: number, nowSec: bigint): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const now = Number(nowSec);
  if (!Number.isFinite(now) || now <= 0) return '';

  // A timestamp slightly ahead of our clock is normal (block drift); treat any
  // future stamp as "just now" rather than showing a negative age.
  const delta = now - ts;
  if (delta < 60) return 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
    for (const [unit, seconds] of units) {
      if (delta >= seconds) {
        return rtf.format(-Math.floor(delta / seconds), unit);
      }
    }
    return 'just now';
  } catch {
    // Intl unavailable or a bad locale: a coarse fallback beats an exception.
    return `${Math.floor(delta / 60)}m ago`;
  }
}

/** Absolute timestamp for a comment's title attribute. */
export function formatAbsoluteTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
