/**
 * Off-chain derivation of ERC-1155 outcome-token ids.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `FixedProductMarketMaker` exposes `yesPositionId()` / `noPositionId()`, and the
 * app used to read them. Both are `immutable`, set once in the constructor from
 * `ConditionalTokens.getPositionId`, which is a `pure` hash:
 *
 *     positionId = uint256(keccak256(abi.encode(collateral, conditionId, outcome)))
 *
 * Every input is already known on the client — `collateral` comes from the
 * deployment entry and `conditionId` from the factory's market record — so
 * reading them back was two `eth_call`s per market to learn a constant we could
 * compute for free. On the portfolio page that was 2N requests before a single
 * balance had been fetched, and because the balance reads DEPEND on the ids, it
 * also forced two serial round-trips instead of one.
 *
 * Deriving them locally removes both the requests and the round-trip. The
 * formula is pinned by `contracts/test/PositionId.test.ts`, which asserts these
 * functions agree with `getPositionId` AND with the pool's own immutables — if a
 * future contract changes the hash, that test fails rather than the UI silently
 * reading balances for ids that do not exist.
 *
 * Total: never throws. Malformed input yields null, which callers use to skip
 * the market entirely rather than query a garbage id.
 */

import { encodeAbiParameters, keccak256 } from 'viem';

/** `abi.encode(IERC20, bytes32, uint256)` — the exact tuple the contract hashes. */
const POSITION_ABI = [
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'uint256' },
] as const;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

/** The YES and NO token ids for one market. */
export interface PositionPair {
  yes: bigint;
  no: bigint;
}

/**
 * One position id, or null when either input is not a well-formed hex value.
 *
 * `outcome` is 0 for YES and 1 for NO, matching `ConditionalTokens.OUTCOME_COUNT`
 * ordering. Anything else is rejected: the contracts are binary at every layer,
 * so a third outcome would hash to an id no pool has ever minted.
 */
export function positionIdFor(
  collateral: string | undefined,
  conditionId: string | undefined,
  outcome: 0 | 1
): bigint | null {
  if (typeof collateral !== 'string' || !HEX_ADDRESS.test(collateral)) return null;
  if (typeof conditionId !== 'string' || !HEX_WORD.test(conditionId)) return null;
  if (outcome !== 0 && outcome !== 1) return null;

  try {
    const encoded = encodeAbiParameters(POSITION_ABI, [
      collateral as `0x${string}`,
      conditionId as `0x${string}`,
      BigInt(outcome),
    ]);
    return BigInt(keccak256(encoded));
  } catch {
    // encodeAbiParameters validates the address checksum; a bad one is a skip,
    // not a crash.
    return null;
  }
}

/**
 * Both ids for one market in one call, or null if either cannot be derived.
 *
 * Returning a pair-or-nothing is deliberate: a caller that got YES but not NO
 * would build a mismatched batch, and `balanceOfBatch` pairs accounts to ids by
 * INDEX — one missing entry would silently shift every later balance onto the
 * wrong market.
 */
export function positionPairFor(
  collateral: string | undefined,
  conditionId: string | undefined
): PositionPair | null {
  const yes = positionIdFor(collateral, conditionId, 0);
  const no = positionIdFor(collateral, conditionId, 1);
  if (yes === null || no === null) return null;
  return { yes, no };
}
