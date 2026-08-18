'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { Disclaimer } from '@/components/ProfileView';
import { EmptyState, Skeleton } from '@/components/ui';
import { StaleNotice } from '@/components/StaleNotice';
import { useTradeStats } from '@/hooks/useTradeStats';
import { useUsernames } from '@/hooks/useSocial';
import { formatUsdc, formatUsdcSigned } from '@/lib/format';
import { shortAddress } from '@/lib/sanitize';
import type { UserStats } from '@/lib/ledger';

type SortMode = 'volume' | 'pnl';

/**
 * All traders, ranked.
 *
 * The data source is the shared trade sweep, which is anchored at the factory's
 * deployment block — so once it completes, this ranks every trade that has ever
 * gone through the market maker, and `stats.complete` says so rather than hedging.
 * While it is still working back, the page says THAT instead of claiming there are
 * no trades: an empty ranking used to read as "nobody has ever traded", which was
 * the reported bug and was false on a chain with plenty of activity.
 *
 * Ordering defaults to VOLUME, deliberately: volume is a direct sum of event
 * amounts and is exact even under partial coverage, whereas total PnL depends on a
 * cost basis an incomplete scan may not have reached yet. The PnL toggle is there,
 * but a PnL ranking that silently ignores older losses is worse than none.
 */
export default function LeaderboardPage() {
  const stats = useTradeStats();
  const [sort, setSort] = useState<SortMode>('volume');

  // Usernames are resolved in one batched call; names are attacker-controlled
  // and sanitized inside useUsernames.
  const names = useUsernames(stats.leaderboard.map((u) => u.trader));

  const rows = useMemo(() => {
    const sorted = [...stats.leaderboard];
    if (sort === 'volume') {
      sorted.sort((a, b) => (a.volume < b.volume ? 1 : a.volume > b.volume ? -1 : 0));
    } else {
      sorted.sort((a, b) => (a.total < b.total ? 1 : a.total > b.total ? -1 : 0));
    }
    return sorted.slice(0, 100);
  }, [stats.leaderboard, sort]);

  // Skip mounting the ranking until after hydration so the client-side sort
  // cannot mismatch a server render (the page is a client component, but keep
  // the convention the rest of the app uses).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-content sm:text-2xl">
          Leaderboard
        </h1>
        <p className="mb-6 text-sm text-content-muted">
          Top traders on Arc by volume and profit.
        </p>

        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex gap-0.5 rounded-md border border-edge p-0.5">
            {(['volume', 'pnl'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSort(mode)}
                aria-pressed={sort === mode}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  sort === mode
                    ? 'bg-content text-surface'
                    : 'text-content-muted hover:text-content'
                }`}
              >
                {mode === 'volume' ? 'Volume' : 'Total PnL'}
              </button>
            ))}
          </div>
          {stats.partial && (
            <span className="text-2xs text-warn">Scan incomplete — refreshing</span>
          )}
        </div>

        {mounted && stats.stale && <StaleNotice onRetry={stats.refresh} />}

        {!mounted || stats.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-card" />
            <Skeleton className="h-12 w-full rounded-card" />
            <Skeleton className="h-12 w-full rounded-card" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={stats.complete ? 'No trades yet' : 'Still scanning trade history'}
            hint={
              stats.complete
                ? 'Nobody has traded through the market maker on this chain yet. Trade something to appear here.'
                : 'The scan is working back through the chain and this page fills in as it goes. Reload in a moment.'
            }
          />
        ) : (
          <div className="overflow-hidden rounded-card border border-edge">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-sunken text-2xs uppercase tracking-wide text-content-subtle">
                <tr>
                  <th scope="col" className="w-14 px-3 py-2 font-medium">#</th>
                  <th scope="col" className="px-3 py-2 font-medium">Trader</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Volume</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">PnL</th>
                  <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                    Trades
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u, i) => (
                  <Row key={u.trader} user={u} rank={i + 1} name={names.nameFor(u.trader)} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-2xs text-content-subtle">
          {stats.complete
            ? 'Covers every trade since this market factory was deployed. Volumes are exact.'
            : 'Ranks addresses seen so far. Volumes are exact; PnL may be understated while a trader’s opening buys are still being scanned.'}
        </p>

        <Disclaimer
          partial={stats.partial}
          lookback={stats.lookbackBlocks}
          complete={stats.complete}
        />
      </div>
    </main>
  );
}

function Row({ user, rank, name }: { user: UserStats; rank: number; name: string }) {
  const topThree = rank <= 3;
  return (
    <tr className="border-t border-edge">
      <td className="px-3 py-2">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold tabular-nums ${
            topThree ? 'bg-brand-muted text-brand' : 'bg-surface-sunken text-content-muted'
          }`}
        >
          {rank}
        </span>
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/profile/${user.trader}`}
          className="text-content transition-colors hover:text-brand"
        >
          <span className="font-medium">{name}</span>
          <span className="ml-1.5 font-mono text-2xs text-content-subtle">
            {shortAddress(user.trader)}
          </span>
        </Link>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-content">
        ${formatUsdc(user.volume)}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${
          user.total > BigInt(0) ? 'text-yes' : user.total < BigInt(0) ? 'text-no' : 'text-content-muted'
        }`}
      >
        {/* formatUsdcSigned already carries its own leading sign. */}
        {formatUsdcSigned(user.total)}
      </td>
      <td className="hidden px-3 py-2 text-right tabular-nums text-content-muted sm:table-cell">
        {user.tradeCount}
      </td>
    </tr>
  );
}
