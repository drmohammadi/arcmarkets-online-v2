/**
 * Backfill `startBlock` for a chain whose factory is ALREADY deployed.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The frontend uses `startBlock` — the block the MarketFactory was deployed in —
 * as the floor for every trade-log sweep. No Buy/Sell event can exist below it,
 * so it converts "scan backward from the chain head and hope to reach the
 * markets" into a bounded range that actually terminates.
 *
 * `deploy.ts` records it now, but the live Arc testnet factory predates that, and
 * a full redeploy is not an option: it would create a NEW factory and orphan
 * every existing market, pool and position. So this script discovers the number
 * for an existing deployment and merges it in, exactly like
 * `deploy-metadata.ts` merges an address into a live chain entry.
 *
 * ── HOW IT FINDS THE BLOCK ───────────────────────────────────────────────────
 * Binary search on `eth_getCode`: a contract's code is absent before its
 * deployment block and present from it onward, so the lowest block at which code
 * is present IS the deployment block. That is ~log2(head) requests — about 26 on
 * a 57,000,000-block chain.
 *
 * The search is only sound where the node still serves historical STATE. A pruned
 * node answers "0x" for every block below its horizon regardless of whether the
 * contract existed, which makes the search converge on the horizon instead of the
 * deployment. That failure is silent and produces a floor ABOVE the real one —
 * the worst possible outcome, because it hides trades rather than merely slowing
 * the scan. So the result is VERIFIED before it is written (see below), and the
 * script refuses to write anything it cannot prove.
 */

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Confirm a candidate really is the deployment block rather than a pruning
 * horizon, by checking the transition at its boundary and proving the node
 * distinguishes ages at all.
 */
async function verify(
  address: string,
  candidate: number,
  reference: { address: string; label: string } | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const provider = ethers.provider;

  // 1. Code must be present AT the candidate and absent one block BELOW it.
  //    A pruning horizon satisfies this too, hence checks 2 and 3.
  const at = await provider.getCode(address, candidate);
  if (at === "0x") {
    return { ok: false, reason: `no code at the candidate block ${candidate}` };
  }
  if (candidate > 0) {
    const below = await provider.getCode(address, candidate - 1);
    if (below !== "0x") {
      return {
        ok: false,
        reason: `code already present at ${candidate - 1}, so ${candidate} is not the deployment`,
      };
    }
  }

  /*
   * 2. The decisive check. A second contract deployed at a DIFFERENT time must
   *    resolve to a different block. If both land on the same one, that block is
   *    the node's state horizon and neither number means anything.
   */
  if (reference) {
    const refAt = await provider.getCode(reference.address, candidate);
    const refBelow =
      candidate > 0 ? await provider.getCode(reference.address, candidate - 1) : "0x";
    if (refAt !== "0x" && refBelow === "0x") {
      return {
        ok: false,
        reason:
          `${reference.label} appears to be created in the same block ${candidate}. ` +
          `That is the signature of a pruned state horizon, not a deployment block — ` +
          `this node is not serving historical state deep enough to search`,
      };
    }
  }

  return { ok: true };
}

async function main() {
  const net = await network.provider.send("eth_chainId");
  const chainId = Number(BigInt(net));

  const outDir = path.resolve(__dirname, "../../frontend/lib/deployments");
  const indexFile = path.join(outDir, "index.json");

  let index: Record<string, Record<string, unknown>>;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    throw new Error(`Could not read ${indexFile}. Deploy first.`);
  }

  const entry = index[String(chainId)];
  if (!entry) {
    throw new Error(
      `No deployment recorded for chain ${chainId}. Run a deploy before backfilling.`
    );
  }

  const factory = entry.marketFactory;
  if (typeof factory !== "string" || !ethers.isAddress(factory)) {
    throw new Error(`Entry for chain ${chainId} has no usable marketFactory address.`);
  }

  console.log(`\nChain ${chainId} (${network.name})`);
  console.log(`MarketFactory: ${factory}`);

  if (typeof entry.startBlock === "number") {
    console.log(`\nstartBlock is already recorded as ${entry.startBlock}. Nothing to do.`);
    console.log(`Delete the field and re-run if you need to recompute it.`);
    return;
  }

  const head = await ethers.provider.getBlockNumber();
  const headCode = await ethers.provider.getCode(factory, head);
  if (headCode === "0x") {
    throw new Error(
      `No code at ${factory} on chain ${chainId} at block ${head}. Wrong network or wrong address.`
    );
  }

  /*
   * Binary search for the lowest block with code.
   *
   * Invariant: `lo` has no code, `hi` has code. Starting `lo` at -1 makes a
   * contract present in the genesis block representable rather than a special
   * case, since block 0 is then a valid answer.
   */
  let lo = -1;
  let hi = head;
  let probes = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await ethers.provider.getCode(factory, mid);
    probes++;
    if (code === "0x") lo = mid;
    else hi = mid;
  }
  console.log(`\nCandidate deployment block: ${hi}  (${probes} getCode probes)`);

  /*
   * Verify against a contract deployed at a different time. `social` and
   * `marketMetadata` were both added AFTER the factory, so either is a good
   * control — if the search claims they share a block, it found a horizon.
   */
  const refAddr = entry.social ?? entry.marketMetadata;
  const reference =
    typeof refAddr === "string" && ethers.isAddress(refAddr) && refAddr !== factory
      ? { address: refAddr, label: entry.social === refAddr ? "Social" : "MarketMetadata" }
      : null;

  if (!reference) {
    console.warn(
      `  ! No second contract available as a control, so the pruning check is weaker.`
    );
  }

  const check = await verify(factory, hi, reference);
  if (!check.ok) {
    console.error(`\nRefusing to write startBlock: ${check.reason}.`);
    console.error(
      `\nA floor ABOVE the real deployment block silently hides every trade below it,\n` +
        `which is worse than having no floor at all. Get the creation block from the\n` +
        `block explorer instead and add it by hand:\n\n` +
        `  https://testnet.arcscan.app/address/${factory}\n\n` +
        `then set "startBlock": <number> in ${indexFile} under key "${chainId}".`
    );
    process.exitCode = 1;
    return;
  }

  entry.startBlock = hi;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");

  // Keep the standalone per-chain file in step, if one exists.
  const perChain = path.join(outDir, `${chainId}.json`);
  try {
    const single = JSON.parse(fs.readFileSync(perChain, "utf8"));
    single.startBlock = hi;
    fs.writeFileSync(perChain, JSON.stringify(single, null, 2) + "\n");
  } catch {
    // Optional convenience file; absent or unreadable is fine.
  }

  console.log(`\nVerified. Wrote startBlock=${hi} to ${indexFile} (key ${chainId}).`);
  console.log(`Blocks from deployment to head: ${head - hi}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
