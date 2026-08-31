'use client';

/**
 * ONE shared, cached snapshot of chain state for every page that shows markets.
 *
 * ── THE ROOT CAUSE THIS FIXES ────────────────────────────────────────────────
 * `useReadContracts` LOOKS like a batching primitive, and the code that used it
 * said so in its comments. On this chain it is not one.
 *
 * viem's `multicall` resolves the multicall3 address from `chain.contracts`.
 * `lib/chains.ts` defines `arcTestnet` with no `contracts` field at all, so
 * `getChainContractAddress` throws `ChainDoesNotSupportContract`. @wagmi/core's
 * `readContracts` catches that and falls back to
 *
 *     Promise.allSettled(contracts.map(readContract))
 *
 * — one HTTP request per contract, all fired simultaneously, with no queue in
 * front of them. Every `useReadContracts` in the app was therefore an
 * unthrottled burst, and the failure was invisible because `allowFailure`
 * turned the resulting 429s into per-entry `status: 'failure'` rather than a
 * thrown error. The pages then rendered zeros and "no positions" instead of an
 * error, which is why they looked slow-and-flaky rather than broken.
 *
 * The old cost of opening /portfolio with N markets:
 *
 *     1  nextQuestionId
 *   + N  markets(i)              <- burst
 *   + N  reserves()              <- burst
 *   + 2N yes/noPositionId()      <- burst, and BLOCKS the balance reads
 *   + 2N balanceOf()             <- burst, second round-trip
 *   = 6N + 1 requests in four bursts
 *
 * The new cost:
 *
 *     1  nextQuestionId
 *   + N  markets(i)              <- paced, cached 5 min, shared
 *   + N  reserves()              <- paced, cached 30 s, shared
 *   + 1  balanceOfBatch()        <- ONE request for every position
 *   + R  getPayouts()            <- resolved markets only, paced, cached
 *
 * The 2N position-id reads are gone entirely (derived off-chain, see
 * `lib/positionIds.ts`), which also collapses the two serial round-trips into
 * one. The 2N balance reads become a single `balanceOfBatch`. What remains is
 * paced through `rpcQueue` instead of bursting, and shared through react-query
 * so /portfolio, /profile and /leaderboard mounted in sequence cost ZERO
 * additional requests within the stale window.
 *
 * ── WHY ONE HOOK RATHER THAN FIXING EACH CALL SITE ───────────────────────────
 * The query key is derived from the chain and the deployment addresses only, so
 * every page asking for "the markets" hits the same react-query entry. Four
 * pages previously each built their own contract array and therefore their own
 * cache entry, which is why navigating between them refetched everything.
 *
 * ── NEVER FAILS VISIBLY ──────────────────────────────────────────────────────
 * Every read degrades to a documented placeholder instead of throwing, matching
 * the convention `useTradeLedger` and `useTradeHistory` already follow. A failed
 * `reserves()` yields `hasLiquidity: false` (NOT a 50/50 price presented as
 * real), and a failed `getPayouts` yields null (NOT "lost"). `stale` tells the
 * UI when it is showing cached data after a failed refresh, so a slow or
 * rate-limited RPC shows the last good numbers with a note rather than an empty
 * page.
 */

import { useCallback, useMemo } from 'react';
import { useChainId, usePublicClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseAbi } from 'viem';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi, fpmmAbi, conditionalTokensAbi } from '@/lib/abis';
import { enqueueCall } from '@/lib/rpcQueue';
import { yesProbBps, poolLiquidity } from '@/lib/pricing';
import { positionPairFor } from '@/lib/positionIds';
import type { PayoutInfo } from '@/lib/ledger';
import type { Market } from './useMarkets';
import type { Pool } from './useMarketPools';

const ZERO = BigInt(0);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * `balanceOfBatch` only. Kept out of `conditionalTokensAbi` so that ABI keeps
 * describing exactly the interface the write paths use.
 *
 * `ConditionalTokens` inherits it from OpenZeppelin's ERC1155. It pairs
 * `accounts[i]` with `ids[i]`, which is what lets ONE request cover many
 * different wallets/pools at once — see `useWalletPositions`.
 */
const erc1155BatchAbi = parseAbi([
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
]);

/** Reserves change on every trade, so they are refetched more eagerly than the
 *  market list, which only changes when an admin creates or resolves one. */
const MARKETS_STALE_MS = 5 * 60_000;
const POOLS_STALE_MS = 30_000;
const GC_MS = 30 * 60_000;

