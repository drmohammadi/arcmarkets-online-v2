import { expect } from "chai";
import { closePool, getPool, sslConfigFor, withTx } from "../../frontend/lib/db/pool";
import {
  acquireLease,
  commitCheckpoint,
  ensureIndexerState,
  getBlockHash,
  insertMarketEvents,
  latestReplayState,
  markResolved,
  questionIdByFpmm,
  readIndexerState,
  recordError,
  releaseLease,
  truncateAbove,
  upsertBlocks,
  upsertMarkets,
  type MarketEventInsert,
} from "../../frontend/lib/db/queries";
import type { MarketCreatedRow, MarketResolvedRow } from "../../frontend/lib/indexer/decode";

/**
 * WHY THIS FILE EXISTS. Every defect this suite hunts is SILENT.
 *
 * The one it exists for above all: `exec_yes_bps` may legitimately be **0** (an
 * `outcome === 1` trade filled at 10000 bps on the NO side is 0 on the YES
 * side, and that is reachable on-chain). Zero is falsy, so a single
 * `execYesBps || null` anywhere on the write path converts a real execution
 * price into "no execution price" — no error, no warning, just a hole in the
 * chart that looks like missing data. Only a persistence ROUND TRIP can prove
 * it: 0 must come back as 0, and a genuine null must still come back as NULL.
 *
 * The rest of the suite covers the other failure modes that raise nothing:
 * a lease that fails open (two indexers writing at once), a `numeric(78,0)`
 * silently narrowed through a JS `number`, `latestReplayState` ordering by the
 * wrong columns (which would resume a replay from the wrong reserves), and a
 * reorg truncation that forgets to un-resolve a market.
 *
 * DATABASE SAFETY. These tests run against whatever `DATABASE_URL` points at,
 * which in this project is the ONE real Neon database — there is no scratch
 * copy. So:
 *  - every row written uses a NEGATIVE chain id, which no real chain has and
 *    the indexer will never produce, so nothing can collide with indexed data;
 *  - cleanup deletes exactly those rows, by that key;
 *  - there is no DROP, no TRUNCATE, no ALTER and no unqualified DELETE
 *    anywhere in this file.
 * With `DATABASE_URL` unset the suite skips instead of failing: it needs a
 * migrated database, and not every checkout has one.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB
  ? describe
  : describe.skip;

if (!HAS_DB) {
  console.warn(
    "IndexerDb: skipping database round-trip tests — DATABASE_URL is not set. " +
      "Set it to a database with db/migrations applied to run them."
  );
}

/** Negative, so it cannot collide with chain 5042002, 31337 or any other. */
const CHAIN = -5042002;
const FACTORY = "0x1111111111111111111111111111111111111111";
const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRADER = "0xdddddddddddddddddddddddddddddddddddddddd";
const START_BLOCK = BigInt(1000);

/** Distinct 32-byte hashes, generated rather than pasted. */
function hash32(seed: number): string {
  return "0x" + seed.toString(16).padStart(64, "0");
}

function at(seconds: number): Date {
  return new Date(1_756_651_200_000 + seconds * 1000);
}

/**
 * A complete event row. Amounts are deliberately ABOVE 2^53 in some tests, so a
 * `number` anywhere on the path would lose digits and fail the comparison.
 */
function event(over: Partial<MarketEventInsert> & { blockNumber: bigint; logIndex: number }): MarketEventInsert {
  return {
    txHash: hash32(Number(over.blockNumber) * 100 + over.logIndex),
    questionId: BigInt(7),
    fpmm: POOL_A,
    kind: "buy",
    actor: TRADER,
    outcome: 0,
    collateral: BigInt(1_000_000),
    shares: BigInt(2_000_000),
    reserveYes: BigInt(3_000_000),
    reserveNo: BigInt(4_000_000),
    totalSupply: BigInt(5_000_000),
    yesBps: 5714,
    execYesBps: 5000,
    blockTime: at(Number(over.logIndex)),
    ...over,
  };
}

/**
 * No database needed: the SSL decision is pure. It is tested because getting it
 * wrong is invisible — an `ssl` object passed alongside a URL carrying
 * `sslmode=require&channel_binding=require` silently REPLACES those settings.
 */
