/**
 * Deterministic per-market presentation metadata: icon, accent color, category.
 *
 * Icons are generated locally from the market's own text — no external image
 * fetches (privacy + no third-party dependency) and no new package. The same
 * market always renders the same icon on every client because the seed is a
 * pure hash of chain data.
 */

import { sanitizeText } from './sanitize';

/** FNV-1a 32-bit. Small, fast, well-distributed, and stable across engines. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Multiply by the FNV prime using shifts to stay inside 32-bit range.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Icon accent palette. Each entry is a Tailwind-safe pair of explicit classes
 * (not interpolated, so Tailwind's content scanner keeps them).
 */
const ACCENTS = [
  { bg: 'bg-blue-500/12', fg: 'text-blue-600 dark:text-blue-400', ring: 'ring-blue-500/20' },
  { bg: 'bg-violet-500/12', fg: 'text-violet-600 dark:text-violet-400', ring: 'ring-violet-500/20' },
  { bg: 'bg-emerald-500/12', fg: 'text-emerald-600 dark:text-emerald-400', ring: 'ring-emerald-500/20' },
  { bg: 'bg-amber-500/12', fg: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/20' },
  { bg: 'bg-rose-500/12', fg: 'text-rose-600 dark:text-rose-400', ring: 'ring-rose-500/20' },
  { bg: 'bg-cyan-500/12', fg: 'text-cyan-600 dark:text-cyan-400', ring: 'ring-cyan-500/20' },
  { bg: 'bg-indigo-500/12', fg: 'text-indigo-600 dark:text-indigo-400', ring: 'ring-indigo-500/20' },
  { bg: 'bg-teal-500/12', fg: 'text-teal-600 dark:text-teal-400', ring: 'ring-teal-500/20' },
] as const;

export type Accent = (typeof ACCENTS)[number];

/**
 * Canonical categories with a keyword matcher and a glyph name. The on-chain
 * category string is free-form, so we normalize it into one of these buckets
 * and fall back to 'Other' rather than trusting arbitrary input.
 */
export const CATEGORIES = [
  { key: 'politics', label: 'Politics', match: ['politic', 'election', 'president', 'senate', 'vote', 'govern'] },
  { key: 'crypto', label: 'Crypto', match: ['crypto', 'bitcoin', 'btc', 'eth', 'defi', 'token', 'stablecoin'] },
  { key: 'sports', label: 'Sports', match: ['sport', 'football', 'soccer', 'nba', 'nfl', 'cup', 'olympic', 'match'] },
  { key: 'economics', label: 'Economics', match: ['econ', 'inflation', 'rate', 'fed', 'gdp', 'cpi', 'recession'] },
  { key: 'tech', label: 'Tech', match: ['tech', 'ai', 'software', 'chip', 'space', 'launch', 'model'] },
  { key: 'culture', label: 'Culture', match: ['culture', 'movie', 'film', 'music', 'award', 'oscar', 'game'] },
  { key: 'other', label: 'Other', match: [] },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

/**
 * Map a raw on-chain category (and the question as a fallback signal) onto a
 * canonical category key. Always sanitizes first.
 */
export function normalizeCategory(rawCategory: unknown, question?: unknown): CategoryKey {
  const cat = sanitizeText(rawCategory).toLowerCase();
  const q = sanitizeText(question).toLowerCase();
  for (const c of CATEGORIES) {
    if (c.key === 'other') continue;
    if (c.label.toLowerCase() === cat) return c.key;
    if (c.match.some((m) => cat.includes(m))) return c.key;
  }
  // Only consult the question if the category gave us nothing usable.
  for (const c of CATEGORIES) {
    if (c.key === 'other') continue;
    if (c.match.some((m) => q.includes(m))) return c.key;
  }
  return 'other';
}

export function categoryLabel(key: CategoryKey): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? 'Other';
}

/** Pick a stable accent from a seed string. */
export function accentFor(seed: string): Accent {
  return ACCENTS[hashString(seed) % ACCENTS.length];
}

/**
 * Up-to-2-character monogram for the icon, derived from the market text.
 * Prefers initials of the first two significant words, else the first letters.
 */
export function monogramFor(text: unknown): string {
  const clean = sanitizeText(text).replace(/[^A-Za-z0-9 ]/g, ' ').trim();
  if (!clean) return '?';
  const stop = new Set(['will', 'the', 'a', 'an', 'be', 'is', 'to', 'of', 'in', 'on', 'by', 'at', 'for', 'and', 'or']);
  const words = clean.split(/\s+/).filter((w) => w.length > 0 && !stop.has(w.toLowerCase()));
  const pick = words.length > 0 ? words : clean.split(/\s+/);
  if (pick.length === 1) return pick[0].slice(0, 2).toUpperCase();
  return (pick[0][0] + pick[1][0]).toUpperCase();
}
