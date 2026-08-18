'use client';

import { useMarketPoolsData } from './useChainData';
import type { Market } from './useMarkets';

export interface Pool {
  reserveYes: bigint;
  reserveNo: bigint;
  /** Implied YES probability in bps (0..10000). */
  yesBps: number;
  /** Collateral backing the pool (the mergeable full-set amount). */
  liquidity: bigint;
  /** False when the reserves call failed or the pool is empty. */
  hasLiquidity: boolean;
}

/**
 * Live reserves for every supplied market, plus the implied probability and
 * liquidity derived from each.
 *
 * A thin adapter over `useMarketPoolsData`, which owns the fetching and the
 * shared cache. The fetch moved for the same reason `useMarkets`'s did: the
 * `useReadContracts` this used to call is not a multicall on Arc, it is an
 * N-request burst. See the header of `useChainData.ts`.
 *
 * `poolFor` is keyed by questionId rather than array index, so a partial
 * failure cannot shift every later market onto the wrong pool.
 */
export function useMarketPools(markets: Market[]) {
  const { poolFor, isLoading, incomplete, stale, refresh } = useMarketPoolsData(markets);

  return {
    poolFor,
    isLoading,
    /** True when at least one pool's reserves could not be read. */
    isError: incomplete,
    /** True when showing cached reserves after a failed refresh. */
    stale,
    refetch: refresh,
  };
}
