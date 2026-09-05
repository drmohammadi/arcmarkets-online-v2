
  import { expect } from "chai";
  import { ethers } from "hardhat";
  import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
  import { deploySystem, createMarket, usdc, DeployedSystem } from "./helpers";

  describe("ConditionalTokens", () => {
    async function fixture() {
      const [deployer, alice, bob] = await ethers.getSigners();
      const system = await deploySystem();
      await system.mockUSDC.mint(alice.address, usdc(10_000));
      await system.mockUSDC.mint(bob.address, usdc(10_000));
      return { system, deployer, alice, bob };
    }

    it("split then merge is a perfect round-trip (conservation)", async () => {
      const { system, alice } = await loadFixture(fixture);
      const { conditionId } = await createMarket(system, alice.address);
      const ct = system.conditionalTokens;
      const usdcAddr = await system.mockUSDC.getAddress();

      const before = await system.mockUSDC.balanceOf(alice.address);

      await system.mockUSDC.connect(alice).approve(await ct.getAddress(), usdc(100));
      await ct.connect(alice).splitPosition(usdcAddr, conditionId, usdc(100));

      // Alice holds 100 YES + 100 NO, and 100 USDC left the wallet.
      const yesId = await ct.getPositionId(usdcAddr, conditionId, 0);
      const noId = await ct.getPositionId(usdcAddr, conditionId, 1);
      expect(await ct.balanceOf(alice.address, yesId)).to.equal(usdc(100));
      expect(await ct.balanceOf(alice.address, noId)).to.equal(usdc(100));
      expect(await system.mockUSDC.balanceOf(alice.address)).to.equal(before - usdc(100));

      // Merge back → exact collateral returned, shares burned.
      await ct.connect(alice).mergePositions(usdcAddr, conditionId, usdc(100));
      expect(await system.mockUSDC.balanceOf(alice.address)).to.equal(before);
      expect(await ct.balanceOf(alice.address, yesId)).to.equal(0);
      expect(await ct.balanceOf(alice.address, noId)).to.equal(0);
    });

    it("redeem pays winners and reverts for losers", async () => {
      const { system, alice, bob } = await loadFixture(fixture);
      const { questionId, conditionId } = await createMarket(system, alice.address);
      const ct = system.conditionalTokens;
      const usdcAddr = await system.mockUSDC.getAddress();

      // Bob splits 100 → 100 YES + 100 NO.
      await system.mockUSDC.connect(bob).approve(await ct.getAddress(), usdc(100));
      await ct.connect(bob).splitPosition(usdcAddr, conditionId, usdc(100));

      // Resolve YES wins. Resolver is alice; must be past resolutionTime.
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);
      await system.factory.connect(alice).resolveMarket(questionId, [1, 0]);

      const before = await system.mockUSDC.balanceOf(bob.address);
      await ct.connect(bob).redeemPositions(usdcAddr, conditionId);
      // YES paid 100, NO paid 0 → net +100.
      expect(await system.mockUSDC.balanceOf(bob.address)).to.equal(before + usdc(100));
    });

    it("reverts split on unprepared condition and zero amount", async () => {
      const { system, alice } = await loadFixture(fixture);
      const ct = system.conditionalTokens;
      const usdcAddr = await system.mockUSDC.getAddress();
      const fakeCondition = ethers.keccak256(ethers.toUtf8Bytes("nope"));

      await expect(
        ct.connect(alice).splitPosition(usdcAddr, fakeCondition, usdc(1))
      ).to.be.revertedWithCustomError(ct, "ConditionNotPrepared");
    });

    it("only the factory (owner) can prepareCondition", async () => {
      const { system, alice } = await loadFixture(fixture);
      const ct = system.conditionalTokens;
      await expect(
        ct.connect(alice).prepareCondition(alice.address, 999)
      ).to.be.revertedWithCustomError(ct, "OwnableUnauthorizedAccount");
    });
  });