import { expect } from "chai";
import { closePool, getPool } from "../../frontend/lib/db/pool";
import {
  acquireLease,
  ensureIndexerState,
  readIndexerState,
  releaseLease,
} from "../../frontend/lib/db/queries";
import { MIN_CHUNK } from "../../frontend/lib/indexer/chunking";
import type { IndexedEvent } from "../../frontend/lib/indexer/replay";
import {
  LEASE_SECONDS,
  MAX_REORG_WALKBACK,
  atOrBelow,
  blockTimeOf,
  clampRange,
  computeSafeHead,
  distinctBlockNumbers,
  foldAcceptedChunk,
  groupEventsByMarket,
  headerBudget,
  missingBlockNumbers,
  normalizeChainSettings,
  runIndexer,
  toCount,
} from "../../frontend/lib/indexer/run";

/**
 * WHY THIS FILE EXISTS. Every decision in `run.ts` that decides WHAT gets indexed
 * fails silently when it is wrong. A range clamped to nothing, a header fetched
 * once per event instead of once per block, events folded in the wrong order, a
 * learned chunk ceiling lowered instead of raised — none of them raise anything.
 * They just yield less data, or wrong reserves, which is the exact failure mode
 * CLAUDE.md documents twice. So the arithmetic is factored into pure functions and
 * pinned here.
 *
 * NO NETWORK, AND (mostly) NO DATABASE. The pure helpers need neither. Two tests
 * do exercise `runIndexer` itself: one proves it RETURNS rather than throws when
 * its dependencies fail — load-bearing, because `scheduleBackgroundIndex` hands
 * the promise to `waitUntil()`, where a rejection is invisible — and it needs no
 * database because settings resolution comes first. The database-backed pair is
 * gated on DATABASE_URL, writes only under a NEGATIVE synthetic chain id, deletes
 * exactly those rows by that key, and contains no DROP, TRUNCATE, ALTER or
 * unqualified DELETE. Arc testnet is never contacted; the one RPC URL used here
 * is in the reserved `.invalid` TLD, which cannot resolve by definition.
 *
 * Task 9 is the end-to-end proof against a live local chain. This file covers
 * what is reachable without one.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const dbSuite = HAS_DB ? describe : describe.skip;

/** Negative, so it cannot collide with 5042002, 31337 or any real chain. */
const SYNTH_CHAIN = -31337;
const SYNTH_FACTORY = "0x2222222222222222222222222222222222222222";
/** RFC 2606 reserves `.invalid`: it must never resolve, so nothing is contacted. */
const DEAD_RPC = "https://rpc.invalid/never-called";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const TRADER = "0xdddddddddddddddddddddddddddddddddddddddd";

/** One FPMM event, with only the fields these tests vary. */
function ev(fpmm: string, blockNumber: number, logIndex: number): IndexedEvent {
  return {
    blockNumber: BigInt(blockNumber),
    logIndex,
    txHash: "0x" + (blockNumber * 100 + logIndex).toString(16).padStart(64, "0"),
    fpmm,
    kind: "buy",
    actor: TRADER,
    outcome: 0,
    collateral: BigInt(1_000_000),
    shares: BigInt(1_800_000),
  };
}

const nums = (list: readonly bigint[]): string[] => list.map((n) => n.toString());

describe("indexer run: safe head", () => {
  it("holds back exactly `confirmations` blocks", () => {
    expect(computeSafeHead(BigInt(57_300_000), 12)).to.equal(BigInt(57_299_988));
    expect(computeSafeHead(BigInt(100), 0)).to.equal(BigInt(100));
  });

  it("reads a nonsense confirmations count as zero rather than trusting it", () => {
    expect(computeSafeHead(BigInt(100), -5)).to.equal(BigInt(100));
    expect(computeSafeHead(BigInt(100), Number.NaN)).to.equal(BigInt(100));
    expect(computeSafeHead(BigInt(100), Number.POSITIVE_INFINITY)).to.equal(BigInt(100));
    expect(computeSafeHead(BigInt(100), 2.9)).to.equal(BigInt(98));
  });

  it("goes negative on a chain younger than the window instead of clamping to 0", () => {
    // Clamping to 0 would index block 0 as though it were final on a 5-block
    // chain. The honest negative answer becomes "nothing to do" in clampRange.
    expect(computeSafeHead(BigInt(5), 12)).to.equal(BigInt(-7));
    expect(clampRange(BigInt(-1), computeSafeHead(BigInt(5), 12), BigInt(1000))).to.equal(null);
  });
});

