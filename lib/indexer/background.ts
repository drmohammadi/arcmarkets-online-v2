/**
 * The single seam for background execution.
 *
 * waitUntil() from @vercel/functions, NOT after() from next/server: after()
 * requires Next 15.1+ and this project is pinned to 14.2.35, where upgrading is
 * a semver-major change bundled with wagmi/viem (see TODO.md).
 *
 * Everything else calls scheduleBackgroundIndex(). Swapping the mechanism —
 * to after() after a future Next upgrade, to Vercel Queues, to a plain await in
 * a test — is a change to this file alone. It is also the ONLY module in the
 * codebase permitted to import that package, so the quarantine is checkable
 * with one grep.
 */
import { waitUntil } from '@vercel/functions';
import { runIndexer, type IndexRunOptions } from './run';

export function scheduleBackgroundIndex(opts: IndexRunOptions): void {
  // runIndexer never throws, so this promise always settles; the catch is a
  // belt-and-braces guard against an unhandled rejection in a background task,
  // which on Vercel would be invisible.
  const work = runIndexer(opts).then(
    (r) => {
      if (r.error) console.error('[indexer] run error', r.error);
    },
    (err) => console.error('[indexer] unexpected throw', err)
  );

  try {
    waitUntil(work);
  } catch {
    // No Vercel runtime (local dev, the Hardhat e2e). waitUntil throws outside
    // a request context, so fall back to letting the promise run detached. The
    // e2e script awaits runIndexer directly instead of going through here, so
    // its assertions are never racing a fire-and-forget.
    void work;
  }
}
