/**
 * Global RPC request queue with rate limiting and 429 backoff.
 *
 * Public Arc testnet RPC returns HTTP 429 when requests arrive too fast, so
 * every RPC the app makes on a page's critical path goes through here.
 *
 * Design:
 *  - **Module-level singleton.** The limit is a property of the RPC endpoint,
 *    not of a component, so the queue must be shared across every hook instance
 *    and survive re-renders. A per-hook limiter would let four mounted charts
 *    each fire at the full rate.
 *  - **Two lanes, one endpoint budget.** See below.
 *  - **Exponential backoff on 429 only.** 1s, 2s, 4s, 8s then give up. Other
 *    errors fail immediately — retrying a malformed request just wastes budget.
 *  - **Global cooldown.** A 429 pauses BOTH lanes, not just the failing
 *    request, because the limit is endpoint-wide. Without this, queued requests
 *    would keep hitting a limit that is already tripped.
 *
 * ── WHY TWO LANES ────────────────────────────────────────────────────────────
 * `getLogs` and `eth_call` have very different cost and latency profiles, and
 * serializing them together is wrong in both directions.
 *
 *  - **Logs (`enqueueRpc`)** stay strictly serial. A log query can scan
 *    thousands of blocks; two in flight is what trips the limiter.
 *  - **Calls (`enqueueCall`)** run up to CALL_CONCURRENCY at a time. These are
 *    cheap point reads, and this chain has NO multicall3 deployed — viem's
 *    `multicall` throws `ChainDoesNotSupportContract`, which @wagmi/core catches
 *    and silently degrades into `Promise.allSettled(contracts.map(readContract))`.
 *    That is an UNTHROTTLED burst of one request per contract, and it was the
 *    single largest source of the 429s on the leaderboard, profile and portfolio
 *    pages. Routing those reads through this lane converts the burst into a
 *    paced stream while keeping enough parallelism that a cold load is not
 *    latency-bound.
 *
 * Both lanes share `cooldownUntil`, so a 429 raised by either one pauses
 * everything — the rate limit belongs to the endpoint, not to a lane.
 */

/** Minimum spacing between log-request starts. */
const MIN_GAP_MS = 120;
/** Minimum spacing between call starts. Lower: these are cheap point reads. */
const CALL_GAP_MS = 40;
/** How many `eth_call`s may be in flight at once. */
const CALL_CONCURRENCY = 4;
/** Backoff schedule for 429s, in ms. Length also caps the retry count. */
const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

type Task<T> = () => Promise<T>;

interface QueueEntry {
  run: () => Promise<void>;
}

const pending: QueueEntry[] = [];
let draining = false;
let lastStart = 0;
/** Timestamp (ms) before which no request may start, set by a 429. */
let cooldownUntil = 0;

/** Call-lane state, mirroring the log lane but with bounded concurrency. */
const callPending: QueueEntry[] = [];
let callActive = 0;
let callLastStart = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a rate-limit rejection.
 *
 * viem wraps transport errors, so the status may appear as a numeric `status`,
 * as an HTTP code inside the message, or as a JSON-RPC -32005 ("limit
 * exceeded"). Checked broadly because a missed 429 means no backoff at all.
 */
export function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const anyErr = err as Record<string, unknown>;
  if (anyErr.status === 429 || anyErr.code === 429 || anyErr.code === -32005) return true;

  const nested = anyErr.cause;
  if (nested && nested !== err && isRateLimit(nested)) return true;

  const msg = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('limit exceeded')
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const entry = pending.shift();
      if (!entry) continue;

      // Respect both the inter-request gap and any active 429 cooldown.
      const now = Date.now();
      const waitFor = Math.max(cooldownUntil - now, lastStart + MIN_GAP_MS - now, 0);
      if (waitFor > 0) await sleep(waitFor);

      lastStart = Date.now();
      await entry.run();
    }
  } finally {
    draining = false;
  }
}

/**
 * Queue an RPC call. Resolves with the task's value, or rejects with the last
 * error after the backoff schedule is exhausted.
 *
 * The task is invoked fresh on each attempt, so it must be a thunk rather than
 * an already-started promise.
 */
export function enqueueRpc<T>(task: Task<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          resolve(await task());
          return;
        } catch (err) {
          if (!isRateLimit(err) || attempt >= BACKOFF_MS.length) {
            reject(err);
            return;
          }
          // Pause every queued request: the limit is endpoint-wide.
          const delay = BACKOFF_MS[attempt];
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
          await sleep(delay);
        }
      }
    };

    pending.push({ run });
    void drain();
  });
}

/**
 * Queue a cheap point read (`eth_call`, `getBlockNumber`, …).
 *
 * Same retry/backoff/cooldown semantics as `enqueueRpc`, but runs up to
 * CALL_CONCURRENCY at a time so loading N market records does not take N gaps of
 * wall-clock. Use this for everything that is NOT a log query; use `enqueueRpc`
 * for `getLogs`.
 */
export function enqueueCall<T>(task: Task<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          resolve(await task());
          return;
        } catch (err) {
          if (!isRateLimit(err) || attempt >= BACKOFF_MS.length) {
            reject(err);
            return;
          }
          // Pause every queued request in BOTH lanes: the limit is endpoint-wide.
          const delay = BACKOFF_MS[attempt];
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
          await sleep(delay);
        }
      }
    };

    callPending.push({ run });
    void drainCalls();
  });
}

async function drainCalls(): Promise<void> {
  while (callActive < CALL_CONCURRENCY && callPending.length > 0) {
    const entry = callPending.shift();
    if (!entry) continue;

    callActive += 1;
    // Each worker waits for its own slot, so the gap staggers starts rather
    // than blocking the whole lane behind one slow request.
    void (async () => {
      try {
        const now = Date.now();
        const waitFor = Math.max(cooldownUntil - now, callLastStart + CALL_GAP_MS - now, 0);
        if (waitFor > 0) await sleep(waitFor);
        callLastStart = Date.now();
        await entry.run();
      } finally {
        callActive -= 1;
        void drainCalls();
      }
    })();
  }
}

/** True while a 429 cooldown is active. Lets the UI explain a stall honestly. */
export function isCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}