describe("indexer run: range clamping", () => {
  it("starts one block above the cursor, so nothing is ever re-scanned", () => {
    expect(clampRange(BigInt(55_632_100), BigInt(57_300_000), BigInt(500_000))).to.deep.equal({
      from: BigInt(55_632_101),
      to: BigInt(56_132_100),
    });
  });

  it("begins at the anchor on a fresh chain, including start block 0", () => {
    // `last_indexed_block` initialises to `start_block - 1`, which is -1 for a
    // Hardhat chain, so the first range must begin at block 0 — not block 1.
    expect(clampRange(BigInt(-1), BigInt(9), BigInt(1000))).to.deep.equal({
      from: BigInt(0),
      to: BigInt(9),
    });
  });

  it("stops at the safe head when maxBlocks would overshoot it", () => {
    expect(clampRange(BigInt(100), BigInt(150), BigInt(4_000_000))).to.deep.equal({
      from: BigInt(101),
      to: BigInt(150),
    });
  });

  it("stops at maxBlocks when the safe head is further away", () => {
    // A cap is not a failure: this run commits what it reached and the next
    // continues from there.
    expect(clampRange(BigInt(0), BigInt(9_999_999), BigInt(10))).to.deep.equal({
      from: BigInt(1),
      to: BigInt(10),
    });
  });

  it("returns null when there is nothing to do", () => {
    expect(clampRange(BigInt(100), BigInt(100), BigInt(500))).to.equal(null);
    expect(clampRange(BigInt(100), BigInt(88), BigInt(500))).to.equal(null);
  });

  it("treats a non-positive maxBlocks as one block, not as zero progress", () => {
    // A zero step is an indexer that commits nothing forever while looking
    // perfectly healthy on an idle chain.
    expect(clampRange(BigInt(10), BigInt(999), BigInt(0))).to.deep.equal({
      from: BigInt(11),
      to: BigInt(11),
    });
    expect(clampRange(BigInt(10), BigInt(999), BigInt(-5))).to.deep.equal({
      from: BigInt(11),
      to: BigInt(11),
    });
  });
});

describe("indexer run: distinct block extraction", () => {
  it("dedupes across every source and sorts ascending", () => {
    // Ascending matters beyond tidiness: the header budget takes a PREFIX of this
    // list, and a prefix is only a contiguous slice of history when it is sorted.
    const out = distinctBlockNumbers([
      [{ blockNumber: BigInt(30) }, { blockNumber: BigInt(10) }],
      [{ blockNumber: BigInt(10) }, { blockNumber: BigInt(10) }, { blockNumber: BigInt(20) }],
      [],
    ]);
    expect(nums(out)).to.deep.equal(["10", "20", "30"]);
  });

  it("asks for ONE header per block however many events share it", () => {
    // This is the whole reason the chart can afford a time axis. Four events in
    // two blocks must cost two getBlock calls, not four.
    const events = [ev(POOL_A, 100, 0), ev(POOL_A, 100, 1), ev(POOL_B, 100, 2), ev(POOL_A, 101, 0)];
    expect(nums(distinctBlockNumbers([events]))).to.deep.equal(["100", "101"]);
  });

  it("is empty for empty input", () => {
    expect(distinctBlockNumbers([])).to.deep.equal([]);
    expect(distinctBlockNumbers([[], []])).to.deep.equal([]);
  });

  it("skips blocks whose header is already cached", () => {
    const distinct = [BigInt(10), BigInt(20), BigInt(30)];
    expect(nums(missingBlockNumbers(distinct, new Set(["20"])))).to.deep.equal(["10", "30"]);
    expect(missingBlockNumbers(distinct, new Set(["10", "20", "30"]))).to.deep.equal([]);
    expect(nums(missingBlockNumbers(distinct, new Set<string>()))).to.deep.equal(["10", "20", "30"]);
  });
});

