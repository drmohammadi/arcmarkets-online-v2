/**
 * Shared log sweeper: gets event history deep enough to be useful, without
 * going back to the unbounded per-load scan that caused the 429s.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
 * The RPC-reduction pass replaced the chart's creation-block replay with a FIXED
 * window of the most recent 54,000 blocks (`LOOKBACK_BLOCKS = 9000 * 6`). That
 * made each load cheap and bounded, which was the goal — but the window is
 * anchored to the CHAIN HEAD, not to the market, so it silently stops containing
 * the data as soon as the chain outruns it. Every trade older than 54,000 blocks
 * became invisible.
 *
 * All three reported symptoms are that one window:
 *
 *   - the price chart drew a single point (the live price it appends itself),
 *     because zero Buy/Sell logs fell inside the window;
 *   - /profile showed "no trades in the recent window" for wallets that had
 *     traded, because the ledger uses the same window;
 *   - /leaderboard showed "no trades in the scanned window" for the same reason,
 *     which reads as "nobody has ever traded" rather than "we looked at the last
 *     few hours".
 *
 * A fixed head-anchored window is the wrong shape for history. It is a *cache
 * eviction policy* being used as a *query bound*: it throws away exactly the old
 * data that a price history and a cost basis are made of.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
 * A GROWING window, persisted, extended from both ends:
 *
 *   1. **Forward** from the cached upper bound to the head. Cheap, and it is what
 *      keeps an already-warm chart current after a trade.
 *   2. **Backward** from the cached lower bound, chunk by chunk, under a per-load
 *      budget — deepening the same cached range instead of re-fetching a sliding
 *      one.
 *
 * The cached range therefore only ever grows, so history accumulates rather than
 * ageing out from under the UI. Crucially, blocks below the cached lower bound
 * are the ONLY thing a repeat visit fetches, so depth is paid for once.
 *
 * This is not a return to the old replay. What made that expensive was not its
 * depth, it was: a full-history `getLogs` just to locate the creation block, FOUR
 * event types per chunk, a `getBlock` per distinct block for timestamps, and no
 * persistence, so every mount paid again. None of those are here. Depth alone is
 * comparatively cheap, and it is the part that was actually load-bearing.
 *
 * ── THE FLOOR IS THE ANCHOR, AND IT IS WHAT MAKES THIS TERMINATE ─────────────
 * A growing window still has to know when to stop growing. With `floor = 0` the
 * only stopping condition is the per-load budget, so on a long chain the sweep
 * crawls backward forever and never earns the right to say "this is the complete
 * history" — it just runs out of allowance somewhere and reports a shallow
 * window as though that were all there was.
 *
 * Callers now pass the factory's DEPLOYMENT BLOCK as `floor` (see
 * `lib/contracts.ts#getStartBlock`). No Buy/Sell event can exist below it, so it
 * is an exact bound, not a heuristic. On Arc testnet that turns an open-ended
 * crawl across 57,000,000+ blocks into a closed 1.7M-block range that finishes,
 * caches, and sets `reachedFloor` truthfully — which is what lets the UI say
 * "full trade history" instead of hedging forever.
 *
 * ── ADAPTIVE CHUNKING ────────────────────────────────────────────────────────
 * The chunk size starts LARGE and halves on refusal. A range refused for
 * returning too many results is not a 429, so backing off in time does not help
 * — only asking for less does. Starting large means a permissive endpoint covers
 * a lot of ground in few requests; halving means a strict one still makes
 * progress instead of ending the scan at its first dense range. Rate limiting is
 * left to `rpcQueue`'s backoff and treated as terminal here, because retrying
 * narrower ranges while the endpoint is asking for FEWER requests makes it worse.
 *
 * ── TOTAL ────────────────────────────────────────────────────────────────────
 * `sweepLogs` never throws. Every failure path yields whatever was gathered plus
 * flags describing what is missing, matching the convention the hooks already
 * follow: a partial line beats an error panel, and a truncated leaderboard is
 * honest where an empty one is not.
 */

