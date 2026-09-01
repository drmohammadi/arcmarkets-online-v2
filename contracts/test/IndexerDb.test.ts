import { expect } from "chai";
import type { PoolClient } from "pg";
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
/** A second synthetic chain, so the anchor tests cannot disturb the rest. */
const CHAIN_ALT = -5042003;
const FACTORY = "0x1111111111111111111111111111111111111111";
const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const POOL_E = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
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

/** A `MarketCreated` row with only the fields a test varies. */
function market(questionId: bigint, fpmm: string, blockNumber: bigint): MarketCreatedRow {
  return {
    questionId,
    fpmm,
    conditionId: hash32(Number(questionId)),
    question: "q",
    category: "c",
    resolutionTime: BigInt(1_800_000_000),
    resolver: TRADER,
    feeBps: 100,
    blockNumber,
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

/**
 * NO DATABASE. This is where the carried acceptance criterion is pinned
 * UNCONDITIONALLY.
 *
 * The round-trip test below proves the column and the driver behave, but it only
 * runs when someone has exported `DATABASE_URL` — nothing loads
 * `frontend/.env.local` for the test suite — so on its own it would let a
 * regression to `execYesBps || null` ship green through a normal `npm test`.
 * This test drives the real `insertMarketEvents` through a fake client and
 * asserts the BOUND PARAMETER ARRAY it builds, so the invariant is checked on
 * every run, everywhere, with no database at all.
 *
 * It also asserts the shape of the statement itself: 17 placeholders per row in
 * `$n` form, ON CONFLICT DO NOTHING at the end, and every amount and block
 * number carried as a decimal STRING rather than a `number`.
 */
describe("market_events insert parameters (no database)", () => {
  /** The column order of the INSERT, so an index assertion reads as a name. */
  const COL = {
    chainId: 0,
    blockNumber: 1,
    logIndex: 2,
    txHash: 3,
    questionId: 4,
    fpmm: 5,
    kind: 6,
    actor: 7,
    outcome: 8,
    collateral: 9,
    shares: 10,
    reserveYes: 11,
    reserveNo: 12,
    totalSupply: 13,
    yesBps: 14,
    execYesBps: 15,
    blockTime: 16,
  };
  const WIDTH = 17;

  interface Captured {
    text: string;
    params: unknown[];
  }

  /** A PoolClient that records instead of connecting. */
  function recordingClient(into: Captured[]): PoolClient {
    return {
      query: async (text: string, params?: unknown[]) => {
        into.push({ text, params: params ?? [] });
        return { rowCount: (params?.length ?? 0) / WIDTH };
      },
    } as unknown as PoolClient;
  }

  it("binds exec_yes_bps 0 as the number 0, and null as null", async () => {
    const captured: Captured[] = [];
    const inserted = await insertMarketEvents(recordingClient(captured), CHAIN, [
      event({ blockNumber: BigInt(1001), logIndex: 0, outcome: 1, execYesBps: 0 }),
      event({
        blockNumber: BigInt(1001),
        logIndex: 1,
        kind: "liquidity_added",
        outcome: null,
        execYesBps: null,
      }),
    ]);
    expect(captured.length).to.equal(1);
    const params = captured[0].params;
    expect(params.length).to.equal(2 * WIDTH);
    expect(inserted).to.equal(2);

    // THE invariant: a real execution price of 0 must survive as 0. Under
    // `execYesBps || null` this slot would be null and nothing else would fail.
    const zero = params[COL.execYesBps];
    expect(zero).to.equal(0);
    expect(zero).to.not.equal(null);
    expect(typeof zero).to.equal("number");
    // A genuine absence still binds null.
    expect(params[WIDTH + COL.execYesBps]).to.equal(null);
    // The neighbouring nullable column behaves the same way: outcome 0 is YES.
    expect(params[COL.outcome]).to.equal(1);
    expect(params[WIDTH + COL.outcome]).to.equal(null);
  });

  it("carries every amount and block number as a string, never a number", async () => {
    const captured: Captured[] = [];
    const huge = BigInt(2) ** BigInt(200);
    await insertMarketEvents(recordingClient(captured), CHAIN, [
      event({
        blockNumber: BigInt(57_301_912),
        logIndex: 3,
        questionId: BigInt(9),
        collateral: huge,
        shares: huge - BigInt(1),
        reserveYes: huge,
        reserveNo: huge,
        totalSupply: huge,
      }),
    ]);
    const params = captured[0].params;
    for (const key of [
      "blockNumber",
      "questionId",
      "collateral",
      "shares",
      "reserveYes",
      "reserveNo",
      "totalSupply",
    ] as const) {
      expect(typeof params[COL[key]], key).to.equal("string");
    }
    expect(params[COL.collateral]).to.equal(huge.toString());
    expect(params[COL.blockNumber]).to.equal("57301912");
    // Small integers that DO fit a number stay numbers: they are counts and
    // indexes, not amounts.
    expect(typeof params[COL.logIndex]).to.equal("number");
    expect(typeof params[COL.yesBps]).to.equal("number");
    expect(params[COL.blockTime]).to.be.instanceOf(Date);
  });

  it("emits one parameterized tuple per row and ends with DO NOTHING", async () => {
    const captured: Captured[] = [];
    const rows = [0, 1, 2].map((i) => event({ blockNumber: BigInt(1001), logIndex: i }));
    await insertMarketEvents(recordingClient(captured), CHAIN, rows);
    const { text, params } = captured[0];
    expect(params.length).to.equal(3 * WIDTH);
    // Every value is a placeholder: $1..$51, in order, and nothing else.
    const placeholders = text.match(/\$\d+/g) ?? [];
    expect(placeholders.length).to.equal(3 * WIDTH);
    expect(placeholders).to.deep.equal(
      Array.from({ length: 3 * WIDTH }, (_unused, i) => `$${i + 1}`)
    );
    expect(text).to.contain(
      "ON CONFLICT (chain_id, block_number, log_index) DO NOTHING"
    );
    // No literal from a row leaked into the SQL.
    expect(text).to.not.contain(TRADER);
    expect(text).to.not.contain("buy");
  });

  it("splits at 500 rows, and never truncates the batch", async () => {
    // 500 x 17 = 8500 parameters, inside Postgres's 65535 limit; 501 rows must
    // be two statements, with every row present exactly once.
    const captured: Captured[] = [];
    const rows = Array.from({ length: 501 }, (_unused, i) =>
      event({ blockNumber: BigInt(2000), logIndex: i })
    );
    const inserted = await insertMarketEvents(recordingClient(captured), CHAIN, rows);
    expect(captured.length).to.equal(2);
    expect(captured[0].params.length).to.equal(500 * WIDTH);
    expect(captured[1].params.length).to.equal(1 * WIDTH);
    expect(inserted).to.equal(501);
    const indexes = captured.flatMap((c) =>
      c.params.filter((_unused, i) => i % WIDTH === COL.logIndex)
    );
    expect(indexes.length).to.equal(501);
    expect(new Set(indexes).size).to.equal(501);
  });
});

/** Deletes ONLY this suite's synthetic chains. Qualified, per-table, by key. */
async function cleanup(): Promise<void> {
  const db = getPool();
  for (const chain of [CHAIN, CHAIN_ALT]) {
    await db.query("DELETE FROM market_events WHERE chain_id = $1", [chain]);
    await db.query("DELETE FROM blocks WHERE chain_id = $1", [chain]);
    await db.query("DELETE FROM markets WHERE chain_id = $1", [chain]);
    await db.query("DELETE FROM indexer_state WHERE chain_id = $1", [chain]);
  }
}

suite("indexer database round-trip (needs DATABASE_URL)", () => {
  before(async () => {
    await cleanup();
    await ensureIndexerState(CHAIN, FACTORY, START_BLOCK);
  });

  after(async () => {
    // Guarded: a cleanup failure must not skip the close, or an open pool keeps
    // the event loop alive and mocha never exits. Both failures are reported —
    // the finally block cannot swallow the first one.
    try {
      await cleanup();
    } finally {
      await closePool();
    }
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
    // Self-contained: its own question id and block, inserted twice here rather
    // than relying on the test above having run.
    const rows = [
      event({ blockNumber: BigInt(1010), logIndex: 0, questionId: BigInt(13) }),
      event({ blockNumber: BigInt(1010), logIndex: 1, questionId: BigInt(13) }),
    ];
    expect(await withTx((c) => insertMarketEvents(c, CHAIN, rows))).to.equal(2);
    // No lease is taken anywhere in this test: idempotency must stand alone.
    expect(await withTx((c) => insertMarketEvents(c, CHAIN, rows))).to.equal(0);
    const res = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM market_events WHERE chain_id = $1 AND question_id = $2",
      [CHAIN, "13"]
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

  /** Rebuild CHAIN_ALT's state row from scratch, so each anchor test stands alone. */
  async function bootstrapAlt(start: bigint): Promise<void> {
    await getPool().query("DELETE FROM indexer_state WHERE chain_id = $1", [CHAIN_ALT]);
    await ensureIndexerState(CHAIN_ALT, FACTORY, start);
  }

  it("lowers a corrected anchor and rewinds an untouched checkpoint", async () => {
    // The case CLAUDE.md is scarred by: an operator discovers the anchor is
    // wrong and fixes the deployments entry. Ignoring that would leave the
    // floor above the real deploy block, hiding trades silently.
    await bootstrapAlt(BigInt(5000));
    await ensureIndexerState(CHAIN_ALT, FACTORY, BigInt(4000));
    const state = await readIndexerState(CHAIN_ALT);
    expect(state!.startBlock).to.equal(BigInt(4000));
    expect(state!.lastIndexedBlock).to.equal(BigInt(3999));
  });

  it("lowers the anchor but keeps a checkpoint that has already advanced", async () => {
    await bootstrapAlt(BigInt(5000));
    await withTx((c) => commitCheckpoint(c, CHAIN_ALT, BigInt(5500), hash32(5500), null, false));
    await ensureIndexerState(CHAIN_ALT, FACTORY, BigInt(4000));
    const state = await readIndexerState(CHAIN_ALT);
    expect(state!.startBlock).to.equal(BigInt(4000));
    // Dragging the checkpoint below indexed blocks would make the run loop fold
    // re-discovered early events onto a LATER replay tail — wrong reserves.
    expect(state!.lastIndexedBlock).to.equal(BigInt(5500));
  });

  it("refuses to raise the anchor, leaving the stored floor alone", async () => {
    await bootstrapAlt(BigInt(5000));
    await ensureIndexerState(CHAIN_ALT, FACTORY, BigInt(9000));
    const state = await readIndexerState(CHAIN_ALT);
    expect(state!.startBlock).to.equal(BigInt(5000));
    expect(state!.lastIndexedBlock).to.equal(BigInt(4999));
  });

  it("distinguishes a contended lease from a missing state row", async () => {
    await getPool().query("DELETE FROM indexer_state WHERE chain_id = $1", [CHAIN_ALT]);
    let message = "";
    try {
      await acquireLease(CHAIN_ALT, "owner-a", 60);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // A bare null here would make an un-bootstrapped chain look permanently busy.
    expect(message).to.contain("no indexer_state row");
    await bootstrapAlt(BigInt(5000));
    expect(await acquireLease(CHAIN_ALT, "owner-a", 60)).to.not.equal(null);
    expect(await acquireLease(CHAIN_ALT, "owner-b", 60)).to.equal(null);
    await releaseLease(CHAIN_ALT, "owner-a");
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
    // Seeds everything it asserts on — its own blocks (3000-3002), its own two
    // markets and its own pools — so it does not depend on any other test having
    // run, and its assertions are scoped to those keys.
    const CUT = BigInt(3000);
    await withTx(async (c) => {
      await upsertBlocks(c, CHAIN, [
        { blockNumber: BigInt(3000), blockHash: hash32(3000), blockTime: at(3000) },
        { blockNumber: BigInt(3001), blockHash: hash32(3001), blockTime: at(3001) },
        { blockNumber: BigInt(3002), blockHash: hash32(3002), blockTime: at(3002) },
      ]);
      await upsertMarkets(
        c,
        CHAIN,
        [
          market(BigInt(14), POOL_C, BigInt(3000)),
          market(BigInt(15), POOL_E, BigInt(3002)),
        ],
        new Map([
          ["3000", at(3000)],
          ["3002", at(3002)],
        ])
      );
      await markResolved(c, CHAIN, [
        {
          questionId: BigInt(14),
          payoutYes: BigInt(1),
          payoutNo: BigInt(0),
          blockNumber: BigInt(3002),
        },
      ]);
      await insertMarketEvents(c, CHAIN, [
        event({
          blockNumber: BigInt(3000),
          logIndex: 0,
          questionId: BigInt(14),
          fpmm: POOL_C,
          reserveYes: BigInt(31),
          reserveNo: BigInt(32),
          totalSupply: BigInt(33),
        }),
        event({ blockNumber: BigInt(3001), logIndex: 0, questionId: BigInt(14), fpmm: POOL_C }),
        event({ blockNumber: BigInt(3002), logIndex: 7, questionId: BigInt(14), fpmm: POOL_C }),
      ]);
    });

    await withTx((c) => truncateAbove(c, CHAIN, CUT));

    const events = await getPool().query<{ block_number: string }>(
      `SELECT block_number FROM market_events
        WHERE chain_id = $1 AND question_id = $2 ORDER BY block_number`,
      [CHAIN, "14"]
    );
    expect(events.rows.map((r) => r.block_number)).to.deep.equal(["3000"]);

    const blocks = await getPool().query<{ block_number: string }>(
      `SELECT block_number FROM blocks
        WHERE chain_id = $1 AND block_number >= $2 ORDER BY block_number`,
      [CHAIN, CUT.toString()]
    );
    expect(blocks.rows.map((r) => r.block_number)).to.deep.equal(["3000"]);

    // Created above the cut: gone, to be re-inserted when re-indexed.
    const byFpmm = await questionIdByFpmm(CHAIN);
    expect(byFpmm.get(POOL_C)).to.equal(BigInt(14));
    expect(byFpmm.has(POOL_E)).to.equal(false);

    // Resolved above the cut: un-resolved. Market rows are keyed by question
    // id, not by block, so nothing else would ever undo this.
    const row = await getPool().query<{
      resolved: boolean;
      resolved_block: string | null;
      payout_yes: string | null;
    }>(
      `SELECT resolved, resolved_block, payout_yes FROM markets
        WHERE chain_id = $1 AND question_id = $2`,
      [CHAIN, "14"]
    );
    expect(row.rows[0].resolved).to.equal(false);
    expect(row.rows[0].resolved_block).to.equal(null);
    expect(row.rows[0].payout_yes).to.equal(null);

    // And the replay resumes from the surviving row below the cut.
    expect(await latestReplayState(CHAIN, BigInt(14))).to.deep.equal({
      reserveYes: BigInt(31),
      reserveNo: BigInt(32),
      totalSupply: BigInt(33),
    });
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

