import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deploySystem, createMarket } from "./helpers";

/**
 * Pins the off-chain position-id derivation used by `frontend/lib/positionIds.ts`.
 *
 * The frontend no longer reads `yesPositionId()` / `noPositionId()` from each
 * pool — it computes them locally, which removes 2 RPC calls per market AND the
 * serial round-trip that reading them forced (balance reads depend on the ids).
 *
 * That is only safe while the on-chain hash matches the off-chain one. These
 * tests assert the formula against BOTH sources of truth:
 *   1. `ConditionalTokens.getPositionId`, the pure function itself, and
 *   2. the FPMM's `immutable` copies, which is what the app actually indexes by.
 *
 * If a future contract change alters the hash — a different encoding, an extra
 * field, a non-binary outcome count — this fails loudly here instead of the UI
 * silently reading balances for token ids that were never minted.
 */
describe("Position id derivation (frontend parity)", () => {
  async function fixture() {
    const [deployer, alice] = await ethers.getSigners();
    const system = await deploySystem();
    return { system, deployer, alice };
  }

  /** The exact expression frontend/lib/positionIds.ts evaluates. */
  function derivePositionId(
    collateral: string,
    conditionId: string,
    outcome: 0 | 1
  ): bigint {
    return BigInt(
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "bytes32", "uint256"],
          [collateral, conditionId, outcome]
        )
      )
    );
  }

  it("matches ConditionalTokens.getPositionId for both outcomes", async () => {
    const { system, alice } = await loadFixture(fixture);
    const { conditionId } = await createMarket(system, alice.address);
    const ct = system.conditionalTokens;
    const usdcAddr = await system.mockUSDC.getAddress();

    for (const outcome of [0, 1] as const) {
      const onChain = await ct.getPositionId(usdcAddr, conditionId, outcome);
      expect(derivePositionId(usdcAddr, conditionId, outcome)).to.equal(onChain);
    }
  });

  it("matches the pool's immutable yesPositionId / noPositionId", async () => {
    const { system, alice } = await loadFixture(fixture);
    const { fpmm, conditionId } = await createMarket(system, alice.address);
    const usdcAddr = await system.mockUSDC.getAddress();

    // These are the reads the frontend replaced; the derivation must reproduce
    // them exactly, since positions are indexed by the resulting id.
    const pool = await ethers.getContractAt("FixedProductMarketMaker", fpmm);
    expect(derivePositionId(usdcAddr, conditionId, 0)).to.equal(await pool.yesPositionId());
    expect(derivePositionId(usdcAddr, conditionId, 1)).to.equal(await pool.noPositionId());
  });

  it("YES and NO ids differ, so balances cannot be conflated", async () => {
    const { system, alice } = await loadFixture(fixture);
    const { conditionId } = await createMarket(system, alice.address);
    const usdcAddr = await system.mockUSDC.getAddress();

    expect(derivePositionId(usdcAddr, conditionId, 0)).to.not.equal(
      derivePositionId(usdcAddr, conditionId, 1)
    );
  });

  it("distinct markets derive distinct ids", async () => {
    const { system, alice } = await loadFixture(fixture);
    const first = await createMarket(system, alice.address);
    const second = await createMarket(system, alice.address);
    const usdcAddr = await system.mockUSDC.getAddress();

    expect(first.conditionId).to.not.equal(second.conditionId);
    expect(derivePositionId(usdcAddr, first.conditionId, 0)).to.not.equal(
      derivePositionId(usdcAddr, second.conditionId, 0)
    );
  });

  it("derived ids index real balances after a split", async () => {
    const { system, alice } = await loadFixture(fixture);
    const { conditionId } = await createMarket(system, alice.address);
    const ct = system.conditionalTokens;
    const usdcAddr = await system.mockUSDC.getAddress();

    await system.mockUSDC.mint(alice.address, 1_000_000n);
    await system.mockUSDC.connect(alice).approve(await ct.getAddress(), 1_000_000n);
    await ct.connect(alice).splitPosition(usdcAddr, conditionId, 1_000_000n);

    // The end-to-end claim: derive locally, read the balance, get the real number.
    const yesId = derivePositionId(usdcAddr, conditionId, 0);
    const noId = derivePositionId(usdcAddr, conditionId, 1);
    expect(await ct.balanceOf(alice.address, yesId)).to.equal(1_000_000n);
    expect(await ct.balanceOf(alice.address, noId)).to.equal(1_000_000n);
  });

  it("balanceOfBatch returns the same balances as individual reads", async () => {
    const { system, alice } = await loadFixture(fixture);
    const a = await createMarket(system, alice.address);
    const b = await createMarket(system, alice.address);
    const ct = system.conditionalTokens;
    const usdcAddr = await system.mockUSDC.getAddress();

    await system.mockUSDC.mint(alice.address, 3_000_000n);
    await system.mockUSDC.connect(alice).approve(await ct.getAddress(), 3_000_000n);
    await ct.connect(alice).splitPosition(usdcAddr, a.conditionId, 1_000_000n);
    await ct.connect(alice).splitPosition(usdcAddr, b.conditionId, 2_000_000n);

    // The portfolio page collapses 2N balanceOf calls into ONE balanceOfBatch.
    // Order must be preserved: accounts pair to ids by index.
    const ids = [
      derivePositionId(usdcAddr, a.conditionId, 0),
      derivePositionId(usdcAddr, a.conditionId, 1),
      derivePositionId(usdcAddr, b.conditionId, 0),
      derivePositionId(usdcAddr, b.conditionId, 1),
    ];
    const accounts = ids.map(() => alice.address);

    const batched = await ct.balanceOfBatch(accounts, ids);
    expect(batched).to.deep.equal([1_000_000n, 1_000_000n, 2_000_000n, 2_000_000n]);
  });
});
