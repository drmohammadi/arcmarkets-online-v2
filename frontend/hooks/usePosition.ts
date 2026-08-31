'use client';

import { useMemo } from 'react';
import { useAccount } from 'wagmi';
import { useMarketsData, useWalletPositions } from './useChainData';

/**
 * The connected wallet's YES/NO share balances for one market.
 *
 * ── WHY THIS READS THROUGH THE SHARED SNAPSHOT ───────────────────────────────
 * The old implementation issued four requests per mount, in two serial rounds:
 * `yesPositionId()` + `noPositionId()`, and only once those resolved, two
 * `balanceOf` calls. Both rounds were `useReadContracts`, which on Arc is an
 * unthrottled burst rather than a multicall (see `useChainData.ts`).
 *
 * Now the ids are derived off-chain (`lib/positionIds.ts`, pinned by
 * `contracts/test/PositionId.test.ts`) and the balances come from the SAME
 * batched `balanceOfBatch` the portfolio page uses. Opening a market page after
 * the portfolio — or vice versa — costs zero extra requests inside the stale
 * window, and this hook adds no request of its own beyond the shared snapshot.
 *
 * The market is located by `fpmm` because that is what callers already hold;
 * each pool is minted for exactly one questionId, so the match is unique.
 * `conditionalTokens` is accepted for API compatibility and is resolved from the
 * deployment inside the shared hook.
 */
export function usePosition(
  fpmm: `0x${string}` | undefined,
  conditionalTokens: `0x${string}` | undefined
) {
  const { address } = useAccount();
  const { markets } = useMarketsData();

  // Restrict the batch to this one market: the shared query is keyed by the
  // market SET, so passing the full list here would build a second, larger
  // cache entry for every market page rather than reusing the portfolio's.
  const target = useMemo(() => {
    if (!fpmm) return [];
    const wanted = fpmm.toLowerCase();
    const hit = markets.find((m) => m.fpmm?.toLowerCase() === wanted);
    return hit ? [hit] : [];
  }, [markets, fpmm]);

  const { balanceFor, refresh } = useWalletPositions(address, target);

  const questionId = target[0]?.questionId;
  const balance = questionId !== undefined ? balanceFor(questionId) : null;
  const yesShares = balance?.yes ?? BigInt(0);
  const noShares = balance?.no ?? BigInt(0);

  void conditionalTokens; // resolved from the deployment inside useWalletPositions

  return {
    yesShares,
    noShares,
    hasPosition: yesShares > BigInt(0) || noShares > BigInt(0),
    refetch: refresh,
  };
}
