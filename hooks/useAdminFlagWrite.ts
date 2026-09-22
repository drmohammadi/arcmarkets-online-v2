'use client';

import { useCallback, useState } from 'react';
import { useSignMessage } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { buildAdminMessage } from '@/lib/admin/message';
import { sanitizeText } from '@/lib/sanitize';

/**
 * Removes markets from the app, or restores them, through a signed request.
 *
 * THE FLOW, AND WHY EACH STEP EXISTS:
 *   1. Ask the server for a single-use nonce. The server records it; we never
 *      invent one, because a client-chosen nonce is not a replay guard.
 *   2. Build the message with the SAME builder the server verifies with. The
 *      chain id and the host are included so a signature cannot be replayed
 *      against another deployment, and the action and ids are included so it
 *      cannot be replayed as a different action.
 *   3. Sign it with the connected wallet. No gas, no transaction — nothing here
 *      is on-chain.
 *   4. POST. The server recovers the signer and compares it to a fresh
 *      `MarketFactory.owner()` read. This hook's opinion about who is an admin
 *      is irrelevant to the outcome, which is the point.
 *   5. Invalidate the flags query so every list on the page updates.
 *
 * Every failure path sets an error string; nothing throws into a click handler.
 */

export interface AdminFlagWrite {
  setDeleted: (questionIds: readonly bigint[], deleted: boolean, reason?: string) => Promise<boolean>;
  busy: boolean;
  error: string;
  clearError: () => void;
}

export function useAdminFlagWrite(): AdminFlagWrite {
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setDeleted = useCallback(
    async (questionIds: readonly bigint[], deleted: boolean, reason?: string): Promise<boolean> => {
      if (questionIds.length === 0) return false;
      setError('');
      setBusy(true);
      try {
        const nonceRes = await fetch('/api/admin/nonce', {
          headers: { accept: 'application/json' },
        });
        if (!nonceRes.ok) {
          setError('Could not start the request. The admin store may be unavailable.');
          return false;
        }
        const { nonce, expiresAt } = (await nonceRes.json()) as {
          nonce?: unknown;
          expiresAt?: unknown;
        };
        if (typeof nonce !== 'string' || typeof expiresAt !== 'string') {
          setError('The server returned an unusable nonce.');
          return false;
        }

        const ids = questionIds.map((id) => id.toString());
        const trimmed = reason && reason.trim().length > 0 ? reason.trim() : null;

        // Built here exactly as the server will rebuild it. If these ever
        // diverge the signature simply will not verify, which is why both sides
        // call the same function.
        const message = buildAdminMessage({
          domain: window.location.host,
          chainId,
          questionIds: ids,
          deleted,
          reason: trimmed,
          nonce,
          expiresAt,
        });

        const signature = await signMessageAsync({ message });

        const res = await fetch('/api/admin/markets/flags', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            questionIds: ids,
            deleted,
            reason: trimmed,
            nonce,
            expiresAt,
            signature,
          }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          const detail =
            typeof body?.error === 'string' ? sanitizeText(body.error).slice(0, 200) : '';
          setError(detail || `The request was refused (${res.status}).`);
          return false;
        }

        await queryClient.invalidateQueries({ queryKey: ['arc', 'market-flags'] });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(
          /user rejected|user denied/i.test(msg)
            ? 'Signature rejected.'
            : sanitizeText(msg).slice(0, 200) || 'The request failed.'
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [chainId, signMessageAsync, queryClient]
  );

  return { setDeleted, busy, error, clearError: () => setError('') };
}
