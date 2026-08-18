'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { getDeployment } from '@/lib/contracts';
import { marketFactoryAbi } from '@/lib/abis';
import { FaucetButton } from './FaucetButton';
import { LogoLink } from './Logo';

/*
 * Top-level navigation.
 *
 * `/portfolio` used to sit between Leaderboard and Profile. It was removed
 * because its entire contents now render inside /profile as `PortfolioPanel` —
 * keeping the link would have advertised two routes for one thing. The old route
 * still exists as a redirect so shared links and bookmarks keep working.
 */
const NAV = [
  { href: '/', label: 'Markets' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/profile', label: 'Profile' },
] as const;

export function Header() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const pathname = usePathname();
  const deployment = getDeployment(chainId);
  const unsupported = isConnected && !deployment;

  const [menuOpen, setMenuOpen] = useState(false);

  // Close on navigation. Next keeps the Header mounted across route changes, so
  // without this the menu would stay open covering the page you just opened.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Only surface the Admin link to the factory owner. This is a UI convenience,
  // not a security boundary — the page itself and the contract both re-check.
  const { data: owner } = useReadContract({
    address: deployment?.marketFactory as `0x${string}` | undefined,
    abi: marketFactoryAbi,
    functionName: 'owner',
    query: { enabled: !!deployment?.marketFactory },
  });
  const isOwner =
    !!address && !!owner && address.toLowerCase() === (owner as string).toLowerCase();

  const links = isOwner ? [...NAV, { href: '/admin', label: 'Admin' } as const] : NAV;

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-surface/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <LogoLink />

        {/* Desktop nav. On mobile these move into the menu below. */}
        <nav aria-label="Main" className="hidden items-center gap-0.5 sm:flex">
          {links.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname?.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-2 py-1 text-xs font-medium transition-colors sm:px-2.5 sm:text-sm ${
                  active
                    ? 'bg-surface-sunken text-content'
                    : 'text-content-muted hover:text-content'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {unsupported && (
            <span role="alert" className="hidden text-2xs font-medium text-no sm:inline">
              Wrong network — switch to Arc
            </span>
          )}
          {/* Faucet is in the mobile menu instead, to leave room for Connect. */}
          <span className="hidden sm:inline-flex">
            <FaucetButton />
          </span>
          <ThemeToggle />
          <ConnectButton
            chainStatus="icon"
            accountStatus={{ smallScreen: 'avatar', largeScreen: 'address' }}
            showBalance={{ smallScreen: false, largeScreen: true }}
          />
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-edge text-content-muted transition-colors hover:text-content sm:hidden"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
              {menuOpen ? (
                <path
                  d="M4 4l8 8m0-8l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M2 4.5h12M2 8h12M2 11.5h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/*
       * Mobile menu. Holds the nav links AND the faucet, which is the only place
       * a phone user can reach it — the header row has no room for it next to
       * the connect button.
       */}
      {menuOpen && (
        <div id="mobile-menu" className="border-t border-edge bg-surface px-4 py-3 sm:hidden">
          <nav aria-label="Main" className="flex flex-col gap-0.5">
            {links.map((l) => {
              const active = l.href === '/' ? pathname === '/' : pathname?.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-md px-2 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-surface-sunken text-content'
                      : 'text-content-muted hover:text-content'
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-3 border-t border-edge pt-3">
            <FaucetButton fullWidth />
          </div>
        </div>
      )}

      {/* Mobile network warning: the inline one is hidden at this width. */}
      {unsupported && (
        <p role="alert" className="border-t border-edge bg-no-soft px-4 py-1.5 text-2xs text-no sm:hidden">
          Wrong network — switch to Arc to trade.
        </p>
      )}
    </header>
  );
}

/**
 * Light/dark toggle. Writes the class the inline script in layout.tsx reads on
 * next load, so the choice survives a refresh without a flash.
 */
function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('arc-theme', next ? 'dark' : 'light');
    } catch {
      // Private mode / storage disabled: the toggle still works for this session.
    }
    setDark(next);
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-edge text-content-muted transition-colors hover:text-content"
    >
      {/* Render a stable icon until mounted so SSR and first client paint match. */}
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        {dark ? (
          <path
            d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"
            fill="currentColor"
          />
        ) : (
          <>
            <circle cx="8" cy="8" r="3" fill="currentColor" />
            <path
              d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1m11-5-1 1M5 11l-1 1m0-8 1 1m6 6 1 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </button>
  );
}
