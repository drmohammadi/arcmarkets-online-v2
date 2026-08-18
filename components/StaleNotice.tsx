'use client';

import { useEffect, useState } from 'react';

/**
 * "Showing last known data" banner, with a retry.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every read path in this app degrades to a placeholder instead of throwing, so
 * a rate-limited or slow RPC produces a page full of zeros rather than an error.
 * That is the right failure mode — a partial page beats a blank one — but on its
 * own it is dishonest: "$0.00" and "no positions" are indistinguishable from the
 * truth. This states which of the two the user is looking at.
 *
 * Rendered only when there IS cached data to fall back on (`stale`), so it never
 * appears during a normal first load, which is what the skeletons are for.
 */
export function StaleNotice({ onRetry }: { onRetry?: () => void }) {
  // Debounce the retry so an impatient double-click cannot queue two full
  // refetches at the moment the endpoint is already asking us to slow down.
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!retrying) return;
    const id = setTimeout(() => setRetrying(false), 3000);
    return () => clearTimeout(id);
  }, [retrying]);

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2"
    >
      <p className="text-2xs text-warn">
        Showing the last data we loaded — the network is slow or rate-limited right now.
      </p>
      {onRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            onRetry();
          }}
          className="rounded border border-edge px-2 py-0.5 text-2xs font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
