/**
 * Centralized external + informational links.
 *
 * Single source of truth: nothing in the app hardcodes a social or policy URL.
 * Change a destination here and every render site follows.
 *
 * Each entry is env-overridable so a fork or a preview deployment can point at
 * its own community/docs without a code change. Values are resolved through
 * `safeExternalUrl`, which enforces an https-only allowlist — a malformed or
 * javascript:/data: URL yields `null` and the link is simply not rendered,
 * rather than shipping a clickable script sink.
 *
 * NEXT_PUBLIC_* is required for the value to reach the browser bundle. Next
 * inlines these at build time, so they must be referenced as full literal
 * property accesses (process.env.NEXT_PUBLIC_X), never computed.
 */

/**
 * Accept only absolute https URLs. Rejects javascript:, data:, vbscript:,
 * protocol-relative and malformed input.
 *
 * Total: never throws, returns null on anything it cannot vouch for.
 */
export function safeExternalUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Internal app routes are validated separately: they must be root-relative and
 * single-slash, which excludes "//evil.com" (protocol-relative, treated as
 * external by browsers) and any absolute URL.
 */
export function safeInternalPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('//')) return null;
  return trimmed;
}

/** Matches MarketMetadata.MAX_URL_BYTES, so the UI rejects what the chain would. */
const MAX_IMAGE_URL_LEN = 512;

/**
 * Validate a market/outcome image URL supplied by an admin.
 *
 * Built on safeExternalUrl, so it inherits the https-only allowlist: a
 * `javascript:`, `data:` or protocol-relative URL yields null and simply never
 * reaches an <img src>.
 *
 * ── WHAT THIS CANNOT DO ──────────────────────────────────────────────────────
 * A URL is a promise, not a payload. This function cannot verify that the
 * target is an image, that it stays reachable, or that its bytes are the same
 * ones the admin previewed — the host can swap them at any time after approval.
 * That is inherent to referencing a third-party URL instead of storing pixels,
 * and it is a real change from the uploaded-image path, which re-encoded files
 * through a canvas so only pixels survived.
 *
 * The mitigations that DO hold, applied at the render site:
 *   - https only (here), so no script-bearing scheme can be linked
 *   - referrerPolicy="no-referrer", so the third-party host is not told which
 *     market or page the viewer is on
 *   - a fixed box with object-fit, so a hostile aspect ratio cannot break layout
 *   - onError fallback to the generated monogram, so a dead link is not a hole
 *
 * The viewer's IP is still disclosed to the image host on load. Only the
 * contract owner can set these URLs, which bounds this to a trusted role.
 */
export function safeImageUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length > MAX_IMAGE_URL_LEN) return null;
  const url = safeExternalUrl(input);
  if (!url || url.length > MAX_IMAGE_URL_LEN) return null;
  return url;
}

export interface SiteLink {
  label: string;
  /** Resolved destination, or null when unset/invalid — caller skips rendering. */
  href: string | null;
  /** External links get target/rel treatment and a visual affordance. */
  external: boolean;
}

export interface LinkSection {
  heading: string;
  links: SiteLink[];
}

/**
 * Native-gas faucet.
 *
 * Distinct from the in-app MockUSDC faucet button, and both are needed on
 * testnet: `MockUSDC.faucet()` mints COLLATERAL to trade with, but Arc's gas
 * token is native USDC — so a wallet with a zero native balance cannot even pay
 * for the transaction that calls it. This link is the way out of that deadlock.
 */
export const FAUCET_URL: string | null = safeExternalUrl(
  process.env.NEXT_PUBLIC_LINK_FAUCET ?? 'https://faucet.circle.com'
);

/** Brand/product identity, kept here so the footer and header agree. */
export const SITE = {
  name: process.env.NEXT_PUBLIC_SITE_NAME || 'Arc Markets',
  tagline: 'Binary prediction markets settled in USDC on Circle Arc L1.',
} as const;

/**
 * Optional custom logo image.
 *
 * Resolved through `safeExternalUrl`, so it is https-only: an http, data: or
 * javascript: URL yields null and the built-in monogram mark is rendered
 * instead. Null is the normal, supported state — not a misconfiguration.
 *
 * NEXT_PUBLIC_* is inlined at build time, so this must be a full literal
 * property access and a change requires a rebuild.
 */
