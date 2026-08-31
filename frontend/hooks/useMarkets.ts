'use client';

import { useMarketsData } from './useChainData';

export interface Market {
  questionId: bigint;
  fpmm: string;
  conditionId: string;
  question: string;
  category: string;
  resolutionTime: bigint;
  resolver: string;
  resolved: boolean;
}

/**
 * Every market on the connected chain.
 *
 * A thin adapter over `useMarketsData`, which owns the fetching, the pacing and
 * the shared react-query cache. Kept as its own export because most of the app
 * only wants the list and has no use for position ids or staleness.
 *
 * ── WHY THE FETCH MOVED ──────────────────────────────────────────────────────
 * This hook used to call `useReadContracts`, whose name implies a batched
 * multicall. On Arc it is not one: the chain has no multicall3 deployed and
 * `lib/chains.ts` declares no `contracts` entry, so viem throws
 * `ChainDoesNotSupportContract` and @wagmi/core silently falls back to one
 * unthrottled `eth_call` per market. With N markets that was an N-request burst
 * on EVERY page that showed a market list, each page building its own cache
 * entry. See the header of `useChainData.ts` for the full accounting.
 */
export function useMarkets(): { markets: Market[]; isLoading: boolean } {
  const { markets, isLoading } = useMarketsData();
  return { markets, isLoading };
}
