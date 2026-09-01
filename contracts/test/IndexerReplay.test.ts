import { expect } from "chai";
import {
  applyEvent, replay, yesProbBps, execYesBps, zeroState,
  type IndexedEvent, type PoolState,
} from "../../frontend/lib/indexer/replay";
// The invariant under test is that the indexer and the UI price a pool
// identically, so compare against the REAL implementation rather than against
// literals copied out of it. pricing.ts imports only ./format, which imports
// nothing, so it resolves under this workspace's CommonJS tsconfig.
import { yesProbBps as uiYesProbBps } from "../../frontend/lib/pricing";

const ev = (
  kind: IndexedEvent["kind"],
  collateral: number,
  shares: number,
  outcome: 0 | 1 | null = null,
  logIndex = 0
): IndexedEvent => ({
  blockNumber: BigInt(100 + logIndex), logIndex, txHash: "0xtx",
  fpmm: "0xpool", kind, actor: "0xactor", outcome,
  collateral: BigInt(collateral), shares: BigInt(shares),
});

describe("indexer replay", () => {
  it("mirrors lib/pricing.ts, including the empty pool", () => {
    const huge = BigInt(2) ** BigInt(255);
    const cases: Array<[bigint, bigint]> = [
      [BigInt(0), BigInt(0)],                 // empty pool -> NEUTRAL_BPS
      [BigInt(1000), BigInt(1000)],           // balanced
      [BigInt(910), BigInt(1100)],            // after a 100-for-190 YES buy
      [BigInt(1100), BigInt(910)],            // the NO-side mirror
      [BigInt(1), BigInt(999_999_999)],       // heavily lopsided, YES near-worthless
      [BigInt(999_999_999), BigInt(1)],       // heavily lopsided the other way
      [huge, huge - BigInt(1)],               // uint256 scale, total = 2^256 - 1
    ];
    for (const [yes, no] of cases) {
      const mine = yesProbBps(yes, no);
      expect(mine, `yes=${yes} no=${no}`).to.equal(uiYesProbBps(yes, no));
      expect(mine).to.be.within(0, 10000);
    }
    // The one value that is a documented constant rather than a computation.
    expect(yesProbBps(BigInt(0), BigInt(0))).to.equal(5000);
    expect(uiYesProbBps(BigInt(0), BigInt(0))).to.equal(5000);
  });

  it("seeds a balanced pool at even odds", () => {
    const { state } = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000));
    expect(state).to.deep.equal({
      reserveYes: BigInt(1000), reserveNo: BigInt(1000), totalSupply: BigInt(1000),
    });
    expect(yesProbBps(state.reserveYes, state.reserveNo)).to.equal(5000);
  });

  it("moves the price the right way on a YES buy", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    // buy(outcome=0, investmentAmount=100) with fee=0 yields sharesOut=190.
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    expect(s.reserveYes).to.equal(BigInt(910));
    expect(s.reserveNo).to.equal(BigInt(1100));
    // Buying YES makes YES dearer: 5000 -> 5472.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(5472);
  });

  it("moves the price the right way on a NO buy", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    // buy(outcome=1, investmentAmount=100): calcBuyAmount reads buyReserve=no=1000,
    // otherReserve=yes=1000, so it is the exact mirror -> sharesOut=190.
    s = applyEvent(s, ev("buy", 100, 190, 1)).state;
    // The 190 shares leave the NO side this time, not the YES side.
    expect(s.reserveYes).to.equal(BigInt(1100));
    expect(s.reserveNo).to.equal(BigInt(910));
    // Buying NO makes YES cheaper. Not exactly 10000-5472: both sides floor, so
    // 4527.36 -> 4527 while 5472.63 -> 5472, and the pair sums to 9999.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(4527);
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.be.lessThan(5000);
  });

  it("reproduces the contract's endingSellReserve", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    // sell(outcome=0, returnAmount=50) with fee=0 yields sharesIn=94,
    // and calcSellAmount's endingSellReserve is 954.
    s = applyEvent(s, ev("sell", 50, 94, 0)).state;
    expect(s.reserveYes).to.equal(BigInt(954));
    expect(s.reserveNo).to.equal(BigInt(1050));
  });

  it("reproduces endingSellReserve on the NO side too", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 1)).state; // yes=1100, no=910
    // sell(outcome=1, returnAmount=50): sellReserve=no=910, otherReserve=yes=1100,
    // endingSellReserve = ceilDiv(910*1100, 1050) = 954, sharesIn = 50+954-910 = 94.
    s = applyEvent(s, ev("sell", 50, 94, 1)).state;
    expect(s.reserveNo).to.equal(BigInt(954));
    expect(s.reserveYes).to.equal(BigInt(1050));
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(4760);
  });

  it("addLiquidity MOVES the price on an unbalanced pool", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    const before = yesProbBps(s.reserveYes, s.reserveNo); // 5472
    // shares = amount*totalSupply/min(yes,no) = 100*1000/910 = 109 (:110).
    s = applyEvent(s, ev("liquidity_added", 100, 109)).state;
    expect(s.reserveYes).to.equal(BigInt(1010));
    expect(s.reserveNo).to.equal(BigInt(1200));
    // Equal amounts onto unequal reserves pull the ratio toward 50/50.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(5429);
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.be.lessThan(before);
  });

  it("recomputes addLiquidity's LP shares and flags a mismatch", () => {
    // First LP is 1:1 with the collateral (:105-106).
    expect(applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).checksumOk).to.equal(true);
    expect(applyEvent(zeroState(), ev("liquidity_added", 1000, 999)).checksumOk).to.equal(false);
    // Afterwards it is proportional to the smaller PRE-event reserve (:109-110).
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state; // yes=910, no=1100, ts=1000
    expect(applyEvent(s, ev("liquidity_added", 100, 109)).checksumOk).to.equal(true);
    expect(applyEvent(s, ev("liquidity_added", 100, 90)).checksumOk).to.equal(false);
  });

  it("removeLiquidity does NOT move the price, and its checksum holds", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    s = applyEvent(s, ev("sell", 50, 94, 0)).state; // yes=954, no=1050, ts=1000
    const before = yesProbBps(s.reserveYes, s.reserveNo);
    // shares=500 -> yesOut=477, noOut=525, so the contract emits collateral=477.
    const res = applyEvent(s, ev("liquidity_removed", 477, 500));
    expect(res.checksumOk).to.equal(true);
    expect(res.state.reserveYes).to.equal(BigInt(477));
    expect(res.state.reserveNo).to.equal(BigInt(525));
    expect(res.state.totalSupply).to.equal(BigInt(500));
    // Proportional withdrawal preserves the ratio.
    expect(yesProbBps(res.state.reserveYes, res.state.reserveNo)).to.equal(before);
  });

  it("flags a checksum mismatch instead of trusting the replay", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    const res = applyEvent(s, ev("liquidity_removed", 999, 500)); // should be 500
    expect(res.checksumOk).to.equal(false);
  });

  it("never divides by zero on an empty LP supply", () => {
    const res = applyEvent(zeroState(), ev("liquidity_removed", 10, 5));
    expect(res.checksumOk).to.equal(false);
    expect(res.state).to.deep.equal(zeroState());
  });

  it("stands still on a trade with no outcome side", () => {
    const s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    // A Buy log we could not attribute to a side. Guessing would corrupt every
    // later event, so the state must not move and the row must be flagged.
    const res = applyEvent(s, ev("buy", 100, 190, null));
    expect(res.checksumOk).to.equal(false);
    expect(res.state).to.deep.equal(s);
    expect(execYesBps("buy", null, BigInt(100), BigInt(190))).to.equal(null);
  });

  it("floors a negative reserve at zero and flags the gap", () => {
    // A Sell replayed without the liquidity that preceded it: the merge takes 50
    // off a NO reserve of 0. Impossible on-chain, so it means our history has a
    // hole; the value is floored so it stays storable, and flagged so it is not
    // mistaken for truth.
    const res = applyEvent(zeroState(), ev("sell", 50, 94, 0));
    expect(res.checksumOk).to.equal(false);
    expect(res.state).to.deep.equal({
      reserveYes: BigInt(44), reserveNo: BigInt(0), totalSupply: BigInt(0),
    });
  });

  it("computes execution price on the YES side and rejects nonsense", () => {
    expect(execYesBps("buy", 0, BigInt(100), BigInt(190))).to.equal(5263);
    // A NO buy at 5263 on the NO side is 4737 on the YES side.
    expect(execYesBps("buy", 1, BigInt(100), BigInt(190))).to.equal(10000 - 5263);
    expect(execYesBps("buy", 0, BigInt(100), BigInt(0))).to.equal(null);
    // A share cannot be worth more than the 1 USDC it pays out.
    expect(execYesBps("buy", 0, BigInt(200), BigInt(100))).to.equal(null);
    expect(execYesBps("liquidity_added", null, BigInt(100), BigInt(100))).to.equal(null);
  });

  it("returns a real, falsy 0 rather than null at the price floor", () => {
    // Consumers must use === null / ??, never truthiness: both of these are 0.
    // A NO trade at 10000 bps on its own side is 0 bps on the YES side.
    expect(execYesBps("sell", 1, BigInt(100), BigInt(100))).to.equal(0);
    // And a sub-1bp YES trade in a lopsided pool floors to 0: 1*10000/20000 = 0.
    expect(execYesBps("buy", 0, BigInt(1), BigInt(20000))).to.equal(0);
    expect(execYesBps("buy", 0, BigInt(1), BigInt(20000))).to.not.equal(null);
  });

  it("replays a series in order and carries reserves onto each row", () => {
    const rows = replay(zeroState(), [
      ev("liquidity_added", 1000, 1000, null, 0),
      ev("buy", 100, 190, 0, 1),
      ev("sell", 50, 94, 0, 2),
    ]);
    expect(rows).to.have.length(3);
    expect(rows[0].yesBps).to.equal(5000);
    expect(rows[1].yesBps).to.equal(5472);
    expect(rows[2].reserveYes).to.equal(BigInt(954));
    expect(rows[2].yesBps).to.equal(5239);
    expect(rows[0].execYesBps).to.equal(null);
    expect(rows[1].execYesBps).to.equal(5263);
  });

  it("sorts shuffled events before folding, and does not mutate the input", () => {
    const seed = ev("liquidity_added", 1000, 1000, null, 0);
    const buy = ev("buy", 100, 190, 0, 1);
    const sell = ev("sell", 50, 94, 0, 2);
    // Chunked eth_getLogs can hand these back in any order; the arithmetic is
    // order-dependent, so replay must sort rather than trust the caller.
    const shuffled = [sell, seed, buy];
    const rows = replay(zeroState(), shuffled);
    expect(rows).to.deep.equal(replay(zeroState(), [seed, buy, sell]));
    // Assert the ORDER, not just the endpoint: folding the sell first happens to
    // land on the same final reserveYes, so an unsorted replay is only visible in
    // the per-row sequence.
    expect(rows.map((r) => r.kind)).to.deep.equal(["liquidity_added", "buy", "sell"]);
    expect(rows.map((r) => r.yesBps)).to.deep.equal([5000, 5472, 5239]);
    expect(rows.every((r) => r.checksumOk)).to.equal(true);
    expect(shuffled).to.deep.equal([sell, seed, buy]);
  });
});