export const EMPTY_POOL: Pool = {
  reserveYes: ZERO,
  reserveNo: ZERO,
  yesBps: 5000,
  liquidity: ZERO,
  hasLiquidity: false,
};

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/** A market plus the derived ids of its two outcome tokens. */
export interface MarketWithPositions extends Market {
  /** Null when the record is malformed, e.g. a zero fpmm. */
  positions: { yes: bigint; no: bigint } | null;
}

interface MarketsSnapshot {
  markets: MarketWithPositions[];
  /** True when some market records could not be read. */
  incomplete: boolean;
}

/* ────────────────────────────── market records ───────────────────────────── */

/**
 * The factory's market list.
 *
 * Reads `nextQuestionId`, then one `markets(i)` per id through the call lane.
 * A record that fails to read is SKIPPED, not zero-filled: a market rendered
 * with a zero address and an empty question would look real and be untradeable.
 * `incomplete` reports that so the UI can say the list is partial.
 */
async function loadMarkets(
  client: Client,
  factory: `0x${string}`,
  collateral: string | undefined
): Promise<MarketsSnapshot> {
  const nextId = await enqueueCall(() =>
    client.readContract({
      address: factory,
      abi: marketFactoryAbi,
      functionName: 'nextQuestionId',
    })
  );

  const count = Number(nextId ?? ZERO);
  if (!Number.isFinite(count) || count <= 0) return { markets: [], incomplete: false };

  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      enqueueCall(() =>
        client.readContract({
          address: factory,
          abi: marketFactoryAbi,
          functionName: 'markets',
          args: [BigInt(i)],
        })
      )
    )
  );

  const markets: MarketWithPositions[] = [];
  let incomplete = false;

  settled.forEach((entry, idx) => {
    if (entry.status !== 'fulfilled' || !entry.value) {
      incomplete = true;
      return;
    }
    const [fpmm, conditionId, question, category, resolutionTime, resolver, resolved] =
      entry.value as unknown as [string, string, string, string, bigint, string, boolean];

    markets.push({
      questionId: BigInt(idx),
      fpmm,
      conditionId,
      question,
      category,
      resolutionTime,
      resolver,
      resolved,
      // Derived, never read. See lib/positionIds.ts for why this is sound.
      positions: positionPairFor(collateral, conditionId),
    });
  });

  return { markets, incomplete };
}

/**
 * Every market on the connected chain, shared across pages.
 *
 * Replaces `useMarkets`'s `useReadContracts` fan-out. Same return shape plus
 * `positions`, `stale` and `refresh`, so existing callers keep working.
 */
export function useMarketsData(): {
  markets: MarketWithPositions[];
  isLoading: boolean;
  /** True when showing cached data because the last refresh failed. */
  stale: boolean;
  /** True when some market records could not be read at all. */
  incomplete: boolean;
  refresh: () => void;
} {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const deployment = getDeployment(chainId);
  const factory = deployment?.marketFactory as `0x${string}` | undefined;
  const collateral = deployment?.collateralToken as string | undefined;

  const enabled = !!client && !!factory;

  const queryKey = useMemo(
    () => ['arc', 'markets', chainId, factory ?? '', collateral ?? ''] as const,
    [chainId, factory, collateral]
  );

  const { data, isLoading, isError, isFetching } = useQuery<MarketsSnapshot, Error>({
    queryKey,
    enabled,
    staleTime: MARKETS_STALE_MS,
    gcTime: GC_MS,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // rpcQueue already backs off on 429; a react-query retry on top would
    // multiply requests at exactly the moment the RPC asked us to slow down.
    retry: false,
    // Keep the previous snapshot visible while a refetch is in flight, so a
    // slow refresh never blanks a populated page.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      if (!client || !factory) return { markets: [], incomplete: false };
      return loadMarkets(client, factory, collateral);
    },
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    markets: data?.markets ?? [],
    isLoading: enabled && isLoading,
    // Data on screen that we already know is out of date: an error, and not
    // because we are mid-retry.
    stale: isError && !isFetching && !!data,
    incomplete: data?.incomplete ?? false,
    refresh,
  };
}

/* ───────────────────────────────── pools ─────────────────────────────────── */

interface PoolsSnapshot {
  /** questionId string -> Pool. */
  byId: Record<string, Pool>;
  incomplete: boolean;
}

