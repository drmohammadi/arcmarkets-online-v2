/**
 * The bits of the indexer's HTTP surface that more than one route needs: how a
 * chain quantity becomes JSON, how far behind the index is, and a best-effort
 * read of the chain head.
 *
 * Server-only, like everything under `lib/indexer/`. Never imported by a client
 * component.
 */

import { createPublicClient, http } from 'viem';

const ZERO = BigInt(0);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Default timeout for a head read, in ms. Short on purpose: it is a diagnostic
 * field on a response the caller is waiting for, so it must never be the reason
 * a chart is slow.
 */
export const HEAD_TIMEOUT_MS = 1500;

/**
 * A chain quantity as JSON: an exact number when it fits one, else a decimal
 * string.
 *
 * The required response shapes carry block numbers as JSON NUMBERS
 * (`"lastIndexedBlock": 57301912`), which is right for a value a human reads —
 * but this codebase's standing rule is that no block number passes through
 * `Number` unchecked, because that is how digits vanish silently. Both hold
 * here: a chain would need 9 quadrillion blocks to leave the exact range, and if
 * one ever did, a string is a visibly different shape rather than a quietly
 * wrong figure. Never do arithmetic on the result — do it in `bigint` and
 * serialize last.
 */
export function jsonNumber(value: bigint): number | string {
  return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
}

/**
 * How many blocks the index is behind the chain, or null when either end is
 * unknown.
 *
 * A COUNT for a human to read, so a `number` is the right type — and it
 * SATURATES rather than losing digits, the same trade `lib/indexer/run.ts:toCount`
 * makes for `reorgDepth`: a visibly pinned figure beats a silently wrong one.
 * Clamped at 0 because a checkpoint at or above the head is not "negatively
 * behind"; it is caught up. That is reachable and normal, since the checkpoint
 * chases `head - confirmations` while this compares against the head itself.
 */
export function blocksBehindOf(head: bigint | null, indexed: bigint | null): number | null {
  if (head === null || indexed === null) return null;
  const delta = head - indexed;
  if (delta <= ZERO) return 0;
  return delta > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(delta);
}

/**
 * The chain's head block, or null when it could not be read in time.
 *
 * NO RETRY, DELIBERATELY, and a short timeout. This feeds a diagnostic field
 * (`blocksBehind`), so the honest answer to a slow or rate-limited endpoint is
 * "unknown", not "wait". `lib/indexer/rpc.ts` retries a 429 on a ladder that can
 * sleep 15 seconds, which is correct for an indexing run and completely wrong on
 * a request a browser is blocked on — so this builds its own client with
 * `retryCount: 0` instead of going through that facade.
 *
 * A `null` return must never empty the response: the chart's points come from
 * Postgres and are unaffected by whether the head was readable.
 */
export async function readChainHead(
  rpcUrl: string,
  timeoutMs: number = HEAD_TIMEOUT_MS
): Promise<bigint | null> {
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 0, timeout: timeoutMs }),
    });
    return await client.getBlockNumber();
  } catch (err) {
    // Logged, not raised: an unreadable head is a missing diagnostic, not a
    // failed request. The message can name the endpoint host, never a secret —
    // `INDEXER_RPC_URL` is rejected by `config.ts` if it carries credentials.
    console.warn(
      '[indexer] chain head read failed:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return null;
  }
}
