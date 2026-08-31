'use client';

import { useState } from 'react';
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { erc20Abi, fpmmAbi } from '@/lib/abis';
import { sanitizeText } from '@/lib/sanitize';
import { formatUsdc, parseUsdc } from '@/lib/format';

/**
 * Self-contained add-liquidity control for a single market's FPMM.
 * Handles the ERC-20 approve → addLiquidity two-step, with its own state so
 * multiple instances on the admin page don't interfere with each other.
 */
export function LiquidityForm({
  fpmm,
  collateralToken,
}: {
  fpmm: `0x${string}`;
  collateralToken: `0x${string}`;
}) {
  const { address } = useAccount();
  const [amountInput, setAmountInput] = useState('');
  const [error, setError] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txWaiting } = useWaitForTransactionReceipt({ hash: txHash });
  const working = isPending || txWaiting;

  const amount = parseUsdc(amountInput); // BigInt(0) on invalid input

  const { data: usdcBalance } = useReadContract({
    address: collateralToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: allowance } = useReadContract({
    address: collateralToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, fpmm] : undefined,
    query: { enabled: !!address },
  });

  const needsApproval = amount > BigInt(0) && (allowance ?? BigInt(0)) < amount;

  function onError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setError(sanitizeText(msg) || 'Transaction failed');
  }

  function handleApprove() {
    setError('');
    writeContract(
      {
        address: collateralToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [fpmm, amount],
      },
      { onError }
    );
  }

  function handleAddLiquidity() {
    if (amount === BigInt(0)) return;
    setError('');
    writeContract(
      {
        address: fpmm,
        abi: fpmmAbi,
        functionName: 'addLiquidity',
        args: [amount, BigInt(0)],
      },
      { onSuccess: () => setAmountInput(''), onError }
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
      <p className="text-sm font-medium mb-2">Add liquidity</p>
      <div className="flex gap-2 items-start">
        <div className="flex-1">
          <input
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="USDC amount"
            className="w-full px-3 py-2 border rounded"
            disabled={working}
          />
          <p className="text-xs text-gray-500 mt-1">
            Balance: {usdcBalance ? formatUsdc(usdcBalance as bigint) : '0'} USDC
          </p>
        </div>
        {needsApproval ? (
          <button
            onClick={handleApprove}
            disabled={working}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            {working ? '…' : 'Approve'}
          </button>
        ) : (
          <button
            onClick={handleAddLiquidity}
            disabled={working || amount === BigInt(0)}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
          >
            {working ? '…' : 'Add'}
          </button>
        )}
      </div>
      {error && (
        <p className="text-xs text-red-600 mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
