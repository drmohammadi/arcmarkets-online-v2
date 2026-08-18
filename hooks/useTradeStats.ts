'use client';

import { useCallback, useMemo } from 'react';
import type { Market } from './useMarkets';
import { useMarketsData } from './useChainData';
import { useMarketPools } from './useMarketPools';
import { useMarketPayouts } from './useMarketPayouts';
import { useTradeLedger } from './useTradeLedger';
import {
  buildLots,
  lotPnl,
  lotStatus,
  aggregateByUser,
  tradePriceBps,
  type Lot,
  type LotPnl,
  type TradeStatus,
  type LedgerTrade,
  type UserStats,
} from '@/lib/ledger';

/**
 * Everything the profile and leaderboard pages need, from ONE ledger scan.
 *
 * Composes the bounded log sweep with live pool prices and resolution payouts,
 * then runs the pure accounting in `lib/ledger.ts`. Both pages call this, so the
 * expensive part (the sweep) happens once and is shared through react-query.
 */

/** A trade row, enriched for display. */
export interface TradeRow extends LedgerTrade {
  market: Market | null;
  /** Execution price in bps, from the event's own args. */
  priceBps: number | null;
  /** Status of the POSITION this trade belongs to. */
  status: TradeStatus;
}

export interface PositionRow {
  lot: Lot;
  market: Market | null;
  pnl: LotPnl;
  status: TradeStatus;
}

export function useTradeStats(): {
  markets: Market[];
  /** All trades in the window, newest first. */
  trades: LedgerTrade[];
  tradesFor: (address: string | undefined) => TradeRow[];
  positionsFor: (address: string | undefined) => PositionRow[];
  statsFor: (address: string | undefined) => UserStats | null;
  leaderboard: UserStats[];
  isLoading: boolean;
  partial: boolean;
  /** True when showing cached chain data after a failed refresh. */
  stale: boolean;
  /** Blocks the trade scan actually covered. */
  lookbackBlocks: bigint;
  /** True when the scan reached the start of the chain, so nothing is missing. */
  complete: boolean;
  refresh: () => void;
} {
  const {
    markets,
    isLoading: marketsLoading,
    stale: marketsStale,
    refresh: refreshMarkets,
  } = useMarketsData();
  const { poolFor, stale: poolsStale, refetch: refreshPools } = useMarketPools(markets);
  const { payoutFor } = useMarketPayouts(markets);
  const ledger = useTradeLedger(markets);

  const marketById = useMemo(() => {
    const map = new Map<string, Market>();
    for (const m of markets) map.set(m.questionId.toString(), m);
    return map;
  }, [markets]);

  const lots = useMemo(() => buildLots(ledger.trades), [ledger.trades]);

  /** Value one position against live prices or its resolution payout. */
  const valueLot = useCallback(
    (lot: Lot): LotPnl => {
      const market = marketById.get(lot.questionId.toString());
      const pool = poolFor(lot.questionId);
      return lotPnl(lot, {
        resolved: !!market?.resolved,
        payout: payoutFor(market?.conditionId),
        reserveYes: pool.reserveYes,
        reserveNo: pool.reserveNo,
        hasLiquidity: pool.hasLiquidity,
      });
    },
    [marketById, poolFor, payoutFor]
  );

  const statusOf = useCallback(
    (lot: Lot): TradeStatus => {
      const market = marketById.get(lot.questionId.toString());
      return lotStatus(lot, !!market?.resolved, payoutFor(market?.conditionId));
    },
    [marketById, payoutFor]
  );

  const leaderboard = useMemo(() => {
    const rows = aggregateByUser(lots.values(), valueLot);
    // Default ordering is volume: it is exact under a truncated window, whereas
    // PnL depends on a cost basis the window may have clipped.
    rows.sort((a, b) => (a.volume < b.volume ? 1 : a.volume > b.volume ? -1 : 0));
    return rows;
  }, [lots, valueLot]);

  const statsFor = useCallback(
    (address: string | undefined) => {
      if (!address) return null;
      const target = address.toLowerCase();
      return leaderboard.find((u) => u.trader === target) ?? null;
    },
    [leaderboard]
  );

  const positionsFor = useCallback(
    (address: string | undefined): PositionRow[] => {
      if (!address) return [];
      const target = address.toLowerCase();
      const out: PositionRow[] = [];
      for (const lot of lots.values()) {
        if (lot.trader !== target) continue;
        out.push({
          lot,
          market: marketById.get(lot.questionId.toString()) ?? null,
          pnl: valueLot(lot),
          status: statusOf(lot),
        });
      }
      return out;
    },
    [lots, marketById, valueLot, statusOf]
  );

  const tradesFor = useCallback(
    (address: string | undefined): TradeRow[] => {
      if (!address) return [];
      const target = address.toLowerCase();
      const out: TradeRow[] = [];
      for (const t of ledger.trades) {
        if (t.trader !== target || t.questionId === null) continue;
        const lot = lots.get(`${target}:${t.questionId.toString()}:${t.outcome}`);
        out.push({
          ...t,
          market: marketById.get(t.questionId.toString()) ?? null,
          priceBps: tradePriceBps(t),
          // A SELL is terminal for the shares it removed; a BUY inherits the
          // position's current state.
          status: t.side === 'sell' ? 'closed' : lot ? statusOf(lot) : 'unknown',
        });
      }
      // Newest first: the ledger is stored in chain order.
      return out.reverse();
    },
    [ledger.trades, lots, marketById, statusOf]
  );

  /**
   * Refresh everything the pages show, in one call.
   *
   * The ledger is the expensive part, but refreshing it alone would leave the
   * marks and the market list stale, so a "Retry" that visibly changed nothing.
   */
  const refresh = useCallback(() => {
    refreshMarkets();
    refreshPools();
    ledger.refresh();
  }, [refreshMarkets, refreshPools, ledger]);

  return {
    markets,
    trades: ledger.trades,
    tradesFor,
    positionsFor,
    statsFor,
    leaderboard,
    isLoading: marketsLoading || ledger.isLoading,
    partial: ledger.partial,
    stale: marketsStale || poolsStale,
    lookbackBlocks: ledger.lookbackBlocks,
    complete: ledger.complete,
    refresh,
  };
}