export const LOGO_URL: string | null = safeExternalUrl(process.env.NEXT_PUBLIC_LOGO_URL);

function external(label: string, raw: string | undefined, fallback: string): SiteLink {
  return { label, href: safeExternalUrl(raw ?? fallback), external: true };
}

function internal(label: string, path: string): SiteLink {
  return { label, href: safeInternalPath(path), external: false };
}

/**
 * A link whose default is an in-app route, but which an operator may override
 * with either another app path or an external https URL.
 *
 * Needed because About/Terms/Privacy now ship as real pages, yet a fork may want
 * to point them at its own hosted policies. The override is validated as one or
 * the other — never blindly trusted — and an unusable override falls back to the
 * built-in page rather than rendering a dead link.
 */
function internalOrExternal(
  label: string,
  raw: string | undefined,
  fallbackPath: string
): SiteLink {
  const override = (raw ?? '').trim();
  if (override) {
    const ext = safeExternalUrl(override);
    if (ext) return { label, href: ext, external: true };
    const int = safeInternalPath(override);
    if (int) return { label, href: int, external: false };
  }
  return { label, href: safeInternalPath(fallbackPath), external: false };
}

/**
 * Community / social destinations.
 *
 * Defaults point at the real Arc + Circle properties rather than placeholder
 * URLs, so an unconfigured deployment still links somewhere truthful. Override
 * per-deployment with the corresponding env var.
 */
export const SOCIAL_LINKS: SiteLink[] = [
  external('Twitter / X', process.env.NEXT_PUBLIC_LINK_TWITTER, 'https://x.com/circle'),
  external('Discord', process.env.NEXT_PUBLIC_LINK_DISCORD, 'https://discord.com/invite/buildoncircle'),
];

/**
 * Informational pages.
 *
 * About now resolves to a real in-app route. The env override is still honoured
 * for forks that host their own copy — `internalOrExternal` accepts either an
 * app path or an https URL, so an operator can point these anywhere without a
 * code change.
 */
export const RESOURCE_LINKS: SiteLink[] = [
  internalOrExternal('About', process.env.NEXT_PUBLIC_LINK_ABOUT, '/about'),
  external('Documentation', process.env.NEXT_PUBLIC_LINK_DOCS, 'https://developers.circle.com/arc'),
  external('Faucet', process.env.NEXT_PUBLIC_LINK_FAUCET, 'https://faucet.circle.com'),
  external('Contact', process.env.NEXT_PUBLIC_LINK_CONTACT, 'https://developers.circle.com/support'),
];

/**
 * Legal/policy destinations.
 *
 * These default to this app's OWN Terms and Privacy pages. They previously
 * pointed at Circle's corporate legal pages, which describe Circle's products —
 * not this interface — so they told a visitor nothing about the site they were
 * actually using.
 */
export const LEGAL_LINKS: SiteLink[] = [
  internalOrExternal('Terms', process.env.NEXT_PUBLIC_LINK_TERMS, '/terms'),
  internalOrExternal('Privacy', process.env.NEXT_PUBLIC_LINK_PRIVACY, '/privacy'),
];

/**
 * In-app navigation echoed in the footer.
 *
 * Points at `/profile` rather than the old `/portfolio`: holdings are rendered
 * inside the profile now, and linking to the redirect would send every footer
 * click through an extra hop to reach the same page.
 */
export const APP_LINKS: SiteLink[] = [
  internal('Markets', '/'),
  internal('Leaderboard', '/leaderboard'),
  internal('Profile', '/profile'),
];

/**
 * Footer layout. Sections with no resolvable links are filtered at render time,
 * so an aggressively-overridden deployment degrades to fewer columns instead of
 * rendering empty headings.
 */
export const FOOTER_SECTIONS: LinkSection[] = [
  { heading: 'Markets', links: APP_LINKS },
  { heading: 'Resources', links: RESOURCE_LINKS },
  { heading: 'Community', links: SOCIAL_LINKS },
  { heading: 'Legal', links: LEGAL_LINKS },
];

/** Drop unresolvable links, then drop sections left empty. */
export function resolvedSections(sections: LinkSection[] = FOOTER_SECTIONS): LinkSection[] {
  return sections
    .map((s) => ({ heading: s.heading, links: s.links.filter((l) => l.href !== null) }))
    .filter((s) => s.links.length > 0);
}
