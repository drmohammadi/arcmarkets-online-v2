import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getIndexerConfig } from '@/lib/indexer/config';
import { issueAdminNonce } from '@/lib/db/queries';

/**
 * Issues a single-use nonce for a signed admin write.
 *
 * UNAUTHENTICATED, DELIBERATELY. A nonce grants nothing on its own — the write
 * route independently recovers the signer and compares it to a fresh on-chain
 * `owner()` read. Gating this endpoint would add a credential without adding a
 * boundary, and the write route is where the boundary belongs.
 *
 * The only abuse surface is filling `admin_nonces` with unused rows, which
 * `issueAdminNonce` bounds by sweeping expired entries on each call.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** Long enough to read a wallet prompt, short enough that a leaked nonce dies fast. */
const TTL_SECONDS = 300;

function jsonWith(body: unknown, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function GET(): Promise<NextResponse> {
  // Inside the handler, never at module scope: it throws without DATABASE_URL,
  // and `next build` imports this file.
  try {
    getIndexerConfig();
  } catch {
    return jsonWith({ error: 'admin actions are not configured on this deployment' }, 503);
  }

  // 32 bytes of CSPRNG. Lowercase hex, matching the format `buildAdminMessage`
  // validates, so a nonce this route issues can never be rejected as malformed
  // by the message builder.
  const nonce = randomBytes(32).toString('hex');

  try {
    const expiresAt = await issueAdminNonce(nonce, TTL_SECONDS);
    return jsonWith({ nonce, expiresAt: expiresAt.toISOString() }, 200);
  } catch (err) {
    console.error(
      '[admin] nonce issue failed:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ error: 'could not issue a nonce' }, 503);
  }
}
