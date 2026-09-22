/**
 * The canonical message an admin signs to change a market's deleted flag.
 *
 * WHY A SIGNED MESSAGE AT ALL. Every other privileged action in this app is an
 * on-chain transaction, so the contract itself is the authority and there is no
 * server-side admin concept. Deletion is app state with no on-chain home, so it
 * needs one — and the cheapest correct answer is to keep using the same
 * authority: the caller signs, the SERVER recovers the address and compares it
 * to a fresh `MarketFactory.owner()` read. No session, no bearer token, no new
 * credential to steal or leak.
 *
 * WHY THE ACTION IS IN THE MESSAGE. A signature over a bare nonce authorizes
 * nothing in particular, so it could be replayed as any other request the
 * attacker likes. Binding the domain, chain, action, market ids, the flag value
 * and the reason means a signature for "delete #12" cannot be resubmitted as
 * "delete #99" — the rebuilt message would differ and recover a different
 * address.
 *
 * WHY BOTH SIDES BUILD IT FROM THIS ONE FUNCTION. The client signs what this
 * produces and the server verifies what this produces. If the two ever built the
 * string differently, every request would fail authorization for a reason no log
 * would explain. `contracts/test/AdminMessage.test.ts` pins the exact bytes.
 *
 * CANONICALISATION. Ids are sorted NUMERICALLY and de-duplicated, so
 * ["13","12"], ["12","13"] and ["12","12","13"] all produce one identical
 * message. Lexical sort would put "10" before "2" on the client and possibly not
 * on the server; numeric sort has one answer.
 *
 * Zero imports: `contracts/test/` compiles this under a CommonJS tsconfig.
 */

/** Bytes, not characters. A multi-byte string passes a character check and still blows the budget. */
export const MAX_REASON_BYTES = 200;

/** Matches `MarketMetadata.MAX_BATCH`, the convention already used for bulk admin writes. */
export const MAX_FLAG_BATCH = 50;

/** uint256 ids are unbounded, but a questionId is a factory counter. 19 digits fits int64. */
const MAX_ID_DIGITS = 19;

export interface AdminMessageFields {
  /** The host the request was made to, so a signature is not portable to another deployment. */
  domain: string;
  chainId: number;
  questionIds: readonly string[];
  deleted: boolean;
  reason: string | null;
  nonce: string;
  /** ISO-8601. Compared against the database clock server-side, never a client one. */
  expiresAt: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validate, de-duplicate and numerically sort the ids.
 *
 * Throws rather than silently dropping a bad id: a caller that asked to delete
 * three markets and got two deleted would have no way to notice.
 */
export function canonicalQuestionIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('questionIds must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') throw new Error('questionId must be a string');
    // Length cap BEFORE the regex, so an anonymous caller cannot force regex
    // work on a megabyte of digits -- the same order as the chart route.
    if (id.length === 0 || id.length > MAX_ID_DIGITS) throw new Error('questionId out of range');
    if (!/^[0-9]+$/.test(id)) throw new Error('questionId must be digits');
    // Normalise leading zeros so "07" and "7" cannot become two entries.
    seen.add(BigInt(id).toString());
  }
  if (seen.size > MAX_FLAG_BATCH) throw new Error('too many markets in one request');
  return Array.from(seen).sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export function buildAdminMessage(fields: AdminMessageFields): string {
  if (typeof fields.domain !== 'string' || fields.domain.length === 0) {
    throw new Error('domain is required');
  }
  if (!Number.isInteger(fields.chainId) || fields.chainId <= 0) {
    throw new Error('chainId must be a positive integer');
  }
  if (typeof fields.nonce !== 'string' || !/^[0-9a-f]{16,128}$/.test(fields.nonce)) {
    throw new Error('nonce must be lowercase hex');
  }
  if (typeof fields.expiresAt !== 'string' || fields.expiresAt.length === 0) {
    throw new Error('expiresAt is required');
  }
  if (typeof fields.deleted !== 'boolean') throw new Error('deleted must be a boolean');

  const reason = fields.reason ?? '';
  if (typeof reason !== 'string') throw new Error('reason must be a string or null');
  if (byteLength(reason) > MAX_REASON_BYTES) throw new Error('reason is too long');
  // A newline would let a reason forge extra message lines.
  if (/[\r\n]/.test(reason)) throw new Error('reason must be a single line');

  const ids = canonicalQuestionIds(fields.questionIds);

  return [
    '0xOutcome admin action',
    '',
    `Domain: ${fields.domain}`,
    `Chain: ${fields.chainId}`,
    'Action: set-deleted',
    `Markets: ${ids.join(',')}`,
    `Deleted: ${fields.deleted ? 'true' : 'false'}`,
    `Reason: ${reason === '' ? '-' : reason}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${fields.expiresAt}`,
  ].join('\n');
}
