/**
 * 6-decimal USDC formatting/parsing for Arc's native gas token.
 * NEVER use ethers.formatEther / parseEther (those are 18-decimal).
 */

export const USDC_DECIMALS = 6;

/**
 * Format a bigint USDC amount (raw 6-decimal units) to a human-readable string.
 * @example formatUsdc(BigInt(1500000)) → "1.5"
 * @example formatUsdc(BigInt(-1500000)) → "-1.5"
 *
 * The sign is stripped BEFORE padding and re-applied at the end. Padding a
 * negative value's string form puts the minus sign inside the digits — e.g.
 * (-1).toString().padStart(7, '0') is "0000-1", whose last six characters are
 * "000-1", so the sign ends up in the FRACTION. That produced "0.0000-1" for
 * one micro-USDC of loss and "-.5" for half a dollar. Harmless while every
 * caller passed a balance or a quote (never negative), but PnL is signed.
 */
export function formatUsdc(amount: bigint): string {
  const negative = amount < BigInt(0);
  const magnitude = negative ? -amount : amount;
  const str = magnitude.toString().padStart(USDC_DECIMALS + 1, '0');
  const intPart = str.slice(0, -USDC_DECIMALS) || '0';
  const fracPart = str.slice(-USDC_DECIMALS).replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  // Guard against "-0": a magnitude that rounds to nothing is just zero.
  return negative && body !== '0' ? `-${body}` : body;
}

/**
 * Format a signed amount with an explicit leading sign, for PnL display.
 * Zero carries no sign. The magnitude goes through formatUsdc, so this is
 * correct for negatives by construction rather than by a second implementation.
 * @example formatUsdcSigned(BigInt(1500000)) → "+1.5"
 */
export function formatUsdcSigned(amount: bigint): string {
  if (amount > BigInt(0)) return `+${formatUsdc(amount)}`;
  return formatUsdc(amount);
}

/**
 * Parse a human-readable USDC string to a bigint (raw 6-decimal units).
 * @example parseUsdc("1.5") → 1_500_000n
 */
export function parseUsdc(value: string): bigint {
  // Defensive: reject anything that isn't a plain decimal number. Returns BigInt(0) on
  // invalid input so callers can use it directly in render without try/catch.
  const trimmed = (value ?? '').trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return BigInt(0);
  const [intPart = '0', fracPart = ''] = trimmed.split('.');
  const safeInt = intPart === '' ? '0' : intPart;
  const paddedFrac = fracPart.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  try {
    return BigInt(safeInt + paddedFrac);
  } catch {
    return BigInt(0);
  }
}

/**
 * Format a bigint USDC amount as a compact display string (e.g., "1.2K", "3.4M").
 *
 * Works on the magnitude so a large negative compacts too: the threshold tests
 * are `>=`, which a negative number never satisfies, so -2_000_000_000 would
 * otherwise fall through to the full "-2000" instead of "-2.0K".
 */
export function formatUsdcCompact(amount: bigint): string {
  const negative = amount < BigInt(0);
  const magnitude = negative ? -amount : amount;
  const num = Number(magnitude) / 10 ** USDC_DECIMALS;
  const sign = negative ? '-' : '';
  if (num >= 1_000_000) return `${sign}${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${sign}${(num / 1_000).toFixed(1)}K`;
  return formatUsdc(amount);
}
