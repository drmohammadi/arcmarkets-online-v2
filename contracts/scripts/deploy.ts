                                                                                                                         import { ethers, network } from "hardhat";                                                                              import * as fs from "fs";
  import * as path from "path";
                                                                                                                          /**
   * Deploys the full system. Behavior by network:                                                                         *  - localhost / hardhat: deploys MockUSDC, seeds demo markets + liquidity.
   *  - arcTestnet:          deploys MockUSDC (faucet token), no auto-seed (needs gas USDC).
   *  - arcMainnet:          GUARDED. Requires ARC_MAINNET_USDC_ADDRESS; uses real USDC, no MockUSDC.
   *
   * Writes addresses to frontend/lib/deployments/<chainId>.json for the UI to consume.
   */

  const FEE_BPS = 200; // 2% default market fee

  async function main() {
    const [deployer] = await ethers.getSigners();
    const net = await ethers.provider.getNetwork();
    const chainId = Number(net.chainId);

    console.log(`\nDeploying to network "${network.name}" (chainId ${chainId})`);
    console.log(`Deployer: ${deployer.address}`);
    const bal = await ethers.provider.getBalance(deployer.address);
    // Arc gas token is 6-decimal USDC; format accordingly for readability.
    console.log(`Gas balance (native USDC, 6dp): ${ethers.formatUnits(bal, 6)}\n`);

    const isMainnet = network.name === "arcMainnet";

    // ── 1. Collateral token ──────────────────────────────────────────────
    let collateralAddress: string;
    if (isMainnet) {
      const real = process.env.ARC_MAINNET_USDC_ADDRESS;
      if (!real || !ethers.isAddress(real)) {
        throw new Error(
          "Mainnet deploy blocked: set ARC_MAINNET_USDC_ADDRESS to the canonical USDC address."
        );
      }
      collateralAddress = real;
      console.log(`Using real USDC at ${collateralAddress} (no MockUSDC on mainnet).`);
    } else {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const mockUSDC = await MockUSDC.deploy();
      await mockUSDC.waitForDeployment();
      collateralAddress = await mockUSDC.getAddress();
      console.log(`MockUSDC deployed: ${collateralAddress}`);
    }

    // ── 2. ConditionalTokens ─────────────────────────────────────────────
    const CT = await ethers.getContractFactory("ConditionalTokens");
    const conditionalTokens = await CT.deploy();
    await conditionalTokens.waitForDeployment();
    const ctAddress = await conditionalTokens.getAddress();
    console.log(`ConditionalTokens deployed: ${ctAddress}`);

    // ── 3. MarketFactory ─────────────────────────────────────────────────
    const Factory = await ethers.getContractFactory("MarketFactory");
    const factory = await Factory.deploy(collateralAddress, ctAddress);
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log(`MarketFactory deployed: ${factoryAddress}`);

    /*
     * Record the block the factory landed in.
     *
     * The frontend uses this as the FLOOR for every trade-log sweep. No Buy/Sell
     * event can exist below it, so it turns "scan backward from the head and hope
     * to find the markets" into a bounded range that finishes.
     *
     * This is not a nicety. Arc testnet's head is past 57,000,000; without this
     * number the UI crawled backward in ~1M-block steps looking for markets 1.7M
     * blocks down, never got there, and rendered an empty leaderboard and a
     * single-point price chart on a chain full of trades.
     *
     * Falls back to the current head rather than 0 if the receipt is somehow
     * unavailable: this deploy's markets cannot predate the head either, and 0
     * would quietly restore the full-chain crawl.
     */
    let startBlock: number;
    const deployTx = factory.deploymentTransaction();
    const deployReceipt = deployTx ? await deployTx.wait() : null;
    if (deployReceipt && typeof deployReceipt.blockNumber === "number") {
      startBlock = deployReceipt.blockNumber;
    } else {
      startBlock = await ethers.provider.getBlockNumber();
      console.warn(
        `  ! Could not read the deployment receipt; recording startBlock=${startBlock} (current head).`
      );
    }
    console.log(`  startBlock (trade-log scan floor): ${startBlock}`);

    // ── 4. Wire ownership: factory must own ConditionalTokens ────────────
    const tx = await conditionalTokens.transferOwnership(factoryAddress);
    await tx.wait();
    console.log(`ConditionalTokens ownership -> MarketFactory`);

    // ── 4b. MarketMetadata (descriptions / image URLs / resolution source) ─
    // Standalone and unlinked to the factory on purpose, so it can also be
    // deployed on its own against an ALREADY-LIVE factory. See deploy-metadata.ts.
    const Metadata = await ethers.getContractFactory("MarketMetadata");
    const metadata = await Metadata.deploy();
    await metadata.waitForDeployment();
    const metadataAddress = await metadata.getAddress();
    console.log(`MarketMetadata deployed: ${metadataAddress}`);

    // ── 5. Seed demo markets on local networks only ──────────────────────
    const seeded: Array<{ questionId: string; fpmm: string; question: string }> = [];
    if (!isMainnet && (network.name === "localhost" || network.name === "hardhat")) {
      console.log(`\nSeeding demo markets...`);
      const mockUSDC = await ethers.getContractAt("MockUSDC", collateralAddress);
      await (await mockUSDC.mint(deployer.address, ethers.parseUnits("100000", 6))).wait();

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const demos = [
        { q: "Will BTC close above $150k by end of 2026?", c: "Crypto" },
        { q: "Will Arc mainnet launch in 2026?", c: "Crypto" },
        { q: "Will it rain in London tomorrow?", c: "Weather" },
      ];

      for (const d of demos) {
        const createTx = await factory.createMarket(
          d.q, d.c, now + 7 * 24 * 3600, deployer.address, FEE_BPS
        );
        const rcpt = await createTx.wait();
        const ev = rcpt!.logs
          .map((l) => { try { return factory.interface.parseLog(l as any); } catch { return null; } })
          .find((e) => e?.name === "MarketCreated");
        const questionId = ev!.args.questionId as bigint;
        const fpmm = ev!.args.fpmm as string;

        // Seed 1000 USDC liquidity.
        const seed = ethers.parseUnits("1000", 6);
        await (await mockUSDC.approve(fpmm, seed)).wait();
        const market = await ethers.getContractAt("FixedProductMarketMaker", fpmm);
        await (await market.addLiquidity(seed, 0)).wait();

        seeded.push({ questionId: questionId.toString(), fpmm, question: d.q });
        console.log(`  Market #${questionId}: "${d.q}" @ ${fpmm} (seeded 1000 USDC)`);
      }
    }

    // ── 6. Persist addresses for the frontend ────────────────────────────
    const deployment = {
      chainId,
      network: network.name,
      collateralToken: collateralAddress,
      isMockUSDC: !isMainnet,
      conditionalTokens: ctAddress,
      marketFactory: factoryAddress,
      marketMetadata: metadataAddress,
      startBlock,
      deployer: deployer.address,
      seededMarkets: seeded,
    };

    const outDir = path.resolve(__dirname, "../../frontend/lib/deployments");
    fs.mkdirSync(outDir, { recursive: true });

    // Merge into index.json keyed by chainId (frontend imports this statically).
    const indexFile = path.join(outDir, "index.json");
    let index: Record<string, unknown> = {};
    try {
      index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    } catch {
      index = {}; // First deploy, or file missing/corrupt — start fresh.
    }
    index[String(chainId)] = deployment;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    // Also write a standalone per-chain file for convenience/debugging.
    const outFile = path.join(outDir, `${chainId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

    console.log(`\nDeployment written to ${indexFile} (key ${chainId}) and ${outFile}`);
    console.log(JSON.stringify(deployment, null, 2));
  }

  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });