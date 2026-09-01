import { expect } from "chai";
import { custom, numberToHex, toEventSelector, type EIP1193RequestFn } from "viem";
import { BACKOFF_MS } from "../../frontend/lib/indexer/chunking";
import { FPMM_EVENTS } from "../../frontend/lib/indexer/decode";
import { createIndexerRpc } from "../../frontend/lib/indexer/rpc";

/**
 * WHY THIS FILE EXISTS. Every policy in `rpc.ts` fails SILENTLY when it is wrong:
 * a mis-recorded `acceptedSpan` throttles every later scan of every pool, a
 * range refusal mistaken for a rate limit burns the whole request budget, and a
 * sweep with no budget at all turns a cron tick into thousands of requests.
 * None of those raise anything — they just yield progressively less data, which
 * is the exact failure CLAUDE.md documents twice. Only assertions catch them.
 *
 * NO NETWORK. The transport is viem's `custom()`, driven by a hand-written stub,
 * and the backoff clock is injected, so the ladder is asserted in microseconds
 * rather than waited out for 15 seconds. Arc testnet is never contacted.
 */

const RPC_URL = "https://rpc.invalid/never-called";
const POOL_A = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const POOL_B = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";
const POOL_C = "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc";
const TRADER = "0xDDddDDddDDddDDddDDddDDddDDddDDddDDddDDdd";

interface Call {
  method: string;
  params: unknown[];
}

/** The `eth_getLogs` filter object, as the stub receives it. */
interface LogFilter {
  address?: unknown;
  topics?: unknown;
  fromBlock?: string;
  toBlock?: string;
}

type Handler = (method: string, params: unknown[], nth: number) => unknown;

/**
 * A viem transport backed by `handler`, recording every call.
 *
 * `retryCount: 0` matters: viem retries some failures inside the transport by
 * default, which would double-count attempts and make the ladder assertions
 * meaningless. The retry under test is the one in `rpc.ts`.
 */
function stubTransport(handler: Handler) {
  const calls: Call[] = [];
  const request = (async (args: { method: string; params?: unknown }) => {
    const params = (args.params ?? []) as unknown[];
    calls.push({ method: args.method, params });
    return handler(args.method, params, calls.length - 1);
  }) as unknown as EIP1193RequestFn;
  return { transport: custom({ request }, { retryCount: 0 }), calls };
}

/** Every `eth_getLogs` span, as "from-to", in the order it was requested. */
function spans(calls: Call[]): string[] {
  return calls
    .filter((c) => c.method === "eth_getLogs")
    .map((c) => {
      const f = c.params[0] as LogFilter;
      return `${BigInt(f.fromBlock ?? "0x0")}-${BigInt(f.toBlock ?? "0x0")}`;
    });
}

function filterOf(calls: Call[], nth = 0): LogFilter {
  return calls.filter((c) => c.method === "eth_getLogs")[nth].params[0] as LogFilter;
}

const BUY = FPMM_EVENTS.find((e) => e.name === "Buy")!;
const BUY_TOPIC = toEventSelector(BUY);

const word = (v: number) => v.toString(16).padStart(64, "0");

/** A raw JSON-RPC Buy log the real pipeline will accept and decode. */
function buyLog(pool: string, blockNumber: bigint, logIndex: number) {
  return {
    address: pool.toLowerCase(),
    topics: [BUY_TOPIC, `0x${"0".repeat(24)}${TRADER.slice(2).toLowerCase()}`],
    data: `0x${word(0)}${word(1_000_000)}${word(1_800_000)}`,
    blockNumber: numberToHex(blockNumber),
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x1",
    logIndex: numberToHex(BigInt(logIndex)),
    removed: false,
  };
}

/** One log per range, tagged with the range's own first block so unions are checkable. */
function oneLogPerRange(params: unknown[]) {
  const f = params[0] as LogFilter;
  return [buyLog(POOL_A, BigInt(f.fromBlock ?? "0x0"), 0)];
}

