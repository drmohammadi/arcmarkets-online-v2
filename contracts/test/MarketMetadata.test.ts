import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("MarketMetadata", () => {
  async function fixture() {
    const [deployer, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MarketMetadata");
    const metadata = await Factory.deploy();
    await metadata.waitForDeployment();
    return { metadata, deployer, alice };
  }

  const DESC = "Predict which candidate wins. Resolves to the official result.";
  const IMG = "https://example.com/image.png";
  const SRC = "https://example.com/official-results";

  it("stores and returns metadata for a question id", async () => {
    const { metadata } = await loadFixture(fixture);
    await metadata.setMetadata(7, DESC, IMG, SRC);

    const m = await metadata.getMetadata(7);
    expect(m.description).to.equal(DESC);
    expect(m.imageUrl).to.equal(IMG);
    expect(m.resolutionSource).to.equal(SRC);
    expect(m.set).to.equal(true);
  });

  it("reports set=false for a question id that was never written", async () => {
    const { metadata } = await loadFixture(fixture);
    const m = await metadata.getMetadata(999);
    expect(m.set).to.equal(false);
    expect(m.description).to.equal("");
    expect(m.imageUrl).to.equal("");
    expect(m.resolutionSource).to.equal("");
  });

  it("overwrites an existing entry", async () => {
    const { metadata } = await loadFixture(fixture);
    await metadata.setMetadata(1, DESC, IMG, SRC);
    await metadata.setMetadata(1, "new description", "https://example.com/b.png", "");

    const m = await metadata.getMetadata(1);
    expect(m.description).to.equal("new description");
    expect(m.imageUrl).to.equal("https://example.com/b.png");
    expect(m.resolutionSource).to.equal("");
    expect(m.set).to.equal(true);
  });

  it("emits MetadataSet with the written values", async () => {
    const { metadata } = await loadFixture(fixture);
    await expect(metadata.setMetadata(3, DESC, IMG, SRC))
      .to.emit(metadata, "MetadataSet")
      .withArgs(3, DESC, IMG, SRC);
  });

  it("clears an entry back to the never-set state and emits", async () => {
    const { metadata } = await loadFixture(fixture);
    await metadata.setMetadata(4, DESC, IMG, SRC);

    await expect(metadata.clearMetadata(4)).to.emit(metadata, "MetadataCleared").withArgs(4);

    const m = await metadata.getMetadata(4);
    expect(m.set).to.equal(false);
    expect(m.description).to.equal("");
  });

  it("only the owner can set, batch-set, or clear", async () => {
    const { metadata, alice } = await loadFixture(fixture);

    await expect(
      metadata.connect(alice).setMetadata(1, DESC, IMG, SRC)
    ).to.be.revertedWithCustomError(metadata, "OwnableUnauthorizedAccount");

    await expect(
      metadata.connect(alice).setMetadataBatch([1], [DESC], [IMG], [SRC])
    ).to.be.revertedWithCustomError(metadata, "OwnableUnauthorizedAccount");

    await expect(
      metadata.connect(alice).clearMetadata(1)
    ).to.be.revertedWithCustomError(metadata, "OwnableUnauthorizedAccount");
  });

  it("enforces the description byte cap at the boundary", async () => {
    const { metadata } = await loadFixture(fixture);
    const max = Number(await metadata.MAX_DESCRIPTION_BYTES());

    // Exactly at the cap is accepted.
    await metadata.setMetadata(1, "x".repeat(max), "", "");
    expect((await metadata.getMetadata(1)).description.length).to.equal(max);

    // One byte over reverts.
    await expect(
      metadata.setMetadata(2, "x".repeat(max + 1), "", "")
    ).to.be.revertedWithCustomError(metadata, "InvalidInput");
  });

  it("enforces the url and resolution-source byte caps", async () => {
    const { metadata } = await loadFixture(fixture);
    const maxUrl = Number(await metadata.MAX_URL_BYTES());
    const maxSrc = Number(await metadata.MAX_SOURCE_BYTES());

    await expect(
      metadata.setMetadata(1, "", "x".repeat(maxUrl + 1), "")
    ).to.be.revertedWithCustomError(metadata, "InvalidInput");

    await expect(
      metadata.setMetadata(1, "", "", "x".repeat(maxSrc + 1))
    ).to.be.revertedWithCustomError(metadata, "InvalidInput");
  });

  it("counts limits in BYTES, not characters", async () => {
    const { metadata } = await loadFixture(fixture);
    const max = Number(await metadata.MAX_DESCRIPTION_BYTES());

    // "é" is 2 UTF-8 bytes, so max/2 + 1 characters exceeds the byte cap while
    // remaining well under it as a character count. This is the exact class of
    // bug the byte-based check exists to prevent.
    const multiByte = "é".repeat(max / 2 + 1);
    expect(multiByte.length).to.be.lessThan(max);
    await expect(
      metadata.setMetadata(1, multiByte, "", "")
    ).to.be.revertedWithCustomError(metadata, "InvalidInput");
  });

  it("writes a batch and reads it back", async () => {
    const { metadata } = await loadFixture(fixture);
    await metadata.setMetadataBatch(
      [10, 11, 12],
      ["a", "b", "c"],
      ["https://example.com/1.png", "", "https://example.com/3.png"],
      ["s1", "s2", ""]
    );

    const all = await metadata.getMetadataBatch([10, 11, 12]);
    expect(all.length).to.equal(3);
    expect(all[0].description).to.equal("a");
    expect(all[1].description).to.equal("b");
    expect(all[2].imageUrl).to.equal("https://example.com/3.png");
    expect(all.every((m) => m.set)).to.equal(true);
  });

  it("rejects a batch with mismatched array lengths", async () => {
    const { metadata } = await loadFixture(fixture);
    await expect(
      metadata.setMetadataBatch([1, 2], ["a"], ["", ""], ["", ""])
    ).to.be.revertedWithCustomError(metadata, "LengthMismatch");

    await expect(
      metadata.setMetadataBatch([1, 2], ["a", "b"], [""], ["", ""])
    ).to.be.revertedWithCustomError(metadata, "LengthMismatch");
  });

  it("rejects an empty batch and one over MAX_BATCH", async () => {
    const { metadata } = await loadFixture(fixture);
    await expect(
      metadata.setMetadataBatch([], [], [], [])
    ).to.be.revertedWithCustomError(metadata, "InvalidInput");

    const max = Number(await metadata.MAX_BATCH());
    const ids = Array.from({ length: max + 1 }, (_, i) => i);
    const blanks = ids.map(() => "");
    await expect(
      metadata.setMetadataBatch(ids, blanks, blanks, blanks)
    ).to.be.revertedWithCustomError(metadata, "BatchTooLarge");
  });

  it("caps the batched read too", async () => {
    const { metadata } = await loadFixture(fixture);
    const max = Number(await metadata.MAX_BATCH());
    const ids = Array.from({ length: max + 1 }, (_, i) => i);
    await expect(metadata.getMetadataBatch(ids)).to.be.revertedWithCustomError(
      metadata,
      "BatchTooLarge"
    );
  });

  it("accepts metadata for a question id created before this contract existed", async () => {
    // The registry is deliberately decoupled from the factory: it never checks
    // that a market exists, which is what makes backfilling already-deployed
    // markets possible at all.
    const { metadata } = await loadFixture(fixture);
    await metadata.setMetadata(0, "backfilled", "", "");
    expect((await metadata.getMetadata(0)).description).to.equal("backfilled");
  });
});
