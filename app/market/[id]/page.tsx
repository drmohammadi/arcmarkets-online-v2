'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { Header } from '@/components/Header';
import { PriceChart } from '@/components/PriceChart';
import { TradePanel } from '@/components/TradePanel';
import { Comments } from '@/components/Comments';
import { MarketIcon, Badge, ProbabilityBar, EmptyState, Skeleton, ErrorNote } from '@/components/ui';
import { useMarket } from '@/hooks/useMarket';
import { useMarkets } from '@/hooks/useMarkets';
import { useMarketPools } from '@/hooks/useMarketPools';
import { usePosition } from '@/hooks/usePosition';
import { useTradeHistory } from '@/hooks/useTradeHistory';
import { useMarketImage, useHiddenMarkets } from '@/hooks/useMarketImage';
import { useMarketMetadata } from '@/hooks/useMarketMetadata';
import { conditionalTokensAbi } from '@/lib/abis';
import { sanitizeText, shortAddress } from '@/lib/sanitize';
import { formatUsdc, formatUsdcCompact } from '@/lib/format';
import { yesProbBps, formatProbPct, sharePriceUsdc } from '@/lib/pricing';
import { categoryLabel, normalizeCategory } from '@/lib/marketMeta';
import { groupMarkets, findGroupFor, parseQuestion } from '@/lib/eventGroups';
import { formatResolutionDateTime, formatTimeLeft } from '@/lib/time';

