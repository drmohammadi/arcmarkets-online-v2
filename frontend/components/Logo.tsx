'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LOGO_URL, SITE } from '@/lib/links';

/**
 * Site logo mark, used in the header and footer.
 *
 * Renders the image at NEXT_PUBLIC_LOGO_URL when one is configured, and the
 * built-in monogram otherwise. Both paths occupy the SAME box, so swapping a
 * logo in or out never shifts the layout around it.
 *
 * `object-contain`, not `object-cover`: a logo is a whole mark, and cropping it
 * to fill a square would cut the edges off a wide wordmark. Market images use
 * cover because a cropped photo is fine; a cropped logo is broken branding.
 *
 * A load failure falls back to the monogram, so a dead or hotlink-blocked URL
 * degrades to the default mark rather than a broken-image glyph.
 */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7';
  // LOGO_URL is inlined at build time and never changes at runtime, so this only
  // ever has to latch once: if the image 404s or the host blocks hotlinking, we
  // fall back to the monogram for the rest of the session.
  const [failed, setFailed] = useState(false);

  if (LOGO_URL && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- arbitrary operator
      // supplied https URL; next/image would proxy it through our own server and
      // requires the host be allow-listed in next.config at build time.
      <img
        src={LOGO_URL}
        alt=""
        aria-hidden="true"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-md object-contain ${box}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-md bg-brand text-xs font-bold text-white ${box}`}
    >
      {SITE.name.trim().charAt(0).toUpperCase() || 'A'}
    </span>
  );
}

/**
 * Logo + wordmark, linking home.
 *
 * The wordmark is hidden on the narrowest screens in the header (where space is
 * contested by the connect button) but the mark itself always shows, so the
 * site is always identifiable and there is always a tap target back to home.
 */
export function LogoLink({
  href = '/',
  showNameOnMobile = false,
  size = 'md',
}: {
  href?: string;
  showNameOnMobile?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-2" aria-label={SITE.name}>
      <Logo size={size} />
      <span
        className={`text-sm font-semibold tracking-tight text-content ${
          showNameOnMobile ? '' : 'hidden sm:inline'
        }`}
      >
        {SITE.name}
      </span>
    </Link>
  );
}