import type { CachedEvent, CachedRange } from './logCache';

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/** An inclusive block range that has been covered. */
export interface CoveredRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface SweepOptions {
  /** Current chain head. */
  latest: bigint;
  /** Previously cached range and its events, or null for a cold load. */
  cached: CachedRange | null;
  /**
   * Fetch every event in an inclusive range. Must reject to signal failure;
   * resolving with `[]` means "covered, nothing there".
   */
  fetchRange: (from: bigint, to: bigint) => Promise<CachedEvent[]>;
  /** Lowest block worth scanning. Defaults to 0. */
  floor?: bigint;
  /** Blocks this load may newly cover going BACKWARD. Bounds a cold scan. */
  maxNewBlocks: bigint;
  /** Hard cap on requests for this load, so a halving storm cannot run away. */
  maxRequests?: number;
  /** First chunk size tried. Halved on a non-rate-limit refusal. */
  startChunk?: bigint;
  /** Give up on a range once halving would go below this. */
  minChunk?: bigint;
  /**
   * Stop extending BACKWARD once this many events are known.
   *
   * For a price chart a few hundred points is already more shape than a 200px
   * line can show, so digging further is pure cost. Omit to always spend the
   * full budget — which is what an aggregate like the leaderboard needs, since a
   * trader it has not seen yet may only appear deeper in history.
   */
  enough?: number;
  /** Cap on retained events; the NEWEST are kept. Defaults to 5000. */
  maxEvents?: number;
  /** True when the error is a rate limit, which must not be subdivided. */
  isFatal?: (err: unknown) => boolean;
}

export interface SweepResult {
  /** Merged, deduped, chain-ordered (block, then logIndex) events. */
  events: CachedEvent[];
  /** What is now covered, for the cache. Null when nothing could be read. */
  range: CoveredRange | null;
  /**
   * True when a request FAILED, so the covered range has a hole or stops short
   * of the head. Distinct from `reachedFloor`: a scan that succeeded but spent
   * its budget is not degraded, it is merely shallow.
   */
  incomplete: boolean;
  /** True when history is covered all the way down to `floor` — nothing older exists. */
  reachedFloor: boolean;
  /**
   * The widest block range this endpoint actually ACCEPTED at full chunk size,
   * or null if no full-size request succeeded.
   *
   * Reported so the caller can persist it (see `logCache.writeChunkCeiling`) and
   * open the next sweep at a size already known to work. Without that, every
   * cold load reopens at the optimistic `startChunk` and re-pays the same
   * halving probe to relearn a constant property of the endpoint.
   *
   * Only FULL-SIZE requests count. A sweep that merely catches up to the head
   * covers a handful of blocks, and a backward pass ends on whatever remainder
   * is left above the floor; treating either as "the widest range accepted"
   * would report a tiny number and persist it as the ceiling, throttling every
   * later scan to that size. The distinction is what makes this value safe to
   * store.
   */
  acceptedChunk: bigint | null;
  /**
   * True when the scan stopped because it ran out of budget rather than because
   * anything went wrong.
   *
   * Kept separate from `incomplete` so the UI does not cry wolf: a market whose
   * history simply lies deeper than one load's allowance is working perfectly,
   * and warning "some trades could not be loaded" about it would be false. The
   * next visit continues from the cached range.
   */
  budgetStopped: boolean;
  /** Requests actually issued, for diagnostics and tests. */
  requests: number;
}

/** Sentinel for hitting the request cap; separated so it is never mistaken for RPC failure. */
const BUDGET_EXHAUSTED = Symbol('budget');

function minOf(...values: bigint[]): bigint {
  let m = values[0];
  for (const v of values) if (v < m) m = v;
  return m;
}

