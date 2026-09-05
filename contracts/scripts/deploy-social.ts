import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys ONLY Social and merges its address into the existing deployment entry
 * for this chain.
 *
 * WHY THIS EXISTS SEPARATELY FROM deploy.ts:
 * Same reason as deploy-metadata.ts. `MarketFactory` is already live on Arc
 * testnet with real markets, pools and open positions. Running the full
 * deploy.ts against that network would deploy a NEW factory and rewrite the
 * frontend's address book to point at it, orphaning every existing market.
 * This script touches nothing but the `social` key.
 *
 * It intentionally refuses to run if there is no existing entry for the chain,
 * because in that case the right move is a full deploy.ts run.
 *
 * Usage: npx hardhat run scripts/deploy-social.ts --network arcTestnet
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log(`\nDeploying Social to "${network.name}" (chainId ${chainId})`);
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
        `This script only ADDS Social to a chain that already has a factory. ` +
        `For a fresh chain, run the full deploy script instead.`
    );
  }

  console.log(`Existing MarketFactory (left untouched): ${existing.marketFactory}`);

  const Social = await ethers.getContractFactory("Social");
  const social = await Social.deploy();
  await social.waitForDeployment();
  const socialAddress = await social.getAddress();
  console.log(`Social deployed: ${socialAddress}`);

  // Merge one key. Every other field of the entry is preserved verbatim.
  const previous = existing.social;
  index[String(chainId)] = { ...existing, social: socialAddress };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

  // Keep the standalone per-chain file in sync if it exists.
  const outFile = path.join(outDir, `${chainId}.json`);
  try {
    const single = JSON.parse(fs.readFileSync(outFile, "utf8"));
    fs.writeFileSync(outFile, JSON.stringify({ ...single, social: socialAddress }, null, 2));
  } catch {
    // Optional convenience file; index.json is the one the frontend reads.
  }

  if (typeof previous === "string" && previous.length > 0) {
    console.log(
      `\nNOTE: this chain already had a Social at ${previous}.\n` +
        `It has been replaced by the new address. Usernames and comments written ` +
        `to the old contract will no longer be read.`
    );
  }

  console.log(`\nUpdated ${indexFile} (key ${chainId}) with social only.`);
  console.log(`Owner of Social is ${deployer.address}. Unlike MarketMetadata, the`);
  console.log(`owner role here is only used for moderation (deleting a comment);`);
  console.log(`setting a username and posting are permissionless by design.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
