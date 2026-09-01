/**
 * Server-only indexer configuration.
 *
 * Nothing here is NEXT_PUBLIC_, so none of it reaches the browser bundle. Every
 * value has a safe default except DATABASE_URL, which has no sensible default —
 * a missing database is a hard failure, not a degraded mode.
 *
 * Importing this module is ALWAYS safe: nothing is read from process.env at
 * module scope and getIndexerConfig() is never called here. `next build`
 * imports every route module, so a module-scope call would turn a missing
 * DATABASE_URL into a build failure instead of a request-time error.
 */

export interface IndexerConfig {
  chainId: number;
  rpcUrl: string;
  confirmations: number;
  chunkBlocks: bigint;
  staleSeconds: number;
  trafficMaxBlocks: bigint;
  cronMaxBlocks: bigint;
  cronSecret: string | null;
  databaseUrl: string;
}

/** Public Arc testnet endpoint, matching lib/chains.ts. */
const DEFAULT_RPC = 'https://rpc.testnet.arc.io';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function bigEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v > BigInt(0) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getIndexerConfig(): IndexerConfig {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  // https only, and no credentials in the URL — the same rule lib/chains.ts
  // applies to the public RPC, for the same reason.
  let rpcUrl = process.env.INDEXER_RPC_URL ?? DEFAULT_RPC;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== 'https:' || u.username || u.password) rpcUrl = DEFAULT_RPC;
  } catch {
    rpcUrl = DEFAULT_RPC;
  }

  return {
    chainId: intEnv('INDEXER_CHAIN_ID', 5042002),
    rpcUrl,
    confirmations: intEnv('INDEXER_CONFIRMATIONS', 12),
    chunkBlocks: bigEnv('INDEXER_CHUNK_BLOCKS', BigInt(250_000)),
    staleSeconds: intEnv('INDEXER_STALE_SECONDS', 120),
    trafficMaxBlocks: bigEnv('INDEXER_TRAFFIC_MAX_BLOCKS', BigInt(500_000)),
    cronMaxBlocks: bigEnv('INDEXER_CRON_MAX_BLOCKS', BigInt(4_000_000)),
    cronSecret: process.env.CRON_SECRET ?? null,
    databaseUrl,
  };
}
