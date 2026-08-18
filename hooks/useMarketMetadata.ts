'use client';

import { useCallback, useMemo } from 'react';
import { useChainId, useReadContract } from 'wagmi';
import { getMetadataAddress } from '@/lib/contracts';
import { marketMetadataAbi } from '@/lib/abis';
import { sanitizeText, sanitizeMultiline } from '@/lib/sanitize';
import { safeImageUrl } from '@/lib/links';

/**
 * On-chain market metadata: description, image URL, resolution source.
 *
 * Lives in a separate registry contract because the deployed MarketFactory has
 * no such fields and is not upgradeable. Two consequences shape this hook:
 *
 *  1. **The registry may not exist on this chain.** Chains deployed before it
 *     was written have no `marketMetadata` address. That is not an error state
 *     — it means "no descriptions", and every consumer renders exactly as it
 *     did before. `available` distinguishes the two for the admin UI.
 *  2. **Everything here is attacker-controlled in principle.** The values are
 *     arbitrary strings written by whoever owns the registry, so they are
 *     sanitized here, once, rather than at each render site.
 */

export interface MarketMetadata {
  /** Sanitized paragraphs, ready to render as <p> elements. Empty when unset. */
  descriptionParagraphs: string[];
  /** Raw-ish description, single-line, for previews and inputs. */
  descriptionText: string;
  /** https-only image URL, or null when unset/invalid. */
  imageUrl: string | null;
  /** Sanitized single-line resolution source. */
  resolutionSource: string;
  /** True when an admin has written an entry for this market. */
  isSet: boolean;
}

const EMPTY: MarketMetadata = {
  descriptionParagraphs: [],
  descriptionText: '',
  imageUrl: null,
  resolutionSource: '',
  isSet: false,
};

/** Raw tuple shape returned by getMetadata. */
type RawMetadata = {
  description: string;
  imageUrl: string;
  resolutionSource: string;
  set: boolean;
};

function normalize(raw: RawMetadata | undefined): MarketMetadata {
  if (!raw || !raw.set) return EMPTY;
  return {
    descriptionParagraphs: sanitizeMultiline(raw.description),
    descriptionText: sanitizeText(raw.description),
    imageUrl: safeImageUrl(raw.imageUrl),
    resolutionSource: sanitizeText(raw.resolutionSource),
    isSet: true,
  };
}

/**
 * Metadata for a single market.
 *
 * Returns EMPTY (not an error) whenever the registry is absent or the read is
 * in flight, so callers never need a loading branch just to render a page.
 */
export function useMarketMetadata(questionId: bigint | null): MarketMetadata & {
  isLoading: boolean;
  /** False when this chain has no metadata registry deployed. */
  available: boolean;
  refetch: () => void;
} {
  const chainId = useChainId();
  const registry = getMetadataAddress(chainId);
  const enabled = !!registry && questionId !== null;

  const { data, isLoading, refetch } = useReadContract({
    address: registry ?? undefined,
    abi: marketMetadataAbi,
    functionName: 'getMetadata',
    args: questionId !== null ? [questionId] : undefined,
    query: { enabled },
  });

  const value = useMemo(() => normalize(data as RawMetadata | undefined), [data]);

  return {
    ...value,
    isLoading: enabled && isLoading,
    available: !!registry,
    refetch: () => void refetch(),
  };
}

/**
 * Metadata for many markets at once, for the list and carousel.
 *
 * Returns a Map keyed by the decimal questionId string, plus a convenience
 * `imageUrlFor` for the common case of "just give me this card's image".
 *
 * Callers pass `markets.map(m => m.questionId)`, which is a fresh array on every
 * render. That is fine and deliberate: everything below keys off the *contents*
 * (a joined string), not the array's identity, so an unmemoized caller does not
 * cause a refetch loop. Requiring every call site to remember useMemo would be a
 * trap that fails silently and expensively.
 *
 * The contract caps a batch at MAX_BATCH (50); this requests the first 50,
 * because the list view never renders more at once. If that changes, chunk here
 * rather than raising the on-chain cap.
 */
const MAX_BATCH = 50;

export function useMarketMetadataBatch(questionIds: bigint[]): {
  byId: Map<string, MarketMetadata>;
  imageUrlFor: (questionId: bigint) => string | null;
  isLoading: boolean;
  available: boolean;
} {
  const chainId = useChainId();
  const registry = getMetadataAddress(chainId);

  // Content-addressed identity: same ids in the same order => same string =>
  // same memo, regardless of how many new arrays the caller creates.
  const key = questionIds
    .slice(0, MAX_BATCH)
    .map((i) => i.toString())
    .join(',');

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the content
  // identity of questionIds; depending on the array itself would defeat the memo.
  const ids = useMemo(() => (key === '' ? [] : key.split(',').map((s) => BigInt(s))), [key]);

  const enabled = !!registry && ids.length > 0;

  const { data, isLoading } = useReadContract({
    address: registry ?? undefined,
    abi: marketMetadataAbi,
    functionName: 'getMetadataBatch',
    args: [ids],
    query: { enabled },
  });

  const byId = useMemo(() => {
    const out = new Map<string, MarketMetadata>();
    const rows = data as RawMetadata[] | undefined;
    if (!rows) return out;
    ids.forEach((id, i) => {
      out.set(id.toString(), normalize(rows[i]));
    });
    return out;
  }, [data, ids]);

  const imageUrlFor = useCallback(
    (questionId: bigint) => byId.get(questionId.toString())?.imageUrl ?? null,
    [byId]
  );

  return { byId, imageUrlFor, isLoading: enabled && isLoading, available: !!registry };
}
