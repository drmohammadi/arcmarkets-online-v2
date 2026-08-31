'use client';

import '@rainbow-me/rainbowkit/styles.css';
import { RainbowKitProvider, connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rainbowWallet,
  walletConnectWallet,
  trustWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider, createConfig, http, fallback } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getConfiguredChains } from './chains';
import { isRateLimit } from './rpcQueue';

/**
 * Wallet + query providers.
 *
 * WHY THIS IS NOT `getDefaultConfig`
 * ----------------------------------
 * Every wallet except Coinbase reaches this app through the WalletConnect relay,
 * and the relay requires a real project id. This file used to fall back to
 * `projectId: 'demo'`, which is not a valid id — the relay handshake failed
 * silently, so on mobile MetaMask/Trust/Rainbow appeared in the picker and did
 * nothing at all when tapped. Coinbase Wallet still worked because its connector
 * uses the Coinbase SDK and never touches the relay, which is exactly why it was
 * the only one that worked.
 *
 * `getDefaultConfig` always installs the relay-backed wallets, so it cannot
 * express "only offer wallets that can actually connect". Hence the explicit
 * connector list below: the picker is built from what is actually functional in
 * the current configuration, so a user is never offered a dead button.
 *
 * To enable the full list, set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to a real id
 * from https://cloud.reown.com (free). See frontend/.env.example.
 */

const chains = getConfiguredChains();

// A WalletConnect project id is a 32-character hex string. Anything else — empty,
// 'demo', a placeholder someone pasted — is treated as absent rather than
// half-working, because a bad id fails at connect time, not at load time.
const rawProjectId = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();
export const hasWalletConnect = /^[0-9a-fA-F]{32}$/.test(rawProjectId);

const APP_NAME = 'Arc Prediction Market';

/**
 * Injected and Coinbase work with no project id:
 *  - injectedWallet covers any in-page provider, including MetaMask's own
 *    in-app browser and desktop extensions.
 *  - coinbaseWallet uses the Coinbase SDK directly.
 *
 * The rest are added only when the relay is actually usable.
 */
const connectors = connectorsForWallets(
  hasWalletConnect
    ? [
        {
          groupName: 'Recommended',
          wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet],
        },
        {
          groupName: 'More',
          wallets: [trustWallet, walletConnectWallet, injectedWallet],
        },
      ]
    : [
        {
          groupName: 'Available',
          wallets: [injectedWallet, coinbaseWallet],
        },
      ],
  {
    appName: APP_NAME,
    // connectorsForWallets requires the field even when no relay wallet is
    // registered; with the list above it is never dialled in that case.
    projectId: hasWalletConnect ? rawProjectId : 'disabled',
  }
);

// One transport per configured chain, keyed by chain id. Built from the same
// guarded list as `chains` so the two can never disagree.
/*
 * `retryCount: 1` (viem's default is 3) and a bounded timeout.
 *
 * Retries here multiply with react-query's, so the default stack could turn one
 * logical read into a dozen requests against an endpoint that was already
 * signalling overload. Backoff belongs in `lib/rpcQueue.ts`, which can see all
 * in-flight traffic and pause every lane at once; a transport-level retry only
 * sees its own request.
 *
 * NOT enabling `batch: true` (JSON-RPC batching) deliberately. It would be the
 * single biggest further win — it collapses N `eth_call`s into one HTTP request
 * — but if the endpoint rejects batched payloads then EVERY read fails rather
 * than degrading, and Arc's public RPC could not be reached from the dev
 * environment to confirm support. Verify against the live endpoint first, then
 * turn it on here.
 *
 * ── WHY `fallback` AND NOT A SINGLE `http` ───────────────────────────────────
 * `chain.rpcUrls.default.http` may now hold a private endpoint first and the
 * public one second (see `lib/chains.ts`). Building a transport from `http[0]`
 * alone would mean a private endpoint that is down, over quota, geo-blocked or
 * simply mistyped takes the whole app down with it — and an over-quota key fails
 * exactly when the app is busiest.
 *
 * `fallback` tries entry 0 and moves to the next only on failure, so the public
 * endpoint is a genuine safety net. `rank: false` keeps the order FIXED rather
 * than letting viem re-rank by latency: the ordering here is a deliberate
 * preference (use my paid endpoint; fall back only if it breaks), not a
 * performance guess, and latency ranking would quietly send traffic to the
 * rate-limited public node whenever it happened to respond faster.
 */
const transports = Object.fromEntries(
  chains.map((c) => [
    c.id,
    fallback(
      c.rpcUrls.default.http.map((url) => http(url, { retryCount: 1, timeout: 20_000 })),
      { rank: false }
    ),
  ])
);

export const wagmiConfig = createConfig({
  chains: chains as any, // wagmi wants a non-empty readonly tuple; our guard returns an array
  connectors,
  transports,
  ssr: true,
});

/**
 * Query defaults.
 *
 * `retry` used to be 2, which meant every failed read was attempted THREE
 * times. On a rate-limited endpoint that is exactly backwards: the reads fail
 * because the endpoint asked for less traffic, and retrying multiplied the
 * burst that caused it. Rate-limit errors are now never retried here —
 * `lib/rpcQueue.ts` already owns 429 backoff, and doing it in two places
 * compounds. Genuine one-off failures still get a single retry.
 *
 * `staleTime` is raised to 60s as a floor for reads that do not set their own.
 * The heavy shared queries in `hooks/useChainData.ts` set longer ones
 * explicitly; this only affects incidental reads like balances and allowances.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (isRateLimit(error)) return false;
        return failureCount < 1;
      },
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