describe("db pool ssl policy", () => {
  it("passes no ssl option when the URL declares sslmode", () => {
    expect(
      sslConfigFor("postgresql://u:p@h.neon.tech/db?sslmode=require&channel_binding=require")
    ).to.equal(undefined);
    expect(sslConfigFor("postgresql://u:p@h/db?sslmode=disable")).to.equal(undefined);
    expect(sslConfigFor("postgresql://u:p@h/db?SSLMODE=require")).to.equal(undefined);
    expect(sslConfigFor("postgresql://u:p@h/db?ssl=true")).to.equal(undefined);
  });

  it("defaults to verified TLS when the URL says nothing about SSL", () => {
    // pg's own default for a bare URL is NO TLS, which would send credentials
    // to a managed provider in plaintext.
    expect(sslConfigFor("postgresql://u:p@h.neon.tech/db")).to.deep.equal({
      rejectUnauthorized: true,
    });
    expect(sslConfigFor("postgresql://u:p@h/db?application_name=arc")).to.deep.equal({
      rejectUnauthorized: true,
    });
    // A password that merely contains the word is not a setting.
    expect(sslConfigFor("postgresql://u:sslmode@h/db")).to.deep.equal({
      rejectUnauthorized: true,
    });
  });
});

/** Deletes ONLY this suite's synthetic chain. Qualified, per-table, by key. */
async function cleanup(): Promise<void> {
  const db = getPool();
  await db.query("DELETE FROM market_events WHERE chain_id = $1", [CHAIN]);
  await db.query("DELETE FROM blocks WHERE chain_id = $1", [CHAIN]);
  await db.query("DELETE FROM markets WHERE chain_id = $1", [CHAIN]);
  await db.query("DELETE FROM indexer_state WHERE chain_id = $1", [CHAIN]);
}

