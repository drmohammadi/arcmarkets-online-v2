'use client';

import { useReadContract, useReadContracts, useChainId } from 'wagmi';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi, fpmmAbi } from '@/lib/abis';

/**
 * Load a single market's factory record plus live FPMM reserves.
 * Returns null-ish fields until data arrives; callers must handle loading.
 */
export function useMarket(questionId: bigint | null) {
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const factory = deployment?.marketFactory as `0x${string}` | undefined;
  const enabled = !!factory && questionId !== null;

  const { data: record, isLoading: loadingRecord } = useReadContract({
    address: factory,
    abi: marketFactoryAbi,
    functionName: 'markets',
    args: questionId !== null ? [questionId] : undefined,
    query: { enabled },
  });

  const parsed = record
    ? (record as unknown as [string, string, string, string, bigint, string, boolean])
    : null;
  const fpmm = parsed?.[0] as `0x${string}` | undefined;

  const { data: fpmmData, isLoading: loadingFpmm } = useReadContracts({
    contracts: [
      { address: fpmm, abi: fpmmAbi, functionName: 'reserves' as const },
      { address: fpmm, abi: fpmmAbi, functionName: 'fee' as const },
      { address: fpmm, abi: fpmmAbi, functionName: 'totalSupply' as const },
    ],
    query: { enabled: !!fpmm && fpmm !== '0x0000000000000000000000000000000000000000' },
  });

  const reserves =
    fpmmData?.[0]?.status === 'success'
      ? (fpmmData[0].result as unknown as [bigint, bigint])
      : null;

  return {
    isLoading: loadingRecord || loadingFpmm,
    exists: !!parsed && parsed[0] !== '0x0000000000000000000000000000000000000000',
    fpmm,
    conditionId: parsed?.[1],
    question: parsed?.[2] ?? '',
    category: parsed?.[3] ?? '',
    resolutionTime: parsed?.[4] ?? BigInt(0),
    resolver: parsed?.[5],
    resolved: parsed?.[6] ?? false,
    reserveYes: reserves?.[0] ?? BigInt(0),
    reserveNo: reserves?.[1] ?? BigInt(0),
    /**
     * Whether `reserveYes`/`reserveNo` are real values read from the pool, as
     * opposed to the BigInt(0) placeholder returned when the multicall entry
     * failed.
     *
     * Callers MUST check this before treating the reserves as authoritative. An
     * empty pool and a failed read both look like (0, 0), and conflating them
     * previously caused the price chart to hide itself whenever an RPC read
     * failed — it compared its replay against (0, 0), saw a mismatch, and
     * concluded its own data was wrong.
     */
    reservesKnown: reserves !== null,
    fee: fpmmData?.[1]?.status === 'success' ? (fpmmData[1].result as bigint) : BigInt(0),
    collateralToken: deployment?.collateralToken as `0x${string}` | undefined,
    conditionalTokens: deployment?.conditionalTokens as `0x${string}` | undefined,
  };
}
