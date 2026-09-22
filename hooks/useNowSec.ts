'use client';

import { useEffect, useState } from 'react';

/**
 * Current unix seconds, re-rendering every 30s.
 *
 * Starts at BigInt(0) and fills in AFTER mount, not during render. Reading the
 * clock while rendering makes the server and client produce different markup and
 * trips a hydration mismatch -- the same mount-then-read shape `useHiddenMarkets`
 * uses, and the reason every existing ticker in this codebase is written that way.
 *
 * BigInt(0) on the first paint means `marketStatus` reports 'open' for one frame.
 * That is the right way round: a countdown appearing a moment late is better than
 * flashing "expired" across a page of live markets.
 *
 * 30s because every consumer displays minute-or-coarser granularity; a 1s timer
 * would re-render every card twice a minute for nothing.
 *
 * THERE ARE FOUR HAND-ROLLED COPIES OF THIS in the codebase today --
 * `app/page.tsx`, `app/market/[id]/page.tsx`, `components/Comments.tsx` and
 * `components/FaucetButton.tsx` (that one in `number`, not `bigint`). They are
 * deliberately left alone here and migrate in Task 4, where their consumers move
 * to the shared predicate anyway. Do not add a fifth.
 */
export function useNowSec(): bigint {
  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));

  useEffect(() => {
    const tick = () => setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return nowSec;
}