/**
 * Live reserves for every market, in one shared query.
 *
 * Keyed by the market set's CONTENT, so the same markets in any order reuse one
 * cache entry and an unmemoized caller array cannot cause a refetch loop.
 */
export function useMarketPoolsData(markets: MarketWithPositions[] | Market[]): {
  poolFor: (questionId: bigint) => Pool;
  isLoading: boolean;
  stale: boolean;
  incomplete: boolean;
  refresh: () => void;
} {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();

  const targets = useMemo(
    () =>
      markets
        .filter((m) => typeof m.fpmm === 'string' && m.fpmm !== ZERO_ADDRESS && !!m.fpmm)
        .map((m) => ({ id: m.questionId.toString(), fpmm: m.fpmm as `0x${string}` })),
    [markets]
  );

  // Content identity: "id:fpmm|id:fpmm|...". Same set => same key => one fetch.
  const setKey = useMemo(
    () => targets.map((t) => `${t.id}:${t.fpmm.toLowerCase()}`).sort().join('|'),
    [targets]
  );

  const enabled = !!client && targets.length > 0;
  const queryKey = useMemo(() => ['arc', 'pools', chainId, setKey] as const, [chainId, setKey]);

  const { data, isLoading, isError, isFetching } = useQuery<PoolsSnapshot, Error>({
    queryKey,
    enabled,
    staleTime: POOLS_STALE_MS,
    gcTime: GC_MS,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      if (!client) return { byId: {}, incomplete: false };

      const settled = await Promise.allSettled(
        targets.map((t) =>
          enqueueCall(() =>
            client.readContract({ address: t.fpmm, abi: fpmmAbi, functionName: 'reserves' })
          )
        )
      );

      const byId: Record<string, Pool> = {};
      let incomplete = false;

      settled.forEach((entry, i) => {
        const target = targets[i];
        if (entry.status !== 'fulfilled' || !entry.value) {
          // A failed read is NOT an empty pool. hasLiquidity:false keeps the
          // 50/50 placeholder from being presented as a real market price.
          byId[target.id] = EMPTY_POOL;
          incomplete = true;
          return;
        }
        const [yes, no] = entry.value as unknown as [bigint, bigint];
        byId[target.id] = {
          reserveYes: yes,
          reserveNo: no,
          yesBps: yesProbBps(yes, no),
          liquidity: poolLiquidity(yes, no),
          hasLiquidity: yes + no > ZERO,
        };
      });

      return { byId, incomplete };
    },
  });

  const byId = data?.byId;
  const poolFor = useCallback(
    (questionId: bigint): Pool => byId?.[questionId.toString()] ?? EMPTY_POOL,
    [byId]
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    poolFor,
    isLoading: enabled && isLoading,
    stale: isError && !isFetching && !!data,
    incomplete: data?.incomplete ?? false,
    refresh,
  };
}

/* ──────────────────────────────── payouts ────────────────────────────────── */

/**
 * Resolution payouts for RESOLVED markets only.
 *
 * An unresolved condition has a zero denominator, so querying it spends a
 * request to learn nothing. A failed read stays absent from the map, and
 * `payoutFor` returns null — meaning "we do not know", which the ledger renders
 * as an unknown status rather than defaulting to "lost" and telling a winning
 * trader they lost.
 */
export function useMarketPayoutsData(markets: MarketWithPositions[] | Market[]): {
  payoutFor: (conditionId: string | undefined) => PayoutInfo | null;
  isLoading: boolean;
} {
  const client = usePublicClient();
  const chainId = useChainId();
  const deployment = getDeployment(chainId);
  const conditionalTokens = deployment?.conditionalTokens as `0x${string}` | undefined;

  const key = useMemo(
    () =>
      markets
        .filter((m) => m.resolved && typeof m.conditionId === 'string')
        .map((m) => m.conditionId.toLowerCase())
        .sort()
        .join(','),
    [markets]
  );

  const conditionIds = useMemo(
    () => (key === '' ? [] : (key.split(',') as `0x${string}`[])),
    [key]
  );

  const enabled = !!client && !!conditionalTokens && conditionIds.length > 0;

  const { data, isLoading } = useQuery<Record<string, PayoutInfo>, Error>({
    queryKey: ['arc', 'payouts', chainId, conditionalTokens ?? '', key] as const,
    enabled,
    // Resolution is one-shot and permanent, so a hit never needs revalidating.
    staleTime: Infinity,
    gcTime: GC_MS,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    queryFn: async () => {
      if (!client || !conditionalTokens) return {};

      const settled = await Promise.allSettled(
        conditionIds.map((id) =>
          enqueueCall(() =>
            client.readContract({
              address: conditionalTokens,
              abi: conditionalTokensAbi,
              functionName: 'getPayouts',
              args: [id],
            })
          )
        )
      );

      const out: Record<string, PayoutInfo> = {};
      settled.forEach((entry, i) => {
        if (entry.status !== 'fulfilled' || !entry.value) return;
        const [resolved, numerators, denominator] = entry.value as unknown as [
          boolean,
          readonly [bigint, bigint],
          bigint,
        ];
        if (!resolved || denominator <= ZERO) return;
        out[conditionIds[i]] = { numerators, denominator };
      });
      return out;
    },
  });

  const payoutFor = useCallback(
    (conditionId: string | undefined) => {
      if (typeof conditionId !== 'string') return null;
      return data?.[conditionId.toLowerCase()] ?? null;
    },
    [data]
  );

  return { payoutFor, isLoading: enabled && isLoading };
}

