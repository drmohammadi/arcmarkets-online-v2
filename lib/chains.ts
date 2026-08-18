import { defineChain } from 'viem';

/**
 * Public Arc testnet endpoints.
 *
 * Always present as the LAST entry in the endpoint list, even when an override is
 * configured, so a private endpoint that is down, over quota or misconfigured
 * degrades to a working public one instead of bricking the app. See the fallback
 * transport in `lib/wagmi.tsx`.
 */
const ARC_TESTNET_HTTP = 'https://rpc.testnet.arc.io';
const ARC_TESTNET_WS = 'wss://rpc.testnet.arc.io';

/**
 * Validate an operator-supplied RPC URL, or return null.
 *
 * Deliberately strict about the scheme:
 *  - **https only** for the HTTP lane. A plaintext RPC would expose every call
 *    and every address a visitor reads to the network path, and a browser on an
 *    https page blocks the mixed-content request anyway — so `http://` is both
 *    unsafe and non-functional. Rejecting it beats shipping a site whose reads
 *    silently fail in production but work on localhost.
 *  - **wss only** for the websocket lane, for the same reasons.
 *
 * An unusable value returns null and the caller falls back to the public
 * endpoint, matching how every other env override in this app behaves: a bad
 * override degrades to the built-in default rather than producing a dead app.
 */
function safeRpcUrl(raw: string | undefined, scheme: 'https:' | 'wss:'): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== scheme) return null;
    // Reject credentials in the URL: they would be embedded in the client bundle
    // and sent to whatever host is named, which is never what an operator wants.
    if (url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Optional private RPC for Arc testnet (Alchemy, Infura, a self-hosted node…).
 *
 * ── THIS VALUE IS PUBLIC ─────────────────────────────────────────────────────
 * `NEXT_PUBLIC_*` is inlined into the browser bundle at build time, so anything
 * here — including an API key in the path — is readable by every visitor. That is
 * unavoidable for a client-side dapp: the browser must reach an RPC directly.
 *
 * So treat a key placed here as published, not secret. Protect it at the
 * provider instead: restrict the app by allowed domain/origin in the provider's
 * dashboard, and keep a spend cap on it. If you need the key to stay genuinely
 * private, it has to move behind a server route that proxies the RPC — this
 * variable cannot do that.
 *
 * The public endpoint remains as a fallback either way.
 */
const testnetHttpOverride = safeRpcUrl(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL, 'https:');
const testnetWsOverride = safeRpcUrl(process.env.NEXT_PUBLIC_ARC_TESTNET_WS_URL, 'wss:');

/*
 * Endpoint preference order: override first, public second.
 *
 * The ORDER is the contract with `lib/wagmi.tsx`, which turns this list into a
 * viem `fallback` transport — entry 0 is tried first and later entries are used
 * only when it fails. Keeping the preference in the chain definition means the
 * transport and anything else reading `rpcUrls` can never disagree about which
 * endpoint is primary.
 *
 * An override equal to the public endpoint collapses to a single entry: listing
 * the same URL twice would make `fallback` "retry" a dead endpoint against
 * itself, which reads like redundancy while providing none.
 *
 * Both sides are compared in NORMALIZED form. `safeRpcUrl` returns
 * `URL.toString()`, which appends a root path — so the raw constant
 * `https://rpc.testnet.arc.io` and a validated override of the same host differ
 * by a trailing slash and a naive `===` would never match.
 */
function withFallback(override: string | null, publicUrl: string): [string, ...string[]] {
  if (override === null) return [publicUrl];
  const normalizedPublic = new URL(publicUrl).toString();
  return override === normalizedPublic ? [publicUrl] : [override, publicUrl];
}

const testnetHttp = withFallback(testnetHttpOverride, ARC_TESTNET_HTTP);
const testnetWs = withFallback(testnetWsOverride, ARC_TESTNET_WS);

/** True when a private testnet RPC is configured. Used only for diagnostics. */
export const hasTestnetRpcOverride = testnetHttpOverride !== null;

/**
 * Arc Testnet (Chain ID 5042002)
 * Circle's stablecoin L1. Native gas token is USDC (6 decimals, not 18).
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6, // CRITICAL: Arc native gas is 6-decimal USDC, not 18-decimal ETH
  },
  rpcUrls: {
    default: {
      http: testnetHttp,
      webSocket: testnetWs,
    },
    public: {
      // `public` stays on the public endpoint by definition — it is what the
      // name means, and a wallet reading this key should not be handed someone's
      // rate-limited private quota.
      http: [ARC_TESTNET_HTTP],
      webSocket: [ARC_TESTNET_WS],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan',
      url: 'https://testnet.arcscan.app',
    },
  },
  testnet: true,
});

/**
 * Mainnet RPC, validated on the same terms as the testnet override.
 *
 * Hoisted out of the chain definition so the mainnet GUARD below can test the
 * validated value rather than the raw env var. Gating on the raw string would
 * let a typo'd or `http://` URL count as "mainnet is configured" and enable a
 * chain whose transport cannot work.
 */
const mainnetRpc = safeRpcUrl(process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL, 'https:');

/**
 * Arc Mainnet (placeholder — Circle has NOT published mainnet params yet).
 * This config is guarded: only used when ARC_MAINNET_CHAIN_ID env is set.
 * When Circle launches mainnet, update this with the real chain ID + RPC.
 */
export const arcMainnet = defineChain({
  id: parseInt(process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID || '0', 10) || 0,
  name: 'Arc Mainnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: mainnetRpc ? [mainnetRpc] : [],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan',
      url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL || '',
    },
  },
  testnet: false,
});

/**
 * The chain guard: only returns Arc mainnet when its chain id AND a USABLE rpc
 * URL are both configured. Otherwise returns just the testnet.
 */
export function getConfiguredChains() {
  const mainnetReady = !!process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID && !!mainnetRpc && arcMainnet.id > 0;

  return mainnetReady ? [arcTestnet, arcMainnet] : [arcTestnet];
}