export default function MarketPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const rawId = params?.id as string | undefined;
  // Route param must be a plain non-negative integer of sane length.
  const validId = typeof rawId === 'string' && /^\d{1,18}$/.test(rawId);
  const routeQuestionId = validId ? BigInt(rawId) : null;

  /**
   * The outcome currently being viewed.
   *
   * A multi-outcome "event" is N independent binary markets, so switching
   * outcome means pointing every hook below at a different questionId — there
   * is no shared pool to re-slice. Holding it in state (rather than navigating)
   * is what lets the chart, odds, position and trade panel update in place.
   *
   * Seeded from the route and re-seeded whenever the route changes, so a direct
   * link, a back/forward navigation and an in-page click all agree.
   */
  const [selectedId, setSelectedId] = useState<bigint | null>(routeQuestionId);
  const routeKey = routeQuestionId === null ? '' : routeQuestionId.toString();
  useEffect(() => {
    setSelectedId(routeKey === '' ? null : BigInt(routeKey));
  }, [routeKey]);

  const questionId = selectedId;

  const market = useMarket(questionId);
  const { markets } = useMarkets();
  const { poolFor } = useMarketPools(markets);
  const position = usePosition(market.fpmm, market.conditionalTokens);
  const storedImage = useMarketImage(questionId);
  const metadata = useMarketMetadata(questionId);
  // Shared on-chain image wins over the per-browser localStorage upload.
  const marketImage = metadata.imageUrl ?? storedImage;

  /**
   * Outcomes removed by the owner must not appear in this event's outcome list.
   *
   * This page previously grouped the RAW market list, so a deleted outcome stayed
   * in the Outcomes list here even though the home page and its event card had
   * already dropped it — the deletion looked like it had only half applied.
   * `useHiddenMarkets` is the same source the home page filters on and it
   * re-reads on the change event, so a removal takes effect immediately, in this
   * tab, without a reload.
   *
   * A removed outcome is excluded unconditionally, INCLUDING the one being
   * viewed. That is what makes it vanish from the list rather than lingering as
   * the group's own entry. The page itself keeps working: everything it renders
   * comes from `useMarket`, not from the group, so a direct link to a removed
   * market still shows its price, position and Redeem button. That matters —
   * `MarketFactory` has no delete (see lib/hiddenMarkets.ts), so the market and
   * any shares outstanding against it are still very much on-chain.
   */
  const hidden = useHiddenMarkets();
  const visibleMarkets = useMemo(
    () =>
      hidden.size === 0
        ? markets
        : markets.filter((m) => !hidden.has(m.questionId.toString())),
    [markets, hidden]
  );

  /** True when the outcome on screen has itself been removed from the lists. */
  const viewingHidden = questionId !== null && hidden.has(questionId.toString());

  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));
  useEffect(() => {
    const tick = () => setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Implied YES probability from the live pool. Computed here (rather than at
  // its first render use, further down) because the trade-history hook needs it:
  // it appends the live price as the chart's final point, so the line is correct
  // at the right-hand edge even when no trade logs could be fetched.
  const yesBps = yesProbBps(market.reserveYes, market.reserveNo);

  // The chart API is keyed by question id, so the hook needs it to read history
  // from the indexer; without it the hook would only ever have its RPC fallback.
  // This is the same id `useMarket` above was pointed at — including after an
  // in-page outcome switch — so the history and the live price always agree.
  const history = useTradeHistory(market.fpmm, yesBps, questionId ?? undefined);

  const group = useMemo(() => {
    if (questionId === null || visibleMarkets.length === 0) return null;
    return findGroupFor(groupMarkets(visibleMarkets), questionId);
  }, [visibleMarkets, questionId]);

  // Re-read the user's balances after a trade or redemption, and pull the new
  // trade into the chart. The history hook no longer polls (that was the source
  // of the RPC rate limiting), so this explicit refresh is what keeps the chart
  // current; it resumes from the cached block tail rather than rescanning.
  //
  // Depends on the two FUNCTION references, not on the hook result objects:
  // those are new identities every render, and PositionCard calls this from an
  // effect that keys on it while isSuccess stays true — an unstable callback
  // there would loop forever and hammer the RPC.
  const refetchPosition = position.refetch;
  const refreshHistory = history.refresh;
  const refetchAll = useCallback(() => {
    refetchPosition();
    refreshHistory();
  }, [refetchPosition, refreshHistory]);

  /**
   * Switch which outcome of the event is being viewed.
   *
   * Uses replaceState rather than router.push on purpose: clicking through five
   * outcomes should not put five entries in the back stack, and a full Next
   * navigation would remount the tree and refetch everything that is already in
   * the react-query cache. The URL still updates, so the page stays copyable and
   * a reload lands on the same outcome.
   */
  const selectOutcome = useCallback(
    (id: bigint) => {
      setSelectedId(id);
      if (typeof window === 'undefined') return;
      try {
        // Preserve ?side= so a quick-buy deep link keeps its preselected side.
        const side = searchParams?.get('side');
        const query = side === 'no' || side === 'yes' ? `?side=${side}` : '';
        window.history.replaceState(null, '', `/market/${id.toString()}${query}`);
      } catch {
        // A blocked history API must not break the in-page switch; the state
        // change above is what actually drives the UI.
      }
    },
    [searchParams]
  );

  if (!validId) {
    return (
      <Shell>
        <EmptyState
          title="Invalid market link"
          hint="That market id isn't a valid number."
          action={<BackLink />}
        />
      </Shell>
    );
  }

  if (market.isLoading) {
    return (
      <Shell>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Skeleton className="h-20 w-full rounded-card" />
            <Skeleton className="h-[260px] w-full rounded-card" />
          </div>
          <Skeleton className="h-[420px] w-full rounded-card" />
        </div>
      </Shell>
    );
  }

  if (!market.exists) {
    return (
      <Shell>
        <EmptyState
          title="Market not found"
          hint="This market doesn't exist on the connected network."
          action={<BackLink />}
        />
      </Shell>
    );
  }

  const fullQuestion = sanitizeText(market.question) || 'Untitled market';
  const parsed = parseQuestion(market.question);
  const isGrouped = !!group?.isMultiOutcome;
  const heading = isGrouped ? parsed.outcomeLabel : fullQuestion;
  const eventTitle = isGrouped ? group.title : null;

  const hasLiquidity = market.reserveYes + market.reserveNo > BigInt(0);
  const category = normalizeCategory(market.category, market.question);
  const liquidity =
    market.reserveYes < market.reserveNo ? market.reserveYes : market.reserveNo;

  // ?side=no preselects NO on the trade panel from a card's quick-buy link.
  const sideParam = searchParams?.get('side');
  const initialOutcome: 0 | 1 = sideParam === 'no' ? 1 : 0;

  return (
    <Shell>
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-content-subtle">
        <Link href="/" className="hover:text-content">
          Markets
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate text-content-muted">{eventTitle ?? heading}</span>
      </nav>

      {/*
        Viewing an outcome that has been removed from the lists.
        Stated rather than silently rendered: the page looks completely normal
        otherwise, and someone arriving from an old link deserves to know why it
        is no longer listed — especially since it is still tradable and, if they
        hold shares, still redeemable.
      */}
      {viewingHidden && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-2xs text-content-muted"
        >
          This outcome has been removed from the market lists. It stays on-chain and reachable by
          this link, so any shares you hold can still be sold or redeemed.
        </div>
      )}

      {/* Header */}
      <div className="mb-5 flex items-start gap-3">
        <MarketIcon
          seed={market.fpmm ?? fullQuestion}
          text={eventTitle ?? fullQuestion}
          size="lg"
          src={marketImage}
        />
        <div className="min-w-0 flex-1">
          {eventTitle && (
            <p className="text-xs font-medium text-content-muted">{eventTitle}</p>
          )}
          <h1 className="text-lg font-semibold leading-tight tracking-tight text-content sm:text-xl">
            {heading}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-subtle">
            <Badge tone="neutral">{categoryLabel(category)}</Badge>
            {market.resolved ? (
              <Badge tone="brand">Resolved</Badge>
            ) : (
              <span>{formatTimeLeft(market.resolutionTime, nowSec)}</span>
            )}
            <span>Resolves {formatResolutionDateTime(market.resolutionTime)}</span>
            <span>Liquidity ${formatUsdcCompact(liquidity)}</span>
            <span>Resolver {shortAddress(market.resolver)}</span>
          </div>
        </div>
      </div>

      {/* Two-column on desktop, stacked on mobile. Trade panel sticks on scroll. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="min-w-0 space-y-4">
          <PriceChart
            points={history.points}
            isLoading={history.isLoading}
            degraded={history.degraded}
            complete={history.complete}
            currentBps={yesBps}
          />

          {/* Outcome switcher, directly under the chart it drives. */}
          {isGrouped && group && (
            <OutcomeList
              group={group}
              activeId={questionId}
              poolFor={poolFor}
              onSelect={selectOutcome}
            />
          )}

          {/* Current odds summary */}
          <div className="rounded-card border border-edge bg-surface-raised p-4">
            <div className="mb-3 grid grid-cols-2 gap-3">
              <OddsTile label="Yes" bps={yesBps} tone="yes" />
              <OddsTile label="No" bps={10000 - yesBps} tone="no" />
            </div>
            <ProbabilityBar yesBps={yesBps} showLabels />
            {!hasLiquidity && (
              <p className="mt-3 text-2xs text-warn">
                No liquidity in this pool yet — the 50/50 split shown is a placeholder, not a
                market price.
              </p>
            )}
          </div>

          {(metadata.descriptionParagraphs.length > 0 || metadata.resolutionSource) && (
            <MarketDescription
              paragraphs={metadata.descriptionParagraphs}
              resolutionSource={metadata.resolutionSource}
            />
          )}

          <PositionCard
            yesShares={position.yesShares}
            noShares={position.noShares}
            resolved={market.resolved}
            conditionalTokens={market.conditionalTokens}
            collateralToken={market.collateralToken}
            conditionId={market.conditionId as `0x${string}` | undefined}
            onRedeemed={refetchAll}
          />

          {questionId !== null && <Comments questionId={questionId} />}
        </div>

        <div className="lg:sticky lg:top-4">
          <TradePanel
            /*
             * Keyed by market: the panel holds an amount, a mode and a quote
             * that are only meaningful against one pool. Switching outcome must
             * reset that state, or a leftover amount would be quoted against a
             * different market's reserves.
             */
            key={questionId?.toString() ?? 'none'}
            fpmm={market.fpmm}
            collateralToken={market.collateralToken}
            conditionalTokens={market.conditionalTokens}
            yesBps={yesBps}
            resolved={market.resolved}
            hasLiquidity={hasLiquidity}
            initialOutcome={initialOutcome}
            yesShares={position.yesShares}
            noShares={position.noShares}
            onTraded={refetchAll}
          />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/" className="text-sm font-medium text-brand hover:underline">
      Back to markets
    </Link>
  );
}

/**
 * Admin-written market rules, read from the on-chain metadata registry.
 *
 * `paragraphs` has already been through sanitizeMultiline, so each entry is
 * plain text with controls, zero-width and bidi-override characters removed.
 * They are rendered as separate <p> text nodes — React escapes those — which is
 * why this needs no dangerouslySetInnerHTML despite being multi-paragraph.
 */
function MarketDescription({
  paragraphs,
  resolutionSource,
}: {
  paragraphs: string[];
  resolutionSource: string;
}) {
  return (
    <section
      aria-labelledby="market-about"
      className="rounded-card border border-edge bg-surface-raised p-4"
    >
      <h2
        id="market-about"
        className="mb-2 text-2xs font-medium uppercase tracking-wide text-content-subtle"
      >
        About this market
      </h2>

      {paragraphs.length > 0 ? (
        <div className="space-y-2">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-content-muted">
              {p}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-content-subtle">No description has been added yet.</p>
      )}

      {resolutionSource && (
        <p className="mt-3 border-t border-edge pt-3 text-2xs text-content-subtle">
          <span className="font-medium text-content-muted">Resolution source: </span>
          {resolutionSource}
        </p>
      )}
    </section>
  );
}

function OddsTile({ label, bps, tone }: { label: string; bps: number; tone: 'yes' | 'no' }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-content-subtle">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone === 'yes' ? 'text-yes' : 'text-no'}`}>
        {formatProbPct(bps)}
      </p>
      <p className="text-2xs tabular-nums text-content-subtle">${sharePriceUsdc(bps)} per share</p>
    </div>
  );
}

