import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deploySystem, createMarket, usdc } from "./helpers";
import { FixedProductMarketMaker } from "../typechain-types";

describe("FixedProductMarketMaker", () => {
  async function fixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const system = await deploySystem();
    await system.mockUSDC.mint(alice.address, usdc(100_000));
    await system.mockUSDC.mint(bob.address, usdc(100_000));

    const { questionId, fpmm } = await createMarket(system, deployer.address, 200);
    const market = (await ethers.getContractAt(
      "FixedProductMarketMaker",
      fpmm
    )) as unknown as FixedProductMarketMaker;

    return { system, deployer, alice, bob, questionId, market };
  }

  async function seedLiquidity(system: any, market: any, lp: any, amount: bigint) {
    await system.mockUSDC.connect(lp).approve(await market.getAddress(), amount);
    await market.connect(lp).addLiquidity(amount, 0);
  }

  it("first LP gets shares equal to deposit; reserves are balanced", async () => {
    const { system, alice, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));
    expect(await market.balanceOf(alice.address)).to.equal(usdc(1000));
    expect(await market.totalSupply()).to.equal(usdc(1000));
    const [yes, no] = await market.reserves();
    expect(yes).to.equal(usdc(1000));
    expect(no).to.equal(usdc(1000));
  });

  it("buy YES: spends collateral, returns shares, moves price", async () => {
    const { system, alice, bob, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));

    const quote = await market.calcBuyAmount(0, usdc(100));
    expect(quote).to.be.gt(0);
    // Near 50/50, ~100 USDC should buy noticeably more than 100 YES shares
    // (price of YES < 1), proving the +investment term is present.
    expect(quote).to.be.gt(usdc(100));

    await system.mockUSDC.connect(bob).approve(await market.getAddress(), usdc(100));
    await expect(market.connect(bob).buy(0, usdc(100), quote)).to.emit(market, "Buy");

    const yesId = await market.yesPositionId();
    expect(await system.conditionalTokens.balanceOf(bob.address, yesId)).to.equal(quote);
  });

  it("buy reverts when minSharesOut not met (slippage protection)", async () => {
    const { system, alice, bob, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));
    await system.mockUSDC.connect(bob).approve(await market.getAddress(), usdc(100));
    await expect(
      market.connect(bob).buy(0, usdc(100), usdc(1_000_000))
    ).to.be.revertedWithCustomError(market, "SlippageExceeded");
  });

  it("sell returns exactly the requested collateral, costs shares", async () => {
    const { system, alice, bob, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));

    // Bob first buys YES so he has shares to sell.
    await system.mockUSDC.connect(bob).approve(await market.getAddress(), usdc(200));
    await market.connect(bob).buy(0, usdc(200), 0);

    const yesId = await market.yesPositionId();
    const heldBefore = await system.conditionalTokens.balanceOf(bob.address, yesId);

    // Approve FPMM as ERC1155 operator, then sell to receive exactly 50 USDC.
    await system.conditionalTokens.connect(bob).setApprovalForAll(await market.getAddress(), true);
    const sharesNeeded = await market.calcSellAmount(0, usdc(50));
    expect(sharesNeeded).to.be.lte(heldBefore);

    const balBefore = await system.mockUSDC.balanceOf(bob.address);
    await expect(market.connect(bob).sell(0, usdc(50), heldBefore)).to.emit(market, "Sell");
    const balAfter = await system.mockUSDC.balanceOf(bob.address);

    // Received EXACTLY the requested collateral.
    expect(balAfter - balBefore).to.equal(usdc(50));
    // Shares actually consumed match the quote.
    const heldAfter = await system.conditionalTokens.balanceOf(bob.address, yesId);
    expect(heldBefore - heldAfter).to.equal(sharesNeeded);
  });

  it("no free money: buying 100 USDC of YES cannot be sold back for 100 USDC", async () => {
    const { system, alice, bob, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));

    await system.mockUSDC.connect(bob).approve(await market.getAddress(), usdc(100));
    const sharesBought = await market.calcBuyAmount(0, usdc(100));
    await market.connect(bob).buy(0, usdc(100), 0);

    // To withdraw the full 100 USDC back requires MORE shares than were received
    // (fee + price impact). This proves the AMM can't be drained by a round-trip.
    const sharesToGet100Back = await market.calcSellAmount(0, usdc(100));
    expect(sharesToGet100Back).to.be.gt(sharesBought);
  });

  it("sell reverts if it would exceed pool reserves", async () => {
    const { system, alice, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));
    // Requesting more collateral than a reserve can back must revert in the quote.
    await expect(market.calcSellAmount(0, usdc(2000))).to.be.revertedWithCustomError(
      market,
      "ReturnExceedsReserves"
    );
  });

  it("rejects fee above 10% cap at construction", async () => {
    const { system, deployer } = await loadFixture(fixture);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await expect(
      system.factory.createMarket("Q", "C", now + 3600, deployer.address, 1001)
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("FixedProductMarketMaker"),
      "InvalidFee"
    );
  });

  it("remove liquidity returns collateral and burns LP shares", async () => {
    const { system, alice, market } = await loadFixture(fixture);
    await seedLiquidity(system, market, alice, usdc(1000));

    const before = await system.mockUSDC.balanceOf(alice.address);
    await market.connect(alice).removeLiquidity(usdc(1000), 0);
    const after = await system.mockUSDC.balanceOf(alice.address);

    // With no trades, a balanced pool returns the full deposit.
    expect(after - before).to.equal(usdc(1000));
    expect(await market.balanceOf(alice.address)).to.equal(0);
  });
});
