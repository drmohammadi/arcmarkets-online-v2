'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { MarketAvatar, Badge, EmptyState, Skeleton } from '@/components/ui';
import { StaleNotice } from '@/components/StaleNotice';
import { useMarketsData, useWalletPositions } from '@/hooks/useChainData';
import { useMarketPools } from '@/hooks/useMarketPools';
import { useMarketMetadataBatch } from '@/hooks/useMarketMetadata';
import { formatUsdc } from '@/lib/format';
import { formatProbPct } from '@/lib/pricing';
import { parseQuestion } from '@/lib/eventGroups';
import { formatResolutionDate } from '@/lib/time';
import { useHiddenMarkets } from '@/hooks/useMarketImage';

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
 * Hidden markets are filtered here for the same reason they are filtered on `/`
 * and on a market page: `lib/hiddenMarkets.ts` is a presentation filter, so it
 * only works where it is actually applied, and a browsable list of positions is
 * one of those places. A holder can still reach the market by direct URL and
 * redeem — nothing here affects what is tradable.
 */
export function PortfolioPanel({ address }: { address: `0x${string}` }) {
  const { markets, isLoading, stale: marketsStale, refresh: refreshMarkets } = useMarketsData();
  const { poolFor, stale: poolsStale, refetch: refreshPools } = useMarketPools(markets);
  // Shared on-chain images, so position rows match the cards elsewhere.
  const metadata = useMarketMetadataBatch(markets.map((m) => m.questionId));
  const hidden = useHiddenMarkets();

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

  const positions = useMemo(
    () =>
      heldPositions
        .map((p) => {
          const market = marketById.get(p.questionId.toString());
          return market ? { market, yes: p.yes, no: p.no } : null;
        })
        .filter(
          (p): p is { market: (typeof markets)[number]; yes: bigint; no: bigint } => p !== null
        )
        .filter((p) => !hidden.has(p.market.questionId.toString())),
    [heldPositions, marketById, hidden]
  );

  // Current mark-to-market value: each share is worth its implied probability
  // until resolution. This is an estimate of exit value, not a guaranteed price.
  const totals = useMemo(() => {
    let value = ZERO;
    let redeemable = ZERO;
    for (const p of positions) {
      const pool = poolFor(p.market.questionId);
      const yesBps = BigInt(pool.yesBps);
      const noBps = BigInt(10000 - pool.yesBps);
      const v = (p.yes * yesBps + p.no * noBps) / BigInt(10000);
      value += v;
      if (p.market.resolved) redeemable += v;
    }
    return { value, redeemable };
  }, [positions, poolFor]);

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
            <SummaryTile label="Estimated value" value={`$${formatUsdc(totals.value)}`} />
            <SummaryTile label="Redeemable now" value={`$${formatUsdc(totals.redeemable)}`} />
            <SummaryTile
              label="Open positions"
              value={String(positions.length)}
              className="col-span-2 sm:col-span-1"
            />
          </div>

          <ul className="space-y-2">
            {positions.map(({ market, yes, no }) => {
              const pool = poolFor(market.questionId);
              const parsed = parseQuestion(market.question);
              const title = parsed.eventTitle
                ? `${parsed.eventTitle}: ${parsed.outcomeLabel}`
                : parsed.outcomeLabel || 'Untitled market';
              return (
                <li key={market.questionId.toString()}>
                  <Link
                    href={`/market/${market.questionId.toString()}`}
                    className="flex items-start gap-3 rounded-card border border-edge bg-surface-raised p-3 transition-colors hover:border-edge-strong"
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
                    {market.resolved ? (
                      <Badge tone="brand">Redeemable</Badge>
                    ) : (
                      <Badge tone="neutral">Open</Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <p className="mt-4 text-2xs text-content-subtle">
            Estimated value marks each share at the pool&apos;s current implied probability. Actual
            proceeds depend on liquidity and slippage at the time you sell.
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
