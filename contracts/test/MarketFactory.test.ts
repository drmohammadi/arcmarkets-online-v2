
  import { expect } from "chai";
  import { ethers } from "hardhat";
  import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
  import { deploySystem, usdc } from "./helpers";

  describe("MarketFactory", () => {
    async function fixture() {
      const [deployer, alice] = await ethers.getSigners();
      const system = await deploySystem();
      return { system, deployer, alice };
    }

    it("only owner can create markets", async () => {
      const { system, alice } = await loadFixture(fixture);
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await expect(
        system.factory.connect(alice).createMarket("Q", "C", now + 3600, alice.address, 100)
      ).to.be.revertedWithCustomError(system.factory, "OwnableUnauthorizedAccount");
    });

    it("rejects empty question, oversized strings, and past resolution time", async () => {
      const { system, deployer } = await loadFixture(fixture);
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      await expect(
        system.factory.createMarket("", "C", now + 3600, deployer.address, 100)
      ).to.be.revertedWithCustomError(system.factory, "InvalidInput");

      await expect(
        system.factory.createMarket("Q", "C", now - 1, deployer.address, 100)
      ).to.be.revertedWithCustomError(system.factory, "InvalidInput");

      const huge = "x".repeat(257);
      await expect(
        system.factory.createMarket(huge, "C", now + 3600, deployer.address, 100)
      ).to.be.revertedWithCustomError(system.factory, "InvalidInput");
    });

    it("resolution is time-gated, resolver-gated, and one-shot", async () => {
      const { system, deployer, alice } = await loadFixture(fixture);
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const tx = await system.factory.createMarket("Q", "C", now + 3600, alice.address, 100);
      const receipt = await tx.wait();
      const ev = receipt!.logs
        .map((l) => { try { return system.factory.interface.parseLog(l as any); } catch { return null; } })
        .find((e) => e?.name === "MarketCreated");
      const questionId = ev!.args.questionId;

      // Too early.
      await expect(
        system.factory.connect(alice).resolveMarket(questionId, [1, 0])
      ).to.be.revertedWithCustomError(system.factory, "ResolutionTimeLocked");

      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Wrong resolver.
      await expect(
        system.factory.connect(deployer).resolveMarket(questionId, [1, 0])
      ).to.be.revertedWithCustomError(system.factory, "Unauthorized");

      // Correct resolver.
      await system.factory.connect(alice).resolveMarket(questionId, [1, 0]);

      // One-shot: second attempt reverts.
      await expect(
        system.factory.connect(alice).resolveMarket(questionId, [0, 1])
      ).to.be.revertedWithCustomError(system.factory, "MarketAlreadyResolved");
    });

    it("pause halts market creation and cascades to ConditionalTokens", async () => {
      const { system, deployer } = await loadFixture(fixture);
      await system.factory.pause();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await expect(
        system.factory.createMarket("Q", "C", now + 3600, deployer.address, 100)
      ).to.be.revertedWithCustomError(system.factory, "EnforcedPause");
      expect(await system.conditionalTokens.paused()).to.equal(true);
    });
  });