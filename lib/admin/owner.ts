import { createPublicClient, http, getAddress } from 'viem';
import { marketFactoryAbi } from '@/lib/abis';
import { getDeployment } from '@/lib/contracts';
import { getIndexerConfig } from '@/lib/indexer/config';

/**
 * Reads `MarketFactory.owner()` server-side, over the server-only RPC.
 *
 * THIS IS THE AUTHORIZATION SOURCE. The client tells us who signed; the chain
 * tells us who is allowed. Those must be two independent facts, or the check is
 * just the client asserting its own privileges.
 *
 * DELIBERATELY NOT `createIndexerRpc` (`lib/indexer/rpc.ts`). That facade carries
 * mutable chunk-width state and a rate-limit backoff ladder built for sweeping
 * logs, neither of which means anything for a single `eth_call`, and its
 * `IndexerRpc` interface exposes no `readContract` at all. A four-line client
 * here is clearer than widening that one.
 *
 * NOT CACHED, ON PURPOSE. Caching an authorization decision means a transferred
 * ownership keeps working for the lifetime of the cache — the old owner retains
 * power they no longer have on-chain. Admin writes are rare; one `eth_call` each
 * is the right price.
 *
 * Returns null when the deployment or the read is unavailable, and callers must
 * treat null as DENY rather than as "skip the check".
 */
export async function readFactoryOwner(): Promise<string | null> {
  let config;
  try {
    config = getIndexerConfig();
  } catch {
    return null;
  }

  const deployment = getDeployment(config.chainId);
  const factory = deployment?.marketFactory;
  if (typeof factory !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(factory)) return null;

  try {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const owner = await client.readContract({
      address: factory as `0x${string}`,
      abi: marketFactoryAbi,
      functionName: 'owner',
    });
    return typeof owner === 'string' ? getAddress(owner) : null;
  } catch {
    return null;
  }
}
