import { expect } from "chai";
import {
  BACKOFF_MS, halve, isRangeTooLarge, isRateLimit, nextChunkCeiling, planRanges,
} from "../../frontend/lib/indexer/chunking";

describe("indexer chunking", () => {
  it("tells a range refusal apart from a rate limit", () => {
    const range = { code: -32012, message: "requested range too large" };
    expect(isRangeTooLarge(range)).to.equal(true);
    expect(isRateLimit(range)).to.equal(false);
    expect(isRateLimit({ status: 429 })).to.equal(true);
    expect(isRateLimit({ code: -32005 })).to.equal(true);
    expect(isRateLimit({ cause: { message: "Too Many Requests" } })).to.equal(true);
    expect(isRangeTooLarge({ status: 429 })).to.equal(false);
  });

  it("halves down to the floor then gives up", () => {
    expect(halve(BigInt(250000), BigInt(1000))).to.equal(BigInt(125000));
    expect(halve(BigInt(1000), BigInt(1000))).to.equal(null);
    expect(halve(BigInt(1), BigInt(1000))).to.equal(null);
  });

  it("raises the learned ceiling but never lowers it", () => {
    expect(nextChunkCeiling(null, BigInt(250000))).to.equal(BigInt(250000));
    expect(nextChunkCeiling(BigInt(250000), BigInt(500000))).to.equal(BigInt(500000));
    expect(nextChunkCeiling(BigInt(500000), BigInt(50))).to.equal(BigInt(500000));
  });

  it("plans contiguous forward ranges and clamps the tail", () => {
    const r = planRanges(BigInt(100), BigInt(350), BigInt(100), 40);
    expect(r).to.deep.equal([
      { from: BigInt(100), to: BigInt(199) },
      { from: BigInt(200), to: BigInt(299) },
      { from: BigInt(300), to: BigInt(350) },
    ]);
  });

  it("respects the request cap and never inverts a range", () => {
    expect(planRanges(BigInt(0), BigInt(10_000), BigInt(100), 3)).to.have.length(3);
    expect(planRanges(BigInt(500), BigInt(499), BigInt(100), 40)).to.deep.equal([]);
    expect(planRanges(BigInt(7), BigInt(7), BigInt(100), 40)).to.deep.equal([
      { from: BigInt(7), to: BigInt(7) },
    ]);
  });

  it("exposes the same backoff ladder as rpcQueue", () => {
    expect([...BACKOFF_MS]).to.deep.equal([1000, 2000, 4000, 8000]);
  });
});
