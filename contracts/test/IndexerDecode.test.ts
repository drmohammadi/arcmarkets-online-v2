import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { parseAbiItem } from "viem";
import {
  FACTORY_EVENTS, FPMM_EVENTS, decodeFactoryLogs, decodeFpmmLogs, toIndexedEvent,
  type RawEventLog,
} from "../../frontend/lib/indexer/decode";

/**
 * WHY THIS FILE EXISTS. `decode.ts` maps two events that take the same two
 * values in opposite order:
 *
 *   event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares);
 *   event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral);
 *
 * A positional mapping typechecks, runs, and silently swaps collateral with
 * shares on every removeLiquidity — corrupting every replayed reserve in that
 * pool with no error raised anywhere. `tsc` cannot see it; only an assertion
 * with DISTINCT values for the two fields can.
 *
 * The mapping is exercised with PLAIN OBJECTS, not viem logs. That is a design
 * requirement, not a shortcut: the mapping validates every field at runtime, so
 * nothing about it should need a live client, a node, or viem's `Log` type.
 */

const POOL = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const POOL_LC = POOL.toLowerCase();
const TRADER = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";
const TRADER_LC = TRADER.toLowerCase();
const TX = "0x" + "cd".repeat(32);
const CONDITION = "0x" + "ef".repeat(32);

/** A log with valid identity fields; `over` supplies the event-specific parts. */
const log = (over: Partial<Record<keyof RawEventLog, unknown>>): RawEventLog => ({
  address: POOL,
  blockNumber: BigInt(55_632_100),
  logIndex: 7,
  transactionHash: TX,
  ...over,
});

const one = (over: Partial<Record<keyof RawEventLog, unknown>>) => toIndexedEvent(log(over));