suite("indexer database round-trip (needs DATABASE_URL)", () => {
  before(async () => {
    await cleanup();
    await ensureIndexerState(CHAIN, FACTORY, START_BLOCK);
  });

  after(async () => {
    await cleanup();
    await closePool();
  });

  it("round-trips exec_yes_bps 0 as 0, and null as NULL", async () => {
    // Row 0 is the case that matters: a NO-side trade filled at 10000 bps,
    // i.e. execYesBps === 0. Row 1 is a liquidity event, which has no
    // execution price at all.
    const inserted = await withTx((c) =>
      insertMarketEvents(c, CHAIN, [
        event({ blockNumber: BigInt(1001), logIndex: 0, outcome: 1, execYesBps: 0 }),
        event({
          blockNumber: BigInt(1001),
          logIndex: 1,
          kind: "liquidity_added",
          outcome: null,
          execYesBps: null,
        }),
      ])
    );
    expect(inserted).to.equal(2);

    const res = await getPool().query<{ log_index: number; exec_yes_bps: number | null }>(
      `SELECT log_index, exec_yes_bps FROM market_events
        WHERE chain_id = $1 AND block_number = $2 ORDER BY log_index`,
      [CHAIN, "1001"]
    );
    expect(res.rows.length).to.equal(2);
    expect(res.rows[0].exec_yes_bps).to.equal(0);
    expect(res.rows[0].exec_yes_bps).to.not.equal(null);
    expect(typeof res.rows[0].exec_yes_bps).to.equal("number");
    expect(res.rows[1].exec_yes_bps).to.equal(null);
  });

  it("inserts each log exactly once, without help from the lease", async () => {
    // Same two rows again, no lease involved anywhere.
    const again = await withTx((c) =>
      insertMarketEvents(c, CHAIN, [
        event({ blockNumber: BigInt(1001), logIndex: 0, outcome: 1, execYesBps: 0 }),
        event({
          blockNumber: BigInt(1001),
          logIndex: 1,
          kind: "liquidity_added",
          outcome: null,
          execYesBps: null,
        }),
      ])
    );
    expect(again).to.equal(0);
    const res = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM market_events WHERE chain_id = $1",
      [CHAIN]
    );
    expect(res.rows[0].n).to.equal("2");
  });

  it("carries a uint256 through numeric(78,0) without losing a digit", async () => {
    // 2^200 is far beyond Number.MAX_SAFE_INTEGER: a `number` anywhere on the
    // path — write, read, or the pg type parser — loses digits here.
    const huge = BigInt(2) ** BigInt(200);
    await withTx((c) =>
      insertMarketEvents(c, CHAIN, [
        event({
          blockNumber: BigInt(1002),
          logIndex: 0,
          questionId: BigInt(8),
          reserveYes: huge,
          reserveNo: huge + BigInt(1),
          totalSupply: huge - BigInt(1),
          collateral: huge,
          shares: huge,
          yesBps: 5000,
          execYesBps: 10000,
        }),
      ])
    );
    const state = await latestReplayState(CHAIN, BigInt(8));
    expect(state).to.not.equal(null);
    expect(state!.reserveYes).to.equal(huge);
    expect(state!.reserveNo).to.equal(huge + BigInt(1));
    expect(state!.totalSupply).to.equal(huge - BigInt(1));
  });

  it("reads the replay tail by (block_number, log_index), not by time", async () => {
    // Deliberately out of order, and with a LATER block carrying a SMALLER
    // log_index and an EARLIER block_time than the row before it: ordering by
    // block_time, or by log_index alone, picks the wrong tail and every
    // resumed replay then starts from the wrong reserves.
    await withTx((c) =>
      insertMarketEvents(c, CHAIN, [
        event({
          blockNumber: BigInt(1003),
          logIndex: 9,
          questionId: BigInt(8),
          reserveYes: BigInt(11),
          reserveNo: BigInt(12),
          totalSupply: BigInt(13),
          blockTime: at(900),
        }),
        event({
          blockNumber: BigInt(1004),
          logIndex: 0,
          questionId: BigInt(8),
          reserveYes: BigInt(21),
          reserveNo: BigInt(22),
          totalSupply: BigInt(23),
          blockTime: at(100),
        }),
      ])
    );
    const state = await latestReplayState(CHAIN, BigInt(8));
    expect(state).to.deep.equal({
      reserveYes: BigInt(21),
      reserveNo: BigInt(22),
      totalSupply: BigInt(23),
    });
    expect(await latestReplayState(CHAIN, BigInt(999))).to.equal(null);
  });

  it("grants the lease to one owner at a time and releases only to its holder", async () => {
    const first = await acquireLease(CHAIN, "owner-a", 60);
    expect(first).to.not.equal(null);
    expect(first!.startBlock).to.equal(START_BLOCK);
    expect(first!.lastIndexedBlock).to.equal(START_BLOCK - BigInt(1));
    expect(first!.leaseOwner).to.equal("owner-a");

    // The second run must do nothing at all.
    expect(await acquireLease(CHAIN, "owner-b", 60)).to.equal(null);

    // A non-holder cannot free it for itself.
    await releaseLease(CHAIN, "owner-b");
    expect(await acquireLease(CHAIN, "owner-b", 60)).to.equal(null);

    await releaseLease(CHAIN, "owner-a");
    const third = await acquireLease(CHAIN, "owner-b", 60);
    expect(third).to.not.equal(null);
    await releaseLease(CHAIN, "owner-b");
  });

  it("takes over a lease that has expired by itself", async () => {
    // The reason this is a lease row and not an advisory lock: a serverless
    // function killed mid-run releases nothing, so expiry must be automatic.
    await getPool().query(
      `UPDATE indexer_state SET lease_until = now() - interval '1 second', lease_owner = $2
        WHERE chain_id = $1`,
      [CHAIN, "dead-run"]
    );
    const taken = await acquireLease(CHAIN, "owner-c", 60);
    expect(taken).to.not.equal(null);
    expect(taken!.leaseOwner).to.equal("owner-c");
    await releaseLease(CHAIN, "owner-c");
  });

  it("refuses to reuse a state row built for a different factory", async () => {
    let message = "";
    try {
      await ensureIndexerState(CHAIN, "0x2222222222222222222222222222222222222222", START_BLOCK);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).to.contain("not 0x2222");
    // The original row is untouched.
    const state = await readIndexerState(CHAIN);
    expect(state!.startBlock).to.equal(START_BLOCK);
  });

  it("advances the checkpoint and never forgets a learned chunk ceiling", async () => {
    await withTx((c) =>
      commitCheckpoint(c, CHAIN, BigInt(1500), hash32(1500), BigInt(250_000), false)
    );
    let state = await readIndexerState(CHAIN);
    expect(state!.lastIndexedBlock).to.equal(BigInt(1500));
    expect(state!.lastIndexedBlockHash).to.equal(hash32(1500));
    expect(state!.acceptedChunk).to.equal(BigInt(250_000));
    expect(state!.backfillComplete).to.equal(false);
    expect(state!.lastError).to.equal(null);
    expect(state!.lastTickAt).to.not.equal(null);

    // A later run that learned nothing new must NOT wipe the ceiling: storing
    // that null would throw away a limit we spent requests discovering.
    await withTx((c) => commitCheckpoint(c, CHAIN, BigInt(1600), hash32(1600), null, true));
    state = await readIndexerState(CHAIN);
    expect(state!.lastIndexedBlock).to.equal(BigInt(1600));
    expect(state!.acceptedChunk).to.equal(BigInt(250_000));
    expect(state!.backfillComplete).to.equal(true);
  });

  it("records an error, and a successful commit clears it", async () => {
    await recordError(CHAIN, "boom");
    expect((await readIndexerState(CHAIN))!.lastError).to.equal("boom");
    await withTx((c) => commitCheckpoint(c, CHAIN, BigInt(1600), hash32(1600), null, true));
    expect((await readIndexerState(CHAIN))!.lastError).to.equal(null);
    // recordError(null) is also the "ticked with nothing to do" path.
    await recordError(CHAIN, null);
    expect((await readIndexerState(CHAIN))!.lastError).to.equal(null);
  });

  it("stores block headers once per block and refreshes a stale hash", async () => {
    await withTx((c) =>
      upsertBlocks(c, CHAIN, [
        { blockNumber: BigInt(1001), blockHash: hash32(1), blockTime: at(1) },
        { blockNumber: BigInt(1002), blockHash: hash32(2), blockTime: at(2) },
      ])
    );
    expect(await getBlockHash(CHAIN, BigInt(1001))).to.equal(hash32(1));
    expect(await getBlockHash(CHAIN, BigInt(4242))).to.equal(null);

    // A re-fetched header is fresher than the stored one, so it wins — a stale
    // hash would poison the reorg comparison it exists to serve.
    await withTx((c) =>
      upsertBlocks(c, CHAIN, [
        { blockNumber: BigInt(1001), blockHash: hash32(99), blockTime: at(9) },
      ])
    );
    expect(await getBlockHash(CHAIN, BigInt(1001))).to.equal(hash32(99));
  });

  it("upserts markets, resolves them, and maps pool addresses back to markets", async () => {
    const created: MarketCreatedRow[] = [
      {
        questionId: BigInt(9),
        fpmm: POOL_A,
        conditionId: hash32(9),
        question: "Will it rain?",
        category: "Weather",
        resolutionTime: BigInt(1_800_000_000),
        resolver: TRADER,
        feeBps: 200,
        blockNumber: BigInt(1000),
      },
      {
        questionId: BigInt(10),
        fpmm: POOL_B,
        conditionId: hash32(10),
        question: "Event: Outcome",
        category: "Other",
        // Absurd on purpose: a uint256 no timestamptz can hold must be clamped,
        // not allowed to abort the whole range transaction forever.
        resolutionTime: BigInt(2) ** BigInt(80),
        resolver: TRADER,
        feeBps: 0,
        blockNumber: BigInt(1003),
      },
    ];
    const times = new Map<string, Date>([
      ["1000", at(0)],
      ["1003", at(300)],
    ]);
    await withTx((c) => upsertMarkets(c, CHAIN, created, times));
    // Re-running the same range must not duplicate or fail.
    await withTx((c) => upsertMarkets(c, CHAIN, created, times));

    const byFpmm = await questionIdByFpmm(CHAIN);
    expect(byFpmm.size).to.equal(2);
    expect(byFpmm.get(POOL_A)).to.equal(BigInt(9));
    expect(byFpmm.get(POOL_B)).to.equal(BigInt(10));

    const resolved: MarketResolvedRow[] = [
      { questionId: BigInt(9), payoutYes: BigInt(1), payoutNo: BigInt(0), blockNumber: BigInt(1005) },
      // No such market: must update nothing rather than raise (there is no FK).
      { questionId: BigInt(4242), payoutYes: BigInt(1), payoutNo: BigInt(1), blockNumber: BigInt(1005) },
    ];
    await withTx((c) => markResolved(c, CHAIN, resolved));
    const row = await getPool().query<{
      resolved: boolean;
      resolved_block: string;
      payout_yes: string;
      payout_no: string;
    }>(
      `SELECT resolved, resolved_block, payout_yes, payout_no FROM markets
        WHERE chain_id = $1 AND question_id = $2`,
      [CHAIN, "9"]
    );
    expect(row.rows[0].resolved).to.equal(true);
    expect(BigInt(row.rows[0].resolved_block)).to.equal(BigInt(1005));
    expect(BigInt(row.rows[0].payout_yes)).to.equal(BigInt(1));
    expect(BigInt(row.rows[0].payout_no)).to.equal(BigInt(0));

    // Re-indexing the creation log must not un-resolve it.
    await withTx((c) => upsertMarkets(c, CHAIN, created, times));
    const after = await getPool().query<{ resolved: boolean }>(
      "SELECT resolved FROM markets WHERE chain_id = $1 AND question_id = $2",
      [CHAIN, "9"]
    );
    expect(after.rows[0].resolved).to.equal(true);
  });

  it("refuses to invent a creation timestamp", async () => {
    let message = "";
    try {
      await withTx((c) =>
        upsertMarkets(
          c,
          CHAIN,
          [
            {
              questionId: BigInt(11),
              fpmm: POOL_A,
              conditionId: hash32(11),
              question: "q",
              category: "c",
              resolutionTime: BigInt(1_800_000_000),
              resolver: TRADER,
              feeBps: 0,
              blockNumber: BigInt(1234),
            },
          ],
          new Map()
        )
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).to.contain("no block time for block 1234");
    const res = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM markets WHERE chain_id = $1 AND question_id = $2",
      [CHAIN, "11"]
    );
    expect(res.rows[0].n).to.equal("0");
  });

  it("truncates above a reorg cut, including a resolution that never happened", async () => {
    await withTx((c) => truncateAbove(c, CHAIN, BigInt(1002)));

    const events = await getPool().query<{ block_number: string }>(
      "SELECT block_number FROM market_events WHERE chain_id = $1 ORDER BY block_number",
      [CHAIN]
    );
    expect(events.rows.map((r) => r.block_number)).to.deep.equal(["1001", "1001", "1002"]);

    const blocks = await getPool().query<{ block_number: string }>(
      "SELECT block_number FROM blocks WHERE chain_id = $1 ORDER BY block_number",
      [CHAIN]
    );
    expect(blocks.rows.map((r) => r.block_number)).to.deep.equal(["1001", "1002"]);

    // Created above the cut: gone, to be re-inserted when re-indexed.
    const remaining = await questionIdByFpmm(CHAIN);
    expect(remaining.size).to.equal(1);
    expect(remaining.get(POOL_A)).to.equal(BigInt(9));

    // Resolved above the cut: un-resolved. Market rows are keyed by question
    // id, not by block, so nothing else would ever undo this.
    const row = await getPool().query<{
      resolved: boolean;
      resolved_block: string | null;
      payout_yes: string | null;
    }>(
      `SELECT resolved, resolved_block, payout_yes FROM markets
        WHERE chain_id = $1 AND question_id = $2`,
      [CHAIN, "9"]
    );
    expect(row.rows[0].resolved).to.equal(false);
    expect(row.rows[0].resolved_block).to.equal(null);
    expect(row.rows[0].payout_yes).to.equal(null);

    // And the replay can resume from the surviving row below the cut.
    const state = await latestReplayState(CHAIN, BigInt(8));
    expect(state!.reserveYes).to.equal(BigInt(2) ** BigInt(200));
  });

  it("writes a 500-row batch in one statement", async () => {
    // 500 rows x 17 columns = 8500 bound parameters, inside Postgres's 65535
    // limit. Proves the batching arithmetic against a real server rather than
    // against a comment.
    const rows: MarketEventInsert[] = [];
    for (let i = 0; i < 500; i += 1) {
      rows.push(event({ blockNumber: BigInt(2000), logIndex: i, questionId: BigInt(12) }));
    }
    const inserted = await withTx((c) => insertMarketEvents(c, CHAIN, rows));
    expect(inserted).to.equal(500);
    const res = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM market_events WHERE chain_id = $1 AND question_id = $2",
      [CHAIN, "12"]
    );
    expect(res.rows[0].n).to.equal("500");
  });
});

