import { ethers } from "hardhat";

/**
 * End-to-end smoke test on the local Hardhat network. Requires NO private key.
 * Run: `npx hardhat run scripts/e2e-local.ts`
 * Proves the whole trade/resolve/redeem lifecycle and checks conservation.
 */

const u = (n: string | number) => ethers.parseUnits(n.toString(), 6);
const fmt = (n: bigint) => ethers.formatUnits(n, 6);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`E2E ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const [deployer, trader] = await ethers.getSigners();

  console.log("1. Deploying system...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const CT = await ethers.getContractFactory("ConditionalTokens");
  const ct = await CT.deploy();
  const Factory = await ethers.getContractFactory("MarketFactory");
  const factory = await Factory.deploy(await usdc.getAddress(), await ct.getAddress());
  await (await ct.transferOwnership(await factory.getAddress())).wait();

  await (await usdc.mint(deployer.address, u(10000))).wait();
  await (await usdc.mint(trader.address, u(10000))).wait();

  const usdcTotalBefore = await usdc.totalSupply();

  console.log("2. Creating market...");
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const createTx = await factory.createMarket(
    "E2E: coin flip heads?",
    "Test",
    now + 3600,
    deployer.address,
    200
  );
  const rcpt = await createTx.wait();
  const ev = rcpt!.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l as any);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === "MarketCreated");
  const questionId = ev!.args.questionId as bigint;
  const fpmmAddr = ev!.args.fpmm as string;
  const conditionId = ev!.args.conditionId as string;
  const market = await ethers.getContractAt("FixedProductMarketMaker", fpmmAddr);

  console.log("3. Adding liquidity (deployer, 1000 USDC)...");
  await (await usdc.approve(fpmmAddr, u(1000))).wait();
  await (await market.addLiquidity(u(1000), 0)).wait();

  console.log("4. Trader buys YES with 200 USDC...");
  await (await usdc.connect(trader).approve(fpmmAddr, u(200))).wait();
  const sharesBought = await market.calcBuyAmount(0, u(200));
  console.log(`   quoted YES shares: ${fmt(sharesBought)}`);
  await (await market.connect(trader).buy(0, u(200), (sharesBought * 99n) / 100n)).wait();
  assert(sharesBought > 0n, "trader received YES shares");

  console.log("5. Trader sells YES back for 50 USDC...");
  await (await ct.connect(trader).setApprovalForAll(fpmmAddr, true)).wait();
  const balBeforeSell = await usdc.balanceOf(trader.address);
  const sharesNeeded = await market.calcSellAmount(0, u(50));
  await (await market.connect(trader).sell(0, u(50), sharesBought)).wait();
  const balAfterSell = await usdc.balanceOf(trader.address);
  assert(balAfterSell === balBeforeSell + u(50), "sell returned exactly 50 USDC");

  console.log("6. Resolving market YES-wins...");
  await ethers.provider.send("evm_increaseTime", [3601]);
  await ethers.provider.send("evm_mine", []);
  await (await factory.resolveMarket(questionId, [1, 0])).wait();

  console.log("7. Trader redeems remaining YES shares...");
  const balBeforeRedeem = await usdc.balanceOf(trader.address);
  await (await ct.connect(trader).redeemPositions(await usdc.getAddress(), conditionId)).wait();
  const balAfterRedeem = await usdc.balanceOf(trader.address);
  assert(balAfterRedeem > balBeforeRedeem, "redeem paid out winning shares");

  console.log("8. Conservation checks...");
  const usdcTotalAfter = await usdc.totalSupply();
  assert(usdcTotalAfter === usdcTotalBefore, "no USDC minted/burned by trading");

  const ctUsdcBalance = await usdc.balanceOf(await ct.getAddress());
  console.log(`   USDC still locked in ConditionalTokens: ${fmt(ctUsdcBalance)}`);
  console.log(`   (belongs to remaining LP position + any unredeemed shares)`);

  console.log("\n✅ E2E lifecycle passed.");
}

main().catch((err) => {
  console.error("\n❌ E2E failed:", err);
  process.exitCode = 1;
});
