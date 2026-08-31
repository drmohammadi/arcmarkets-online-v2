/**
 * Multi-outcome event grouping.
 *
 * Arc's contracts are strictly binary (ConditionalTokens.OUTCOME_COUNT = 2, and
 * the count is baked into the conditionId hash), so an N-outcome event is
 * modeled the way Polymarket models it: one independent binary market per
 * outcome, each with its own FPMM and its own YES/NO price.
 *
 * Markets are grouped by a convention in the on-chain question string:
 *
 *     "US Election 2028: Democrat"
 *      ^^^^^^^^^^^^^^^^  ^^^^^^^^
 *      event title       outcome label
 *
 * Requires no contract change. A market with no separator is a standalone
 * binary market and is returned as a group of one.
 *
 * Grouping is deliberately conservative: a lone market that happens to contain
 * a colon does NOT become an "event" — a group is only formed when two or more
 * markets share the same event title. This avoids mislabeling questions that
 * merely use a colon (e.g. "Breaking: will X happen?").
 */

import type { Market } from '@/hooks/useMarkets';
import { sanitizeText } from './sanitize';
import { normalizeCategory, type CategoryKey } from './marketMeta';

/** Longest prefix we treat as an event title, to bound pathological strings. */
const MAX_TITLE_LEN = 120;

export interface ParsedQuestion {
  /** Event title if the question follows the convention, else null. */
  eventTitle: string | null;
  /** Outcome label if grouped, else the full question. */
  outcomeLabel: string;
}

/**
 * Split a sanitized question into (eventTitle, outcomeLabel) on the FIRST
 * colon. Both sides must be non-empty after trimming to count as a split.
 */
export function parseQuestion(rawQuestion: unknown): ParsedQuestion {
  const q = sanitizeText(rawQuestion);
  const idx = q.indexOf(':');
  if (idx <= 0 || idx >= q.length - 1) {
    return { eventTitle: null, outcomeLabel: q };
  }
  const title = q.slice(0, idx).trim();
  const label = q.slice(idx + 1).trim();
  if (!title || !label || title.length > MAX_TITLE_LEN) {
    return { eventTitle: null, outcomeLabel: q };
  }
  return { eventTitle: title, outcomeLabel: label };
}

/** A market plus its derived display fields. */
export interface MarketView {
  market: Market;
  /** Label shown for this specific outcome row. */
  outcomeLabel: string;
  /** Sanitized full question, for tooltips and standalone display. */
  fullQuestion: string;
}

export interface EventGroup {
  /** Stable key for React lists and URL fragments. */
  key: string;
  /** Display title: the shared event title, or the single market's question. */
  title: string;
  /** True when this group represents 2+ markets under one event. */
  isMultiOutcome: boolean;
  /** Canonical category, taken from the group's first market. */
  category: CategoryKey;
  /** Member markets, in questionId order. */
  markets: MarketView[];
  /** Earliest resolution time across members, for sorting and display. */
  earliestResolution: bigint;
  /** True only when every member market has resolved. */
  allResolved: boolean;
}

/**
 * Group a flat market list into events.
 *
 * Preserves questionId ordering within each group and orders groups by their
 * first-seen market, so the result is deterministic given the same input.
 */
export function groupMarkets(markets: Market[]): EventGroup[] {
  // Bucket by normalized (case-insensitive) event title.
  const buckets = new Map<string, { title: string; items: MarketView[] }>();
  const standalone: MarketView[] = [];
  // Preserves insertion order of group keys.
  const order: string[] = [];

  for (const m of markets) {
    const { eventTitle, outcomeLabel } = parseQuestion(m.question);
    const fullQuestion = sanitizeText(m.question);
    const view: MarketView = { market: m, outcomeLabel, fullQuestion };

    if (!eventTitle) {
      standalone.push(view);
      continue;
    }
    const key = eventTitle.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { title: eventTitle, items: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.items.push(view);
  }

  const groups: EventGroup[] = [];

  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (bucket.items.length < 2) {
      // A single colon-containing market is NOT an event; treat as standalone
      // and show its full question rather than a truncated outcome label.
      standalone.push({
        ...bucket.items[0],
        outcomeLabel: bucket.items[0].fullQuestion,
      });
      continue;
    }
    groups.push(buildGroup(`event:${key}`, bucket.title, bucket.items, true));
  }

  for (const view of standalone) {
    groups.push(
      buildGroup(
        `market:${view.market.questionId.toString()}`,
        view.fullQuestion || 'Untitled market',
        [view],
        false
      )
    );
  }

  // Stable ordering: by lowest questionId in the group, ascending.
  groups.sort((a, b) => {
    const aId = minQuestionId(a);
    const bId = minQuestionId(b);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  return groups;
}

function buildGroup(
  key: string,
  title: string,
  items: MarketView[],
  isMultiOutcome: boolean
): EventGroup {
  const sorted = [...items].sort((a, b) =>
    a.market.questionId < b.market.questionId ? -1 : a.market.questionId > b.market.questionId ? 1 : 0
  );
  const first = sorted[0].market;
  let earliest = first.resolutionTime;
  let allResolved = true;
  for (const it of sorted) {
    if (it.market.resolutionTime < earliest) earliest = it.market.resolutionTime;
    if (!it.market.resolved) allResolved = false;
  }
  return {
    key,
    title,
    isMultiOutcome,
    category: normalizeCategory(first.category, first.question),
    markets: sorted,
    earliestResolution: earliest,
    allResolved,
  };
}

function minQuestionId(g: EventGroup): bigint {
  let min = g.markets[0].market.questionId;
  for (const m of g.markets) if (m.market.questionId < min) min = m.market.questionId;
  return min;
}

/**
 * Find the group that contains a given questionId, so the detail page can show
 * sibling outcomes for a multi-outcome event.
 */
export function findGroupFor(groups: EventGroup[], questionId: bigint): EventGroup | null {
  for (const g of groups) {
    if (g.markets.some((m) => m.market.questionId === questionId)) return g;
  }
  return null;
}
