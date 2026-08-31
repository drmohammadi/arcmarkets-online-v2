/**
 * Owner-side hidden market list.
 *
 * The contracts have no delete, archive, or hide function: markets live in a
 * `mapping(uint256 => Market)` that `MarketFactory` only ever appends to, and
 * `useMarkets` enumerates `0..nextQuestionId`. Adding real deletion would mean
 * redeploying the factory and ConditionalTokens, abandoning every market and
 * every open position at the current addresses.
 *
 * Deleting a live market is also unsafe on its own terms: traders hold ERC-1155
 * shares against each FPMM, and removing a market with shares outstanding would
 * strand redeemable funds.
 *
 * So this is a PRESENTATION filter, and the UI says so. Hiding a market removes
 * it from the browsable list in this browser; the market, its pool and every
 * position remain fully intact on-chain and remain reachable by direct URL, so
 * holders can always still redeem.
 *
 * Scoped per chain so a testnet hide never affects another network.
 */

const STORAGE_KEY_PREFIX = 'arc-hidden-markets:v1:';
/** Bound the list so a runaway writer cannot bloat storage. */
const MAX_HIDDEN = 500;

export const HIDDEN_CHANGE_EVENT = 'arc-hidden-markets-change';

function keyFor(chainId: number): string {
  return `${STORAGE_KEY_PREFIX}${chainId}`;
}

/** Read the hidden set. Always returns a usable Set, never throws. */
export function getHiddenMarkets(chainId: number): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(keyFor(chainId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Accept only plain digit strings — these become questionIds.
    return new Set(
      parsed.filter((v): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v))
    );
  } catch {
    return new Set();
  }
}

function persist(chainId: number, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    const list = Array.from(ids).slice(0, MAX_HIDDEN);
    window.localStorage.setItem(keyFor(chainId), JSON.stringify(list));
    window.dispatchEvent(new Event(HIDDEN_CHANGE_EVENT));
  } catch {
    // Storage full or blocked: the in-session filter still applied.
  }
}

export function hideMarket(chainId: number, questionId: bigint): void {
  const ids = getHiddenMarkets(chainId);
  ids.add(questionId.toString());
  persist(chainId, ids);
}

export function unhideMarket(chainId: number, questionId: bigint): void {
  const ids = getHiddenMarkets(chainId);
  ids.delete(questionId.toString());
  persist(chainId, ids);
}

export function isMarketHidden(chainId: number, questionId: bigint): boolean {
  return getHiddenMarkets(chainId).has(questionId.toString());
}
