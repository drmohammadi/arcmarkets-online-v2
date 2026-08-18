/**
 * Display names for wallet addresses.
 *
 * Every address has a name whether or not its owner ever set one: the default
 * is DERIVED from the address itself rather than stored, so it costs nothing,
 * needs no contract call, and is stable forever. An address that has claimed a
 * name in the Social registry shows that instead.
 *
 * The derived form is deliberately NOT a claim of identity — it is a readable
 * handle for an address, and the UI shows the truncated address alongside it
 * wherever confusion would matter (leaderboard rows, comment headers).
 */

import { safeAddress, sanitizeText } from './sanitize';

/** Mirrors Social.sol's MIN_NAME_BYTES / MAX_NAME_BYTES. */
export const MIN_NAME_BYTES = 3;
export const MAX_NAME_BYTES = 20;

/** Mirrors Social.sol's MAX_COMMENT_BYTES. */
export const MAX_COMMENT_BYTES = 200;

/**
 * The default handle for an address, e.g. "arc4821".
 *
 * Derived from the last four hex digits of the address, which gives 65,536
 * possible values presented as a 4-digit decimal. Collisions between two
 * different addresses are therefore possible and expected — this is a display
 * convenience, not an identifier. Anywhere identity matters, show the address.
 *
 * Total: never throws. A malformed address yields a fixed placeholder rather
 * than an exception in a render path.
 */
export function defaultUsername(address: unknown): string {
  const addr = safeAddress(address);
  if (!addr) return 'arc0000';
  // Last 4 hex digits -> 0..65535, rendered zero-padded to 4 decimal digits.
  const tail = Number.parseInt(addr.slice(-4), 16);
  if (!Number.isFinite(tail)) return 'arc0000';
  return `arc${(tail % 10000).toString().padStart(4, '0')}`;
}

/**
 * The name to show for an address: the claimed one if there is a usable one,
 * otherwise the derived default.
 *
 * `onChainName` is attacker-controlled — anyone can call `setUsername` — so it
 * goes through `sanitizeText` before it can reach the DOM. The contract already
 * restricts names to `a-z 0-9 _ -`, but this function must stay correct even if
 * it is ever pointed at a different registry, so it does not assume that.
 */
export function displayName(address: unknown, onChainName?: unknown): string {
  const claimed = sanitizeText(onChainName);
  if (claimed) return claimed.slice(0, MAX_NAME_BYTES);
  return defaultUsername(address);
}

/** True when this address has claimed a name rather than using the default. */
export function hasClaimedName(onChainName?: unknown): boolean {
  return sanitizeText(onChainName).length > 0;
}

export type NameValidation = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate a candidate username against the contract's own rules, so the form
 * can reject bad input before it costs gas.
 *
 * Kept in lockstep with `Social._tryNormalize`. Checked in BYTES because that
 * is what the contract checks — though the legal charset here is single-byte
 * ASCII, so for accepted names bytes and characters coincide. The byte check
 * still matters for REJECTING multi-byte input with an accurate message.
 */
export function validateUsername(raw: string): NameValidation {
  const name = raw.trim();
  const bytes = new TextEncoder().encode(name).length;

  if (bytes < MIN_NAME_BYTES) {
    return { ok: false, error: `Names must be at least ${MIN_NAME_BYTES} characters.` };
  }
  if (bytes > MAX_NAME_BYTES) {
    return { ok: false, error: `Names must be at most ${MAX_NAME_BYTES} characters.` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: 'Use only letters, numbers, underscores and hyphens.' };
  }
  return { ok: true, name };
}
