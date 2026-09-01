import { expect } from "chai";
import {
  applyEvent, replay, yesProbBps, execYesBps, zeroState,
  type IndexedEvent, type PoolState,
} from "../../frontend/lib/indexer/replay";

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
    expect(yesProbBps(BigInt(0), BigInt(0))).to.equal(5000);
    expect(yesProbBps(BigInt(1000), BigInt(1000))).to.equal(5000);
    expect(yesProbBps(BigInt(910), BigInt(1100))).to.equal(5472);
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

  it("reproduces the contract's endingSellReserve", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    // sell(outcome=0, returnAmount=50) with fee=0 yields sharesIn=94,
    // and calcSellAmount's endingSellReserve is 954.
    s = applyEvent(s, ev("sell", 50, 94, 0)).state;
    expect(s.reserveYes).to.equal(BigInt(954));
    expect(s.reserveNo).to.equal(BigInt(1050));
  });

  it("addLiquidity MOVES the price on an unbalanced pool", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    const before = yesProbBps(s.reserveYes, s.reserveNo); // 5472
    s = applyEvent(s, ev("liquidity_added", 100, 90)).state;
    expect(s.reserveYes).to.equal(BigInt(1010));
    expect(s.reserveNo).to.equal(BigInt(1200));
    // Equal amounts onto unequal reserves pull the ratio toward 50/50.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(5429);
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.be.lessThan(before);
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

  it("computes execution price on the YES side and rejects nonsense", () => {
    expect(execYesBps("buy", 0, BigInt(100), BigInt(190))).to.equal(5263);
    // A NO buy at 5263 on the NO side is 4737 on the YES side.
    expect(execYesBps("buy", 1, BigInt(100), BigInt(190))).to.equal(10000 - 5263);
    expect(execYesBps("buy", 0, BigInt(100), BigInt(0))).to.equal(null);
    // A share cannot be worth more than the 1 USDC it pays out.
    expect(execYesBps("buy", 0, BigInt(200), BigInt(100))).to.equal(null);
    expect(execYesBps("liquidity_added", null, BigInt(100), BigInt(100))).to.equal(null);
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
});
