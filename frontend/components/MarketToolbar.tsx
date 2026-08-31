'use client';

import { CATEGORIES, type CategoryKey } from '@/lib/marketMeta';

export type SortKey = 'liquidity' | 'ending' | 'newest';
export type StatusKey = 'open' | 'resolved' | 'all';

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'ending', label: 'Ending soon' },
  { key: 'newest', label: 'Newest' },
];

const STATUSES: { key: StatusKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

/**
 * Search + category + status + sort controls for the market list.
 *
 * Fully controlled: all state lives in the page so the filtering logic is in
 * one place and this component stays presentational.
 */
export function MarketToolbar({
  query,
  onQuery,
  category,
  onCategory,
  status,
  onStatus,
  sort,
  onSort,
  counts,
  resultCount,
}: {
  query: string;
  onQuery: (v: string) => void;
  category: CategoryKey | 'all';
  onCategory: (v: CategoryKey | 'all') => void;
  status: StatusKey;
  onStatus: (v: StatusKey) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  /** Number of available markets per category, to hide empty tabs. */
  counts: Record<string, number>;
  resultCount: number;
}) {
  const visibleCategories = CATEGORIES.filter((c) => (counts[c.key] ?? 0) > 0);

  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={query} onChange={onQuery} />

        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="status-select">
            Status
          </label>
          <select
            id="status-select"
            value={status}
            onChange={(e) => onStatus(e.target.value as StatusKey)}
            className="h-9 rounded-lg border border-edge bg-surface-raised px-2 text-xs text-content"
          >
            {STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="sort-select">
            Sort by
          </label>
          <select
            id="sort-select"
            value={sort}
            onChange={(e) => onSort(e.target.value as SortKey)}
            className="h-9 rounded-lg border border-edge bg-surface-raised px-2 text-xs text-content"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {visibleCategories.length > 1 && (
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          <CategoryChip
            active={category === 'all'}
            onClick={() => onCategory('all')}
            label="All"
            count={resultCount}
          />
          {visibleCategories.map((c) => (
            <CategoryChip
              key={c.key}
              active={category === c.key}
              onClick={() => onCategory(c.key)}
              label={c.label}
              count={counts[c.key] ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex-1">
      <label className="sr-only" htmlFor="market-search">
        Search markets
      </label>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-content-subtle"
        fill="none"
      >
        <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        id="market-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search markets"
        autoComplete="off"
        className="h-9 w-full rounded-lg border border-edge bg-surface-raised pl-8 pr-2 text-sm text-content placeholder:text-content-subtle"
      />
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-content text-surface'
          : 'border border-edge text-content-muted hover:border-edge-strong hover:text-content'
      }`}
    >
      {label}
      <span className={`ml-1 tabular-nums ${active ? 'opacity-60' : 'text-content-subtle'}`}>{count}</span>
    </button>
  );
}
