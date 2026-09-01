/**
 * END-TO-END PROOF OF THE CHART INDEXER, against a local Hardhat chain.
 *
 * WHY IT EXISTS. Every unit suite in `contracts/test/Indexer*.test.ts` stubs
 * something: the transport, the clock, the logs, or the chain itself. This script
 * stubs nothing. It deploys the real contracts, drives real trades, and points
 * the real `runIndexer` at the real database, so the one claim that cannot be
 * made offline gets made here: THE REPLAYED RESERVES EQUAL A LIVE `reserves()`
 * CALL, EXACTLY. Arc testnet is unreachable from this environment, so this is the
 * only place the whole pipeline is proven before deploy.
 *
 * DATABASE SAFETY. `DATABASE_URL` points at the ONE real Neon database; there is
 * no scratch copy and no branch. So:
 *  - the local Hardhat chain is chain id 31337, which cannot collide with Arc
 *    testnet's 5042002, and every write here is scoped to it;
 *  - the script REFUSES TO RUN unless the connected node reports 31337, so it can
 *    never write — or delete — against a real chain;
 *  - setup and teardown delete exactly `WHERE chain_id = 31337`, in all four
 *    tables, and teardown runs from a `finally` so a failed assertion still
 *    cleans up;
 *  - there is no TRUNCATE, no DROP, no ALTER and no unqualified DELETE anywhere
 *    in this file. Every statement is parameterized.
 *  - `DATABASE_URL` is read through `process.env` only (by `lib/indexer/config.ts`),
 *    never from a file, and is never printed.
 *
 * It follows that anything previously indexed under chain 31337 in this database
 * is deleted by a run of this script. That is the intended cost: 31337 is a
 * throwaway local chain whose block hashes change on every `npm run node`.
 *
 * HOW TO RUN
 *   terminal 1:  npm run node
 *   terminal 2:  cd contracts
 *                DATABASE_URL='postgresql://…' npx hardhat run scripts/e2e-indexer.ts --network localhost
 *
 * WHAT IT DOES NOT DO. It never calls `scheduleBackgroundIndex`: that is
 * fire-and-forget (`waitUntil`, or a detached promise off-platform), and every
 * assertion below would race it. `runIndexer` is awaited directly. It also does
 * NOT write a chain-31337 entry into `lib/deployments/index.json` — that file is
 * the record of REAL deployments — and instead passes the freshly deployed
 * factory through `IndexRunOptions.chain`, which exists for exactly this.
 *
 * Assertion labels A..O map 1:1 onto the task brief. P..T and Z are the extra
 * coverage the review asked for: reorg by hash mismatch (P), a failed transaction
 * committing nothing (Q), the lease released after an error (R), the learned range
 * ceiling (S), an empty database afterwards (T), and a final whole-state
 * comparison (Z). Between them they execute the four `queries.ts` statements no
 * test had ever run — `knownBlockHeaders`, `resetCheckpoint`, `blocksAtOrBelow`
 * and `saveAcceptedChunk`.
 */

import { ethers } from "hardhat";
import type { ContractTransactionReceipt, ContractTransactionResponse, Interface } from "ethers";
import { closePool, getPool, withTx } from "../../frontend/lib/db/pool";
import {
  acquireLease,
  blocksAtOrBelow,
  getBlockHash,
  knownBlockHeaders,
  latestReplayState,
  readIndexerState,
  releaseLease,
  resetCheckpoint,
  saveAcceptedChunk,
  truncateAbove,
} from "../../frontend/lib/db/queries";
import { yesProbBps } from "../../frontend/lib/indexer/replay";
import { runIndexer, type ChainSettings } from "../../frontend/lib/indexer/run";
import { deploySystem, usdc } from "../test/helpers";
import type { FixedProductMarketMaker, MarketFactory } from "../typechain-types";

/** The local Hardhat chain. Cannot collide with Arc testnet's 5042002. */
const CHAIN_ID = 31337;
const RPC_URL = "http://127.0.0.1:8545";
/** Wide enough to cover a fresh local chain in one range. */
const MAX_BLOCKS = BigInt(100_000);
const MAX_REQUESTS = 40;
/** A hash of the right SHAPE that no block can have — used to fake a reorg. */
const BOGUS_HASH = "0x" + "de".repeat(32);
const FOREIGN_OWNER = "e2e-foreign-lease-owner";

// ---------------------------------------------------------------------------
// Assertion plumbing. Every failure prints EXPECTED and ACTUAL and is collected
// rather than thrown, so one broken assertion does not hide the other fourteen;
// the process still exits non-zero. Only a missing prerequisite (a market row
// that is not there at all) throws, because nothing after it would mean anything.
// ---------------------------------------------------------------------------

const failures: string[] = [];
let passed = 0;

/** A value as a human-readable, type-distinguishing string. */
function show(v: unknown): string {
  if (typeof v === "bigint") return `${v.toString()} (bigint)`;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Strict structural equality that never equates a bigint with a number. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a !== typeof b) return false;
  return a === b;
}

function pass(label: string): void {
  passed += 1;
  console.log(`  PASS  ${label}`);
}

function fail(label: string, expected: unknown, actual: unknown): void {
  const text = `${label}\n          expected: ${show(expected)}\n          actual:   ${show(actual)}`;
  failures.push(text);
  console.error(`  FAIL  ${text}`);
}

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (sameValue(actual, expected)) pass(label);
  else fail(label, expected, actual);
}

/** For the assertions whose content is "these two must DIFFER". */
function assertNotEq(label: string, actual: unknown, forbidden: unknown): void {
  if (!sameValue(actual, forbidden)) pass(label);
  else fail(label, `anything other than ${show(forbidden)}`, actual);
}

function assertTrue(label: string, condition: boolean, detail: string): void {
  if (condition) pass(label);
  else fail(label, "true", detail);
}

