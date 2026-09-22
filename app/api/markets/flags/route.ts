import { NextResponse } from 'next/server';
import { getIndexerConfig } from '@/lib/indexer/config';
import { selectDeletedMarkets } from '@/lib/db/queries';

/**
 * Which markets the app has removed. Public, read-only, cached.
 *
 * This replaces `lib/hiddenMarkets.ts`, which kept the set in `localStorage` —
 * so a removal only ever applied to the browser that performed it, and clearing
 * site data brought every market back. The authority is now this table, shared
 * by every visitor and every device.
 *
 * DEGRADES RATHER THAN 5xx'ing, matching the other public read routes. A
 * database outage returns an EMPTY deleted set, which means removed markets
 * reappear in listings until it recovers.
 *
 * That is fail-open, and it is a deliberate trade rather than an oversight. The
 * alternative — refusing to render any market list when the flag store is
 * unreachable — blanks the entire site over a curation lookup. Nothing here is a
 * security control: a removed market is still live on-chain and still reachable
 * by direct URL by design, so failing open exposes nothing that was otherwise
 * sealed. Clients keep the last known good set cached, so a brief blip does not
 * flash removed markets back.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(): Promise<NextResponse> {
  let config;
  try {
    config = getIndexerConfig();
  } catch {
    // Not configured is not an error for a reader: the app simply has no
    // removals to report.
    const res = NextResponse.json({ deleted: [], meta: { degraded: true } }, { status: 200 });
    res.headers.set('cache-control', 'no-store');
    return res;
  }

  try {
    // chainId from server config, never a query parameter: a caller must not be
    // able to ask for another chain's curation state.
    const ids = await selectDeletedMarkets(config.chainId);
    const res = NextResponse.json(
      { deleted: ids.map((id) => id.toString()), meta: { degraded: false } },
      { status: 200 }
    );
    res.headers.set('cache-control', 'public, s-maxage=15, stale-while-revalidate=60');
    return res;
  } catch (err) {
    console.error(
      '[flags] read failed:',
      err instanceof Error ? err.message : 'unknown error'
    );
    const res = NextResponse.json({ deleted: [], meta: { degraded: true } }, { status: 200 });
    res.headers.set('cache-control', 'no-store');
    return res;
  }
}
