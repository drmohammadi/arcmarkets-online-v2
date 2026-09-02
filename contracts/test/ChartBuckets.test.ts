import { expect } from "chai";
import {
  INTERVAL_SECONDS,
  clampLimit,
  parseFrom,
  parseIntervalName,
  resolveInterval,
} from "../../frontend/lib/chart/buckets";

/**
 * WHY THESE ARE TESTED AT ALL. Every function here fails SILENTLY when it is
 * wrong: a bucket step that is too narrow returns more points than the caller
 * asked for, and a `from` that parses to garbage returns an empty chart. None
 * of them raise, so only assertions catch them.
 *
 * They live in the contracts workspace because that is where this repo's mocha
 * runner is. `frontend/lib/chart/buckets.ts` therefore has ZERO imports — this
 * file reaches it by relative path under a CommonJS tsconfig, and any import at
 * all (viem, a node builtin, an `@/`-aliased sibling) breaks that.
 */

const DAY = 86400;

describe("chart buckets", () => {
  it("parses relative and absolute from-values", () => {
    const now = 1_756_651_200;
    expect(parseFrom("24h", now)).to.equal(now - DAY);
    expect(parseFrom("7d", now)).to.equal(now - 7 * DAY);
    expect(parseFrom("30d", now)).to.equal(now - 30 * DAY);
    expect(parseFrom("all", now)).to.equal(0);
    expect(parseFrom("1756000000", now)).to.equal(1_756_000_000);
    expect(parseFrom(null, now)).to.equal(now - DAY);   // default 24h
    expect(parseFrom("garbage", now)).to.equal(now - DAY);
  });

  it("picks the documented auto steps", () => {
    expect(resolveInterval("auto", DAY, 2000)).to.equal(300);
    expect(resolveInterval("auto", 7 * DAY, 2000)).to.equal(900);
    expect(resolveInterval("auto", 30 * DAY, 2000)).to.equal(3600);
    expect(resolveInterval("auto", 365 * DAY, 2000)).to.equal(86400);
  });

  it("widens auto until the point count fits the limit", () => {
    // 1 day at 5m is 288 buckets; with limit 100 it must widen.
    const step = resolveInterval("auto", DAY, 100);
    expect(DAY / step).to.be.at.most(100);
    expect(step).to.be.greaterThan(300);
  });

  it("honours an explicit interval", () => {
    expect(resolveInterval("1m", DAY, 2000)).to.equal(60);
    expect(resolveInterval("4h", 30 * DAY, 2000)).to.equal(14400);
  });

  it("clamps limit to a sane integer", () => {
    expect(clampLimit(null)).to.equal(300);
    expect(clampLimit("50")).to.equal(50);
    expect(clampLimit("999999")).to.equal(2000);
    expect(clampLimit("0")).to.equal(300);
    expect(clampLimit("-5")).to.equal(300);
    expect(clampLimit("abc")).to.equal(300);
    expect(clampLimit("12.9")).to.equal(12);
  });

  /**
   * The interval name is interpolated nowhere, but it DOES select a bound
   * parameter, so an unrecognised value must resolve to a known step rather
   * than to `undefined` — which would reach Postgres as a null divisor and
   * abort the query.
   */
  it("validates the interval name against the allowlist", () => {
    expect(parseIntervalName(null)).to.equal("auto");
    expect(parseIntervalName("5m")).to.equal("5m");
    expect(parseIntervalName("1d")).to.equal("1d");
    expect(parseIntervalName("AUTO")).to.equal("auto");
    expect(parseIntervalName("2h")).to.equal("auto");
    expect(parseIntervalName("constructor")).to.equal("auto");
    expect(parseIntervalName("__proto__")).to.equal("auto");
    expect(parseIntervalName("")).to.equal("auto");
    for (const name of Object.keys(INTERVAL_SECONDS)) {
      expect(parseIntervalName(name)).to.equal(name);
      expect(INTERVAL_SECONDS[name as keyof typeof INTERVAL_SECONDS]).to.be.greaterThan(0);
    }
  });

  /**
   * An explicit interval is NOT widened, so it can ask for more buckets than
   * `limit`. That is safe only because `selectChartRows` keeps the NEWEST
   * buckets when its LIMIT binds — see the query's comment. What must never
   * happen is a step of `undefined` or 0.
   */
  it("always yields a positive integer step", () => {
    const names: Array<Parameters<typeof resolveInterval>[0]> = [
      "auto",
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "4h",
      "1d",
    ];
    for (const name of names) {
      for (const span of [-1, DAY, Number.NaN]) {
        for (const limit of [1, Number.NaN]) {
          const step = resolveInterval(name, span, limit);
          const where = `${name}/${span}/${limit}`;
          expect(Number.isSafeInteger(step), where).to.equal(true);
          expect(step > 0, where).to.equal(true);
        }
      }
    }
  });
});