/** A prerequisite, not an assertion: nothing downstream is meaningful without it. */
function mustExist<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`e2e-indexer: precondition failed — ${what}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reading the database back.
//
// These SELECTs are inline rather than added to `lib/db/queries.ts` on purpose.
// `queries.ts` is the indexer's write/read surface and every statement in it is
// production code; a "read every row of this chain and compare it with the
// chain" query belongs to a proof, not to the runtime. The same choice
// `contracts/test/IndexerDb.test.ts` makes. Every statement below is
// parameterized on `chain_id` and none of them writes anything.
// ---------------------------------------------------------------------------

interface RawEvent {
  block_number: string;
  log_index: number;
  tx_hash: string;
  question_id: string;
  fpmm: string;
  kind: string;
  actor: string;
  outcome: number | null;
  collateral: string;
  shares: string;
  reserve_yes: string;
  reserve_no: string;
  total_supply: string;
  yes_bps: number;
  exec_yes_bps: number | null;
  block_time: Date;
}

/** One `market_events` row with every amount already widened to bigint. */
interface EventRow {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  questionId: bigint;
  fpmm: string;
  kind: string;
  actor: string;
  outcome: number | null;
  collateral: bigint;
  shares: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  totalSupply: bigint;
  yesBps: number;
  execYesBps: number | null;
  blockTime: Date;
}

/** Named `..._SELECT_...` because `queries.ts:EVENT_COLUMNS` is a column COUNT. */
const EVENT_SELECT_COLUMNS = `block_number, log_index, tx_hash, question_id, fpmm, kind, actor, outcome,
         collateral, shares, reserve_yes, reserve_no, total_supply, yes_bps, exec_yes_bps, block_time`;

function toEventRow(r: RawEvent): EventRow {
  return {
    blockNumber: BigInt(r.block_number),
    logIndex: r.log_index,
    txHash: r.tx_hash,
    questionId: BigInt(r.question_id),
    fpmm: r.fpmm,
    kind: r.kind,
    actor: r.actor,
    outcome: r.outcome,
    collateral: BigInt(r.collateral),
    shares: BigInt(r.shares),
    reserveYes: BigInt(r.reserve_yes),
    reserveNo: BigInt(r.reserve_no),
    totalSupply: BigInt(r.total_supply),
    yesBps: r.yes_bps,
    execYesBps: r.exec_yes_bps,
    blockTime: r.block_time,
  };
}

/** Every event row for this chain, in the order the contracts applied them. */
async function readEvents(): Promise<EventRow[]> {
  const res = await getPool().query<RawEvent>(
    `SELECT ${EVENT_SELECT_COLUMNS} FROM market_events WHERE chain_id = $1
      ORDER BY block_number, log_index`,
    [CHAIN_ID]
  );
  return res.rows.map(toEventRow);
}

/** How many rows this chain has in `market_events`. */
async function countEvents(): Promise<bigint> {
  const res = await getPool().query<{ n: string }>(
    "SELECT count(*) AS n FROM market_events WHERE chain_id = $1",
    [CHAIN_ID]
  );
  return BigInt(res.rows[0].n);
}

/** The `blocks` rows for this chain, ascending. */
async function readBlocks(): Promise<{ blockNumber: bigint; blockHash: string; blockTime: Date }[]> {
  const res = await getPool().query<{ block_number: string; block_hash: string; block_time: Date }>(
    `SELECT block_number, block_hash, block_time FROM blocks WHERE chain_id = $1
      ORDER BY block_number`,
    [CHAIN_ID]
  );
  return res.rows.map((r) => ({
    blockNumber: BigInt(r.block_number),
    blockHash: r.block_hash,
    blockTime: r.block_time,
  }));
}

interface RawMarket {
  question_id: string;
  fpmm: string;
  condition_id: string;
  question: string;
  category: string;
  resolution_time: Date;
  resolver: string;
  fee_bps: number;
  created_block: string;
  created_at: Date;
  resolved: boolean;
  resolved_block: string | null;
  payout_yes: string | null;
  payout_no: string | null;
}

/** The `markets` rows for this chain, by question id. `updated_at` is excluded
 *  deliberately: it changes on every upsert and is not part of the state a
 *  re-index is supposed to reproduce. */
async function readMarkets(): Promise<RawMarket[]> {
  const res = await getPool().query<RawMarket>(
    `SELECT question_id, fpmm, condition_id, question, category, resolution_time, resolver,
            fee_bps, created_block, created_at, resolved, resolved_block, payout_yes, payout_no
       FROM markets WHERE chain_id = $1 ORDER BY question_id`,
    [CHAIN_ID]
  );
  return res.rows;
}

/**
 * The chain's whole indexed state as one array of lines.
 *
 * Assertions M, N and P all say "converges to the SAME final state", and the only
 * honest way to check that is to compare everything rather than the few columns
 * one happens to think of. Lines rather than a single blob so a mismatch can name
 * the first row that differs instead of dumping two megabytes.
 *
 * The checkpoint is deliberately NOT in here: `last_tick_at`, `lease_*` and
 * `accepted_chunk` legitimately move between snapshots, so the checkpoint is
 * asserted on its own where it matters.
 */
async function snapshotLines(): Promise<string[]> {
  // Sequential, not Promise.all: `pool.ts` caps the pool at 3 clients with a
  // deliberately tight 10s connect timeout, and three simultaneous cold TLS
  // handshakes to Neon can exceed it. A proof script has no reason to race.
  const events = await readEvents();
  const blocks = await readBlocks();
  const markets = await readMarkets();
  const lines: string[] = [];
  for (const e of events) {
    lines.push(
      `E|${e.blockNumber}|${e.logIndex}|${e.txHash}|${e.questionId}|${e.fpmm}|${e.kind}|${e.actor}` +
        `|${e.outcome}|${e.collateral}|${e.shares}|${e.reserveYes}|${e.reserveNo}|${e.totalSupply}` +
        `|${e.yesBps}|${e.execYesBps}|${e.blockTime.toISOString()}`
    );
  }
  for (const b of blocks) {
    lines.push(`B|${b.blockNumber}|${b.blockHash}|${b.blockTime.toISOString()}`);
  }
  for (const m of markets) {
    lines.push(
      `M|${m.question_id}|${m.fpmm}|${m.condition_id}|${m.question}|${m.category}` +
        `|${m.resolution_time.toISOString()}|${m.resolver}|${m.fee_bps}|${m.created_block}` +
        `|${m.created_at.toISOString()}|${m.resolved}|${m.resolved_block}|${m.payout_yes}|${m.payout_no}`
    );
  }
  return lines;
}

/** Compare two snapshots and name the FIRST line that differs. */
function assertSameSnapshot(label: string, actual: string[], expected: string[]): void {
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i += 1) {
    if (actual[i] !== expected[i]) {
      fail(
        `${label} (first difference at row ${i} of ${expected.length})`,
        expected[i] ?? "<no row>",
        actual[i] ?? "<no row>"
      );
      return;
    }
  }
  pass(`${label} (${expected.length} rows identical)`);
}

/**
 * Wait for the database to answer, and say so clearly if it never does.
 *
 * Neon suspends an idle endpoint, and the first connection after that regularly
 * takes longer than `lib/db/pool.ts`'s 10s `connectionTimeoutMillis` — the right
 * setting for a serverless request path (fail while the caller can still degrade)
 * and a nuisance for a one-shot script. Retried HERE rather than by loosening the
 * production pool.
 */
async function waitForDatabase(attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await getPool().query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(
          `the database did not answer after ${attempts} attempts: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
      console.log(`   no answer yet (attempt ${attempt}/${attempts}); the endpoint may be waking...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Delete every row this script could have written, and nothing else.
 *
 * Four statements, each `WHERE chain_id = $1` with $1 = 31337. Run before the
 * scenario (a previous local chain's rows would have different block hashes and
 * would make the reorg check fire against history that no longer exists) and
 * again from `finally`, so a failed assertion still leaves the database as it was.
 */
async function deleteChainRows(): Promise<void> {
  const db = getPool();
  await db.query("DELETE FROM market_events WHERE chain_id = $1", [CHAIN_ID]);
  await db.query("DELETE FROM blocks WHERE chain_id = $1", [CHAIN_ID]);
  await db.query("DELETE FROM markets WHERE chain_id = $1", [CHAIN_ID]);
  await db.query("DELETE FROM indexer_state WHERE chain_id = $1", [CHAIN_ID]);
}

/** Row counts per table for this chain, for the "nothing left behind" report. */
async function chainRowCounts(): Promise<Record<string, bigint>> {
  const db = getPool();
  const one = async (sql: string): Promise<bigint> => {
    const res = await db.query<{ n: string }>(sql, [CHAIN_ID]);
    return BigInt(res.rows[0].n);
  };
  return {
    market_events: await one("SELECT count(*) AS n FROM market_events WHERE chain_id = $1"),
    blocks: await one("SELECT count(*) AS n FROM blocks WHERE chain_id = $1"),
    markets: await one("SELECT count(*) AS n FROM markets WHERE chain_id = $1"),
    indexer_state: await one("SELECT count(*) AS n FROM indexer_state WHERE chain_id = $1"),
  };
}

// ---------------------------------------------------------------------------
// The chain side: send transactions and record, from the RECEIPTS, exactly which
// indexed events the contracts emitted and in which blocks.
//
// The expected row count and the expected `blocks` contents are DERIVED from the
// receipts rather than hard-coded. A hard-coded 9 would still pass if the
// scenario silently stopped emitting one event.
// ---------------------------------------------------------------------------

/** Event name -> `market_events.kind`, mirroring `lib/indexer/decode.ts`. */
const KIND_BY_EVENT: Record<string, string> = {
  Buy: "buy",
  Sell: "sell",
  LiquidityAdded: "liquidity_added",
  LiquidityRemoved: "liquidity_removed",
};

/** One FPMM log as the chain emitted it: the ground truth row A compares against. */
interface EmittedEvent {
  blockNumber: bigint;
  logIndex: number;
  kind: string;
  fpmm: string;
}

const emitted: EmittedEvent[] = [];
/** Every block containing a factory OR pool event — what `blocks` must hold (K). */
const eventBlocks = new Set<string>();
/** Lowercased pool address -> question id, grown as markets are created. */
const pools = new Map<string, bigint>();
let factoryAddress = "";
/** The two factory events the indexer sweeps for; anything else is not indexed. */
const INDEXED_FACTORY_EVENTS = new Set(["MarketCreated", "MarketResolved"]);
/** ABIs, captured once in `main`. The FPMM ABI is shared by every pool. */
let factoryInterface: Interface;
let poolInterface: Interface;

/**
 * Await a transaction and record the indexed events its receipt carries.
 *
 * Block numbers arrive from ethers as `number` (its API, not ours) and are
 * widened to `bigint` HERE, at the boundary, so nothing below this line ever
 * narrows one. `log.index` stays a number: it is a position inside a block, which
 * is what `market_events.log_index` is too.
 */
async function send(
  label: string,
  tx: Promise<ContractTransactionResponse>
): Promise<ContractTransactionReceipt> {
  const receipt = mustExist(await (await tx).wait(), `${label} produced no receipt`);
  const blockNumber = BigInt(receipt.blockNumber);
  for (const log of receipt.logs) {
    const address = log.address.toLowerCase();
    const entry = { topics: [...log.topics], data: log.data };
    if (address === factoryAddress) {
      const parsed = factoryInterface.parseLog(entry);
      if (parsed && INDEXED_FACTORY_EVENTS.has(parsed.name)) eventBlocks.add(blockNumber.toString());
    } else if (pools.has(address)) {
      const parsed = poolInterface.parseLog(entry);
      const kind = parsed ? KIND_BY_EVENT[parsed.name] : undefined;
      if (kind) {
        emitted.push({ blockNumber, logIndex: log.index, kind, fpmm: address });
        eventBlocks.add(blockNumber.toString());
      }
    }
  }
  console.log(`  tx  ${label} -> block ${blockNumber}`);
  return receipt;
}

/** A market plus everything the assertions need to interrogate it. */
interface Market {
  questionId: bigint;
  fpmm: string;
  conditionId: string;
  question: string;
  pool: FixedProductMarketMaker;
}

/**
 * Create one market and register its pool.
 *
 * `contracts/test/helpers.ts:createMarket` is not used here because it hard-codes
 * the question, and one of the three must be `"Event: Outcome"` shaped so the
 * frontend's multi-outcome grouping (`parseQuestion`, which splits on the FIRST
 * colon) is exercised end to end. `deploySystem()` and `usdc()` come from that
 * file unchanged.
 */
async function createMarket(
  factory: MarketFactory,
  question: string,
  category: string,
  resolver: string,
  secondsUntilResolution: number,
  feeBps: number
): Promise<Market> {
  const now = mustExist(await ethers.provider.getBlock("latest"), "no latest block").timestamp;
  const receipt = await send(
    `createMarket "${question}"`,
    factory.createMarket(question, category, now + secondsUntilResolution, resolver, feeBps)
  );
  const created = receipt.logs
    .filter((l) => l.address.toLowerCase() === factoryAddress)
    .map((l) => factoryInterface.parseLog({ topics: [...l.topics], data: l.data }))
    .find((p) => p?.name === "MarketCreated");
  const args = mustExist(created, `MarketCreated was not emitted for "${question}"`).args;
  const questionId = args.questionId as bigint;
  const fpmm = args.fpmm as string;
  pools.set(fpmm.toLowerCase(), questionId);
  return {
    questionId,
    fpmm: fpmm.toLowerCase(),
    conditionId: (args.conditionId as string).toLowerCase(),
    question,
    pool: await ethers.getContractAt("FixedProductMarketMaker", fpmm),
  };
}

/** The chain settings the indexer runs against. Never written to deployments/index.json. */
function chainSettings(rpcUrl = RPC_URL): ChainSettings {
  return {
    chainId: CHAIN_ID,
    factory: factoryAddress,
    startBlock: BigInt(0),
    // A Hardhat node does not reorg, so nothing has to be held back from the head.
    rpcUrl,
    confirmations: 0,
  };
}

/** One indexer run, awaited directly — never through `scheduleBackgroundIndex`. */
function index(rpcUrl = RPC_URL) {
  return runIndexer({
    maxBlocks: MAX_BLOCKS,
    maxRequests: MAX_REQUESTS,
    reason: "manual",
    chain: chainSettings(rpcUrl),
  });
}

// ---------------------------------------------------------------------------
// The proof itself.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== chart indexer: end-to-end proof against a local Hardhat chain ===\n");

  // -- Preflight 1: the database. Read through process.env ONLY. The project's
  // -- real connection string lives in frontend/.env.local; this script never
  // -- opens that file and never prints the value.
  if (!process.env.DATABASE_URL) {
    console.error(
      "e2e-indexer: DATABASE_URL is not set, so there is nothing to prove against.\n" +
        "  Export it in the shell that runs this script and re-run. Nothing was touched."
    );
    process.exitCode = 1;
    return;
  }

  // -- Preflight 2: a reachable node that REALLY is chain 31337. The second half
  // -- is the safety interlock, not a convenience: this script deletes rows keyed
  // -- by chain 31337, so it must refuse to run anywhere the id would be a lie.
  let onChainId: bigint;
  try {
    onChainId = (await ethers.provider.getNetwork()).chainId;
  } catch (err) {
    console.error(
      `e2e-indexer: no JSON-RPC node answered at ${RPC_URL}.\n` +
        "  Start one with `npm run node` in another terminal, then re-run with\n" +
        "  `npx hardhat run scripts/e2e-indexer.ts --network localhost`.\n" +
        `  (${err instanceof Error ? err.message : String(err)})`
    );
    process.exitCode = 1;
    return;
  }
  if (onChainId !== BigInt(CHAIN_ID)) {
    console.error(
      `e2e-indexer: REFUSING TO RUN. The connected node reports chain ${onChainId}, not ` +
        `${CHAIN_ID}.\n  Every write and every delete here is scoped to ${CHAIN_ID}; running ` +
        "against anything else\n  would be meaningless and unsafe."
    );
    process.exitCode = 1;
    return;
  }
  console.log(`node: chain ${onChainId} at ${RPC_URL}`);

  let teardownRan = false;
  try {
    // -- Setup hook. A previous local chain's rows carry block hashes this chain
    // -- has never had; left in place they would make the reorg check fire against
    // -- history that no longer exists.
    console.log("\n0. Waiting for the database, then clearing chain-31337 rows (scoped DELETEs)...");
    await waitForDatabase();
    await deleteChainRows();

    // ------------------------------------------------------------- 1. scenario
    console.log("\n1. Deploying the system and funding two signers...");
    const [deployer, trader] = await ethers.getSigners();
    const { mockUSDC, conditionalTokens, factory } = await deploySystem();
    factoryAddress = (await factory.getAddress()).toLowerCase();
    factoryInterface = factory.interface;
    poolInterface = (await ethers.getContractFactory("FixedProductMarketMaker")).interface;
    await (await mockUSDC.mint(deployer.address, usdc(100_000))).wait();
    await (await mockUSDC.mint(trader.address, usdc(100_000))).wait();
    console.log(`   factory ${factoryAddress}`);

    console.log("\n2. Creating three markets (A plain, B+C an 'Event: Outcome' pair)...");
    const marketA = await createMarket(
      factory,
      "Will Arc mainnet ship in 2026?",
      "Crypto",
      deployer.address,
      3600,
      200
    );
    const marketB = await createMarket(
      factory,
      "Arc E2E Cup: Team Alpha wins",
      "Sports",
      deployer.address,
      3600,
      200
    );
    const marketC = await createMarket(
      factory,
      "Arc E2E Cup: Team Beta wins",
      "Sports",
      deployer.address,
      60,
      200
    );
    const markets = [marketA, marketB, marketC];

    console.log("\n3. Approvals (no indexed events)...");
    for (const m of markets) await (await mockUSDC.approve(m.fpmm, usdc(5_000))).wait();
    for (const m of markets) {
      await (await mockUSDC.connect(trader).approve(m.fpmm, usdc(5_000))).wait();
    }
    // Selling hands outcome tokens back to the pool, which needs ERC-1155 approval.
    await (await conditionalTokens.connect(trader).setApprovalForAll(marketA.fpmm, true)).wait();

    console.log("\n4. Market A: add, buy YES, buy NO, sell YES, add again (UNBALANCED), remove half...");
    await send("A addLiquidity(1000)", marketA.pool.addLiquidity(usdc(1000), 0));
    await send("A buy(YES, 100)", marketA.pool.connect(trader).buy(0, usdc(100), 0));
    await send("A buy(NO, 50)", marketA.pool.connect(trader).buy(1, usdc(50), 0));
    await send("A sell(YES, 25)", marketA.pool.connect(trader).sell(0, usdc(25), ethers.MaxUint256));
    // Equal amounts onto UNEQUAL reserves: the marginal price moves with no
    // Buy/Sell emitted. Assertion E is about exactly this row.
    await send("A addLiquidity(200) onto an unbalanced pool", marketA.pool.addLiquidity(usdc(200), 0));
    const lpShares = await marketA.pool.balanceOf(deployer.address);
    // Proportional withdrawal: the ratio, and so the price, must SURVIVE (F).
    await send("A removeLiquidity(half)", marketA.pool.removeLiquidity(lpShares / BigInt(2), 0));

    console.log("\n5. Market B: liquidity only, never traded...");
    await send("B addLiquidity(300)", marketB.pool.addLiquidity(usdc(300), 0));

    console.log("\n6. Market C: liquidity, one buy, then resolve YES...");
    await send("C addLiquidity(500)", marketC.pool.addLiquidity(usdc(500), 0));
    await send("C buy(YES, 40)", marketC.pool.connect(trader).buy(0, usdc(40), 0));
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    const resolveReceipt = await send(
      "C resolveMarket([1,0])",
      factory.resolveMarket(marketC.questionId, [1, 0])
    );

    const head = BigInt(await ethers.provider.getBlockNumber());
    const aEmitted = emitted.filter((e) => e.fpmm === marketA.fpmm);
    // A mid-range block INSIDE market A's event stream, so the resumability and
    // reorg assertions have to seed the replay from a surviving row rather than
    // from zero. Market A's third event (buy NO).
    const midBlock = mustExist(aEmitted[2], "market A needs at least three events").blockNumber;
    console.log(
      `\n   chain head ${head}; ${emitted.length} indexed pool events across ` +
        `${eventBlocks.size} event-bearing blocks; mid-range probe block ${midBlock}`
    );

    // ------------------------------------------------------- 7. the first index
    console.log("\n7. runIndexer (awaited directly, NOT scheduleBackgroundIndex)...");
    const first = await index();
    console.log(`   ${JSON.stringify(first, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    assertEq("   run 1 reported no error", first.error, null);
    assertEq("   run 1 covered the chain up to the head", first.toBlock, head);
    assertEq("   run 1 was not stopped by a budget", first.budgetStopped, false);
    assertEq("   run 1 made progress", first.noProgress, false);
    assertEq("   run 1 completed the backfill", first.backfillComplete, true);
    assertEq("   run 1 found no replay checksum mismatch", first.checksumFailures, 0);

    const rows = await readEvents();
    const baseline = await snapshotLines();
    const baseCount = await countEvents();

    // A. Exactly the emitted events, no more and no fewer.
    assertEq("A  market_events row count == emitted indexed events", baseCount, BigInt(emitted.length));
    assertEq("A  run 1 inserted that many rows", first.eventsInserted, emitted.length);

    // B/C/D. The decisive comparison: replayed state vs a live contract call.
    console.log("\n8. Replayed (latest indexed row) vs on-chain, per pool:");
    for (const m of markets) {
      const mine = rows.filter((r) => r.questionId === m.questionId);
      const last = mustExist(mine[mine.length - 1], `no indexed rows for question ${m.questionId}`);
      const [onYes, onNo] = await m.pool.reserves();
      const onSupply = await m.pool.totalSupply();
      const onBps = yesProbBps(onYes, onNo);
      console.log(
        `   q${m.questionId} ${m.fpmm}  (${mine.length} rows)\n` +
          `      replayed  yes=${last.reserveYes}  no=${last.reserveNo}  ` +
          `supply=${last.totalSupply}  yesBps=${last.yesBps}\n` +
          `      on-chain  yes=${onYes}  no=${onNo}  supply=${onSupply}  yesBps=${onBps}`
      );
      assertEq(`B  q${m.questionId} reserve_yes == on-chain reserves().yes`, last.reserveYes, onYes);
      assertEq(`B  q${m.questionId} reserve_no  == on-chain reserves().no`, last.reserveNo, onNo);
      assertEq(`C  q${m.questionId} total_supply == on-chain totalSupply()`, last.totalSupply, onSupply);
      assertEq(`D  q${m.questionId} yes_bps == yesProbBps(on-chain reserves)`, last.yesBps, onBps);
    }

    // E/F/G. The two directions that separate "models the contract" from
    // "produces plausible numbers", plus the removeLiquidity checksum.
    console.log("\n9. Liquidity events and the price (E, F, G)...");
    const aRows = rows.filter((r) => r.questionId === marketA.questionId);
    assertEq(
      "   market A's kind sequence is what the scenario drove",
      aRows.map((r) => r.kind),
      ["liquidity_added", "buy", "buy", "sell", "liquidity_added", "liquidity_removed"]
    );
    const addIdx = aRows.map((r, i) => (r.kind === "liquidity_added" ? i : -1)).filter((i) => i >= 0);
    const secondAdd = mustExist(addIdx[1], "market A needs two liquidity_added rows");
    const beforeAdd = mustExist(aRows[secondAdd - 1], "no row before the second addLiquidity");
    const addRow = mustExist(aRows[secondAdd], "no second addLiquidity row");
    console.log(`   yes_bps before/after the second addLiquidity: ${beforeAdd.yesBps} -> ${addRow.yesBps}`);
    assertNotEq(
      "E  the second addLiquidity MOVED yes_bps (equal amounts onto unequal reserves)",
      addRow.yesBps,
      beforeAdd.yesBps
    );

    const removeIdx = aRows.findIndex((r) => r.kind === "liquidity_removed");
    const remRow = mustExist(aRows[removeIdx], "no liquidity_removed row");
    const beforeRem = mustExist(aRows[removeIdx - 1], "no row before the removeLiquidity");
    const drift = Math.abs(remRow.yesBps - beforeRem.yesBps);
    console.log(`   yes_bps before/after removeLiquidity: ${beforeRem.yesBps} -> ${remRow.yesBps}`);
    assertTrue(
      "F  removeLiquidity PRESERVED yes_bps within 1 bps (proportional withdrawal)",
      drift <= 1,
      `|${remRow.yesBps} - ${beforeRem.yesBps}| = ${drift}, expected <= 1`
    );

    // Recomputed from the PRE-event row, which is what the contract divides by.
    const yesOut = (remRow.shares * beforeRem.reserveYes) / beforeRem.totalSupply;
    const noOut = (remRow.shares * beforeRem.reserveNo) / beforeRem.totalSupply;
    assertEq(
      "G  removeLiquidity collateral == min(yesOut, noOut)",
      remRow.collateral,
      yesOut < noOut ? yesOut : noOut
    );

    // H. A pool that was never traded.
    const bRows = rows.filter((r) => r.questionId === marketB.questionId);
    assertEq("H  market B has exactly one row", BigInt(bRows.length), BigInt(1));
    assertEq("H  ... of kind liquidity_added", bRows[0]?.kind, "liquidity_added");
    assertEq("H  ... at yes_bps 5000 (a balanced pool is 50/50)", bRows[0]?.yesBps, 5000);
    assertEq("H  ... and no execution price", bRows[0]?.execYesBps, null);

    // I. Resolution, and only where it belongs.
    console.log("\n10. Markets, resolution and block times (I, J, K)...");
    const marketRows = await readMarkets();
    const rowFor = (q: bigint) =>
      mustExist(
        marketRows.find((m) => m.question_id === q.toString()),
        `no markets row for question ${q}`
      );
    const cMarket = rowFor(marketC.questionId);
    assertEq("I  market C is marked resolved", cMarket.resolved, true);
    assertEq("I  ... payout_yes = 1", cMarket.payout_yes, "1");
    assertEq("I  ... payout_no = 0", cMarket.payout_no, "0");
    assertEq(
      "I  ... resolved_block is the resolveMarket block",
      BigInt(mustExist(cMarket.resolved_block, "resolved_block is NULL")),
      BigInt(resolveReceipt.blockNumber)
    );
    for (const m of [marketA, marketB]) {
      const row = rowFor(m.questionId);
      assertEq(`I  market q${m.questionId} is NOT resolved`, row.resolved, false);
      assertEq(`I  market q${m.questionId} has no payout_yes`, row.payout_yes, null);
    }
    assertEq(
      "I  an 'Event: Outcome' question is stored verbatim (grouping is a UI convention)",
      rowFor(marketB.questionId).question,
      marketB.question
    );
    assertEq("I  the pool address is the join key markets records", rowFor(marketA.questionId).fpmm, marketA.fpmm);

    // J. block_time is the chart's x-axis and the bucket key; a wrong one is not
    // cosmetic. Compared against the chain, block by block.
    let badTime = "";
    for (const r of rows) {
      const block = mustExist(await ethers.provider.getBlock(r.blockNumber), `block ${r.blockNumber} is gone`);
      const stored = BigInt(Math.floor(r.blockTime.getTime() / 1000));
      if (stored !== BigInt(block.timestamp)) {
        badTime = `block ${r.blockNumber}: stored ${stored}, chain ${block.timestamp}`;
        break;
      }
    }
    assertTrue("J  every event row's block_time == that block's on-chain timestamp", badTime === "", badTime);

    // K. One header per DISTINCT event-bearing block, ever — never one per event.
    const storedBlocks = await readBlocks();
    const asc = (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1);
    assertEq(
      "K  blocks holds exactly the distinct event-bearing block numbers",
      storedBlocks.map((b) => b.blockNumber).sort(asc),
      [...eventBlocks].map((n) => BigInt(n)).sort(asc)
    );
    // Property 4 of run.ts, counted rather than assumed: 1 head read + 1 factory
    // sweep + 1 pool sweep + ONE getBlock per distinct event-bearing block. No
    // reorg probe (the first run has no stored witness) and no extra witness read
    // (the head block is itself event-bearing, so its header came from the sweep).
    // This — not the row count — is what rules out one header per event: Hardhat
    // mines one block per transaction, so both counts happen to be 13 here.
    assertEq(
      "K  run 1 spent exactly one RPC request per distinct event-bearing block, plus three",
      BigInt(first.requests),
      BigInt(3 + eventBlocks.size)
    );
    const known = await knownBlockHeaders(CHAIN_ID, BigInt(0), head);
    assertEq(
      "K  knownBlockHeaders returns every stored header for the range",
      BigInt(known.size),
      BigInt(storedBlocks.length)
    );

    // L. Idempotency. Nothing new on the chain, so the run finds nothing to do.
    console.log("\n11. Idempotency and resumability (L, M)...");
    const second = await index();
    assertEq("L  a second run inserted zero rows", second.eventsInserted, 0);
    assertEq("L  ... with no error", second.error, null);
    assertEq("L  ... and no phantom reorg", second.reorgDepth, 0);
    assertEq("L  ... leaving the row count identical", await countEvents(), baseCount);
    assertSameSnapshot("L  ... and the state identical", await snapshotLines(), baseline);

    // The seed bound Task 7 added, asserted directly: the tail STRICTLY BELOW a
    // block, not the global tail. M is only correct because of it.
    const seed = mustExist(
      await latestReplayState(CHAIN_ID, marketA.questionId, midBlock),
      "no replay seed below the mid-range block"
    );
    const lastBelowMid = mustExist(
      aRows.filter((r) => r.blockNumber < midBlock).pop(),
      "no market A row below the mid-range block"
    );
    assertEq(
      "L  latestReplayState(belowBlock) returns the tail strictly below that block",
      [seed.reserveYes, seed.reserveNo, seed.totalSupply],
      [lastBelowMid.reserveYes, lastBelowMid.reserveNo, lastBelowMid.totalSupply]
    );

    // M. Resumability: rewind the checkpoint WITHOUT truncating, re-run, converge.
    const midHeader = mustExist(await ethers.provider.getBlock(midBlock), `block ${midBlock} is gone`);
    const midHash = mustExist(midHeader.hash, `block ${midBlock} has no hash`).toLowerCase();
    assertEq("M  the stored block_hash matches the chain", await getBlockHash(CHAIN_ID, midBlock), midHash);
    await withTx((c) => resetCheckpoint(c, CHAIN_ID, midBlock, midHash));
    const third = await index();
    assertEq("M  re-running from a rewound checkpoint inserted zero rows", third.eventsInserted, 0);
    assertEq("M  ... with no error", third.error, null);
    assertEq("M  ... and no reorg (the stored hash still matches)", third.reorgDepth, 0);
    assertSameSnapshot("M  ... and converged to the identical state", await snapshotLines(), baseline);
    assertEq(
      "M  ... with the checkpoint back at the head",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").lastIndexedBlock,
      head
    );

    // S. `saveAcceptedChunk` — the one statement a Hardhat node cannot reach
    // through a run (it never refuses a range for width, so `acceptedSpan` stays
    // null). Called directly, then checked to SURVIVE a committing run, which is
    // what `commitCheckpoint`'s COALESCE is for.
    console.log("\n12. Learned range ceiling (S)...");
    await saveAcceptedChunk(CHAIN_ID, BigInt(250_000));
    assertEq(
      "S  saveAcceptedChunk round-trips through indexer_state",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").acceptedChunk,
      BigInt(250_000)
    );

    // N. Reorg recovery, driven explicitly: truncate above a mid-range block
    // through the production statement, rewind the checkpoint to it, re-index.
    console.log("\n13. Reorg recovery by explicit truncation (N)...");
    await withTx(async (c) => {
      await truncateAbove(c, CHAIN_ID, midBlock);
      await resetCheckpoint(c, CHAIN_ID, midBlock, midHash);
    });
    const afterCut = await countEvents();
    assertTrue(
      "N  truncateAbove removed the rows above the cut",
      afterCut < baseCount && afterCut > BigInt(0),
      `${afterCut} rows left of ${baseCount}, expected strictly between 0 and ${baseCount}`
    );
    // A reorg can unmake a RESOLUTION as well as an event, and `markets` rows are
    // keyed by question id rather than by block — so this is the easy one to
    // forget and the one that would leave a phantom payout forever.
    const cAfterCut = mustExist(
      (await readMarkets()).find((m) => m.question_id === marketC.questionId.toString()),
      "market C vanished"
    );
    assertEq("N  ... and un-resolved market C, whose resolution was above the cut", cAfterCut.resolved, false);
    assertEq("N  ... (its payouts are gone too)", cAfterCut.payout_yes, null);
    const fourth = await index();
    assertEq("N  the re-index inserted exactly the truncated rows back", BigInt(fourth.eventsInserted), baseCount - afterCut);
    assertEq("N  ... with no error", fourth.error, null);
    assertSameSnapshot("N  ... and converged to the identical state", await snapshotLines(), baseline);
    assertEq(
      "S  a committing run PRESERVES accepted_chunk (COALESCE, not assign)",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").acceptedChunk,
      BigInt(250_000)
    );

    // P. Reorg recovery the way production meets it: a checkpoint whose stored
    // hash no longer matches the chain. This is the only path that reaches
    // `blocksAtOrBelow` and `probeReorgCut`, and no test had ever executed it
    // against a real chain.
    console.log("\n14. Reorg detected by a hash mismatch (P)...");
    const candidates = await blocksAtOrBelow(CHAIN_ID, midBlock - BigInt(1), 256);
    assertTrue(
      "P  blocksAtOrBelow returns stored blocks below the cursor, highest first",
      candidates.length > 0 &&
        candidates[0].blockNumber < midBlock &&
        candidates.every((c, i) => i === 0 || candidates[i - 1].blockNumber > c.blockNumber),
      `${candidates.length} candidates: ${candidates.map((c) => c.blockNumber).join(",")}`
    );
    await withTx((c) => resetCheckpoint(c, CHAIN_ID, midBlock, BOGUS_HASH));
    const fifth = await index();
    assertTrue(
      "P  a checkpoint hash the chain disagrees with triggers a cut and a re-index",
      fifth.reorgDepth > 0,
      `reorgDepth = ${fifth.reorgDepth}`
    );
    assertEq("P  ... without failing the run", fifth.error, null);
    assertTrue(
      "P  ... re-inserting the rows it truncated",
      fifth.eventsInserted > 0,
      `eventsInserted = ${fifth.eventsInserted}`
    );
    assertSameSnapshot("P  ... and converging to the identical state", await snapshotLines(), baseline);

    // Q. A failed range transaction must commit NOTHING — neither the rows nor
    // the checkpoint. Uses the real reorg statement pair, then throws inside it.
    console.log("\n15. A failing transaction commits nothing (Q)...");
    const beforeQ = await snapshotLines();
    const checkpointQ = mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").lastIndexedBlock;
    let rejected = false;
    try {
      await withTx(async (c) => {
        await truncateAbove(c, CHAIN_ID, midBlock);
        await resetCheckpoint(c, CHAIN_ID, midBlock, midHash);
        throw new Error("e2e-indexer: deliberate failure inside the range transaction");
      });
    } catch {
      rejected = true;
    }
    assertTrue("Q  the failing transaction rejected", rejected, "withTx resolved instead");
    assertSameSnapshot("Q  ... and rolled every row back", await snapshotLines(), beforeQ);
    assertEq(
      "Q  ... leaving the checkpoint unmoved",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").lastIndexedBlock,
      checkpointQ
    );

    // R. `runIndexer` NEVER THROWS, and it must release its lease on the way out —
    // otherwise one dead-endpoint tick wedges the indexer for the lease duration.
    console.log("\n16. A failing run reports, changes nothing, and frees the lease (R)...");
    const beforeR = await snapshotLines();
    const dead = await index("http://127.0.0.1:8546");
    assertTrue(
      "R  a run against a dead endpoint returned an error instead of throwing",
      dead.error !== null,
      `error was ${show(dead.error)}`
    );
    assertEq("R  ... inserting nothing", dead.eventsInserted, 0);
    assertSameSnapshot("R  ... and changing no row", await snapshotLines(), beforeR);
    const stateR = mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row");
    assertEq("R  ... leaving the checkpoint unmoved", stateR.lastIndexedBlock, head);
    assertEq("R  ... releasing the lease owner", stateR.leaseOwner, null);
    assertEq("R  ... and its expiry", stateR.leaseUntil, null);
    assertTrue(
      "R  ... while recording the error for /api/indexer/status",
      stateR.lastError !== null,
      `last_error was ${show(stateR.lastError)}`
    );
    const afterR = await index();
    assertEq("R  the next run proceeds rather than meeting an orphaned lease", afterR.skippedBecauseLeased, false);
    assertEq("R  ... and reports no error", afterR.error, null);
    assertEq(
      "R  ... clearing the stale last_error",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").lastError,
      null
    );

    // O. Contention: a lease held by somebody else means DO NOTHING AT ALL.
    console.log("\n17. A foreign lease is respected (O)...");
    const beforeO = await snapshotLines();
    const foreign = await acquireLease(CHAIN_ID, FOREIGN_OWNER, 120);
    assertTrue("O  a foreign owner took the lease", foreign !== null, "acquireLease returned null");
    const leasedRun = await index();
    assertEq("O  the run skipped because the chain was leased", leasedRun.skippedBecauseLeased, true);
    assertEq("O  ... writing zero rows", leasedRun.eventsInserted, 0);
    assertEq("O  ... and reporting no error (contention is not a failure)", leasedRun.error, null);
    assertSameSnapshot("O  ... and changing no row", await snapshotLines(), beforeO);
    await releaseLease(CHAIN_ID, FOREIGN_OWNER);
    assertEq(
      "O  releaseLease cleared the foreign owner",
      mustExist(await readIndexerState(CHAIN_ID), "no indexer_state row").leaseOwner,
      null
    );

    assertSameSnapshot("Z  the final state still equals the first run's", await snapshotLines(), baseline);
  } catch (err) {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    failures.push(`unhandled error: ${text}`);
    console.error(`\n  ABORT  ${text}`);
  } finally {
    // -- Teardown hook. Runs on failure too, which is the point: an assertion that
    // -- throws must not leave chain-31337 rows in the one real database.
    try {
      console.log("\n99. Teardown: deleting every chain-31337 row...");
      // Retried, because the likeliest reason the body above failed is that the
      // database stopped answering — and that is exactly when cleanup matters.
      await waitForDatabase();
      await deleteChainRows();
      const left = await chainRowCounts();
      const total = Object.values(left).reduce((a, b) => a + b, BigInt(0));
      for (const [table, n] of Object.entries(left)) console.log(`   ${table}: ${n} rows remain`);
      assertEq("T  zero rows remain under chain 31337 after teardown", total, BigInt(0));
      teardownRan = true;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      failures.push(`teardown failed: ${text}`);
      console.error(`  FAIL  teardown could not clean up: ${text}`);
    } finally {
      // Without this the pg pool keeps the event loop alive and the script hangs.
      await closePool().catch((err: unknown) => {
        console.error("  closePool failed:", err instanceof Error ? err.message : String(err));
      });
    }
  }

  console.log(
    `\n=== ${passed} assertion(s) passed, ${failures.length} failed` +
      `${teardownRan ? "" : ", TEARDOWN DID NOT COMPLETE"} ===`
  );
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nEvery assertion passed. The replayed reserves equal a live reserves() call.");
}

main().catch((err) => {
  console.error("\ne2e-indexer: fatal:", err);
  process.exitCode = 1;
});