describe("indexer run: grouping and ordering by market", () => {
  const byPool = new Map<string, bigint>([
    [POOL_A, BigInt(7)],
    [POOL_B, BigInt(3)],
  ]);

  it("splits events by market and orders each group by (blockNumber, logIndex)", () => {
    // Order IS correctness: replay folds pre-event state into post-event state, so
    // one transposed pair silently corrupts every later reserve in that pool.
    const { groups, orphans } = groupEventsByMarket(
      [
        ev(POOL_A, 200, 1),
        ev(POOL_B, 100, 0),
        ev(POOL_A, 100, 5),
        ev(POOL_A, 200, 0),
        ev(POOL_A, 100, 2),
      ],
      byPool
    );
    expect(orphans).to.deep.equal([]);
    expect(groups.map((g) => g.questionId.toString())).to.deep.equal(["3", "7"]);
    const a = groups.find((g) => g.questionId === BigInt(7))!;
    expect(a.events.map((e) => `${e.blockNumber}.${e.logIndex}`)).to.deep.equal([
      "100.2",
      "100.5",
      "200.0",
      "200.1",
    ]);
  });

  it("orders groups by question id, so a run's writes are deterministic", () => {
    const { groups } = groupEventsByMarket([ev(POOL_A, 1, 0), ev(POOL_B, 1, 1)], byPool);
    expect(groups.map((g) => g.questionId.toString())).to.deep.equal(["3", "7"]);
  });

  it("matches pool addresses case-insensitively", () => {
    const { groups, orphans } = groupEventsByMarket([ev(POOL_A.toUpperCase(), 1, 0)], byPool);
    expect(orphans).to.deep.equal([]);
    expect(groups).to.have.length(1);
    expect(groups[0].questionId).to.equal(BigInt(7));
    expect(groups[0].fpmm).to.equal(POOL_A);
  });

  it("reports an unattributable event rather than dropping it silently", () => {
    // market_events.question_id is NOT NULL, so such an event cannot be stored —
    // but it means some pool's replay has a hole, which must be reported.
    const { groups, orphans } = groupEventsByMarket(
      [ev(POOL_A, 1, 0), ev(POOL_C, 1, 1)],
      byPool
    );
    expect(groups).to.have.length(1);
    expect(orphans).to.have.length(1);
    expect(orphans[0].fpmm).to.equal(POOL_C);
  });
});

describe("indexer run: chunk ceiling and budgets", () => {
  it("says nothing when no sweep served a full-width range", () => {
    // null, not the current value: it is what lets commitCheckpoint COALESCE and
    // keep a ceiling this run had no opinion about.
    expect(foldAcceptedChunk(BigInt(250_000), [null, null])).to.equal(null);
    expect(foldAcceptedChunk(null, [])).to.equal(null);
    expect(foldAcceptedChunk(BigInt(250_000), [BigInt(0), BigInt(-5)])).to.equal(null);
  });

  it("takes the widest span either sweep served", () => {
    expect(foldAcceptedChunk(null, [BigInt(120_000), BigInt(250_000)])).to.equal(BigInt(250_000));
  });

  it("ONLY EVER RAISES, so one dense range cannot throttle every later scan", () => {
    // eth_getLogs is refused for result COUNT as well as width, so a 250k range
    // rejected once must not become a permanent 120k ceiling.
    expect(foldAcceptedChunk(BigInt(250_000), [BigInt(120_000)])).to.equal(BigInt(250_000));
    expect(foldAcceptedChunk(BigInt(250_000), [BigInt(400_000)])).to.equal(BigInt(400_000));
  });

  it("never returns a ceiling below MIN_CHUNK", () => {
    expect(foldAcceptedChunk(BigInt(1), [BigInt(1)])).to.equal(MIN_CHUNK);
  });

  it("budgets headers separately from log requests", () => {
    // Charging headers to the sweep budget would mean a range holding 300 trades
    // could never be committed at a budget of 40, stalling the backfill for good.
    expect(headerBudget(40)).to.equal(400);
    expect(headerBudget(6)).to.equal(60);
    // Floored, so a tiny sweep budget still makes real progress.
    expect(headerBudget(1)).to.equal(50);
    expect(headerBudget(0)).to.equal(50);
    expect(headerBudget(Number.NaN)).to.equal(50);
  });
});