/* ─────────────────────────────── balances ───────────────────────────────── */

export interface WalletPosition {
  questionId: bigint;
  yes: bigint;
  no: bigint;
}

/**
 * The wallet's YES/NO balances across every market — in ONE request.
 *
 * `ConditionalTokens` is an OpenZeppelin ERC-1155, so it has `balanceOfBatch`.
 * Position ids are derived locally, which is what makes a single batched read
 * possible at all: the previous code had to fetch 2N ids first and could only
 * then issue 2N balance reads, two serial bursts deep.
 *
 * Accounts pair to ids BY INDEX, so a market whose ids could not be derived is
 * dropped from the request entirely rather than sent with a placeholder — one
 * misaligned entry would shift every later balance onto the wrong market.
 */
export function useWalletPositions(
  address: `0x${string}` | undefined,
  markets: MarketWithPositions[]
): {
  positions: WalletPosition[];
  balanceFor: (questionId: bigint) => { yes: bigint; no: bigint };
  isLoading: boolean;
  stale: boolean;
  refresh: () => void;
} {
  const client = usePublicClient();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const deployment = getDeployment(chainId);
  const conditionalTokens = deployment?.conditionalTokens as `0x${string}` | undefined;

  const targets = useMemo(
    () =>
      markets
        .filter((m) => m.positions !== null)
        .map((m) => ({
          id: m.questionId.toString(),
          yesId: m.positions!.yes,
          noId: m.positions!.no,
        })),
    [markets]
  );

  const setKey = useMemo(() => targets.map((t) => t.id).sort().join(','), [targets]);
  const enabled = !!client && !!address && !!conditionalTokens && targets.length > 0;

  const queryKey = useMemo(
    () => ['arc', 'balances', chainId, address ?? '', conditionalTokens ?? '', setKey] as const,
    [chainId, address, conditionalTokens, setKey]
  );

  const { data, isLoading, isError, isFetching } = useQuery<Record<string, WalletPosition>, Error>({
    queryKey,
    enabled,
    staleTime: POOLS_STALE_MS,
    gcTime: GC_MS,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      if (!client || !address || !conditionalTokens) return {};

      const ids: bigint[] = [];
      const accounts: `0x${string}`[] = [];
      for (const t of targets) {
        ids.push(t.yesId, t.noId);
        accounts.push(address, address);
      }

      const balances = (await enqueueCall(() =>
        client.readContract({
          address: conditionalTokens,
          abi: erc1155BatchAbi,
          functionName: 'balanceOfBatch',
          args: [accounts, ids],
        })
      )) as readonly bigint[];

      const out: Record<string, WalletPosition> = {};
      targets.forEach((t, i) => {
        const yes = balances?.[i * 2] ?? ZERO;
        const no = balances?.[i * 2 + 1] ?? ZERO;
        if (yes <= ZERO && no <= ZERO) return;
        out[t.id] = { questionId: BigInt(t.id), yes, no };
      });
      return out;
    },
  });

  const positions = useMemo(() => Object.values(data ?? {}), [data]);

  const balanceFor = useCallback(
    (questionId: bigint) => {
      const hit = data?.[questionId.toString()];
      return { yes: hit?.yes ?? ZERO, no: hit?.no ?? ZERO };
    },
    [data]
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    positions,
    balanceFor,
    isLoading: enabled && isLoading,
    stale: isError && !isFetching && !!data,
    refresh,
  };
}
