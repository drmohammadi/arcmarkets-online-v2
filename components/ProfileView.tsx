'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAccount, useChainId, usePublicClient, useWriteContract } from 'wagmi';
import { Header } from '@/components/Header';
import { TradeTable, PnlValue } from '@/components/TradeTable';
import { PortfolioPanel } from '@/components/PortfolioPanel';
import { EmptyState, Skeleton, ErrorNote, Badge } from '@/components/ui';
import { StaleNotice } from '@/components/StaleNotice';
import { useTradeStats } from '@/hooks/useTradeStats';
import { useUsername } from '@/hooks/useSocial';
import { getSocialAddress } from '@/lib/contracts';
import { socialAbi } from '@/lib/abis';
import { formatUsdc } from '@/lib/format';
import { shortAddress } from '@/lib/sanitize';
import { validateUsername, MAX_NAME_BYTES } from '@/lib/username';

/**
 * A wallet's public profile: name, holdings, totals and trade history.
 *
 * Shared by /profile (the connected wallet) and /profile/[address] (anyone), so
 * a leaderboard row can link straight to the trader it names.
 *
 * ── WHY THE PORTFOLIO LIVES HERE ─────────────────────────────────────────────
 * `/portfolio` used to be its own page, and it only ever worked for the connected
 * wallet. Its contents are a pure function of an address, so it is now
 * `PortfolioPanel` rendered directly below the name — which makes it work for any
 * wallet, removes a nav entry that duplicated half of this page, and leaves one
 * implementation instead of two.
 *
 * ── THE ORDER OF THE TWO HALVES IS DELIBERATE ────────────────────────────────
 * Holdings come first because they are the trustworthy half. `PortfolioPanel`
 * reads current ERC-1155 balances in a single request, so it is exact no matter
 * how far the trade-log sweep has reached. The PnL/volume/trade tiles below are
 * derived from Buy/Sell logs and are therefore only as complete as that sweep —
 * which is why they, and not the holdings, carry the coverage caveats.
 */
