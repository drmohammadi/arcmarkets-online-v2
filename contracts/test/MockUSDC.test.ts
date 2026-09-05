
  import { expect } from "chai";
  import { ethers } from "hardhat";
  import { time } from "@nomicfoundation/hardhat-network-helpers";
  import { usdc } from "./helpers";

  describe("MockUSDC", () => {
    it("has 6 decimals (matches Arc native USDC)", async () => {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      expect(await token.decimals()).to.equal(6);
    });

    it("faucet dispenses 1000 USDC and enforces cooldown", async () => {
      const [, user] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();

      await token.connect(user).faucet();
      expect(await token.balanceOf(user.address)).to.equal(usdc(1000));

      // Second claim within cooldown reverts.
      await expect(token.connect(user).faucet()).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );

      // After cooldown, works again.
      await time.increase(24 * 3600 + 1);
      await token.connect(user).faucet();
      expect(await token.balanceOf(user.address)).to.equal(usdc(2000));
    });

    it("only owner can mint arbitrary amounts", async () => {
      const [owner, user] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();

      await token.mint(user.address, usdc(5000));
      expect(await token.balanceOf(user.address)).to.equal(usdc(5000));

      await expect(
        token.connect(user).mint(user.address, usdc(1))
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });