'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useChainId } from 'wagmi';
import { MarketAvatar, Badge, EmptyState, Skeleton } from '@/components/ui';
import { StaleNotice } from '@/components/StaleNotice';
import { RedeemButton } from '@/components/RedeemButton';
import { getDeployment } from '@/lib/contracts';
import { useMarketsData, useWalletPositions } from '@/hooks/useChainData';
import { useMarketPools } from '@/hooks/useMarketPools';
import { useMarketMetadataBatch } from '@/hooks/useMarketMetadata';
import { useMarketPayouts } from '@/hooks/useMarketPayouts';
import { formatUsdc } from '@/lib/format';
import { formatProbPct } from '@/lib/pricing';
import { parseQuestion } from '@/lib/eventGroups';
import { formatResolutionDate } from '@/lib/time';
import { redeemableAmount } from '@/lib/redeemable';
import { useDeletedMarkets } from '@/hooks/useDeletedMarkets';

const ZERO = BigInt(0);

/**
 * A wallet's open positions: summary tiles plus one row per held outcome.
 *
 * ── WHY THIS IS A COMPONENT AND NOT A PAGE ───────────────────────────────────
 * This was `/portfolio`, a page that only ever worked for the CONNECTED wallet.
 * Everything it does is a pure function of an address, so it now takes one and is
 * rendered inside `ProfileView` — which means the same UI works on your own
 * profile and on anyone else's, and there is exactly one implementation of it.
 *
 * ── WHY IT IS THE RELIABLE HALF OF A PROFILE ─────────────────────────────────
 * These figures come from `balanceOfBatch` — the wallet's CURRENT ERC-1155
 * balances, one request, no history required. That makes them exact regardless of
 * how far the trade-log sweep has managed to scan, which is the opposite of the
 * PnL/volume tiles above them: those are derived from Buy/Sell logs and are only
 * as complete as the scan. So this panel leads, and the ledger-derived numbers
 * follow with their own caveats.
 *
 * Removed markets are NOT filtered out here, unlike every browsable market list.
 * A wallet's holdings are its own money: curation decides what the app lists, not
 * what a holder is owed. Removed markets are badged instead, and their positions
 * still count toward the redeemable total. See the comment on `positions`.
 */
