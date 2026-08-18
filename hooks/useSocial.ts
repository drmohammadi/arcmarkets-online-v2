'use client';

import { useCallback, useMemo } from 'react';
import { useChainId, useReadContract } from 'wagmi';
import { getSocialAddress } from '@/lib/contracts';
import { socialAbi } from '@/lib/abis';
import { sanitizeText, safeAddress } from '@/lib/sanitize';
import { displayName } from '@/lib/username';

/**
 * Usernames and comments from the Social registry.
 *
 * Shaped like `useMarketMetadata`, and for the same two reasons:
 *
 *  1. **The registry may not exist on this chain.** Chains deployed before it
 *     was written have no `social` address. That is not an error — it means
 *     "no comments, default names everywhere", and every consumer renders
 *     something sensible. `available` distinguishes the two for the UI.
 *  2. **Everything here is attacker-controlled.** Unlike MarketMetadata, whose
 *     writes are owner-gated, ANY address can set a username or post a comment.
 *     Every string is sanitized here, once, rather than at each render site.
 */

/** Mirrors Social.sol's MAX_PAGE. */
export const COMMENT_PAGE_SIZE = 50;

export interface CommentView {
  /** Index in the on-chain thread. Stable: deletes are soft. */
  index: number;
  author: `0x${string}` | null;
  /** Unix seconds, as reported by the contract. */
  timestamp: number;
  deleted: boolean;
  /** Sanitized body. Empty for a deleted comment. */
  text: string;
}

/** Raw struct shape returned by commentsPaged. */
type RawComment = {
  author: string;
  timestamp: bigint;
  deleted: boolean;
  text: string;
};

/**
 * The claimed name for one address, plus the resolved display name.
 *
 * `name` is what the UI should print. `claimed` says whether it came from the
 * registry or was derived, which the profile editor needs in order to show
 * "set a username" versus "change your username".
 */
export function useUsername(address: `0x${string}` | undefined): {
  name: string;
  claimed: string;
  isLoading: boolean;
  available: boolean;
  refetch: () => void;
} {
  const chainId = useChainId();
  const registry = getSocialAddress(chainId);
  const enabled = !!registry && !!address;

  const { data, isLoading, refetch } = useReadContract({
    address: registry ?? undefined,
    abi: socialAbi,
    functionName: 'usernameOf',
    args: address ? [address] : undefined,
    query: { enabled },
  });

  const claimed = sanitizeText(data as string | undefined);

  return {
    name: displayName(address, claimed),
    claimed,
    isLoading: enabled && isLoading,
    available: !!registry,
    refetch: () => void refetch(),
  };
}

/**
 * Names for many addresses at once, for the leaderboard and a comment thread.
 *
 * Content-addressed memo on the joined address list, so an unmemoized caller
 * array does not cause a refetch loop — the same trap `useMarketMetadataBatch`
 * documents. Capped at the contract's MAX_PAGE.
 */
export function useUsernames(addresses: string[]): {
  nameFor: (address: string | undefined) => string;
  isLoading: boolean;
  available: boolean;
} {
  const chainId = useChainId();
  const registry = getSocialAddress(chainId);

  // Deduplicate and normalize before hashing: the same set of authors in a
  // different order must not trigger a second request.
  const key = useMemo(() => {
    const seen = new Set<string>();
    for (const a of addresses) {
      const addr = safeAddress(a);
      if (addr) seen.add(addr);
    }
    return Array.from(seen).sort().slice(0, COMMENT_PAGE_SIZE).join(',');
  }, [addresses]);

  const list = useMemo(
    () => (key === '' ? [] : (key.split(',') as `0x${string}`[])),
    [key]
  );

  const enabled = !!registry && list.length > 0;

  const { data, isLoading } = useReadContract({
    address: registry ?? undefined,
    abi: socialAbi,
    functionName: 'usernamesOf',
    args: [list],
    query: { enabled },
  });

  const byAddress = useMemo(() => {
    const out = new Map<string, string>();
    const rows = data as string[] | undefined;
    if (!rows) return out;
    list.forEach((addr, i) => {
      const claimed = sanitizeText(rows[i]);
      if (claimed) out.set(addr, claimed);
    });
    return out;
  }, [data, list]);

  const nameFor = useCallback(
    (address: string | undefined) => {
      const addr = safeAddress(address);
      if (!addr) return displayName(address);
      return displayName(addr, byAddress.get(addr));
    },
    [byAddress]
  );

  return { nameFor, isLoading: enabled && isLoading, available: !!registry };
}

/**
 * A market's comment thread.
 *
 * Reads the total first, then the newest page. Newest-first is what a reader
 * expects, but the contract stores oldest-first, so the window is computed from
 * the end and the returned page is reversed.
 *
 * `count` includes soft-deleted entries, because they still occupy an index —
 * a pager that skipped them would walk off the end. They are filtered out of
 * the rendered list instead.
 */
export function useComments(
  questionId: bigint | null,
  page = 0
): {
  comments: CommentView[];
  count: number;
  hasMore: boolean;
  isLoading: boolean;
  available: boolean;
  refetch: () => void;
} {
  const chainId = useChainId();
  const registry = getSocialAddress(chainId);
  const enabled = !!registry && questionId !== null;

  const { data: countData, isLoading: countLoading, refetch: refetchCount } = useReadContract({
    address: registry ?? undefined,
    abi: socialAbi,
    functionName: 'commentCount',
    args: questionId !== null ? [questionId] : undefined,
    query: { enabled },
  });

  const count = typeof countData === 'bigint' ? Number(countData) : 0;

  // Window from the end: page 0 is the newest COMMENT_PAGE_SIZE entries.
  const end = Math.max(0, count - page * COMMENT_PAGE_SIZE);
  const offset = Math.max(0, end - COMMENT_PAGE_SIZE);
  const limit = Math.max(0, end - offset);

  const { data: pageData, isLoading: pageLoading, refetch: refetchPage } = useReadContract({
    address: registry ?? undefined,
    abi: socialAbi,
    functionName: 'commentsPaged',
    args: questionId !== null ? [questionId, BigInt(offset), BigInt(limit)] : undefined,
    query: { enabled: enabled && limit > 0 },
  });

  const comments = useMemo(() => {
    const rows = pageData as RawComment[] | undefined;
    if (!rows) return [];
    const out: CommentView[] = [];
    rows.forEach((c, i) => {
      if (!c) return;
      out.push({
        index: offset + i,
        author: safeAddress(c.author),
        timestamp: typeof c.timestamp === 'bigint' ? Number(c.timestamp) : 0,
        deleted: !!c.deleted,
        text: c.deleted ? '' : sanitizeText(c.text),
      });
    });
    // Newest first for display; the contract stores oldest-first.
    return out.reverse();
  }, [pageData, offset]);

  const refetch = useCallback(() => {
    void refetchCount();
    void refetchPage();
  }, [refetchCount, refetchPage]);

  return {
    comments,
    count,
    hasMore: offset > 0,
    isLoading: enabled && (countLoading || (limit > 0 && pageLoading)),
    available: !!registry,
    refetch,
  };
}