describe("indexer decode", () => {
  /*
   * The six signatures are COPIES of the ones the app uses, so they can drift.
   * Pin them against the file they were copied from rather than trusting the
   * comment that says they were: a silent drift here decodes nothing (topic0
   * changes) or decodes wrongly (argument order changes).
   */
  describe("event definitions", () => {
    const SIGS = [
      "event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)",
      "event MarketResolved(uint256 indexed questionId, uint256[2] payouts)",
      "event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)",
      "event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)",
      "event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)",
      "event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)",
    ];

    it("match frontend/lib/abis.ts verbatim", () => {
      const abis = readFileSync(join(__dirname, "../../frontend/lib/abis.ts"), "utf8");
      for (const sig of SIGS) {
        expect(abis, `abis.ts still declares: ${sig}`).to.contain(`'${sig}'`);
      }
    });

    it("match the Solidity declarations", () => {
      const sol = readFileSync(
        join(__dirname, "../src/FixedProductMarketMaker.sol"), "utf8"
      );
      for (const sig of SIGS.slice(2)) {
        expect(sol, `FPMM still declares: ${sig}`).to.contain(`${sig};`);
      }
    });

    it("are exported as parsed items, in the same order", () => {
      const parsed = SIGS.map((s) => parseAbiItem(s));
      expect([...FACTORY_EVENTS, ...FPMM_EVENTS]).to.deep.equal(parsed);
    });

    /*
     * The reversal, asserted at the ABI level as well as at the mapping level:
     * this is what makes a positional mapping wrong in the first place.
     */
    it("declare LiquidityAdded and LiquidityRemoved in opposite orders", () => {
      const names = (title: string) => {
        const item = FPMM_EVENTS.find((e) => e.name === title);
        expect(item, `${title} is defined`).to.not.equal(undefined);
        return (item!.inputs as Array<{ name?: string }>).map((i) => i.name);
      };
      expect(names("LiquidityAdded")).to.deep.equal(["provider", "collateral", "shares"]);
      expect(names("LiquidityRemoved")).to.deep.equal(["provider", "shares", "collateral"]);
    });
  });

  describe("FPMM events", () => {
    it("maps Buy: investmentAmount is collateral, sharesOut is shares", () => {
      expect(
        one({
          eventName: "Buy",
          args: {
            buyer: TRADER, outcome: BigInt(0),
            investmentAmount: BigInt(1_000_000), sharesOut: BigInt(1_800_000),
          },
        })
      ).to.deep.equal({
        blockNumber: BigInt(55_632_100), logIndex: 7, txHash: TX.toLowerCase(),
        fpmm: POOL_LC, kind: "buy", actor: TRADER_LC, outcome: 0,
        collateral: BigInt(1_000_000), shares: BigInt(1_800_000),
      });
    });

    it("maps Sell: returnAmount is collateral, sharesIn is shares", () => {
      expect(
        one({
          eventName: "Sell",
          args: {
            seller: TRADER, outcome: BigInt(1),
            returnAmount: BigInt(400_000), sharesIn: BigInt(900_000),
          },
        })
      ).to.deep.equal({
        blockNumber: BigInt(55_632_100), logIndex: 7, txHash: TX.toLowerCase(),
        fpmm: POOL_LC, kind: "sell", actor: TRADER_LC, outcome: 1,
        collateral: BigInt(400_000), shares: BigInt(900_000),
      });
    });

    it("maps LiquidityAdded, with no outcome side", () => {
      const ev = one({
        eventName: "LiquidityAdded",
        args: { provider: TRADER, collateral: BigInt(123), shares: BigInt(777) },
      });
      expect(ev?.kind).to.equal("liquidity_added");
      expect(ev?.actor).to.equal(TRADER_LC);
      expect(ev?.outcome, "liquidity touches both sides").to.equal(null);
      expect(ev?.collateral).to.equal(BigInt(123));
      expect(ev?.shares).to.equal(BigInt(777));
    });

    /*
     * THE TRAP. Distinct values, deliberately: with collateral === shares this
     * test would pass under a swapped mapping and prove nothing.
     */
    it("maps LiquidityRemoved by NAME, not position (reversed signature)", () => {
      const ev = one({
        eventName: "LiquidityRemoved",
        // Written in the signature's own order — shares first, collateral second —
        // so a positional mapping reads 777 as collateral and 123 as shares.
        args: { provider: TRADER, shares: BigInt(777), collateral: BigInt(123) },
      });
      expect(ev?.kind).to.equal("liquidity_removed");
      expect(ev?.outcome).to.equal(null);
      expect(ev?.collateral, "collateral is 123, not the leading 777").to.equal(BigInt(123));
      expect(ev?.shares, "shares is 777, not the trailing 123").to.equal(BigInt(777));
    });

    it("gives the two liquidity events the same meaning for the same numbers", () => {
      const added = one({
        eventName: "LiquidityAdded",
        args: { provider: TRADER, collateral: BigInt(5), shares: BigInt(9) },
      });
      const removed = one({
        eventName: "LiquidityRemoved",
        args: { provider: TRADER, shares: BigInt(9), collateral: BigInt(5) },
      });
      expect(added?.collateral).to.equal(removed?.collateral);
      expect(added?.shares).to.equal(removed?.shares);
    });

    it("decodes a batch and preserves order", () => {
      const events = decodeFpmmLogs([
        log({ eventName: "LiquidityAdded", args: { provider: TRADER, collateral: BigInt(10), shares: BigInt(10) } }),
        log({ eventName: "Buy", args: { buyer: TRADER, outcome: BigInt(0), investmentAmount: BigInt(1), sharesOut: BigInt(2) } }),
        log({ eventName: "Transfer", args: { from: TRADER, to: POOL, value: BigInt(1) } }),
      ]);
      expect(events.map((e) => e.kind)).to.deep.equal(["liquidity_added", "buy"]);
    });
  });

  describe("skips", () => {
    const BUY = {
      eventName: "Buy",
      args: {
        buyer: TRADER, outcome: BigInt(0),
        investmentAmount: BigInt(1_000_000), sharesOut: BigInt(1_800_000),
      },
    };

    it("a null blockNumber (a pending log cannot be ordered)", () => {
      expect(one({ ...BUY, blockNumber: null })).to.equal(null);
    });

    it("a null logIndex", () => {
      expect(one({ ...BUY, logIndex: null })).to.equal(null);
    });

    it("an unrecognised eventName", () => {
      expect(one({ ...BUY, eventName: "FeeWithdrawn" })).to.equal(null);
      expect(one({ ...BUY, eventName: undefined })).to.equal(null);
    });

    it("a trade whose outcome is outside {0,1}", () => {
      for (const outcome of [BigInt(2), BigInt(255), undefined, null, "yes"]) {
        expect(
          one({ eventName: "Buy", args: { ...BUY.args, outcome } }),
          `outcome ${String(outcome)} is not a side`
        ).to.equal(null);
      }
    });

    it("a malformed address, tx hash or actor", () => {
      expect(one({ ...BUY, address: "0xnope" })).to.equal(null);
      expect(one({ ...BUY, transactionHash: null })).to.equal(null);
      expect(one({ eventName: "Buy", args: { ...BUY.args, buyer: undefined } })).to.equal(null);
    });

    /*
     * Positional args are REFUSED rather than guessed. With the liquidity
     * signatures being mirror images, a guess is a coin flip that corrupts a
     * whole pool's reserves when it loses.
     */
    it("positional args", () => {
      expect(one({ eventName: "Buy", args: [TRADER, BigInt(0), BigInt(1), BigInt(2)] })).to.equal(null);
      expect(one({ ...BUY, args: undefined })).to.equal(null);
    });

    /*
     * A JS number cannot hold a uint256 exactly. Accepting one would put silent
     * precision loss into the amounts the whole indexer exists to get right.
     */
    it("an amount that arrived as a number", () => {
      expect(one({ eventName: "Buy", args: { ...BUY.args, investmentAmount: 1_000_000 } })).to.equal(null);
    });

    it("non-objects in a batch", () => {
      expect(decodeFpmmLogs([null, undefined, 42, "log"])).to.deep.equal([]);
    });
  });

  describe("factory events", () => {
    const created = {
      address: "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc",
      blockNumber: BigInt(55_632_013),
      logIndex: 1,
      transactionHash: TX,
      eventName: "MarketCreated",
      args: {
        questionId: BigInt(3), fpmm: POOL, conditionId: CONDITION,
        question: "Will it rain?", category: "Weather",
        resolutionTime: BigInt(1_800_000_000), resolver: TRADER, fee: BigInt(200),
      },
    };

    it("maps MarketCreated, lowercasing keys and keeping strings verbatim", () => {
      const { created: rows, resolved } = decodeFactoryLogs([created]);
      expect(resolved).to.deep.equal([]);
      expect(rows).to.deep.equal([
        {
          questionId: BigInt(3), fpmm: POOL_LC, conditionId: CONDITION,
          question: "Will it rain?", category: "Weather",
          resolutionTime: BigInt(1_800_000_000), resolver: TRADER_LC,
          feeBps: 200, blockNumber: BigInt(55_632_013),
        },
      ]);
    });

    it("maps MarketResolved payouts positionally: [yes, no]", () => {
      const { resolved } = decodeFactoryLogs([
        { ...created, eventName: "MarketResolved", args: { questionId: BigInt(3), payouts: [BigInt(1), BigInt(0)] } },
      ]);
      expect(resolved).to.deep.equal([
        { questionId: BigInt(3), payoutYes: BigInt(1), payoutNo: BigInt(0), blockNumber: BigInt(55_632_013) },
      ]);
    });

    it("skips malformed factory logs", () => {
      const bad = [
        { ...created, args: { ...created.args, conditionId: "0x00" } },
        { ...created, args: { ...created.args, question: 7 } },
        // Wider than the fee_bps integer column, so unstorable rather than merely odd.
        { ...created, args: { ...created.args, fee: BigInt("9007199254740993000") } },
        { ...created, eventName: "MarketResolved", args: { questionId: BigInt(3), payouts: [BigInt(1)] } },
        { ...created, blockNumber: null },
      ];
      const out = decodeFactoryLogs(bad);
      expect(out.created).to.deep.equal([]);
      expect(out.resolved).to.deep.equal([]);
    });
  });
});
