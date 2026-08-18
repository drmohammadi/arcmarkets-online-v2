/**
 * Output sanitization for user/chain-derived strings.
 *
 * Market questions, categories, and any string that originated off-chain or
 * from an untrusted caller are rendered in the UI. React escapes text nodes by
 * default, but we defense-in-depth here for: (1) values interpolated into
 * href/attributes, (2) any future dangerouslySetInnerHTML, (3) log output.
 *
 * Treat ALL contract-returned strings as untrusted — anyone can create a market
 * with an arbitrary question string.
 *
 * ── WHY CODEPOINTS, NOT REGEX ────────────────────────────────────────────────
 * The dangerous characters here are invisible ones: the replacement char,
 * zero-width joiners, and bidi overrides used for RTL display spoofing. Writing
 * them as regex character classes has failed in this file TWICE — each time the
 * source was reformatted, the escape sequences were replaced by the literal
 * invisible characters they denoted, turning the class into either a no-op or
 * an unintended range. The bug is invisible on screen and in review, by
 * construction.
 *
 * So the blocklist is a set of NUMBERS. A number cannot silently become
 * invisible, cannot be normalized away by an editor, and reviews as plain
 * ASCII. This file should contain no non-ASCII characters outside comments;
 * if a tool ever adds one, that is a bug.
 */

const MAX_DISPLAY_LEN = 500;

/** Descriptions get their own, larger budget. Matches MarketMetadata's on-chain
 *  MAX_DESCRIPTION_BYTES so the UI never truncates something the chain accepted. */
const MAX_DESCRIPTION_LEN = 2000;

/** Hard ceiling on rendered paragraphs, so a pathological input can't create
 *  thousands of DOM nodes. */
const MAX_PARAGRAPHS = 40;

/** U+000A. Kept by sanitizeMultiline, stripped by sanitizeText. */
const CODE_LF = 0x0a;
/** Everything at or below U+001F is a C0 control. */
const CODE_C0_MAX = 0x1f;
/** U+007F DELETE. */
const CODE_DEL = 0x7f;

/**
 * Individually-blocked codepoints, written as numbers on purpose (see header).
 *
 *   U+FFFD                REPLACEMENT CHARACTER (mojibake marker)
 *   U+200B..U+200D        zero-width space / non-joiner / joiner
 *   U+FEFF                zero-width no-break space (BOM)
 *   U+202A..U+202E        bidi embedding + override (RTL spoofing)
 *   U+2066..U+2069        bidi isolates (RTL spoofing)
 */
const BLOCKED_CODEPOINTS: ReadonlySet<number> = new Set([
  0xfffd,
  0x200b, 0x200c, 0x200d, 0xfeff,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

/**
 * Drop every control and blocked-invisible codepoint.
 *
 * Iterates by codepoint (for..of over a string yields whole code points, so
 * surrogate pairs stay intact and an emoji is never split into lone halves).
 */
function stripUnsafeCodepoints(input: string, keepNewlines: boolean): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === CODE_LF) {
      if (keepNewlines) out += ch;
      continue;
    }
    if (cp <= CODE_C0_MAX || cp === CODE_DEL) continue;
    if (BLOCKED_CODEPOINTS.has(cp)) continue;
    out += ch;
  }
  return out;
}

/**
 * Strip control chars, collapse whitespace, cap length. For plain-text display.
 * Does NOT allow any HTML — returns a safe text string.
 */
export function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return stripUnsafeCodepoints(input, false)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_LEN);
}

/**
 * Sanitize a multi-paragraph description into an array of plain-text paragraphs.
 *
 * WHY NOT sanitizeText: that function collapses ALL whitespace, which flattens a
 * multi-paragraph description into one unreadable line, and caps at 500 chars.
 * Descriptions are long-form and structured, so they need their own rules — but
 * exactly the same character-level threat model.
 *
 * Returns PARAGRAPHS rather than a string containing newlines, because the
 * caller renders them as separate <p> elements. That keeps the repo's
 * zero-exception "never dangerouslySetInnerHTML" rule intact: at no point does a
 * newline need to be converted into a <br> by injecting markup.
 *
 * Newlines are the one thing kept that sanitizeText discards, because they carry
 * the structure. Horizontal whitespace is still collapsed, so padded input can't
 * be used to draw shapes or push content off-screen.
 *
 * Total: never throws. Non-strings and empty input yield [].
 */
export function sanitizeMultiline(input: unknown, maxLen = MAX_DESCRIPTION_LEN): string[] {
  if (typeof input !== 'string') return [];

  // Normalize CRLF/CR to LF first, so paragraph splitting is line-ending agnostic.
  const normalized = input.replace(/\r\n?/g, '\n');

  const cleaned = stripUnsafeCodepoints(normalized, true)
    .replace(/[^\S\n]+/g, ' ') // collapse spaces/tabs, preserve newlines
    .replace(/\n{3,}/g, '\n\n') // at most one blank line between paragraphs
    .slice(0, Math.max(0, maxLen));

  return cleaned
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim()) // single newlines are soft wraps
    .filter((p) => p.length > 0)
    .slice(0, MAX_PARAGRAPHS);
}

/**
 * Escape a string for safe interpolation into an HTML attribute context.
 * Use when a value must go into an attribute we build manually.
 */
export function escapeHtmlAttr(input: unknown): string {
  return sanitizeText(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate that a string is a well-formed 0x-prefixed EVM address.
 * Returns the lowercase form, or null if invalid.
 * Never render an "address" from chain data without passing it through here.
 */
export function safeAddress(input: unknown): `0x${string}` | null {
  if (typeof input !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return null;
  return input.toLowerCase() as `0x${string}`;
}

/** Horizontal ellipsis, built from its codepoint for the reason in the header. */
const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * Truncate an address for display: 0x1234...abcd (with a real ellipsis).
 * Validates first.
 */
export function shortAddress(input: unknown): string {
  const addr = safeAddress(input);
  if (!addr) return 'unknown';
  return `${addr.slice(0, 6)}${ELLIPSIS}${addr.slice(-4)}`;
}
