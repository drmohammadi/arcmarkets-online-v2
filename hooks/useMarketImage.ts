'use client';

import { useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import { getMarketImage, IMAGE_CHANGE_EVENT } from '@/lib/marketImages';

/**
 * The stored image for one market, kept in sync with uploads.
 *
 * Reads on mount rather than during render: localStorage is unavailable during
 * SSR, and reading it in the render body would desync hydration. Starting at
 * null and filling in on mount means server and first client render agree.
 *
 * Listens to both the same-tab custom event and the cross-tab `storage` event,
 * since the native one does not fire in the tab that made the change.
 */
export function useMarketImage(questionId: bigint | null): string | null {
  const chainId = useChainId();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (questionId === null) {
      setSrc(null);
      return;
    }

    const read = () => setSrc(getMarketImage(chainId, questionId));
    read();

    window.addEventListener(IMAGE_CHANGE_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(IMAGE_CHANGE_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, [chainId, questionId]);

  return src;
}
