import { expect } from "chai";
import { closePool, getPool, withTx } from "../../frontend/lib/db/pool";
import {
  insertMarketEvents,
  selectChartRows,
  type MarketEventInsert,
} from "../../frontend/lib/db/queries";

/**
 * WHY THIS FILE EXISTS. `selectChartRows` is the one statement in `queries.ts`
 * that a unit test cannot check: its whole behaviour is `DISTINCT ON` +
 * bucketing arithmetic + an ordering that decides WHICH row survives, and every
 * way of getting it wrong returns plausible rows rather than an error.
 *
 * The three failures it hunts, all silent:
 *  - **averaging, or picking the FIRST row per bucket.** An average of a
 *    probability path is not a price; the first row is the one the trader least
 *    cares about. Only a bucket holding several events with different prices can
 *    tell the difference.
 *  - **ordering within a bucket by `block_time`.** Events in one block share a
 *    timestamp, so `block_time` cannot order them and the seeded rows below
 *    deliberately disagree with it: a later `block_time` sits on a LOWER
 *    `block_number`, so a time-ordered query picks a different price.
 *  - **keeping the OLDEST buckets when the LIMIT binds.** Empty buckets produce
 *    no rows, so the row count is the number of POPULATED buckets, which the
 *    bucket policy cannot bound. Ascending, a 400-day market asked for at `1d`
 *    with `limit=200` returns days 1-200 and looks like it stopped six months
 *    ago.
 *
 * DATABASE SAFETY, identical to `IndexerDb.test.ts`: one NEGATIVE chain id no
 * real chain can have, cleanup that deletes exactly those rows by that key, and
 * no DROP, TRUNCATE, ALTER or unqualified DELETE anywhere. With `DATABASE_URL`
 * unset the suite skips rather than failing.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn(
    "ChartQuery: skipping chart-query tests — DATABASE_URL is not set. " +
      "Set it to a database with db/migrations applied to run them."
  );
}

/** Negative, and distinct from every other suite's synthetic chain. */
const CHAIN = -5042004;
const POOL = "0xabababababababababababababababababababab";
const TRADER = "0xdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdc";
const QUESTION = BigInt(21);
const OTHER_QUESTION = BigInt(22);

/** Exactly divisible by 300, so a 5m bucket boundary is unambiguous. */
const T0 = 1_756_651_200;
const STEP = 300;

function hash32(seed: number): string {
  return "0x" + seed.toString(16).padStart(64, "0");
}

function event(
  over: Partial<MarketEventInsert> & { blockNumber: bigint; logIndex: number; atSec: number }
): MarketEventInsert {
  const { atSec, ...rest } = over;
  return {
    txHash: hash32(Number(over.blockNumber) * 100 + over.logIndex),
    questionId: QUESTION,
    fpmm: POOL,
    kind: "buy",
    actor: TRADER,
    outcome: 0,
    collateral: BigInt(1_000_000),
    shares: BigInt(2_000_000),
    reserveYes: BigInt(3_000_000),
    reserveNo: BigInt(4_000_000),
    totalSupply: BigInt(5_000_000),
    yesBps: 5000,
    execYesBps: 5000,
    blockTime: new Date(atSec * 1000),
    ...rest,
  };
}

async function cleanup(): Promise<void> {
  await getPool().query("DELETE FROM market_events WHERE chain_id = $1", [CHAIN]);
}

suite("chart query (needs DATABASE_URL)", () => {
  before(async () => {
    await cleanup();
    await withTx((c) =>
      insertMarketEvents(c, CHAIN, [
        // Bucket T0. The LAST row by (block_number, log_index) is 1001/6 at
        // 2500 bps — and 1000/0 carries a LATER block_time (T0+200) with an
        // EARLIER block number, so ordering by time picks 1111 instead.
        event({ blockNumber: BigInt(1000), logIndex: 0, atSec: T0 + 200, yesBps: 1111 }),
        event({ blockNumber: BigInt(1001), logIndex: 5, atSec: T0 + 100, yesBps: 2000 }),
        event({ blockNumber: BigInt(1001), logIndex: 6, atSec: T0 + 100, yesBps: 2500 }),
        // Bucket T0+300, one row.
        event({ blockNumber: BigInt(1002), logIndex: 0, atSec: T0 + 300, yesBps: 3000 }),
        // Bucket T0+600: T0+600 and T0+899 both floor to it; 1004/2 is last.
        event({ blockNumber: BigInt(1003), logIndex: 0, atSec: T0 + 600, yesBps: 4000 }),
        event({ blockNumber: BigInt(1004), logIndex: 2, atSec: T0 + 899, yesBps: 5000 }),
        // A different market in the same buckets: must never leak in.
        event({
          blockNumber: BigInt(1005),
          logIndex: 0,
          atSec: T0 + 120,
          yesBps: 9999,
          questionId: OTHER_QUESTION,
        }),
      ])
    );
  });

  after(async () => {
    // Guarded: a cleanup failure must not skip the close, or an open pool keeps
    // the event loop alive and mocha never exits.
    try {
      await cleanup();
    } finally {
      await closePool();
    }
  });

  it("buckets to the step floor and keeps the last price in each bucket", async () => {
    const rows = await selectChartRows({
      chainId: CHAIN,
      questionId: QUESTION,
      fromSec: 0,
      toSec: T0 + 10_000,
      stepSec: STEP,
      limit: 300,
    });
    expect(rows).to.deep.equal([
      { t: T0, bps: 2500 },
      { t: T0 + 300, bps: 3000 },
      { t: T0 + 600, bps: 5000 },
    ]);
  });

  it("keeps the NEWEST buckets when the limit binds", async () => {
    const rows = await selectChartRows({
      chainId: CHAIN,
      questionId: QUESTION,
      fromSec: 0,
      toSec: T0 + 10_000,
      stepSec: STEP,
      limit: 2,
    });
    // Ascending output, and the oldest bucket is the one dropped.
    expect(rows).to.deep.equal([
      { t: T0 + 300, bps: 3000 },
      { t: T0 + 600, bps: 5000 },
    ]);
  });

  it("treats the window as inclusive at both ends", async () => {
    const rows = await selectChartRows({
      chainId: CHAIN,
      questionId: QUESTION,
      fromSec: T0 + 300,
      toSec: T0 + 600,
      stepSec: STEP,
      limit: 300,
    });
    expect(rows).to.deep.equal([
      { t: T0 + 300, bps: 3000 },
      // T0+899 is outside the window, so this bucket's value is the T0+600 row.
      { t: T0 + 600, bps: 4000 },
    ]);
  });

  it("widens with the step and never mixes markets or chains", async () => {
    const hourly = await selectChartRows({
      chainId: CHAIN,
      questionId: QUESTION,
      fromSec: 0,
      toSec: T0 + 10_000,
      stepSec: 3600,
      limit: 300,
    });
    expect(hourly.length).to.equal(1);
    expect(hourly[0].bps).to.equal(5000);
    expect(hourly[0].t % 3600).to.equal(0);

    const other = await selectChartRows({
      chainId: CHAIN,
      questionId: OTHER_QUESTION,
      fromSec: 0,
      toSec: T0 + 10_000,
      stepSec: STEP,
      limit: 300,
    });
    expect(other).to.deep.equal([{ t: T0, bps: 9999 }]);

    // A chain with no rows is an empty chart, not an error.
    expect(
      await selectChartRows({
        chainId: CHAIN - 1,
        questionId: QUESTION,
        fromSec: 0,
        toSec: T0 + 10_000,
        stepSec: STEP,
        limit: 300,
      })
    ).to.deep.equal([]);
  });
});
