'use client';

import { useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { conditionalTokensAbi } from '@/lib/abis';
import { sanitizeText } from '@/lib/sanitize';
import { formatUsdc } from '@/lib/format';
import { redeemableAmount } from '@/lib/redeemable';
import type { PayoutInfo } from '@/lib/ledger';

/**
 * The single Redeem control, used by both the market page and the portfolio.
 *
 * ONE IMPLEMENTATION ON PURPOSE. Redemption used to exist only on
 * `/market/[id]`, which meant a holder had to already know which of their
 * markets had resolved and open each one to find out. The portfolio is where
 * people actually look for money they are owed, so the same control now renders
 * there too -- and sharing the component is what stops the two drifting into
 * different ideas of when the button should be enabled.
 *
 * THE RULE THIS ENFORCES: never offer an enabled button for a position that
 * cannot be redeemed. `ConditionalTokens.redeemPositions` reverts
 * `NoWinningShares` when the payout is zero (`ConditionalTokens.sol:137`), so a
 * losing position previously produced a button whose only outcome was a failed
 * transaction -- the user learned they had lost from a revert dump. The amount
 * is computed with the same `redeemableAmount` the totals use, so the figure on
 * the button and the figure in the tile can never disagree.
 *
 * `payout === null` means "we do not know", explicitly not "zero": the caller
 * distinguishes still-loading from failed-to-load, and neither is rendered as a
 * confident "nothing to redeem".
 */
export function RedeemButton({
  yesShares,
  noShares,
  payout,
  payoutLoading,
  conditionalTokens,
  collateralToken,
  conditionId,
  onRedeemed,
  compact = false,
}: {
  yesShares: bigint;
  noShares: bigint;
  /** Reported numerators, or null while unknown. Null is NOT zero. */
  payout: PayoutInfo | null;
  payoutLoading: boolean;
  conditionalTokens: `0x${string}` | undefined;
  collateralToken: `0x${string}` | undefined;
  conditionId: `0x${string}` | undefined;
  onRedeemed?: () => void;
  /** Row variant: smaller, no explanatory prose. */
  compact?: boolean;
}) {
  const [error, setError] = useState('');
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: waiting, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || waiting;

  useEffect(() => {
    if (isSuccess && onRedeemed) onRedeemed();
  }, [isSuccess, onRedeemed]);

  const redeemable =
    payout === null
      ? BigInt(0)
      : redeemableAmount({
          yes: yesShares,
          no: noShares,
          numerators: payout.numerators,
          denominator: payout.denominator,
        });

  function handleRedeem() {
    if (!conditionalTokens || !collateralToken || !conditionId) {
      setError('Market data is still loading. Try again in a moment.');
      return;
    }
    setError('');
    writeContract(
      {
        address: conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: 'redeemPositions',
        args: [collateralToken, conditionId],
      },
      {
        onError: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setError(
            msg.toLowerCase().includes('nowinningshares')
              ? 'No winning shares to redeem in this market.'
              : sanitizeText(msg).slice(0, 200) || 'Redeem failed'
          );
        },
      }
    );
  }

  if (payout === null) {
    return (
      <p
        className={`${compact ? 'text-2xs' : 'mt-3 text-xs'} text-content-muted`}
        role="status"
      >
        {payoutLoading
          ? 'Checking payout…'
          : 'Payout data unavailable, so the redeemable amount is unknown.'}
      </p>
    );
  }

  if (redeemable <= BigInt(0)) {
    return (
      <p className={`${compact ? 'text-2xs' : 'mt-3 text-xs'} text-content-muted`}>
        {compact ? 'Nothing to redeem' : 'This market resolved against your position, so there is nothing to redeem.'}
      </p>
    );
  }

  return (
    <div className={compact ? '' : 'mt-3'}>
      <button
        type="button"
        onClick={handleRedeem}
        disabled={working}
        className={`rounded-lg bg-brand font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50 ${
          compact ? 'h-8 px-3 text-2xs' : 'h-9 px-4 text-xs'
        }`}
      >
        {working ? 'Redeeming…' : `Redeem $${formatUsdc(redeemable)}`}
      </button>
      {!compact && (
        <p className="mt-1.5 text-2xs text-content-subtle">
          Exact amount from the reported payouts, not an estimate.
        </p>
      )}
      {error && <p className="mt-2 text-2xs text-no">{error}</p>}
    </div>
  );
}
