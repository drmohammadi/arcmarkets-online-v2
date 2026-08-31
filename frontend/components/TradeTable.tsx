'use client';

import Link from 'next/link';
import { Badge } from './ui';
import { formatUsdc } from '@/lib/format';
import { formatProbPct } from '@/lib/pricing';
import { parseQuestion } from '@/lib/eventGroups';
import type { TradeRow } from '@/hooks/useTradeStats';
import type { TradeStatus } from '@/lib/ledger';

/**
 * A wallet's trade history.
 *
 * Renders as a table on desktop and as stacked cards on mobile — the same
 * markup, restyled — because a seven-column table on a phone either overflows
 * horizontally or truncates every cell to uselessness.
 *
 * PnL is shown per POSITION, not per trade: a buy has no profit of its own until
 * it is sold or settled, so each buy row shows the state of the position it
 * belongs to. Sell rows are terminal and show what that sale locked in.
 */
export function TradeTable({ trades }: { trades: TradeRow[] }) {
  return (
    <>
      {/* Mobile: one card per trade. */}
      <ul className="space-y-2 sm:hidden">
        {trades.map((t) => (
          <li
            key={`${t.blockNumber.toString()}:${t.logIndex}`}
            className="rounded-card border border-edge bg-surface-raised p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <MarketLink trade={t} />
              <StatusBadge status={t.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-content-muted">
              <SideTag side={t.side} outcome={t.outcome} />
              <span className="tabular-nums">
                {t.priceBps !== null ? `@ ${formatProbPct(t.priceBps)}` : '@ —'}
              </span>
              <span className="tabular-nums">${formatUsdc(t.collateral)}</span>
              <span className="tabular-nums text-content-subtle">
                {formatUsdc(t.shares)} shares
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop: a real table. */}
      <div className="hidden overflow-hidden rounded-card border border-edge sm:block">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wide text-content-subtle">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Market</th>
              <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
              <th scope="col" className="px-3 py-2 font-medium">Side</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Entry</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Shares</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr
                key={`${t.blockNumber.toString()}:${t.logIndex}`}
                className="border-t border-edge"
              >
                <td className="max-w-[220px] px-3 py-2">
                  <MarketLink trade={t} />
                </td>
                <td className="px-3 py-2">
                  <span className={t.outcome === 0 ? 'text-yes' : 'text-no'}>
                    {t.outcome === 0 ? 'Yes' : 'No'}
                  </span>
                </td>
                <td className="px-3 py-2 uppercase text-content-muted">{t.side}</td>
                <td className="px-3 py-2 text-right tabular-nums text-content-muted">
                  {t.priceBps !== null ? formatProbPct(t.priceBps) : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-content">
                  ${formatUsdc(t.collateral)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-content-muted">
                  {formatUsdc(t.shares)}
                </td>
                <td className="px-3 py-2 text-right">
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MarketLink({ trade }: { trade: TradeRow }) {
  if (trade.questionId === null) {
    return <span className="text-xs text-content-subtle">Unknown market</span>;
  }
  const parsed = parseQuestion(trade.market?.question);
  const title = parsed.eventTitle
    ? `${parsed.eventTitle}: ${parsed.outcomeLabel}`
    : parsed.outcomeLabel || `Market #${trade.questionId.toString()}`;

  return (
    <Link
      href={`/market/${trade.questionId.toString()}`}
      className="line-clamp-2 text-xs font-medium text-content hover:underline"
      title={title}
    >
      {title}
    </Link>
  );
}

function SideTag({ side, outcome }: { side: 'buy' | 'sell'; outcome: 0 | 1 }) {
  return (
    <span className="font-medium uppercase">
      <span className="text-content-muted">{side} </span>
      <span className={outcome === 0 ? 'text-yes' : 'text-no'}>
        {outcome === 0 ? 'Yes' : 'No'}
      </span>
    </span>
  );
}

/**
 * Status of the position a trade belongs to.
 *
 * "Refunded" deliberately does NOT read as restitution: the contract's [1,1]
 * payout settles BOTH sides at 0.50, so someone who bought at 0.80 still lost.
 * The tooltip says so.
 */
function StatusBadge({ status }: { status: TradeStatus }) {
  const map: Record<TradeStatus, { tone: 'yes' | 'no' | 'brand' | 'neutral' | 'warn'; label: string; title?: string }> = {
    open: { tone: 'neutral', label: 'Open' },
    closed: { tone: 'neutral', label: 'Closed' },
    won: { tone: 'yes', label: 'Won' },
    lost: { tone: 'no', label: 'Lost' },
    refunded: {
      tone: 'warn',
      label: 'Refunded',
      title: 'Both outcomes settled at $0.50 per share, so this is not a full refund of what you paid.',
    },
    unknown: {
      tone: 'warn',
      label: 'Unknown',
      title: 'The resolution payout could not be read, so this position cannot be valued.',
    },
  };
  const entry = map[status];
  return (
    <span title={entry.title}>
      <Badge tone={entry.tone}>{entry.label}</Badge>
    </span>
  );
}

/** Signed PnL with colour. Renders an em dash when the value is not trustworthy. */
export function PnlValue({ value, marked }: { value: bigint; marked: boolean }) {
  if (!marked) {
    return (
      <span
        className="tabular-nums text-content-subtle"
        title="This position has no reliable mark, so its PnL is not shown."
      >
        —
      </span>
    );
  }
  const zero = value === BigInt(0);
  // The sign goes OUTSIDE the dollar sign ("+$1.50", "-$1.50"), so the magnitude
  // reads as money. formatUsdcSigned emits its own leading sign, so take the
  // magnitude through formatUsdc and place the sign here.
  const negative = value < BigInt(0);
  const magnitude = negative ? -value : value;
  return (
    <span
      className={`tabular-nums ${zero ? 'text-content-muted' : value > BigInt(0) ? 'text-yes' : 'text-no'}`}
    >
      {zero ? '$0' : `${negative ? '-' : '+'}$${formatUsdc(magnitude)}`}
    </span>
  );
}
