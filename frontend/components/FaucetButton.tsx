'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { getDeployment } from '@/lib/contracts';
import { erc20Abi } from '@/lib/abis';
import { sanitizeText } from '@/lib/sanitize';
import { formatUsdc } from '@/lib/format';
import { FAUCET_URL } from '@/lib/links';

/**
 * Test-USDC faucet, available to EVERY visitor.
 *
 * `MockUSDC.faucet()` is public and self-rate-limited on-chain (1000 USDC per
 * address per day), so this needs no owner gating — the previous faucet control
 * lived on /admin, where the people who actually need test funds cannot reach it.
 *
 * Renders nothing unless this chain's collateral is MockUSDC. On mainnet the
 * collateral is real USDC, which has no faucet() and must never appear to.
 *
 * NOTE on the two faucets: this mints COLLATERAL to trade with. Arc's gas token
 * is native USDC, and a wallet with no native balance cannot pay for this
 * transaction at all — so the external faucet link is offered alongside, and is
 * the only useful option in that state.
 */
export function FaucetButton({ fullWidth = false }: { fullWidth?: boolean }) {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const deployment = getDeployment(chainId);
  const queryClient = useQueryClient();

  const [error, setError] = useState('');
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const token = deployment?.collateralToken as `0x${string}` | undefined;
  const enabled = !!deployment?.isMockUSDC && !!token && !!address;

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // Cooldown state, so the button can be disabled with a real countdown rather
  // than letting the user send a transaction that is guaranteed to revert.
  const { data: lastClaim, refetch: refetchClaim } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'lastFaucetClaim',
    args: address ? [address] : undefined,
    query: { enabled },
  });
  const { data: cooldown } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'FAUCET_COOLDOWN',
    query: { enabled },
  });
  const { data: faucetAmount } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'FAUCET_AMOUNT',
    query: { enabled },
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: waiting, isSuccess: done } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || waiting;

  useEffect(() => {
    if (!done) return;
    // Balances everywhere (header, trade panel, portfolio) are now stale.
    void queryClient.invalidateQueries();
    void refetchClaim();
  }, [done, queryClient, refetchClaim]);

  const secondsLeft = useMemo(() => {
    if (typeof lastClaim !== 'bigint' || typeof cooldown !== 'bigint') return 0;
    if (lastClaim === BigInt(0)) return 0;
    const next = Number(lastClaim + cooldown);
    return next > nowSec ? next - nowSec : 0;
  }, [lastClaim, cooldown, nowSec]);

  if (!deployment?.isMockUSDC) return null;

  const amountLabel =
    typeof faucetAmount === 'bigint' ? `${formatUsdc(faucetAmount)} test USDC` : 'test USDC';

  // In the mobile menu the control stretches to a full-width tap target; in the
  // header row it stays compact. Visibility is the caller's business — the
  // header hides its own copy on small screens.
  const boxClass = fullWidth ? 'flex w-full justify-center' : 'inline-flex';

  // Not connected: the on-chain faucet is unreachable, so point at the external
  // one, which is also where native gas comes from.
  if (!isConnected || !address) {
    if (!FAUCET_URL) return null;
    return (
      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`h-9 items-center rounded-md border border-edge px-2.5 text-xs font-medium text-content-muted transition-colors hover:text-content sm:h-8 ${boxClass}`}
      >
        {fullWidth ? 'Get test USDC (faucet)' : 'Faucet'}
      </a>
    );
  }

  const onCooldown = secondsLeft > 0;

  return (
    <div className={fullWidth ? 'relative w-full' : 'relative'}>
      <button
        type="button"
        disabled={working || onCooldown}
        onClick={() => {
          if (!token) {
            setError('Faucet is unavailable on this network.');
            return;
          }
          setError('');
          writeContract(
            { address: token, abi: erc20Abi, functionName: 'faucet' },
            {
              onError: (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                setError(friendlyFaucetError(msg));
                // A revert usually means our cooldown read was stale.
                void refetchClaim();
              },
            }
          );
        }}
        title={
          onCooldown
            ? `Already claimed. Next claim in ${formatCountdown(secondsLeft)}.`
            : `Claim ${amountLabel}`
        }
        className={`h-9 items-center rounded-md border border-edge px-2.5 text-xs font-medium text-content-muted transition-colors hover:text-content disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 ${boxClass}`}
      >
        {working
          ? 'Claiming…'
          : onCooldown
            ? `Faucet · ${formatCountdown(secondsLeft)}`
            : fullWidth
              ? `Claim ${amountLabel}`
              : 'Faucet'}
      </button>

      {error && (
        <p
          role="alert"
          className={`z-50 rounded-md border border-edge bg-surface-raised p-2 text-2xs text-no shadow-lg ${
            fullWidth ? 'mt-2 w-full' : 'absolute right-0 top-9 w-60'
          }`}
        >
          {error}
          {FAUCET_URL && (
            <>
              {' '}
              <a
                href={FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-content"
              >
                Open the Arc faucet
              </a>
              .
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** "1h 04m" / "45m" / "30s" — compact enough for a button label. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/** Map the contract's custom errors and wallet failures to plain language. */
function friendlyFaucetError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('user rejected') || m.includes('user denied')) {
    return 'Claim rejected in wallet.';
  }
  if (m.includes('faucetcooldownactive')) {
    return 'You have already claimed recently. Try again after the cooldown.';
  }
  if (m.includes('insufficient funds')) {
    return 'You need a little native USDC for gas before you can claim.';
  }
  return sanitizeText(raw).slice(0, 160) || 'Could not claim from the faucet.';
}
