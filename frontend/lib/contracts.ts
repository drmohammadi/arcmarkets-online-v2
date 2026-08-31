/**
 * Contract addresses by chain, read from deployment artifacts.
 * The contracts deploy script merges into deployments/index.json, keyed by chainId.
 */

import { Address } from 'viem';
import deploymentsData from './deployments/index.json';

export interface Deployment {
  chainId: number;
  network: string;
  collateralToken: Address;
  isMockUSDC: boolean;
  conditionalTokens: Address;
  marketFactory: Address;
  /**
   * Optional: the MarketMetadata registry (descriptions / image URLs).
   *
   * Optional because it was added AFTER the testnet factory was deployed, so a
   * chain entry written by an older deploy will not have it. Every consumer
   * must degrade gracefully — no description, not an error — when it is absent.
   */
  marketMetadata?: Address;
  /**
   * Optional: the Social registry (usernames / comments).
   *
   * Optional for the same reason as marketMetadata — it was added after the
   * testnet factory was deployed. Every consumer must degrade gracefully: no
   * comments section and a derived default username, never an error.
   */
  social?: Address;
  /**
   * Optional: the block the MarketFactory was deployed in.
   *
   * This is the SCAN ANCHOR, and it is the difference between a working trade
   * history and an empty one. No Buy/Sell event for any of this factory's pools
   * can exist below it, so it is an exact, sound floor for every log sweep.
   *
   * Without it the only honest lower bound is block 0, and a sweep therefore has
   * to crawl backward from the chain head hoping to stumble into the markets.
   * On Arc testnet the head is past 57,000,000 while this factory sits at
   * 55,632,013 — about 1.7M blocks back. The old per-load crawl budget reached
   * 640k blocks (leaderboard) and 1.2M (chart), so it could not get there, and
   * the price chart drew one point while /leaderboard reported "no trades in the
   * scanned window" on a chain that had plenty. Anchoring turns an unbounded
   * search into a bounded 1.7M-block range that finishes and then caches.
   *
   * Optional because chains deployed before this field existed do not record it;
   * consumers fall back to block 0 and the old crawl, which is slow but not
   * wrong. `npm run discover:startblock` backfills it.
   */
  startBlock?: number;
  deployer: Address;
}

const deployments = deploymentsData as Record<string, Deployment>;

/**
 * Get deployment addresses for the given chain ID.
 * Returns null if not deployed or deployment entry is missing.
 */
export function getDeployment(chainId: number): Deployment | null {
  return deployments[String(chainId)] ?? null;
}

/**
 * Narrow an optional deployment field to a usable address.
 * Rejects non-strings, malformed hex and the zero address, so callers can use
 * the null to skip a read entirely rather than calling address 0.
 */
function optionalAddress(addr: unknown): Address | null {
  if (typeof addr !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  if (/^0x0{40}$/i.test(addr)) return null;
  return addr as Address;
}

/**
 * The metadata registry for a chain, or null when this chain predates it.
 * Callers use the null to skip the read entirely rather than call address 0.
 */
export function getMetadataAddress(chainId: number): Address | null {
  return optionalAddress(getDeployment(chainId)?.marketMetadata);
}

/**
 * The Social registry (usernames / comments) for a chain, or null when this
 * chain predates it. A null must render as "not available on this network",
 * never as an error — the rest of the app works fine without it.
 */
export function getSocialAddress(chainId: number): Address | null {
  return optionalAddress(getDeployment(chainId)?.social);
}

/**
 * All available deployments (testnet, local, eventually mainnet).
 */
export function getAllDeployments(): Deployment[] {
  return Object.values(deployments);
}

/**
 * Lowest block worth scanning for this chain's trade logs.
 *
 * Returns the factory's deployment block when recorded, else 0. Zero is the
 * correct fallback rather than a "recent enough" guess: a guess that lands ABOVE
 * the real deployment silently hides every trade below it, which is exactly the
 * class of bug this field exists to end. Slow beats invisible.
 *
 * A malformed or negative value is treated as absent for the same reason.
 */
export function getStartBlock(chainId: number): bigint {
  const raw = getDeployment(chainId)?.startBlock;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return BigInt(0);
  return BigInt(raw);
}
