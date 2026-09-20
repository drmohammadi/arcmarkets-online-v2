/**
 * What `ConditionalTokens.redeemPositions` will actually pay.
 *
 * A transcription of the contract's arithmetic (`ConditionalTokens.sol:134-135`):
 *
 *   payout = (yesShares * numerators[0] + noShares * numerators[1]) / denominator
 *
 * kept equivalent on purpose: same operand order, and a SINGLE division at the
 * end. Integer division truncates in Solidity, and bigint `/` truncates too, so
 * the two agree exactly for every value the contract can hold. Rounding up here
 * would make the UI promise a unit the contract refuses to pay.
 *
 * `contracts/test/DifferentialPayouts.test.ts` pins that agreement against a
 * really deployed `ConditionalTokens`, rather than against constants copied out
 * of it by hand.
 *
 * WHY THIS EXISTS. The portfolio used to mark redeemable value at the last pool
 * price and add it whenever `resolved` was true:
 *
 *   const v = (p.yes * yesBps + p.no * noBps) / BigInt(10000);
 *   if (p.market.resolved) redeemable += v;
 *
 * That is wrong twice over. It credits LOSING shares, which redeem for exactly
 * zero, and it prices winning shares off the last trade -- a number that stops
 * meaning anything the moment a market resolves. After resolution a share is
 * worth its payout, not its final quote.
 *
 * WHERE IT DIVERGES FROM THE CONTRACT, AND WHY. Two of the contract's failure
 * modes are reverts, which a summary tile cannot render:
 *
 *   - `denominator == 0` (unresolved): the contract reverts
 *     `ConditionNotResolved` (`:127`); this returns 0.
 *   - a zero payout (all shares losing): the contract reverts `NoWinningShares`
 *     (`:137`); this returns 0.
 *
 * So a 0 from this function means "nothing to redeem", and callers must decide
 * for themselves whether that is because a market is unresolved or because the
 * wallet lost -- those are different things to put in front of a user, and this
 * function cannot tell them apart. Check `resolved` separately; do not infer it.
 *
 * NO RUNTIME TOTALITY IS CLAIMED. The inputs are typed `bigint`, and TypeScript
 * is what enforces that. Called with an `undefined` denominator from untyped
 * data this throws, like any other bigint arithmetic would -- an earlier version
 * of this comment claimed otherwise, which was simply false.
 *
 * Zero imports: `contracts/test/` compiles this under a CommonJS tsconfig.
 */

export interface RedeemableInput {
  yes: bigint;
  no: bigint;
  /** `[yesNumerator, noNumerator]` as reported to the condition. */
  numerators: readonly [bigint, bigint];
  /** `payoutDenominator`; 0 means the condition is not resolved. */
  denominator: bigint;
}

export function redeemableAmount(input: RedeemableInput): bigint {
  // The only guard. A zero weighted sum needs no special case: `0n / d` is
  // already 0n, and the operands are uint256 values, so the sum is never
  // negative. An earlier `weighted <= 0` branch here was unreachable.
  if (input.denominator <= BigInt(0)) return BigInt(0);
  return (input.yes * input.numerators[0] + input.no * input.numerators[1]) / input.denominator;
}