export function ProfileView({ address }: { address: `0x${string}` }) {
  const { address: connected } = useAccount();
  const isOwnProfile = !!connected && connected.toLowerCase() === address.toLowerCase();

  const stats = useTradeStats();
  const username = useUsername(address);
  const trades = stats.tradesFor(address);
  const totals = stats.statsFor(address);

  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-content sm:text-2xl">
              {username.name}
            </h1>
            <span className="font-mono text-xs text-content-subtle">
              {shortAddress(address)}
            </span>
            {isOwnProfile && <Badge tone="brand">You</Badge>}
          </div>
          <p className="mt-1 text-sm text-content-muted">
            {isOwnProfile
              ? 'Your positions and trading history on Arc.'
              : 'Positions and trading history on Arc.'}
          </p>
        </div>

        {isOwnProfile && <UsernameEditor current={username.claimed} onSaved={username.refetch} />}

        {/*
          Holdings first — see the component header. This block does not wait on
          `stats.isLoading`: it has its own single-request data source and its own
          skeleton, so a slow log sweep must not hold back the half of the page
          that is already available and exact.
        */}
        <section aria-labelledby="holdings-heading" className="mb-8">
          <h2
            id="holdings-heading"
            className="mb-2 text-sm font-semibold text-content"
          >
            {isOwnProfile ? 'Your positions' : 'Positions'}
          </h2>
          <PortfolioPanel address={address} />
        </section>

        {stats.stale && <StaleNotice onRetry={stats.refresh} />}

        <section aria-labelledby="activity-heading">
          <h2 id="activity-heading" className="mb-2 text-sm font-semibold text-content">
            Trading activity
          </h2>

          {stats.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-card" />
              <Skeleton className="h-40 w-full rounded-card" />
            </div>
          ) : (
            <>
              <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Tile
                  label="Total PnL"
                  value={
                    <PnlValue
                      value={totals?.total ?? BigInt(0)}
                      marked={!totals?.basisIncomplete}
                    />
                  }
                />
                <Tile
                  label="Realized"
                  value={<PnlValue value={totals?.realized ?? BigInt(0)} marked />}
                />
                <Tile label="Volume" value={`$${formatUsdc(totals?.volume ?? BigInt(0))}`} />
                <Tile label="Trades" value={String(totals?.tradeCount ?? 0)} />
              </div>

              {totals?.basisIncomplete && (
                <p className="mb-4 rounded-lg bg-surface-sunken px-3 py-2 text-2xs text-warn">
                  Some positions were opened before the scanned window, so their cost basis is
                  incomplete and total PnL is not shown. Realized figures below cover only the
                  trades listed.
                </p>
              )}

              {trades.length === 0 ? (
                <EmptyState
                  title="No trades found yet"
                  hint={
                    stats.complete
                      ? 'This wallet has not traded through the market maker.'
                      : 'Still scanning trade history — figures will fill in as it completes.'
                  }
                  action={
                    <Link href="/" className="text-sm font-medium text-brand hover:underline">
                      Browse markets
                    </Link>
                  }
                />
              ) : (
                <>
                  <h3 className="mb-2 text-sm font-semibold text-content">Trade history</h3>
                  <TradeTable trades={trades} />
                </>
              )}

              <Disclaimer
                partial={stats.partial}
                lookback={stats.lookbackBlocks}
                complete={stats.complete}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** Claim or change the connected wallet's display name. */
function UsernameEditor({ current, onSaved }: { current: string; onSaved: () => void }) {
  const chainId = useChainId();
  const registry = getSocialAddress(chainId);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Seed from chain state when the editor opens. Keyed on `open` only: re-seeding
  // on every refetch would overwrite what the user is typing.
  useEffect(() => {
    if (!open) return;
    setValue(current);
    setError('');
  }, [open, current]);

  if (!registry) {
    return (
      <p className="mb-5 rounded-lg bg-surface-sunken px-3 py-2 text-2xs text-content-muted">
        No social registry is deployed on this network, so usernames cannot be set. Deploy it
        with <span className="font-mono text-content">npm run deploy:social:testnet</span>.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-5 h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content"
      >
        {current ? 'Change username' : 'Set a username'}
      </button>
    );
  }

  async function handleSave() {
    setError('');
    // Same reason as Comments.handlePost: this is a hoisted declaration, so the
    // early return above does not narrow `registry` here. Guard rather than cast.
    if (!registry) return;
    const check = validateUsername(value);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: registry,
        abi: socialAbi,
        functionName: 'setUsername',
        args: [check.name],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      onSaved();
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NameTaken/.test(msg)) setError('That username is already taken.');
      else if (/User rejected|denied transaction/i.test(msg)) setError('');
      else if (/InvalidInput/.test(msg)) {
        setError('Use 3-20 letters, numbers, underscores or hyphens.');
      } else setError('Could not save your username. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-card border border-edge bg-surface-raised p-4">
      <label htmlFor="username-input" className="text-xs font-medium text-content">
        Username
      </label>
      <p className="mt-0.5 text-2xs text-content-subtle">
        3-20 characters. Letters, numbers, underscores and hyphens only. Names are unique,
        and this costs a transaction.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          id="username-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={MAX_NAME_BYTES}
          disabled={busy}
          className="h-9 min-w-0 flex-1 rounded-lg border border-edge bg-surface px-3 text-sm text-content placeholder:text-content-subtle disabled:opacity-60"
          placeholder="satoshi"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="h-9 rounded-lg bg-brand px-4 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content-muted transition-colors hover:text-content disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-card border border-edge bg-surface-raised px-3 py-2.5">
      <p className="text-2xs uppercase tracking-wide text-content-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-content">{value}</p>
    </div>
  );
}

/**
 * States plainly what the numbers above can and cannot account for.
 *
 * The coverage sentence is driven by what the scan ACTUALLY reached, not by a
 * constant. It used to print a fixed lookback figure, which stayed reassuringly
 * precise while the window it described had quietly stopped containing any
 * trades at all.
 *
 * Note this describes the LEDGER-derived figures only. The holdings above come
 * from current balances in one request and are exact regardless, which is why
 * they are rendered outside this caveat rather than under it.
 *
 * The direct-transfer caveat is permanent regardless: ERC-1155 shares can move
 * between wallets without touching the AMM, leaving no Buy/Sell event and no
 * price to derive a basis from.
 */
export function Disclaimer({
  partial,
  lookback,
  complete,
}: {
  partial: boolean;
  lookback: bigint;
  complete?: boolean;
}) {
  return (
    <div className="mt-4 space-y-1 text-2xs text-content-subtle">
      {partial && (
        <p className="text-warn">
          The trade scan was cut short, so these figures are incomplete. Refresh to try again.
        </p>
      )}
      <p>
        {complete
          ? 'Covers the full trade history since this market factory was deployed. '
          : `Scanned ${lookback.toString()} blocks so far; older trades are still being loaded. `}
        Shares transferred directly between wallets bypass the market maker and cannot be
        priced, so they are not counted.
      </p>
      <p>
        Open positions are marked at each pool&apos;s current implied probability. Actual
        proceeds depend on liquidity and slippage when you sell.
      </p>
    </div>
  );
}
