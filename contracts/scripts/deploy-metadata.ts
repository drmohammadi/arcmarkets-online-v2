import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys ONLY MarketMetadata and merges its address into the existing
 * deployment entry for this chain.
 *
 * WHY THIS EXISTS SEPARATELY FROM deploy.ts:
 * `MarketFactory` is already live on Arc testnet with real markets, pools and
 * open positions. Running the full deploy.ts against that network would deploy
 * a NEW factory and rewrite the frontend's address book to point at it, which
 * would orphan every existing market. This script touches nothing but the
 * `marketMetadata` key.
 *
 * It is intentionally refuses to run if there is no existing entry for the
 * chain, because in that case the right move is a full deploy.ts run.
 *
 * Usage: npx hardhat run scripts/deploy-metadata.ts --network arcTestnet
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log(`\nDeploying MarketMetadata to "${network.name}" (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Gas balance (native USDC, 6dp): ${ethers.formatUnits(bal, 6)}\n`);

  const outDir = path.resolve(__dirname, "../../frontend/lib/deployments");
  const indexFile = path.join(outDir, "index.json");

  let index: Record<string, Record<string, unknown>> = {};
  try {
    index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    throw new Error(
      `Could not read ${indexFile}. Run the full deploy first (npm run deploy:local / deploy:testnet).`
    );
  }

  const existing = index[String(chainId)];
  if (!existing || typeof existing.marketFactory !== "string") {
    throw new Error(
      `No existing deployment for chainId ${chainId} in ${indexFile}.\n` +
        `This script only ADDS MarketMetadata to a chain that already has a factory. ` +
        `For a fresh chain, run the full deploy script instead.`
    );
  }

  console.log(`Existing MarketFactory (left untouched): ${existing.marketFactory}`);

  const Metadata = await ethers.getContractFactory("MarketMetadata");
  const metadata = await Metadata.deploy();
  await metadata.waitForDeployment();
  const metadataAddress = await metadata.getAddress();
  console.log(`MarketMetadata deployed: ${metadataAddress}`);

  // Merge one key. Every other field of the entry is preserved verbatim.
  const previous = existing.marketMetadata;
  index[String(chainId)] = { ...existing, marketMetadata: metadataAddress };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

  // Keep the standalone per-chain file in sync if it exists.
  const outFile = path.join(outDir, `${chainId}.json`);
  try {
    const single = JSON.parse(fs.readFileSync(outFile, "utf8"));
    fs.writeFileSync(
      outFile,
      JSON.stringify({ ...single, marketMetadata: metadataAddress }, null, 2)
    );
  } catch {
    // Optional convenience file; index.json is the one the frontend reads.
  }

  if (typeof previous === "string" && previous.length > 0) {
    console.log(
      `\nNOTE: this chain already had a MarketMetadata at ${previous}.\n` +
        `It has been replaced by the new address. Metadata written to the old ` +
        `contract will no longer be read — re-enter it from /admin if needed.`
    );
  }

  console.log(`\nUpdated ${indexFile} (key ${chainId}) with marketMetadata only.`);
  console.log(`Owner of MarketMetadata is ${deployer.address} — it must match the`);
  console.log(`factory owner for /admin to expose the metadata controls.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
