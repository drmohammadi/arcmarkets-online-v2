import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/lib/wagmi';
import { Footer } from '@/components/Footer';

export const metadata: Metadata = {
  title: 'Arc Markets — Prediction Markets on Arc',
  description: 'Trade binary prediction markets settled in USDC on Circle Arc L1.',
};

/**
 * Explicit viewport: without this, mobile browsers assume a ~980px layout
 * viewport and scale the page down, which breaks every responsive breakpoint.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0f12' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Blocking, synchronous, same-origin: sets the theme class before first
         * paint so there is no light-mode flash. Kept as a static file instead
         * of an inline string so we never use dangerouslySetInnerHTML.
         */}
        <script src="/theme-init.js" />
      </head>
      <body className="flex min-h-screen flex-col bg-surface text-content antialiased">
        <a
          href="#main"
          className="sr-only-focusable absolute left-4 top-4 z-50 rounded bg-brand px-3 py-2 text-sm font-medium text-white"
        >
          Skip to content
        </a>
        <Providers>
          {/*
           * flex-1 lets the page fill the viewport so the footer is pinned to
           * the bottom on short pages, without each page needing min-h-screen.
           */}
          <div className="flex flex-1 flex-col">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
