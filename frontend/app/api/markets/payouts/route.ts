/**
 * `GET /api/markets/payouts` — resolution payouts per market, out of Postgres.
 *
 * WHY THIS IS SAFE TO SERVE FROM THE INDEX. A payout is immutable once written:
 * `ConditionalTokens.reportPayouts` reverts with `ConditionAlreadyResolved` when
 * `payoutDenominator != 0`, so a resolved condition can never be re-reported.
 * There is no staleness to worry about — only absence, and absence is handled.
 *
 * THE DENOMINATOR IS DERIVED, NOT STORED, AND THAT IS EXACT. The contract sets
 * `cond.payoutDenominator = payouts[0] + payouts[1]` (`ConditionalTokens.sol:79-83`)
 * and rejects a zero sum, so the denominator is always the sum of the two
 * numerators. `markets.payout_yes` / `payout_no` come from `MarketResolved`,
 * which carries that same `uint256[2]`. Recomputing the sum is therefore
 * reproducing the contract's own arithmetic, not approximating it.
 *
 * THE LIVE RESOLUTION CHECK STAYS ON RPC. This route reports what the INDEX
 * knows. A market that resolved since the last tick is resolved on chain and not
 * yet here, so the caller keeps filtering by the live `resolved` flag from
 * `markets(questionId)` and treats a missing entry as "not known yet" — which
 * falls back to an RPC `getPayouts`. That ordering matters: `payoutFor`
 * returning null means "we do not know" and the ledger renders it as an unknown
 * status, whereas defaulting to zero would tell a winning trader they lost.
 *
 * KEYED BY conditionId, NOT questionId. That is what the ledger looks payouts up
 * by, and `markets.condition_id` is indexed alongside the payout columns, so the
 * join happens here rather than in the browser.
 */

import { NextResponse } from 'next/server';
import { ensurePoolReachable } from '@/lib/db/pool';
import { selectMarketPayouts } from '@/lib/db/queries';
import { getIndexerConfig } from '@/lib/indexer/config';

/** `pg` speaks TCP, which the edge runtime has no sockets for. */
export const runtime = 'nodejs';

/** Resolution can land in any block; a build-time snapshot would be a lie. */
export const dynamic = 'force-dynamic';

/** Headroom for a Neon wake-up, matching the other indexed routes. */
export const maxDuration = 30;

/**
 * Longer than the trade routes on purpose: a payout never changes once written,
 * so the only thing a cache can cost here is the delay before a NEWLY resolved
 * market appears — and the caller falls back to RPC for exactly that case.
 */
const CACHE_OK = 'public, s-maxage=60, stale-while-revalidate=300';

const CACHE_NONE = 'no-store';

function jsonWith(body: unknown, status: number, cache: string): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': cache } });
}

export async function GET(): Promise<NextResponse> {
  try {
    // Inside the try: it throws when DATABASE_URL is unset, and never at module
    // scope — `next build` imports this file.
    const config = getIndexerConfig();
    await ensurePoolReachable();

    const rows = await selectMarketPayouts(config.chainId);

    /*
     * Only RESOLVED markets with a non-zero sum are emitted. An unresolved
     * condition has a zero denominator on chain and the ledger must not treat it
     * as settled; omitting it here produces the same "unknown" that a failed RPC
     * read would, which is the behaviour the ledger is already written against.
     */
    const payouts = rows
      .filter((r) => r.resolved && r.payoutYes !== null && r.payoutNo !== null)
      .map((r) => {
        const yes = r.payoutYes as bigint;
        const no = r.payoutNo as bigint;
        return {
          // The ledger looks payouts up by CONDITION id, so that is the key.
          conditionId: r.conditionId.toLowerCase(),
          questionId: r.questionId.toString(),
          // Strings: these are uint256 on chain and a JSON number would corrupt
          // them above 2^53.
          numerators: [yes.toString(), no.toString()] as [string, string],
          denominator: (yes + no).toString(),
        };
      })
      // A zero denominator would be a division by zero in the ledger. The
      // contract rejects a zero sum, so this can only fire on a corrupt row —
      // dropping it yields "unknown", never a wrong number.
      .filter((p) => p.denominator !== '0' && p.conditionId.length > 0);

    return jsonWith({ payouts }, 200, CACHE_OK);
  } catch (err) {
    /*
     * 200 with `degraded`, not a 5xx: the caller falls back to reading
     * `getPayouts` over RPC, and a suspended Neon endpoint must not look like an
     * outage. The message is logged, never returned — it can name a host or a
     * statement, and this endpoint is public.
     */
    console.error(
      '[payouts] serving from the index failed; degrading:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return jsonWith({ payouts: [], degraded: true }, 200, CACHE_NONE);
  }
}
