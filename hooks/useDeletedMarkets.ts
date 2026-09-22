'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * The set of markets removed from the app, shared by every visitor.
 *
 * Replaces `useHiddenMarkets`, which read `localStorage` — so a removal applied
 * only to the browser that made it, and clearing site data undid it. The
 * authority is now `market_admin_flags` in Postgres, written only through a
 * signed admin request.
 *
 * `staleTime` is non-zero and `placeholderData` keeps the previous set, so a
 * transient failure serves the last known good answer instead of briefly
 * flashing removed markets back into the grid. The route itself degrades to an
 * empty set on a database outage (fail-open, documented there), so this hook
 * surfaces `degraded` and lets callers say so rather than pretending.
 *
 * WHAT MUST NOT CONSUME THIS: a wallet's own holdings. `PortfolioPanel`
 * deliberately does not filter positions by this set — money a wallet is owed
 * must not vanish because an admin curated a list. Removed markets are badged
 * there instead.
 */

const FLAGS_STALE_MS = 60_000;

export interface DeletedMarkets {
  /** questionId strings. Empty while loading or degraded. */
  deleted: Set<string>;
  isLoading: boolean;
  /** True when the flag store could not be read; callers should not claim completeness. */
  degraded: boolean;
  refresh: () => void;
}

async function fetchDeleted(): Promise<{ ids: string[]; degraded: boolean }> {
  const res = await fetch('/api/markets/flags', { headers: { accept: 'application/json' } });
  if (!res.ok) return { ids: [], degraded: true };

  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') return { ids: [], degraded: true };

  const raw = (body as { deleted?: unknown }).deleted;
  const meta = (body as { meta?: { degraded?: unknown } }).meta;
  const degraded = meta?.degraded === true;
  if (!Array.isArray(raw)) return { ids: [], degraded: true };

  // Validate each id rather than trusting the payload: these strings are used
  // as map keys against on-chain questionIds.
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && /^\d{1,20}$/.test(v)) ids.push(v);
  }
  return { ids, degraded };
}

export function useDeletedMarkets(): DeletedMarkets {
  const { data, isLoading, refetch } = useQuery<{ ids: string[]; degraded: boolean }, Error>({
    queryKey: ['arc', 'market-flags'],
    staleTime: FLAGS_STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (prev) => prev,
    queryFn: fetchDeleted,
  });

  return {
    deleted: new Set(data?.ids ?? []),
    isLoading,
    degraded: data?.degraded === true,
    refresh: () => {
      void refetch();
    },
  };
}