/**
 * Extend a cached sweep at both ends.
 *
 * Contiguity is the invariant: the returned range is always a single unbroken
 * span. A chunk that fails ends that direction rather than being skipped, because
 * a range recorded as covered but containing a hole would make the next load
 * resume past missing events and lose them permanently.
 */
export async function sweepLogs(opts: SweepOptions): Promise<SweepResult> {
  const {
    latest,
    cached,
    fetchRange,
    floor = ZERO,
    maxNewBlocks,
    maxRequests = 40,
    startChunk = BigInt(45_000),
    minChunk = BigInt(1000),
    enough,
    maxEvents = 5000,
    isFatal = () => false,
  } = opts;

  let requests = 0;
  let incomplete = false;
  let budgetStopped = false;
  /** Widest range the endpoint accepted, for the caller to remember. */
  let acceptedChunk: bigint | null = null;

  /*
   * Floor of ONE block, whatever the caller asked for.
   *
   * `chunk` is a loop step, so a zero would mean a range of `from > to` in the
   * forward pass and a step of nothing in the backward pass — an infinite loop
   * issuing invalid queries. Clamping here keeps that unreachable no matter what
   * a caller passes, rather than relying on every call site to be sensible.
   */
  const floorChunk = minChunk > ONE ? minChunk : ONE;

  /*
   * The working chunk size, which only ever SHRINKS during a load.
   *
   * Halving one chunk is not enough on its own: if the endpoint refuses 45,000
   * blocks it will refuse the next 45,000 too, so a per-chunk-only retry pays a
   * wasted request for every chunk in the scan. Remembering the smaller size
   * turns that into a single one-off cost and lets the sweep self-tune to
   * whatever this endpoint actually allows.
   *
   * It is deliberately not grown back: re-probing a limit we have already been
   * told about would reintroduce exactly the wasted requests this avoids.
   */
  let chunk = startChunk < floorChunk ? floorChunk : startChunk;

  /**
   * One chunk, halving on a refusal that is not a rate limit.
   *
   * Resolves with every event in [from, to] or rejects, so the caller can treat
   * a chunk as atomic and keep its covered span contiguous.
   */
  async function fetchChunk(from: bigint, to: bigint): Promise<CachedEvent[]> {
    if (requests >= maxRequests) throw BUDGET_EXHAUSTED;
    try {
      requests += 1;
      const out = await fetchRange(from, to);
      /*
       * Record the accepted size, but ONLY for a request issued at the full
       * working chunk.
       *
       * A forward catch-up to the head spans a few blocks, and a backward pass
       * ends on whatever remainder sits above the floor. Both are small because
       * that is all that was ASKED for, not because the endpoint refused more.
       * Persisting one as the ceiling would pin every later sweep to it — a warm
       * reload extending 50 blocks would teach the app that this endpoint only
       * accepts 50-block ranges.
       */
      const span = to - from + ONE;
      if (span >= chunk && (acceptedChunk === null || span > acceptedChunk)) {
        acceptedChunk = span;
      }
      return out;
    } catch (err) {
      if (err === BUDGET_EXHAUSTED) throw err;
      // A rate limit has already exhausted rpcQueue's backoff. Splitting now
      // would add requests at the exact moment we were asked for fewer.
      if (isFatal(err)) throw err;

      const span = to - from + ONE;
      const half = span / TWO;
      if (half < floorChunk || span <= ONE) throw err;

      // Carry the narrower size forward to every later chunk in this sweep.
      if (half < chunk) chunk = half;

      // Lower half first so the two halves stay in ascending order.
      const mid = from + half - ONE;
      const lower = await fetchChunk(from, mid);
      const upper = await fetchChunk(mid + ONE, to);
      return [...lower, ...upper];
    }
  }

  const known: CachedEvent[] = [];
  let coveredFrom: bigint | null = null;
  let coveredTo: bigint | null = null;

  /*
   * Adopt the cached range only if it still makes sense against this head.
   *
   * A `toBlock` above the head means the chain moved backwards under us — a
   * testnet reset or a deep reorg. Reusing that range would make the forward
   * pass a no-op forever, pinning the UI to history from a chain that no longer
   * exists. Discarding is cheap; being wrong here is not recoverable.
   */
  if (cached) {
    try {
      const cf = BigInt(cached.fromBlock);
      const ct = BigInt(cached.toBlock);
      if (cf <= ct && ct <= latest) {
        coveredFrom = cf < floor ? floor : cf;
        coveredTo = ct;
        known.push(...cached.events);
      }
    } catch {
      // Unparseable range: treat as a cold load.
    }
  }

  const fresh: CachedEvent[] = [];

  // ── Forward: cached upper bound -> head ───────────────────────────────────
  //
  // Runs first and is not charged to the backward budget: being current at the
  // right-hand edge matters more than being deep, and this is the only part a
  // warm reload needs.
  if (coveredTo !== null) {
    while (coveredTo < latest) {
      const to = minOf(coveredTo + chunk, latest);
      try {
        fresh.push(...(await fetchChunk(coveredTo + ONE, to)));
        coveredTo = to;
      } catch (err) {
        // Running out of request budget is a self-imposed stop, not a failure of
        // the endpoint. Only the latter should make the UI warn.
        if (err === BUDGET_EXHAUSTED) budgetStopped = true;
        else incomplete = true;
        break;
      }
    }
  }

  // ── Backward: cached lower bound -> floor, under budget ───────────────────
  let budget = maxNewBlocks;
  let cursor = coveredFrom !== null ? coveredFrom - ONE : latest;

  const knownCount = () => known.length + fresh.length;
  const haveEnough = () => typeof enough === 'number' && knownCount() >= enough;

  while (cursor >= floor && budget > ZERO && !haveEnough()) {
    const span = minOf(chunk, budget, cursor - floor + ONE);
    const from = cursor - span + ONE;
    try {
      fresh.push(...(await fetchChunk(from, cursor)));
    } catch (err) {
      if (err === BUDGET_EXHAUSTED) budgetStopped = true;
      else incomplete = true;
      break;
    }
    // A cold load has no upper bound until its first chunk lands.
    if (coveredTo === null) coveredTo = cursor;
    coveredFrom = from;
    budget -= span;
    cursor = from - ONE;
  }

  // ── Merge ────────────────────────────────────────────────────────────────
  //
  // (block, logIndex) is unique chain-wide, so it dedupes across pools too —
  // which the shared ledger cache relies on. A boundary block re-fetched by the
  // forward pass must not double-count.
  const seen = new Set<string>();
  const merged: CachedEvent[] = [];
  for (const ev of [...known, ...fresh]) {
    const id = `${ev.blockNumber}:${ev.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(ev);
  }

  merged.sort((a, b) => {
    let ab: bigint;
    let bb: bigint;
    try {
      ab = BigInt(a.blockNumber);
      bb = BigInt(b.blockNumber);
    } catch {
      return 0;
    }
    if (ab !== bb) return ab < bb ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  /*
   * Trim from the HEAD (oldest first) when over the cap.
   *
   * The range is deliberately NOT narrowed to match. That would be the more
   * "correct"-looking bookkeeping, but it would make the next load re-fetch the
   * blocks whose events were just dropped, re-drop them, and never converge. The
   * cap is a memory bound on a display series, not a claim about coverage.
   */
  const events = merged.length > maxEvents ? merged.slice(merged.length - maxEvents) : merged;

  const range =
    coveredFrom !== null && coveredTo !== null && coveredFrom <= coveredTo
      ? { fromBlock: coveredFrom, toBlock: coveredTo }
      : null;

  return {
    events,
    range,
    incomplete,
    reachedFloor: coveredFrom !== null && coveredFrom <= floor,
    acceptedChunk,
    // Spending the whole block allowance is also a budget stop, not a failure.
    budgetStopped: budgetStopped || (budget <= ZERO && cursor >= floor),
    requests,
  };
}