describe("indexer run: small conversions", () => {
  it("saturates a block-count delta instead of losing digits", () => {
    expect(toCount(BigInt(0))).to.equal(0);
    expect(toCount(BigInt(-9))).to.equal(0);
    expect(toCount(BigInt(55_632_013))).to.equal(55_632_013);
    expect(toCount(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10))).to.equal(Number.MAX_SAFE_INTEGER);
  });

  it("converts a block timestamp to the exact instant", () => {
    expect(blockTimeOf(BigInt(1_756_651_200)).toISOString()).to.equal("2025-08-31T14:40:00.000Z");
    expect(blockTimeOf(BigInt(0)).getTime()).to.equal(0);
  });

  it("refuses a timestamp no timestamptz can hold", () => {
    // new Date(Infinity) would reach Postgres as an invalid date and abort the
    // whole range transaction with a far less obvious message.
    expect(() => blockTimeOf(BigInt("253402300800"))).to.throw(/outside timestamptz range/);
    expect(() => blockTimeOf(BigInt(-1))).to.throw(/outside timestamptz range/);
  });

  it("trims rows above the committed range", () => {
    const rows = [{ blockNumber: BigInt(10) }, { blockNumber: BigInt(20) }, { blockNumber: BigInt(30) }];
    expect(nums(atOrBelow(rows, BigInt(20)).map((r) => r.blockNumber))).to.deep.equal(["10", "20"]);
    expect(atOrBelow(rows, BigInt(9))).to.deep.equal([]);
    expect(atOrBelow(rows, BigInt(30))).to.have.length(3);
  });
});

describe("indexer run: chain settings", () => {
  const good = {
    chainId: 31337,
    factory: "0x2222222222222222222222222222222222222222",
    startBlock: BigInt(0),
    rpcUrl: "http://127.0.0.1:8545",
    confirmations: 0,
  };

  it("accepts a local chain with start block 0 and no confirmations", () => {
    // The override exists precisely so chain 31337 can be indexed without a fake
    // entry in lib/deployments/index.json, which must stay truthful.
    expect(normalizeChainSettings(good)).to.deep.equal(good);
  });

  it("lowercases the factory, because it is a stored key", () => {
    // The hex body only: `0X` is refused outright (safeAddress requires a
    // lowercase prefix, as every address viem produces has), and that refusal is
    // covered by the malformed case below.
    const mixed = "0x" + good.factory.slice(2).toUpperCase();
    expect(normalizeChainSettings({ ...good, factory: mixed }).factory).to.equal(good.factory);
  });

  it("refuses a malformed factory instead of storing it", () => {
    // ensureIndexerState stores the factory and then REFUSES every later run whose
    // factory disagrees, so a typo here is sticky until an operator intervenes.
    expect(() => normalizeChainSettings({ ...good, factory: "0xnope" })).to.throw(/malformed/);
    expect(() => normalizeChainSettings({ ...good, factory: "" })).to.throw(/malformed/);
    expect(() =>
      normalizeChainSettings({ ...good, factory: good.factory.toUpperCase() })
    ).to.throw(/malformed/);
  });

  it("refuses a negative start block and an empty rpc url", () => {
    expect(() => normalizeChainSettings({ ...good, startBlock: BigInt(-1) })).to.throw(
      /not a block number/
    );
    expect(() => normalizeChainSettings({ ...good, rpcUrl: "   " })).to.throw(/rpcUrl is empty/);
  });

  it("clamps a nonsense confirmations count rather than refusing the run", () => {
    expect(normalizeChainSettings({ ...good, confirmations: -3 }).confirmations).to.equal(0);
    expect(normalizeChainSettings({ ...good, confirmations: 12.9 }).confirmations).to.equal(12);
  });
});

describe("indexer run: stated bounds", () => {
  it("bounds the reorg walk-back at 256 stored blocks", () => {
    // Unbounded, a chain that disagrees everywhere would spend thousands of
    // requests and fail anyway. Past the bound the run reports and truncates
    // NOTHING, rather than deleting a whole history on a guess.
    expect(MAX_REORG_WALKBACK).to.equal(256);
  });

  it("keeps every lease duration inside acquireLease's own clamp", () => {
    for (const reason of ["traffic", "cron", "manual"] as const) {
      expect(LEASE_SECONDS[reason]).to.be.at.least(1);
      expect(LEASE_SECONDS[reason]).to.be.at.most(3600);
    }
    // cron matches the route's maxDuration = 300.
    expect(LEASE_SECONDS.cron).to.equal(300);
  });
});

