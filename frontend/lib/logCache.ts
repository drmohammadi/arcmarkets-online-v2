/**
 * Persistent cache for FPMM trade events.
 *
 * Historical logs below a confirmed block are immutable, so once a range is
 * fetched it never needs fetching again. The cache stores, per (chain, pool):
 * the block range already covered and the events found in it. A later load
 * resumes from `toBlock + 1` instead of rescanning.
 *
 * Two tiers:
 *  - **Module memory** — survives component unmount and route changes within a
 *    session, so navigating between markets costs nothing.
 *  - **localStorage** — survives a reload AND a tab close.
 *
 * ── WHY THIS MOVED FROM sessionStorage TO localStorage ───────────────────────
 * This was deliberately sessionStorage, on the reasoning that a long-lived cache
 * of chain state risks serving data from a chain that has since been reset, and
 * per-tab scope keeps that failure window short. That reasoning was sound about
 * the risk and wrong about the cost.
 *
 * The cost: covering Arc testnet's ~1.7M blocks between the factory deployment
 * and the head takes tens of `getLogs` requests. Under sessionStorage that bill
 * came due again in every new tab, so the scan restarted from nothing constantly
 * and, on a rate-limited endpoint, frequently never finished. Depth that is
 * re-paid forever is depth the UI never gets to show.
 *
 * The risk is handled directly instead, and more precisely than tab scope ever
 * did: `sweepLogs` discards a cached range whose `toBlock` is above the current
 * head, which is the observable signature of a reset or deep reorg. That check
 * catches the actual failure, whereas per-tab scope only made it shorter-lived —
 * a reset mid-session was already able to serve stale data, and a long-lived tab
 * was never protected at all. `CACHE_VERSION` remains the escape hatch for shape
 * changes.
 *
 * BigInt does not survive JSON, so block numbers are persisted as decimal
 * strings and revived on read. A malformed or version-mismatched entry is
 * discarded rather than trusted.
 */

/**
 * Bump when the stored shape or its MEANING changes, to invalidate old entries.
 *
 * v4: entries carry a per-event `address` (the pool it came from). The chart's
 * per-pool entries always knew their pool from the cache key, but the shared
 * ledger cache stores MANY pools under one synthetic key, so its events must
 * remember which address they belong to. v3 entries have the same other fields
 * but no address, so reusing one would silently drop every event's pool.
 *
 * v5: storage moved from sessionStorage to localStorage (see above). The shape is
 * unchanged, but the bump gives every client a clean first read in the new
 * backing store rather than inheriting a half-covered range written under
 * different assumptions about how long it would live.
 */
const CACHE_VERSION = 5;
const KEY_PREFIX = 'arc-loghist-v' + CACHE_VERSION + ':';

/** Cap on persisted events per entry — beyond this, keep memory-only. */
const MAX_PERSISTED_EVENTS = 4000;

/** One decoded event, in the minimal form the consumers need. */
export interface CachedEvent {
  /** The pool (FPMM) that emitted this event, lowercased. */
  address: string;
  blockNumber: string;
  logIndex: number;
  name: string;
  /** Event args as decimal strings; bigint-safe across JSON. */
  args: Record<string, string>;
}

export interface CachedRange {
  /** First block covered by this cache entry. */
  fromBlock: string;
  /** Last block covered (inclusive). */
  toBlock: string;
  events: CachedEvent[];
}

const memory = new Map<string, CachedRange>();

function keyFor(chainId: number, pool: string): string {
  return `${KEY_PREFIX}${chainId}:${pool.toLowerCase()}`;
}

