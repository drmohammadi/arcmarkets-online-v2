'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { Header } from '@/components/Header';
import { MarketCard, EventGroupCard } from '@/components/MarketCard';
import { FeaturedSlider } from '@/components/FeaturedSlider';
import { MarketToolbar, type SortKey, type StatusKey } from '@/components/MarketToolbar';
import { EmptyState, Skeleton } from '@/components/ui';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketPools } from '@/hooks/useMarketPools';
import { useHiddenMarkets } from '@/hooks/useMarketImage';
import { useMarketMetadataBatch } from '@/hooks/useMarketMetadata';
import { groupMarkets, type EventGroup } from '@/lib/eventGroups';
import { CATEGORIES, type CategoryKey } from '@/lib/marketMeta';

export default function HomePage() {
  const { isConnected } = useAccount();
  const { markets, isLoading } = useMarkets();
  const { poolFor, isLoading: poolsLoading } = useMarketPools(markets);
  const hidden = useHiddenMarkets();
  // One batched read for every card's on-chain image URL. Without this the
  // cards only see per-browser localStorage uploads and render the monogram for
  // every market whose image lives in the metadata registry.
  const metadata = useMarketMetadataBatch(markets.map((m) => m.questionId));

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryKey | 'all'>('all');
  const [status, setStatus] = useState<StatusKey>('open');
  const [sort, setSort] = useState<SortKey>('liquidity');

  // Held in state and set after mount so server and client render the same
  // markup on first paint (calling Date.now() during render breaks hydration).
  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));
  useEffect(() => {
    const tick = () => setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Hidden markets are dropped before grouping, so a hidden outcome also stops
  // contributing to its event's card, counts and featured ranking. Hiding is a
  // presentation filter only — see lib/hiddenMarkets.ts.
  const visibleMarkets = useMemo(
    () => (hidden.size === 0 ? markets : markets.filter((m) => !hidden.has(m.questionId.toString()))),
    [markets, hidden]
  );

  const groups = useMemo(() => groupMarkets(visibleMarkets), [visibleMarkets]);

  // Category counts are computed against the status filter only, so the chip
  // numbers stay meaningful while the user types a search.
  const statusFiltered = useMemo(() => groups.filter((g) => matchesStatus(g, status)), [groups, status]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of statusFiltered) c[g.category] = (c[g.category] ?? 0) + 1;
    return c;
  }, [statusFiltered]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return statusFiltered
      .filter((g) => category === 'all' || g.category === category)
      .filter((g) => (q ? matchesQuery(g, q) : true));
  }, [statusFiltered, category, query]);

  const sorted = useMemo(() => sortGroups(filtered, sort, poolFor), [filtered, sort, poolFor]);

  // Featured = the highest-liquidity open groups. Only shown on the unfiltered
  // default view, so it never contradicts an active search.
  const featured = useMemo(() => {
    if (query.trim() || category !== 'all' || status !== 'open') return [];
    const open = groups.filter((g) => !g.allResolved);
    return sortGroups(open, 'liquidity', poolFor).slice(0, 8);
  }, [groups, query, category, status, poolFor]);

  const loading = isLoading || (markets.length > 0 && poolsLoading);

  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-content sm:text-2xl">
            Prediction Markets
          </h1>
          <p className="mt-1 text-sm text-content-muted">
            {isConnected
              ? 'Trade YES or NO on any outcome. Settled in USDC on Arc.'
              : 'Browse freely — connect a wallet to trade. Settled in USDC on Arc.'}
          </p>
        </div>

        {loading && <LoadingGrid />}

        {!loading && groups.length === 0 && (
          <EmptyState
            title="No markets yet"
            hint="Deploy the contracts and create a market from the admin page to get started."
          />
        )}

        {!loading && groups.length > 0 && (
          <>
            {/*
             * Toolbar sits above Featured: the carousel is withheld once any
             * filter is active, so putting the controls first keeps them
             * anchored instead of jumping up under the user's cursor.
             */}
            <MarketToolbar
              query={query}
              onQuery={setQuery}
              category={category}
              onCategory={setCategory}
              status={status}
              onStatus={setStatus}
              sort={sort}
              onSort={setSort}
              counts={counts}
              resultCount={statusFiltered.length}
            />

            {featured.length > 0 && (
              <FeaturedSlider
                groups={featured}
                poolFor={poolFor}
                nowSec={nowSec}
                imageUrlFor={metadata.imageUrlFor}
              />
            )}

            {sorted.length === 0 ? (
              <EmptyState
                title="No markets match your filters"
                hint="Try a different search term, category, or status."
              />
            ) : (
              <section aria-labelledby="all-markets-heading">
                <h2
                  id="all-markets-heading"
                  className="mb-3 text-lg font-semibold tracking-tight text-content"
                >
                  All markets
                  <span className="ml-2 text-sm font-normal tabular-nums text-content-subtle">
                    {sorted.length}
                  </span>
                </h2>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {sorted.map((g) => (
                    <li key={g.key} className="animate-fade-in">
                      {g.isMultiOutcome ? (
                        <EventGroupCard
                          group={g}
                          poolFor={poolFor}
                          nowSec={nowSec}
                          imageUrlFor={metadata.imageUrlFor}
                        />
                      ) : (
                        <MarketCard
                          group={g}
                          pool={poolFor(g.markets[0].market.questionId)}
                          nowSec={nowSec}
                          imageUrlFor={metadata.imageUrlFor}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function matchesStatus(g: EventGroup, status: StatusKey): boolean {
  if (status === 'all') return true;
  return status === 'resolved' ? g.allResolved : !g.allResolved;
}

/** Search matches the event title, any outcome label, and the category name. */
function matchesQuery(g: EventGroup, q: string): boolean {
  if (g.title.toLowerCase().includes(q)) return true;
  const catLabel = CATEGORIES.find((c) => c.key === g.category)?.label ?? '';
  if (catLabel.toLowerCase().includes(q)) return true;
  return g.markets.some(
    (m) =>
      m.outcomeLabel.toLowerCase().includes(q) || m.fullQuestion.toLowerCase().includes(q)
  );
}

function sortGroups(
  groups: EventGroup[],
  sort: SortKey,
  poolFor: (id: bigint) => { liquidity: bigint }
): EventGroup[] {
  const copy = [...groups];
  if (sort === 'liquidity') {
    copy.sort((a, b) => {
      const la = totalLiquidity(a, poolFor);
      const lb = totalLiquidity(b, poolFor);
      return la < lb ? 1 : la > lb ? -1 : 0;
    });
  } else if (sort === 'ending') {
    copy.sort((a, b) =>
      a.earliestResolution < b.earliestResolution
        ? -1
        : a.earliestResolution > b.earliestResolution
          ? 1
          : 0
    );
  } else {
    // Newest = highest questionId first.
    copy.sort((a, b) => {
      const ma = maxQuestionId(a);
      const mb = maxQuestionId(b);
      return ma < mb ? 1 : ma > mb ? -1 : 0;
    });
  }
  return copy;
}

function totalLiquidity(g: EventGroup, poolFor: (id: bigint) => { liquidity: bigint }): bigint {
  return g.markets.reduce((sum, m) => sum + poolFor(m.market.questionId).liquidity, BigInt(0));
}

function maxQuestionId(g: EventGroup): bigint {
  let max = g.markets[0].market.questionId;
  for (const m of g.markets) if (m.market.questionId > max) max = m.market.questionId;
  return max;
}

function LoadingGrid() {
  return (
    <div>
      <Skeleton className="mb-6 h-8 w-40" />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i}>
            {/* Matches the real card height, which grew when the quick-trade
                YES/NO row was added. A short skeleton makes the grid jump. */}
            <Skeleton className="h-[150px] w-full rounded-card" />
          </li>
        ))}
      </ul>
    </div>
  );
}