const blockNumbers = (logs: unknown[]): bigint[] =>
  logs.map((l) => (l as { blockNumber: bigint }).blockNumber);

/** Arc's own refusal: `-32012 requested range too large`. Not a 429. */
function rangeTooLarge(): Error {
  return Object.assign(new Error("requested range too large"), { code: -32012 });
}

function rateLimited(): Error {
  return Object.assign(new Error("Too Many Requests"), { code: 429 });
}

/** Injected clock: records what the ladder asked for, waits for none of it. */
function recordingSleep() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection, got a resolved promise");
}

describe("indexer rpc", () => {
  describe("one request covers every pool and every event", () => {
    it("sends the whole address array and all four topic0s in a single call", async () => {
      const { transport, calls } = stubTransport((_m, params) => oneLogPerRange(params));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: [POOL_A, POOL_B, POOL_C],
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(1000),
      });

      expect(spans(calls), "one request, not one per address or per event").to.deep.equal([
        "1-1000",
      ]);
      const filter = filterOf(calls);
      expect(filter.address).to.deep.equal([
        POOL_A.toLowerCase(),
        POOL_B.toLowerCase(),
        POOL_C.toLowerCase(),
      ]);
      const topics = filter.topics as string[][];
      expect(topics[0], "topic0 is an OR-set of all four FPMM events").to.have.length(4);
      expect(topics[0]).to.contain(BUY_TOPIC);
      expect(res.requests).to.equal(1);
      expect(res.coveredTo).to.equal(BigInt(1000));
      expect(res.budgetStopped).to.equal(false);
      expect(res.logs).to.have.length(1);
    });
  });

  describe("range refusals", () => {
    it("halves and recurses into BOTH halves, returning their union", async () => {
      const { transport, calls } = stubTransport((_m, params, nth) => {
        if (nth === 0) throw rangeTooLarge();
        return oneLogPerRange(params);
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(4000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(4000),
      });

      expect(spans(calls)).to.deep.equal(["1-4000", "1-2000", "2001-4000"]);
      expect(new Set(spans(calls)).size, "no span is ever re-sent").to.equal(3);
      expect(blockNumbers(res.logs), "the union of both halves, ascending").to.deep.equal([
        BigInt(1),
        BigInt(2001),
      ]);
      expect(res.requests).to.equal(3);
      expect(res.coveredTo).to.equal(BigInt(4000));
    });

    /*
     * The narrower width must carry FORWARD. Without the re-plan, the range
     * already planned at 8000 blocks pays its own refusal — a wasted request per
     * chunk for the rest of the sweep (`logScan.ts:218-226`).
     */
    it("re-plans the remainder at the narrower width", async () => {
      const { transport, calls } = stubTransport((_m, params, nth) => {
        if (nth === 0) throw rangeTooLarge();
        return oneLogPerRange(params);
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(8000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(16_000),
      });

      expect(spans(calls)).to.deep.equal([
        "1-8000",
        "1-4000",
        "4001-8000",
        "8001-12000",
        "12001-16000",
      ]);
      expect(res.coveredTo).to.equal(BigInt(16_000));
      expect(res.logs).to.have.length(4);
    });

    it("gives up on a refusal it cannot subdivide any further", async () => {
      const { transport, calls } = stubTransport(() => {
        throw rangeTooLarge();
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      await rejection(() =>
        rpc.getLogsAdaptive({
          address: POOL_A,
          events: FPMM_EVENTS,
          from: BigInt(1),
          to: BigInt(1000),
        })
      );
      // MIN_CHUNK is 1000, so a refused 1000-block span cannot be halved: one
      // request, then a rejection, rather than log2 requests down to one block.
      expect(spans(calls)).to.deep.equal(["1-1000"]);
    });
  });

  describe("rate limits", () => {
    it("retries the SAME span on the ladder and succeeds", async () => {
      const clock = recordingSleep();
      const { transport, calls } = stubTransport((_m, params, nth) => {
        if (nth < 2) throw rateLimited();
        return oneLogPerRange(params);
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), {
        transport,
        sleep: clock.sleep,
      });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(1000),
      });

      expect(spans(calls), "the same span, never split").to.deep.equal([
        "1-1000",
        "1-1000",
        "1-1000",
      ]);
      expect(clock.slept, "the ladder, in order").to.deep.equal([BACKOFF_MS[0], BACKOFF_MS[1]]);
      expect(res.requests).to.equal(3);
      expect(res.logs).to.have.length(1);
    });

    it("gives up after BACKOFF_MS.length retries rather than retrying forever", async () => {
      const clock = recordingSleep();
      const { transport, calls } = stubTransport(() => {
        throw rateLimited();
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), {
        transport,
        sleep: clock.sleep,
      });

      await rejection(() =>
        rpc.getLogsAdaptive({
          address: POOL_A,
          events: FPMM_EVENTS,
          from: BigInt(1),
          to: BigInt(1000),
        })
      );

      expect(calls, "one initial attempt plus the ladder").to.have.length(BACKOFF_MS.length + 1);
      expect(clock.slept).to.deep.equal([...BACKOFF_MS]);
      // A rate limit is NOT a width problem: the span is never halved.
      expect(new Set(spans(calls))).to.deep.equal(new Set(["1-1000"]));
    });
  });

  it("propagates any other error without retrying it", async () => {
    const { transport, calls } = stubTransport(() => {
      throw new Error("malformed filter");
    });
    const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

    const err = await rejection(() =>
      rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(1000),
      })
    );
    expect(calls, "not retried, not halved").to.have.length(1);
    expect(String(err)).to.contain("malformed filter");
  });

  /*
   * The gate that protects every LATER scan: a short request proves nothing about
   * the endpoint's limit, and remembering one as the ceiling would pin all future
   * sweeps to it (`logScan.ts:240-250`).
   */
  describe("acceptedSpan", () => {
    it("is recorded for a full-size request, and ignores the short tail", async () => {
      const { transport } = stubTransport((_m, params) => oneLogPerRange(params));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(1500),
      });

      expect(res.coveredTo).to.equal(BigInt(1500));
      expect(res.acceptedSpan, "the 1000-block range, not the 500-block tail").to.equal(
        BigInt(1000)
      );
    });

    it("is null when the sweep only ever asked for less than the chunk", async () => {
      const { transport } = stubTransport((_m, params) => oneLogPerRange(params));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(500),
      });

      expect(res.coveredTo).to.equal(BigInt(500));
      expect(
        res.acceptedSpan,
        "a 500-block catch-up must not teach a 500-block ceiling"
      ).to.equal(null);
    });
  });

  /*
   * "Stopped early on purpose" is not "something failed". CLAUDE.md calls
   * conflating them a bug that makes the UI warn about a working system, so the
   * budget resolves with a flag while a real failure rejects.
   */
  describe("request budget", () => {
    it("stops at maxRequests, reporting where to resume", async () => {
      const { transport, calls } = stubTransport((_m, params) => oneLogPerRange(params));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(10_000),
        maxRequests: 3,
      });

      expect(spans(calls)).to.deep.equal(["1-1000", "1001-2000", "2001-3000"]);
      expect(res.budgetStopped, "deliberate, not a failure").to.equal(true);
      expect(res.coveredTo, "resume at 3001").to.equal(BigInt(3000));
      expect(res.requests).to.equal(3);
      expect(blockNumbers(res.logs)).to.deep.equal([BigInt(1), BigInt(1001), BigInt(2001)]);
    });

    it("reports budgetStopped false when the whole span was covered", async () => {
      const { transport } = stubTransport((_m, params) => oneLogPerRange(params));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(3000),
        maxRequests: 10,
      });

      expect(res.budgetStopped).to.equal(false);
      expect(res.coveredTo).to.equal(BigInt(3000));
      expect(res.requests).to.equal(3);
    });

    /*
     * A range interrupted mid-halving contributes NOTHING, so `coveredTo` stays
     * below it. Reporting half a range as covered would leave a permanent hole:
     * the caller resumes above the missing events and never fetches them again.
     */
    it("treats a range cut short by the budget as covering nothing", async () => {
      const { transport, calls } = stubTransport((_m, params, nth) => {
        if (nth === 0) throw rangeTooLarge();
        return oneLogPerRange(params);
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(4000), { transport });

      const res = await rpc.getLogsAdaptive({
        address: POOL_A,
        events: FPMM_EVENTS,
        from: BigInt(1),
        to: BigInt(4000),
        maxRequests: 2,
      });

      expect(spans(calls)).to.deep.equal(["1-4000", "1-2000"]);
      expect(res.budgetStopped).to.equal(true);
      expect(res.coveredTo, "nothing is contiguously covered").to.equal(null);
      expect(res.logs, "the completed half is discarded, not half-reported").to.have.length(0);
    });
  });

  describe("address filter", () => {
    /*
     * `address: []` is read by most nodes as "no address filter", which would
     * match those four topic0s from ANY contract on the chain and write foreign
     * events into market_events. Arc's handling is unverified, so the guard is
     * ours.
     */
    it("refuses an empty array rather than widening to the whole chain", async () => {
      const { transport, calls } = stubTransport(() => []);
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const err = await rejection(() =>
        rpc.getLogsAdaptive({
          address: [],
          events: FPMM_EVENTS,
          from: BigInt(1),
          to: BigInt(1000),
        })
      );
      expect(err.message).to.contain("empty address filter");
      expect(calls, "nothing is sent").to.have.length(0);
    });

    it("refuses a malformed address rather than silently dropping it", async () => {
      const { transport, calls } = stubTransport(() => []);
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const err = await rejection(() =>
        rpc.getLogsAdaptive({
          address: [POOL_A, "0xnope"],
          events: FPMM_EVENTS,
          from: BigInt(1),
          to: BigInt(1000),
        })
      );
      expect(err.message).to.contain("malformed address filter");
      expect(calls).to.have.length(0);
    });
  });

  describe("block reads", () => {
    it("returns the head, retrying a rate limit", async () => {
      const clock = recordingSleep();
      const { transport, calls } = stubTransport((_m, _p, nth) => {
        if (nth === 0) throw rateLimited();
        return numberToHex(BigInt(57_300_000));
      });
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), {
        transport,
        sleep: clock.sleep,
      });

      expect(await rpc.getBlockNumber()).to.equal(BigInt(57_300_000));
      expect(calls).to.have.length(2);
      expect(clock.slept).to.deep.equal([BACKOFF_MS[0]]);
    });

    it("returns a lowercased hash and the timestamp", async () => {
      const { transport } = stubTransport(() => ({
        number: numberToHex(BigInt(55_632_013)),
        hash: `0x${"AB".repeat(32)}`,
        timestamp: numberToHex(BigInt(1_800_000_000)),
      }));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      expect(await rpc.getBlockHeader(BigInt(55_632_013))).to.deep.equal({
        hash: `0x${"ab".repeat(32)}`,
        timestamp: BigInt(1_800_000_000),
      });
    });

    it("refuses a block with no hash, which cannot witness a reorg", async () => {
      const { transport } = stubTransport(() => ({
        number: null,
        timestamp: numberToHex(BigInt(1_800_000_000)),
      }));
      const rpc = createIndexerRpc(RPC_URL, BigInt(1000), { transport });

      const err = await rejection(() => rpc.getBlockHeader(BigInt(1)));
      expect(err.message).to.contain("has no hash");
    });
  });
});