/** Narrow unknown parsed JSON into a CachedRange, or null if it doesn't fit. */
function validate(raw: unknown): CachedRange | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fromBlock !== 'string' || typeof obj.toBlock !== 'string') return null;
  if (!Array.isArray(obj.events)) return null;

  const events: CachedEvent[] = [];
  for (const e of obj.events) {
    if (!e || typeof e !== 'object') return null;
    const ev = e as Record<string, unknown>;
    if (typeof ev.blockNumber !== 'string') return null;
    if (typeof ev.logIndex !== 'number') return null;
    if (typeof ev.name !== 'string') return null;
    if (typeof ev.address !== 'string') return null;
    if (!ev.args || typeof ev.args !== 'object') return null;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(ev.args as Record<string, unknown>)) {
      if (typeof v !== 'string') return null;
      args[k] = v;
    }
    // Rebuilt field by field on purpose, so an unvalidated key cannot ride
    // along from storage. Any NEW field must be added here too, or it will be
    // silently dropped on every cache read.
    events.push({
      address: ev.address,
      blockNumber: ev.blockNumber,
      logIndex: ev.logIndex,
      name: ev.name,
      args,
    });
  }

  // Reject a range that cannot be interpreted as block numbers.
  try {
    if (BigInt(obj.fromBlock) > BigInt(obj.toBlock)) return null;
  } catch {
    return null;
  }

  return {
    fromBlock: obj.fromBlock,
    toBlock: obj.toBlock,
    events,
  };
}

export function readCache(chainId: number, pool: string): CachedRange | null {
  const key = keyFor(chainId, pool);

  const hit = memory.get(key);
  if (hit) return hit;

  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = validate(JSON.parse(raw) as unknown);
    if (!parsed) {
      window.localStorage.removeItem(key);
      return null;
    }
    memory.set(key, parsed);
    return parsed;
  } catch {
    // Storage disabled, quota error, or bad JSON: memory-only is fine.
    return null;
  }
}

export function writeCache(chainId: number, pool: string, range: CachedRange): void {
  const key = keyFor(chainId, pool);
  memory.set(key, range);

  if (typeof window === 'undefined') return;
  if (range.events.length > MAX_PERSISTED_EVENTS) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(range));
  } catch {
    // Over quota or storage blocked: the memory tier still works.
    //
    // Evict this cache's own older entries and retry once. Without this, one
    // full origin quota permanently pins every later scan to memory-only, which
    // silently reinstates the "re-pay the whole scan in every tab" behaviour
    // this cache exists to prevent.
    try {
      pruneOtherEntries(key);
      window.localStorage.setItem(key, JSON.stringify(range));
    } catch {
      // Genuinely out of room. Memory tier still serves this session.
    }
  }
}

/** Drop every entry this module owns except `keep`, to free quota. */
function pruneOtherEntries(keep: string): void {
  const doomed: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX) && k !== keep) doomed.push(k);
  }
  for (const k of doomed) window.localStorage.removeItem(k);
}

/* ─────────────────────── learned getLogs range ceiling ───────────────────── */

/**
 * The largest `getLogs` block range this endpoint has actually accepted.
 *
 * Endpoints cap `eth_getLogs` by range and reject anything wider — Arc testnet
 * answers `-32012 requested range too large`. That is not a rate limit, so the
 * only way through is to ask for less, and `sweepLogs` finds the ceiling by
 * halving until a request lands.
 *
 * Persisting the result is what makes that probe affordable. The ceiling is a
 * property of the ENDPOINT, not of a page or a pool, so re-discovering it on
 * every load means every cold scan opens by spending requests to relearn a
 * constant. Remembering it means the probe is paid once per browser and every
 * later sweep opens at a size known to work.
 *
 * Stored per chain, and only ever written when a range genuinely succeeded.
 */
const CHUNK_KEY_PREFIX = KEY_PREFIX + 'chunk:';

export function readChunkCeiling(chainId: number): bigint | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CHUNK_KEY_PREFIX + chainId);
    if (!raw) return null;
    const v = BigInt(raw);
    return v > BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Remember an accepted range size, if it beats what is already stored.
 *
 * Monotonic on purpose. Halving inside a single sweep already handles an endpoint
 * that refuses a range, and it does so per-request with current information. A
 * stored value that could also go DOWN would let one unusually dense range — a
 * refusal about RESULT COUNT, not about range width — permanently throttle every
 * later scan on every pool. Raising only means the worst case is a few wasted
 * halving requests in a sweep that then self-corrects, instead of a persistent
 * slowdown that never recovers.
 */
export function writeChunkCeiling(chainId: number, chunk: bigint): void {
  if (typeof window === 'undefined') return;
  if (chunk <= BigInt(0)) return;
  const existing = readChunkCeiling(chainId);
  if (existing !== null && existing >= chunk) return;
  try {
    window.localStorage.setItem(CHUNK_KEY_PREFIX + chainId, chunk.toString());
  } catch {
    // Not worth failing a load over; the probe just repeats next time.
  }
}