describe("indexer run: runIndexer never throws", () => {
  it("returns the failure in its result instead of rejecting", async () => {
    // Load-bearing: scheduleBackgroundIndex hands this promise to waitUntil(), so
    // a rejection is an unhandled rejection in a background task with nowhere to
    // surface. Needs no database — settings resolution runs first and fails first.
    const result = await runIndexer({
      maxBlocks: BigInt(1000),
      maxRequests: 4,
      reason: "manual",
      chain: {
        chainId: SYNTH_CHAIN,
        factory: "not-an-address",
        startBlock: BigInt(0),
        rpcUrl: DEAD_RPC,
        confirmations: 0,
      },
    });
    expect(result.error).to.be.a("string");
    expect(result.error).to.not.equal("");
    expect(result.skippedBecauseLeased).to.equal(false);
    expect(result.eventsInserted).to.equal(0);
    expect(result.ranBlocks).to.equal(BigInt(0));
    expect(result.checksumFailures).to.equal(0);
    // An empty range, not a range covering fromBlock.
    expect(result.toBlock < result.fromBlock).to.equal(true);
  });
});

/** Deletes ONLY this suite's synthetic chain. Qualified, per-table, by key. */
async function cleanup(): Promise<void> {
  const db = getPool();
  await db.query("DELETE FROM market_events WHERE chain_id = $1", [SYNTH_CHAIN]);
  await db.query("DELETE FROM blocks WHERE chain_id = $1", [SYNTH_CHAIN]);
  await db.query("DELETE FROM markets WHERE chain_id = $1", [SYNTH_CHAIN]);
  await db.query("DELETE FROM indexer_state WHERE chain_id = $1", [SYNTH_CHAIN]);
}

dbSuite("indexer run loop against the database (needs DATABASE_URL)", () => {
  const opts = {
    maxBlocks: BigInt(1000),
    maxRequests: 4,
    reason: "manual" as const,
    chain: {
      chainId: SYNTH_CHAIN,
      factory: SYNTH_FACTORY,
      startBlock: BigInt(0),
      rpcUrl: DEAD_RPC,
      confirmations: 0,
    },
  };

  before(async () => {
    await cleanup();
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

  it("does nothing at all when another run holds the lease", async () => {
    await ensureIndexerState(SYNTH_CHAIN, SYNTH_FACTORY, BigInt(0));
    const held = await acquireLease(SYNTH_CHAIN, "someone-else", 60);
    expect(held).to.not.equal(null);
    try {
      const result = await runIndexer(opts);
      // Contention is NOT an error, and it must not spend a single request: the
      // next tick is seconds away, and a queue of waiting serverless functions is
      // how one slow run becomes a bill.
      expect(result.skippedBecauseLeased).to.equal(true);
      expect(result.error).to.equal(null);
      expect(result.requests).to.equal(0);
      expect(result.eventsInserted).to.equal(0);
    } finally {
      await releaseLease(SYNTH_CHAIN, "someone-else");
    }
  });

  it("bootstraps, records the error and releases the lease when the RPC is dead", async () => {
    const result = await runIndexer(opts);
    expect(result.error).to.be.a("string");
    expect(result.eventsInserted).to.equal(0);
    expect(result.ranBlocks).to.equal(BigInt(0));

    const state = await readIndexerState(SYNTH_CHAIN);
    expect(state).to.not.equal(null);
    // The bootstrap ran BEFORE anything that might need to report an error, which
    // is the only condition under which recordError records anything at all: it is
    // an UPDATE ... WHERE chain_id, so with no row it silently updates nothing.
    expect(state!.startBlock).to.equal(BigInt(0));
    expect(state!.lastIndexedBlock).to.equal(BigInt(-1));
    expect(state!.lastError).to.be.a("string");
    // Released, so the next tick is not locked out by a dead run.
    expect(state!.leaseOwner).to.equal(null);
    expect(state!.leaseUntil).to.equal(null);
  });
});
