import { expect } from "chai";
import { buildXScale } from "../../frontend/lib/chartScale";

/**
 * WHY THIS LIVES IN THE CONTRACTS WORKSPACE. It is where this repo's mocha runner
 * is; there is no frontend test runner (`TODO.md`), and adding one is a dependency
 * decision for the project owner. `frontend/lib/chartScale.ts` therefore has ZERO
 * imports — this file reaches it by relative path under a CommonJS tsconfig, and
 * any import at all (viem, a node builtin, an `@/`-aliased sibling) breaks that.
 *
 * WHY THE MODE DECISION IS TESTED AT ALL. It fails silently when it is wrong: a
 * time scale built from points whose timestamps are all equal divides by zero, and
 * a sequence scale applied to timestamped points draws evenly spaced trades — a
 * plausible-looking chart that lies about when anything happened. Neither raises.
 */

const PAD = 26, W = 600;

describe("chart x-scale", () => {
  it("falls back to sequence when any timestamp is missing", () => {
    const s = buildXScale([{ bps: 5000, t: 1 }, { bps: 5100 }], PAD, W);
    expect(s.mode).to.equal("sequence");
    expect(s.xAt(0)).to.equal(PAD);
    expect(s.xAt(1)).to.equal(PAD + W);
    expect(s.ticks).to.deep.equal([]);
  });

  it("falls back to sequence when every timestamp is identical", () => {
    const s = buildXScale([{ bps: 1, t: 99 }, { bps: 2, t: 99 }], PAD, W);
    expect(s.mode).to.equal("sequence");
  });

  it("parks a lone point at the right edge, as the flat-line case needs", () => {
    const s = buildXScale([{ bps: 5000, t: 42 }], PAD, W);
    expect(s.mode).to.equal("sequence");
    expect(s.xAt(0)).to.equal(PAD + W);
  });

  it("positions by time, not by index", () => {
    // Three points where the middle one is 10% of the way through the span.
    const s = buildXScale(
      [{ bps: 1, t: 0 }, { bps: 2, t: 10 }, { bps: 3, t: 100 }], PAD, W
    );
    expect(s.mode).to.equal("time");
    expect(s.xAt(0)).to.equal(PAD);
    expect(s.xAt(1)).to.be.closeTo(PAD + 0.1 * W, 0.001);
    expect(s.xAt(2)).to.equal(PAD + W);
    // A sequence scale would have put the middle point at the halfway mark.
    expect(s.xAt(1)).to.be.lessThan(PAD + 0.4 * W);
  });

  it("emits in-range, ordered ticks with non-empty labels", () => {
    const now = 1_756_651_200;
    const s = buildXScale(
      [{ bps: 1, t: now - 86400 }, { bps: 2, t: now }], PAD, W, 4
    );
    expect(s.ticks).to.have.length(4);
    for (const tk of s.ticks) {
      expect(tk.x).to.be.at.least(PAD);
      expect(tk.x).to.be.at.most(PAD + W);
      expect(tk.label).to.be.a("string").and.not.empty;
    }
    const xs = s.ticks.map((t) => t.x);
    expect(xs).to.deep.equal([...xs].sort((a, b) => a - b));
  });

  it("never returns NaN for a degenerate input", () => {
    for (const pts of [[], [{ bps: 5000 }]]) {
      const s = buildXScale(pts as { bps: number; t?: number }[], PAD, W);
      expect(Number.isFinite(s.xAt(0))).to.equal(true);
    }
  });
});