/**
 * Every outcome in the event, as an in-page switcher.
 *
 * Rows are BUTTONS, not links: selecting an outcome re-points the page's hooks
 * rather than navigating, so the chart, odds, position and trade panel all
 * update without a reload. The URL is still kept in sync by the caller, so the
 * page remains linkable and reloads to the same outcome.
 *
 * Every member market is listed — this is the one place a trader can compare
 * the full field, so truncating it would defeat the purpose.
 */
function OutcomeList({
  group,
  activeId,
  poolFor,
  onSelect,
}: {
  group: NonNullable<ReturnType<typeof findGroupFor>>;
  activeId: bigint | null;
  poolFor: (id: bigint) => { yesBps: number; hasLiquidity: boolean };
  onSelect: (id: bigint) => void;
}) {
  return (
    <section className="rounded-card border border-edge bg-surface-raised p-4">
      <h2 className="mb-3 text-sm font-semibold text-content">
        Outcomes
        <span className="ml-1.5 text-2xs font-normal text-content-subtle">
          each trades as its own YES/NO market
        </span>
      </h2>
      <ul className="space-y-1">
        {group.markets.map((v) => {
          const id = v.market.questionId;
          const pool = poolFor(id);
          const active = activeId !== null && id === activeId;
          return (
            <li key={id.toString()}>
              <button
                type="button"
                onClick={() => onSelect(id)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                  active
                    ? 'bg-surface-sunken ring-1 ring-brand'
                    : 'hover:bg-surface-sunken'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-content">
                  {v.outcomeLabel}
                </span>
                {v.market.resolved && <Badge tone="brand">Resolved</Badge>}
                <span className="w-24 shrink-0">
                  <ProbabilityBar yesBps={pool.yesBps} />
                </span>
                <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-content">
                  {pool.hasLiquidity ? formatProbPct(pool.yesBps, 0) : '—'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The user's shares in this market, plus redemption once resolved. */
function PositionCard({
  yesShares,
  noShares,
  resolved,
  conditionalTokens,
  collateralToken,
  conditionId,
  onRedeemed,
}: {
  yesShares: bigint;
  noShares: bigint;
  resolved: boolean;
  conditionalTokens: `0x${string}` | undefined;
  collateralToken: `0x${string}` | undefined;
  conditionId: `0x${string}` | undefined;
  onRedeemed: () => void;
}) {
  const [error, setError] = useState('');
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: waiting, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || waiting;

  useEffect(() => {
    if (isSuccess) onRedeemed();
  }, [isSuccess, onRedeemed]);

  if (yesShares <= BigInt(0) && noShares <= BigInt(0)) return null;

  function handleRedeem() {
    if (!conditionalTokens || !collateralToken || !conditionId) {
      setError('Market data is still loading. Try again in a moment.');
      return;
    }
    setError('');
    writeContract(
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'redeemPositions',
        args: [collateralToken, conditionId],
      },
      {
        onError: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setError(
            msg.toLowerCase().includes('nowinningshares')
              ? 'No winning shares to redeem in this market.'
              : sanitizeText(msg).slice(0, 200) || 'Redeem failed'
          );
        },
      }
    );
  }

  return (
    <section className="rounded-card border border-edge bg-surface-raised p-4">
      <h2 className="mb-2 text-sm font-semibold text-content">Your position</h2>
      <div className="flex flex-wrap gap-4 text-xs text-content-muted">
        {yesShares > BigInt(0) && (
          <span className="tabular-nums">
            <span className="font-medium text-yes">YES</span> {formatUsdc(yesShares)} shares
          </span>
        )}
        {noShares > BigInt(0) && (
          <span className="tabular-nums">
            <span className="font-medium text-no">NO</span> {formatUsdc(noShares)} shares
          </span>
        )}
      </div>

      {resolved && (
        <button
          type="button"
          onClick={handleRedeem}
          disabled={working}
          className="mt-3 h-9 rounded-lg bg-brand px-4 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          {working ? 'Redeeming…' : 'Redeem winnings'}
        </button>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}
    </section>
  );
}
