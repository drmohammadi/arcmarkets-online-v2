import { expect } from "chai";
import {
  BACKOFF_MS, MIN_CHUNK, classifyRpcError, halve, isRangeTooLarge, isRateLimit,
  nextChunkCeiling, planRanges,
} from "../../frontend/lib/indexer/chunking";

type Plan = Array<{ from: bigint; to: bigint }>;

/**
 * Contiguity as a PROPERTY, not as an array length: every range forward, each
 * `from` exactly the previous `to + 1`, no gap and no overlap, anchored at the
 * requested `from`. A gap is permanent silent data loss (the caller records what
 * it covered), so it has to be checked structurally.
 */
function assertContiguous(plan: Plan, from: bigint, to: bigint, complete: boolean): void {
  expect(plan.length, "plan is non-empty").to.be.greaterThan(0);
  expect(plan[0].from, "first from is the requested from").to.equal(from);
  for (let i = 0; i < plan.length; i += 1) {
    expect(plan[i].from <= plan[i].to, `range ${i} is not inverted`).to.equal(true);
    if (i > 0) {
      expect(plan[i].from, `range ${i} abuts range ${i - 1}`)
        .to.equal(plan[i - 1].to + BigInt(1));
    }
  }
  const last = plan[plan.length - 1].to;
  if (complete) expect(last, "last to is the requested to").to.equal(to);
  else expect(last < to, "a capped plan is a prefix that stops short").to.equal(true);
}

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

  it("does not read a block number containing 429 as a rate limit", () => {
    // The live infinite loop: `msg.includes('429')` matched the block number in
    // this message, so the caller retried an unchanged range forever.
    const refusal = {
      code: -32012,
      message: "requested range too large: 55429000..55700000",
    };
    expect(isRateLimit(refusal)).to.equal(false);
    expect(isRangeTooLarge(refusal)).to.equal(true);
    expect(classifyRpcError(refusal)).to.equal("range-too-large");

    // A real 429 still has to be seen, in every wording that carries it.
    expect(isRateLimit({ message: "HTTP 429 Too Many Requests" })).to.equal(true);
    expect(isRateLimit("429")).to.equal(true);
    expect(isRateLimit({ details: "status=429, retry later" })).to.equal(true);
    expect(classifyRpcError({ status: 429 })).to.equal("rate-limit");
  });

  it("classifies range-too-large ahead of rate-limit when both match", () => {
    // Alchemy/Infura shape: -32005 (a rate-limit code) carrying a result-count
    // refusal. Both predicates fire; the classifier must pick the narrowing
    // remedy, because guessing rate-limit here burns the whole request budget.
    const both = { code: -32005, message: "query returned more than 10000 results" };
    expect(isRangeTooLarge(both)).to.equal(true);
    expect(isRateLimit(both)).to.equal(true);
    expect(classifyRpcError(both)).to.equal("range-too-large");
  });

  it("never throws on hostile or non-object errors, and says 'other'", () => {
    const throwingGetter: Record<string, unknown> = {};
    Object.defineProperty(throwingGetter, "message", {
      get() { throw new Error("hostile message getter"); },
      enumerable: true,
    });
    Object.defineProperty(throwingGetter, "code", {
      get() { throw new Error("hostile code getter"); },
      enumerable: true,
    });

    const selfCycle: any = {};
    selfCycle.cause = selfCycle;

    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["a bare string", "something went wrong"],
      // A bare number carries no message and no code field, so it is
      // unclassifiable by design — asserted so nobody "fixes" it silently.
      ["a number", 429],
      ["a frozen object", Object.freeze({ message: "frozen but harmless" })],
      ["a throwing getter", throwingGetter],
      ["a self-referential cycle", selfCycle],
    ];

    for (const [label, value] of cases) {
      expect(() => isRangeTooLarge(value), label).to.not.throw();
      expect(() => isRateLimit(value), label).to.not.throw();
      expect(() => classifyRpcError(value), label).to.not.throw();
      expect(isRangeTooLarge(value), label).to.equal(false);
      expect(isRateLimit(value), label).to.equal(false);
      expect(classifyRpcError(value), label).to.equal("other");
    }
  });

  it("still classifies a signal buried in a cyclic cause chain", () => {
    const outer: any = { message: "transport failed" };
    const inner: any = { code: -32012, cause: outer };
    outer.cause = inner;
    expect(classifyRpcError(outer)).to.equal("range-too-large");
    expect(isRangeTooLarge(Object.freeze({ code: -32012 }))).to.equal(true);
  });

  it("drops the undocumented -32701 code", () => {
    expect(isRangeTooLarge({ code: -32701 })).to.equal(false);
  });

  it("never ratchets the ceiling below MIN_CHUNK", () => {
    expect(MIN_CHUNK).to.equal(BigInt(1000));
    // No information (a non-positive accepted span) must not teach a 1-block
    // ceiling: the fold only raises, so 1 would stick and a backfill would cover
    // `maxRequests` blocks per run.
    expect(nextChunkCeiling(null, BigInt(0))).to.equal(MIN_CHUNK);
    expect(nextChunkCeiling(null, BigInt(-5))).to.equal(MIN_CHUNK);
    // With a prior ceiling, no information leaves it untouched.
    expect(nextChunkCeiling(BigInt(250000), BigInt(0))).to.equal(BigInt(250000));
    expect(nextChunkCeiling(BigInt(250000), BigInt(-1))).to.equal(BigInt(250000));
    // A nonsense stored value is raised to the floor, never passed through.
    expect(nextChunkCeiling(BigInt(1), BigInt(0))).to.equal(MIN_CHUNK);
    expect(nextChunkCeiling(BigInt(0), BigInt(0))).to.equal(MIN_CHUNK);
    expect(nextChunkCeiling(null, BigInt(50))).to.equal(MIN_CHUNK);
    // And the raise still works above the floor.
    expect(nextChunkCeiling(MIN_CHUNK, BigInt(120000))).to.equal(BigInt(120000));
  });

  it("clamps a non-positive chunk to MIN_CHUNK rather than to one block", () => {
    expect(planRanges(BigInt(0), BigInt(2999), BigInt(0), 40)).to.deep.equal([
      { from: BigInt(0), to: BigInt(999) },
      { from: BigInt(1000), to: BigInt(1999) },
      { from: BigInt(2000), to: BigInt(2999) },
    ]);
    expect(planRanges(BigInt(0), BigInt(999), BigInt(-7), 40)).to.deep.equal([
      { from: BigInt(0), to: BigInt(999) },
    ]);
  });

  it("plans a contiguous prefix, gap-free, at real backfill scale", () => {
    // The actual Arc testnet shape: factory at 55,632,013, head past 57,300,000,
    // 120k chunks. Every bound here is a bigint from end to end.
    const from = BigInt(55_632_013);
    const to = BigInt(57_300_000);
    const full = planRanges(from, to, BigInt(120_000), Number.MAX_SAFE_INTEGER);
    assertContiguous(full, from, to, true);
    expect(full).to.have.length(14);

    const capped = planRanges(from, to, BigInt(120_000), 5);
    assertContiguous(capped, from, to, false);
    expect(capped).to.have.length(5);
    // The caller resumes exactly where the prefix stopped.
    const resumed = planRanges(capped[4].to + BigInt(1), to, BigInt(120_000), 40);
    assertContiguous(resumed, capped[4].to + BigInt(1), to, true);

    // Odd sizes, single-block chunks and an exact multiple all hold the property.
    assertContiguous(planRanges(BigInt(1), BigInt(1000), BigInt(7), 1000), BigInt(1), BigInt(1000), true);
    assertContiguous(planRanges(BigInt(9), BigInt(11), BigInt(1), 40), BigInt(9), BigInt(11), true);
    assertContiguous(planRanges(BigInt(0), BigInt(999), BigInt(1000), 40), BigInt(0), BigInt(999), true);
  });

  it("treats Infinity as uncapped, not as zero coverage", () => {
    const plan = planRanges(BigInt(100), BigInt(350), BigInt(100), Infinity);
    assertContiguous(plan, BigInt(100), BigInt(350), true);
    expect(plan).to.have.length(3);
    // NaN and -Infinity carry no plausible intent, so they stay empty.
    expect(planRanges(BigInt(100), BigInt(350), BigInt(100), NaN)).to.deep.equal([]);
    expect(planRanges(BigInt(100), BigInt(350), BigInt(100), -Infinity)).to.deep.equal([]);
    expect(planRanges(BigInt(100), BigInt(350), BigInt(100), 0)).to.deep.equal([]);
  });
});
