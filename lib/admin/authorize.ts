import { recoverMessageAddress, getAddress } from 'viem';
import { consumeAdminNonce } from '@/lib/db/queries';
import { buildAdminMessage, type AdminMessageFields } from './message';
import { readFactoryOwner } from './owner';

export type AuthorizeResult =
  | { ok: true; actor: string }
  | { ok: false; status: number; error: string };

/**
 * Decide whether a signed admin request may proceed.
 *
 * Four steps, each failing closed, in an order chosen so the cheapest and most
 * decisive check runs first:
 *
 *  1. CONSUME THE NONCE. Before any crypto, so a replay attempt costs one UPDATE
 *     rather than a signature recovery. This is also the step that makes the
 *     request single-use: `consumeAdminNonce` is one atomic statement, so of two
 *     concurrent submissions of the same signature exactly one can win.
 *  2. REBUILD THE MESSAGE from the server's own chainId and domain plus the
 *     request's action fields. Nothing the client says about which chain or
 *     which site it is talking to is trusted — if any field was tampered with,
 *     the rebuilt string differs and step 3 recovers a different address.
 *  3. RECOVER the signer from that message.
 *  4. COMPARE to a fresh on-chain `owner()` read. The client's claim to be an
 *     admin is never an input at any point.
 *
 * Never throws: every failure is a typed result, because a throw inside a route
 * handler is a 500 that tells an attacker more than a 401 does.
 *
 * NOTE ON THE NONCE BEING SPENT ON FAILURE. A bad signature still burns the
 * nonce. That is intended: it makes brute-forcing a signature against one nonce
 * impossible, and an honest client simply requests another.
 */
export async function authorizeAdminWrite(args: {
  fields: AdminMessageFields;
  signature: string;
}): Promise<AuthorizeResult> {
  const { fields, signature } = args;

  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{100,200}$/.test(signature)) {
    return { ok: false, status: 400, error: 'malformed signature' };
  }

  let consumed: boolean;
  try {
    consumed = await consumeAdminNonce(fields.nonce);
  } catch {
    return { ok: false, status: 503, error: 'authorization store unavailable' };
  }
  if (!consumed) {
    // Covers unknown, already-used and expired alike. Distinguishing them would
    // tell a caller which nonces exist.
    return { ok: false, status: 401, error: 'invalid or expired nonce' };
  }

  let message: string;
  try {
    message = buildAdminMessage(fields);
  } catch {
    return { ok: false, status: 400, error: 'invalid request fields' };
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return { ok: false, status: 401, error: 'signature could not be verified' };
  }

  const owner = await readFactoryOwner();
  if (owner === null) {
    // DENY, not skip. An unreadable owner means we cannot establish authority,
    // and "we could not check" must never behave like "the check passed".
    return { ok: false, status: 503, error: 'owner could not be verified' };
  }

  let normalizedSigner: string;
  try {
    normalizedSigner = getAddress(signer);
  } catch {
    return { ok: false, status: 401, error: 'signature could not be verified' };
  }

  if (normalizedSigner !== owner) {
    return { ok: false, status: 403, error: 'signer is not the factory owner' };
  }

  return { ok: true, actor: normalizedSigner };
}
