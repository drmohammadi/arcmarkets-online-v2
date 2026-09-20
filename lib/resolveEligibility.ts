/**
 * Why an admin may or may not resolve a market.
 *
 * This mirrors every guard that stands between a click and a successful
 * `MarketFactory.resolveMarket` call, so the UI can explain a refusal instead of
 * letting the user sign a transaction that reverts:
 *
 *   :107  whenNotPaused                     -> EnforcedPause
 *   :109  market.fpmm == address(0)         -> MarketNotFound      (see below)
 *   :110  market.resolver != msg.sender     -> Unauthorized
 *   :111  block.timestamp < resolutionTime  -> ResolutionTimeLocked
 *   :112  market.resolved                   -> MarketAlreadyResolved
 *
 * `MarketNotFound` is the one guard deliberately not modelled: every caller
 * builds its list by enumerating the factory, so `fpmm` is non-zero by
 * construction and there is no input that could express the failure.
 *
 * It is an ADDITIONAL check, never a substitute: the contract remains the
 * authority, and this function being wrong can only produce a worse message,
 * never an unauthorized resolution.
 *
 * WHY IT EXISTS. `/admin` gated its resolve buttons on the factory's `owner()`,
 * but the contract authorizes on the market's own `resolver`, which is chosen
 * per market at creation and need not be the owner. Where the two differed the
 * button was offered, signed, and then reverted.
 *
 * ORDER DIFFERS FROM THE CONTRACT DELIBERATELY. The contract checks cheapest
 * first, and its `whenNotPaused` modifier runs before anything else. Here the
 * order is by how useful the message is:
 *
 *   already-resolved  terminal, and true regardless of who is asking
 *   paused            global; no market can be resolved, so say that once
 *   not-connected     nothing else can be evaluated without a wallet
 *   not-resolver      specific to this wallet
 *   not-expired       specific to this market, and resolves itself with time
 *
 * Telling an admin "wrong wallet" about a market that is simply already
 * resolved reads as a permissions bug and sends them looking for a key they do
 * not need.
 *
 * ONE HONEST LIMIT: `nowSec` is the caller's clock, while the contract compares
 * against `block.timestamp`. On a chain whose head is lagging, or from a machine
 * with a skewed clock, the two disagree and a button may enable a few seconds
 * before the contract will accept it. Closing that would cost an RPC read per
 * render for a bounded, self-correcting error, so it is documented rather than
 * fixed.
 *
 * Zero imports: `contracts/test/` compiles this under a CommonJS tsconfig.
 */

export type ResolveBlocker =
  | null
  | 'already-resolved'
  | 'paused'
  | 'not-connected'
  | 'not-resolver'
  | 'not-expired';

export interface ResolveEligibilityInput {
  /** Connected wallet, or undefined when no wallet is connected. */
  connected: string | undefined;
  /** `markets(questionId).resolver` -- the ONLY address the contract accepts. */
  resolver: string;
  resolved: boolean;
  resolutionTime: bigint;
  nowSec: bigint;
  /**
   * `MarketFactory.paused()`. Treated as NOT paused when unknown, because the
   * read is a convenience: the contract still refuses, and blocking the whole
   * panel on a failed `paused()` read would be a worse failure than a revert.
   */
  paused: boolean;
}

/**
 * Case-insensitive address comparison that treats anything malformed as "no
 * match". Failing closed matters here: a garbled resolver must disable the
 * button, never enable it.
 *
 * The prefix is matched as `0[xX]` rather than `0x`. Leniency there costs
 * nothing -- the comparison is still exact equality after lowercasing, so this
 * cannot admit a non-matching address -- and a valid resolver arriving with an
 * uppercase prefix would otherwise read as "wrong wallet", which sends an admin
 * looking for a key they already hold.
 */
function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;
  if (!ADDRESS.test(a) || !ADDRESS.test(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function resolveBlocker(input: ResolveEligibilityInput): ResolveBlocker {
  if (input.resolved) return 'already-resolved';
  if (input.paused) return 'paused';
  if (typeof input.connected !== 'string' || input.connected.length === 0) {
    return 'not-connected';
  }
  if (!sameAddress(input.connected, input.resolver)) return 'not-resolver';
  // `>=`, matching the contract's `<` revert: the boundary second is resolvable.
  if (input.nowSec < input.resolutionTime) return 'not-expired';
  return null;
}