export function PortfolioPanel({ address }: { address: `0x${string}` }) {
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const conditionalTokens = deployment?.conditionalTokens as `0x${string}` | undefined;
  const collateralToken = deployment?.collateralToken as `0x${string}` | undefined;
  const { markets, isLoading, stale: marketsStale, refresh: refreshMarkets } = useMarketsData();
  const { poolFor, stale: poolsStale, refetch: refreshPools } = useMarketPools(markets);
  // Shared on-chain images, so position rows match the cards elsewhere.
  const metadata = useMarketMetadataBatch(markets.map((m) => m.questionId));
  // Used ONLY to badge a row 'Removed'. Never to filter positions -- see the
  // comment on `positions` below: curation must not hide money a wallet is owed.
  const { deleted: hidden } = useDeletedMarkets();

  /*
   * Every YES/NO balance in ONE request.
   *
   * This used to spend 4N requests across two serial rounds: 2N to read each
   * pool's `yesPositionId`/`noPositionId`, then 2N `balanceOf` calls that could
   * not start until those returned. Both rounds went through `useReadContracts`,
   * which on Arc fans out into one unthrottled request per contract rather than a
   * multicall — see `hooks/useChainData.ts`.
   *
   * The ids are now derived off-chain and the balances come from a single
   * `balanceOfBatch`, so this is 1 request regardless of market count.
   */
  const {
    positions: heldPositions,
    isLoading: balLoading,
    stale: balancesStale,
    refresh: refreshBalances,
  } = useWalletPositions(address, markets);

  const refreshAll = useCallback(() => {
    refreshMarkets();
    refreshPools();
    refreshBalances();
  }, [refreshMarkets, refreshPools, refreshBalances]);

  const marketById = useMemo(() => {
    const map = new Map<string, (typeof markets)[number]>();
    for (const m of markets) map.set(m.questionId.toString(), m);
    return map;
  }, [markets]);

  /*
   * EVERY position the wallet holds -- deliberately NOT filtered by curation.
   *
   * This used to end with `.filter((p) => !hidden.has(...))`, which quietly made
   * a presentation filter decide how much money the page said you could
   * withdraw: hiding a market removed its position from the rows AND from the
   * redeemable total, so a wallet with a winning resolved position could be
   * shown "Redeemable now $0.00". Once deletion becomes global that would get
   * far worse -- an admin removing a market would zero out every holder's
   * redeemable balance while their shares sat redeemable on-chain.
   *
   * A browsable market list is a place to apply curation. A wallet's own
   * holdings are not: the factory has no delete, the shares exist, and the money
   * is owed. Removed markets are badged instead, and `/`, the outcome selector,
   * the featured rail and the leaderboard keep filtering as before.
   */
  const positions = useMemo(
    () =>
      heldPositions
        .map((p) => {
          const market = marketById.get(p.questionId.toString());
          return market ? { market, yes: p.yes, no: p.no } : null;
        })
        .filter(
          (p): p is { market: (typeof markets)[number]; yes: bigint; no: bigint } => p !== null
        ),
    [heldPositions, marketById]
  );

  /*
   * Payouts are read for the markets this WALLET holds, not for every market on
   * the chain.
   *
   * `useMarketPayouts` fetches the index once, then falls back to one RPC
   * `getPayouts` per condition the index cannot answer. Passing the full market
   * list therefore scaled that fallback with the chain rather than with the
   * position count -- 200 resolved markets cost 200 reads for a wallet holding
   * two of them. This hook sits below `positions` for exactly that reason; the
   * call is still unconditional, so hook order is stable.
   */
  const heldMarkets = useMemo(() => positions.map((p) => p.market), [positions]);
  const { payoutFor, isLoading: payoutsLoading } = useMarketPayouts(heldMarkets);

  /*
   * Two quantities, and the split is by RESOLUTION, not by which tile it feeds.
   *
   * An unresolved position is an estimate: a share is worth its implied
   * probability, which is the best available guess at exit value. A RESOLVED
   * position is not an estimate at all -- it is worth exactly what the contract
   * will pay, which is zero for the losing side.
   *
   * So both tiles use the payout once a market resolves. An earlier version fixed
   * only `redeemable` and left `value` marking resolved positions at the last pool
   * price, which meant "Estimated value" still inflated wiped-out holdings with
   * precisely the bug `lib/redeemable.ts` exists to kill -- directly under copy
   * saying losing shares are shown as worthless.
   *
   * `unknownPayouts` counts markets that ARE resolved but whose numerators have
   * not arrived. Those are excluded from BOTH totals rather than guessed:
   * `payoutFor` returning null means "we do not know", explicitly not "zero".
   */
  const totals = useMemo(() => {
    let value = ZERO;
    let redeemable = ZERO;
    let unknownPayouts = 0;
    for (const p of positions) {
      if (!p.market.resolved) {
        const pool = poolFor(p.market.questionId);
        const yesBps = BigInt(pool.yesBps);
        const noBps = BigInt(10000 - pool.yesBps);
        value += (p.yes * yesBps + p.no * noBps) / BigInt(10000);
        continue;
      }

      const payout = payoutFor(p.market.conditionId);
      if (!payout) {
        unknownPayouts += 1;
        continue;
      }
      const amount = redeemableAmount({
        yes: p.yes,
        no: p.no,
        numerators: payout.numerators,
        denominator: payout.denominator,
      });
      value += amount;
      redeemable += amount;
    }
    return { value, redeemable, unknownPayouts };
  }, [positions, poolFor, payoutFor]);

  /*
   * "Still loading" and "failed to load" must not look the same.
   *
   * During the normal initial fetch every resolved position is briefly unknown,
   * so keying the caveat on `unknownPayouts` alone made the "(partial)" label and
   * its banner flash on every single page load. Gating on `!payoutsLoading` means
   * the warning appears only when the data genuinely did not arrive -- which is
   * the distinction `useMarketPayouts` documents and this panel was discarding.
   */
  const payoutsIncomplete = !payoutsLoading && totals.unknownPayouts > 0;

  const loading = isLoading || balLoading;
  const stale = marketsStale || poolsStale || balancesStale;

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-card" />
        ))}
      </div>
    );
  }

  return (
    <>
      {stale && <StaleNotice onRetry={refreshAll} />}

      {positions.length === 0 ? (
        <EmptyState
          title="No open positions"
          hint="Buy YES or NO on any market and it will show up here."
          action={
            <Link href="/" className="text-sm font-medium text-brand hover:underline">
              Browse markets
            </Link>
          }
        />
      ) : (
        <>
          {/*
            Two columns on a phone, three from `sm` up. The third tile is the
            position count, which is the one figure that needs no explanation
            and so is the right thing to drop first at narrow widths.
          */}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryTile
              label={payoutsIncomplete ? 'Estimated value (partial)' : 'Estimated value'}
              value={`$${formatUsdc(totals.value)}`}
            />
            <SummaryTile
              label={payoutsIncomplete ? 'Redeemable now (partial)' : 'Redeemable now'}
              value={`$${formatUsdc(totals.redeemable)}`}
            />
            <SummaryTile
              label="Open positions"
              value={String(positions.length)}
              className="col-span-2 sm:col-span-1"
            />
          </div>

          {payoutsIncomplete && (
            <p className="mb-4 text-2xs leading-relaxed text-content-muted" role="status">
              {totals.unknownPayouts} resolved{' '}
              {totals.unknownPayouts === 1 ? 'market has' : 'markets have'} no payout data
              available, so {totals.unknownPayouts === 1 ? 'it is' : 'they are'} excluded from both
              totals rather than estimated.
            </p>
          )}

          <ul className="space-y-2">
            {positions.map(({ market, yes, no }) => {
              const pool = poolFor(market.questionId);
              const parsed = parseQuestion(market.question);
              const title = parsed.eventTitle
                ? `${parsed.eventTitle}: ${parsed.outcomeLabel}`
                : parsed.outcomeLabel || 'Untitled market';
              return (
                <li
                  key={market.questionId.toString()}
                  className="rounded-card border border-edge bg-surface-raised transition-colors hover:border-edge-strong"
                >
                  <Link
                    href={`/market/${market.questionId.toString()}`}
                    className="flex items-start gap-3 p-3"
                  >
                    <MarketAvatar
                      questionId={market.questionId}
                      seed={market.fpmm}
                      text={title}
                      size="sm"
                      imageUrl={metadata.imageUrlFor(market.questionId)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium leading-snug text-content">
                        {title}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-muted">
                        {yes > ZERO && (
                          <span className="tabular-nums">
                            <span className="font-medium text-yes">YES</span> {formatUsdc(yes)}
                          </span>
                        )}
                        {no > ZERO && (
                          <span className="tabular-nums">
                            <span className="font-medium text-no">NO</span> {formatUsdc(no)}
                          </span>
                        )}
                        <span className="tabular-nums text-content-subtle">
                          {pool.hasLiquidity ? `${formatProbPct(pool.yesBps)} yes` : 'no liquidity'}
                        </span>
                        <span className="text-content-subtle">
                          {formatResolutionDate(market.resolutionTime)}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {(() => {
                        // "Redeemable" must mean money is actually waiting. A
                        // resolved market where this wallet held the losing side
                        // pays zero, and labelling that Redeemable sends people to
                        // a button that reverts with NoWinningShares.
                        if (!market.resolved) return <Badge tone="neutral">Open</Badge>;
                        const payout = payoutFor(market.conditionId);
                        if (!payout) return <Badge tone="neutral">Resolved</Badge>;
                        const amount = redeemableAmount({
                          yes,
                          no,
                          numerators: payout.numerators,
                          denominator: payout.denominator,
                        });
                        return amount > ZERO ? (
                          <Badge tone="brand">Redeemable</Badge>
                        ) : (
                          <Badge tone="neutral">No payout</Badge>
                        );
                      })()}
                      {/*
                        Removed from the browsable lists, but still held and still
                        redeemable. Badged rather than filtered out: hiding a
                        position would hide money the wallet is owed.
                      */}
                      {hidden.has(market.questionId.toString()) && (
                        <Badge tone="warn">Removed</Badge>
                      )}
                    </div>
                  </Link>

                  {/*
                    Redeem lives HERE, not only on the market page. This is where
                    people look for money they are owed, and it is the reason the
                    button is a shared component: one definition of when it may be
                    enabled, used by both surfaces. Outside the <Link> so a click
                    on it does not navigate away mid-transaction.
                  */}
                  {market.resolved && (
                    <div className="border-t border-edge px-3 py-2">
                      <RedeemButton
                        compact
                        yesShares={yes}
                        noShares={no}
                        payout={payoutFor(market.conditionId)}
                        payoutLoading={payoutsLoading}
                        conditionalTokens={conditionalTokens}
                        collateralToken={collateralToken}
                        conditionId={market.conditionId as `0x${string}` | undefined}
                        onRedeemed={refreshAll}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <p className="mt-4 text-2xs leading-relaxed text-content-subtle">
            Open positions are marked at the pool&apos;s current implied probability, so actual
            proceeds depend on liquidity and slippage at the time you sell. Resolved positions are
            not estimated at all &mdash; both figures use what the contract will actually pay, so
            losing shares count as nothing.
          </p>
        </>
      )}
    </>
  );
}

function SummaryTile({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-edge bg-surface-raised px-3 py-2.5 ${className}`}
    >
      <p className="text-2xs uppercase tracking-wide text-content-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-content">{value}</p>
    </div>
  );
}
