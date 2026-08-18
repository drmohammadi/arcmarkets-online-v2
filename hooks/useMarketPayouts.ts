'use client';

import { useMarketPayoutsData } from './useChainData';
import type { PayoutInfo } from '@/lib/ledger';
import type { Market } from './useMarkets';

/**
 * Resolution payouts for resolved markets.
 *
 * `getPayouts` is what tells you WHICH side won — `market.resolved` only says
 * that it settled. Realized PnL needs the former.
 *
 * Only resolved markets are queried: an unresolved condition has a zero
 * denominator, so asking costs a request to learn nothing. Results are cached
 * indefinitely because resolution is one-shot and permanent on-chain.
 *
 * A failed read yields `null` for that market rather than a zeroed struct. The
 * distinction matters: `payoutFor` returning null means "we do not know", and
 * the ledger deliberately renders that as an unknown status instead of
 * defaulting to "lost", which would tell a winning trader they lost.
 *
 * A thin adapter over `useMarketPayoutsData` — see `useChainData.ts` for why the
 * fetching moved out of `useReadContracts`.
 */
export function useMarketPayouts(markets: Market[]): {
  payoutFor: (conditionId: string | undefined) => PayoutInfo | null;
  isLoading: boolean;
} {
  return useMarketPayoutsData(markets);
}
