import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getIndexerConfig } from '@/lib/indexer/config';
import { withTx } from '@/lib/db/pool';
import { setMarketDeleted } from '@/lib/db/queries';
import { authorizeAdminWrite } from '@/lib/admin/authorize';
import {
  canonicalQuestionIds,
  MAX_REASON_BYTES,
  type AdminMessageFields,
} from '@/lib/admin/message';

/**
 * The only authenticated write in this application.
 *
 * Authorization is a signature recovered server-side and compared against a
 * fresh `MarketFactory.owner()` read — see `lib/admin/authorize.ts`. No session,
 * no bearer token, nothing the browser holds that could be stolen or ridden.
 *
 * NOTHING ON-CHAIN CHANGES HERE. This sets an application flag that removes a
 * market from the app's listings. The market, its pool and every outstanding
 * position remain live and redeemable — `MarketFactory` has no delete, and the
 * portfolio deliberately does not filter positions by this flag, so a holder's
 * redeemable balance never disappears because an admin removed a market.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function jsonWith(body: unknown, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set('cache-control', 'no-store');
  return res;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Same-origin check.
 *
 * A signed request is already CSRF-resistant — a cross-site page cannot produce
 * the signature, and there is no ambient cookie to ride. This is defence in
 * depth, and it is also what makes the `Domain` line in the signed message
 * meaningful: the host we verify against is the host we were actually called on.
 *
 * A missing Origin is allowed (curl, server-to-server); a PRESENT but foreign
 * one is refused.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let config;
  try {
    config = getIndexerConfig();
  } catch {
    return jsonWith({ error: 'admin actions are not configured on this deployment' }, 503);
  }

  if (!originAllowed(request)) return jsonWith({ error: 'cross-origin request refused' }, 403);

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonWith({ error: 'expected application/json' }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonWith({ error: 'malformed JSON' }, 400);
  }
  if (!body || typeof body !== 'object') return jsonWith({ error: 'malformed body' }, 400);

  const raw = body as {
    questionIds?: unknown;
    deleted?: unknown;
    reason?: unknown;
    nonce?: unknown;
    signature?: unknown;
    expiresAt?: unknown;
  };

  if (typeof raw.deleted !== 'boolean') {
    return jsonWith({ error: 'deleted must be a boolean' }, 400);
  }
  if (typeof raw.nonce !== 'string' || typeof raw.signature !== 'string') {
    return jsonWith({ error: 'nonce and signature are required' }, 400);
  }
  if (typeof raw.expiresAt !== 'string') {
    return jsonWith({ error: 'expiresAt is required' }, 400);
  }

  const reason = raw.reason === undefined || raw.reason === null ? null : raw.reason;
  if (reason !== null && (typeof reason !== 'string' || byteLength(reason) > MAX_REASON_BYTES)) {
    return jsonWith({ error: 'reason is invalid or too long' }, 400);
  }

  // Validates digits, length, batch cap, and canonicalises order + duplicates.
  // Throws on anything malformed rather than silently dropping an id.
  let ids: string[];
  try {
    ids = canonicalQuestionIds(raw.questionIds as readonly string[]);
  } catch (err) {
    return jsonWith({ error: err instanceof Error ? err.message : 'invalid questionIds' }, 400);
  }

  /*
   * The chain and the domain come from the SERVER, never the body. A caller who
   * could choose them could have a signature intended for another deployment or
   * another chain accepted here.
   */
  const fields: AdminMessageFields = {
    domain: new URL(request.url).host,
    chainId: config.chainId,
    questionIds: ids,
    deleted: raw.deleted,
    reason,
    nonce: raw.nonce,
    expiresAt: raw.expiresAt,
  };

  const auth = await authorizeAdminWrite({ fields, signature: raw.signature });
  if (!auth.ok) return jsonWith({ error: auth.error }, auth.status);

  // The digest, not the signature: enough to identify the request that caused a
  // change, without persisting raw credential material.
  const sigDigest = createHash('sha256').update(raw.signature, 'utf8').digest('hex');

  try {
    const written = await withTx((c) =>
      setMarketDeleted(c, {
        chainId: config.chainId,
        questionIds: ids.map((id) => BigInt(id)),
        deleted: raw.deleted as boolean,
        reason,
        actor: auth.actor,
        nonce: raw.nonce as string,
        sigDigest,
      })
    );
    return jsonWith({ updated: written, deleted: raw.deleted, questionIds: ids }, 200);
  } catch (err) {
    console.error(
      '[admin] flag write failed:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ error: 'could not record the change' }, 503);
  }
}
