/**
 * Validation for the market metadata fields (description / image URL /
 * resolution source).
 *
 * Extracted so the two places that write metadata — the create form on /admin
 * and the per-market edit form — enforce identical rules. When these lived
 * inline they could drift, and the failure mode is a transaction that reverts
 * after the admin has already paid gas to create the market.
 *
 * Every limit here mirrors a constant in contracts/src/MarketMetadata.sol.
 * They are checked in BYTES, not characters, because that is what the contract
 * checks: a multi-byte UTF-8 string can pass a character-count check and still
 * revert. Keep these in sync with the Solidity if the caps ever change.
 */

import { safeImageUrl } from './links';

export const MAX_DESCRIPTION_BYTES = 2000;
export const MAX_URL_BYTES = 512;
export const MAX_SOURCE_BYTES = 256;

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

export interface MetadataFields {
  description: string;
  imageUrl: string;
  resolutionSource: string;
}

export type MetadataValidation =
  | ({ ok: true } & MetadataFields)
  | { ok: false; error: string };

/**
 * Normalize and validate the three fields.
 *
 * An empty image URL is allowed here (it means "no image"); callers that
 * REQUIRE one — market creation does — check for that separately, so this
 * function stays reusable for editing a market that legitimately has none.
 *
 * Returns the normalized values on success: the URL is the parsed form from
 * safeImageUrl, not the raw input, so what gets written on-chain is exactly
 * what was validated.
 */
export function validateMetadataFields(fields: MetadataFields): MetadataValidation {
  const description = fields.description.trim();
  const rawUrl = fields.imageUrl.trim();
  const resolutionSource = fields.resolutionSource.trim();

  if (byteLength(description) > MAX_DESCRIPTION_BYTES) {
    return {
      ok: false,
      error: `Description is too long (${byteLength(description)} bytes, max ${MAX_DESCRIPTION_BYTES}).`,
    };
  }
  if (byteLength(resolutionSource) > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `Resolution source is too long (max ${MAX_SOURCE_BYTES} bytes).`,
    };
  }

  let imageUrl = '';
  if (rawUrl !== '') {
    const safe = safeImageUrl(rawUrl);
    if (!safe) {
      return {
        ok: false,
        error: `Image URL must be an https:// address of at most ${MAX_URL_BYTES} bytes.`,
      };
    }
    if (byteLength(safe) > MAX_URL_BYTES) {
      return { ok: false, error: `Image URL is too long (max ${MAX_URL_BYTES} bytes).` };
    }
    imageUrl = safe;
  }

  return { ok: true, description, imageUrl, resolutionSource };
}
