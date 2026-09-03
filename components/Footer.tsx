import Link from 'next/link';
import { SITE, resolvedSections, type SiteLink } from '@/lib/links';
import { Logo } from './Logo';

/**
 * Site footer.
 *
 * Every destination comes from `lib/links.ts` — no URL is written here, so a
 * link change is a one-file edit. Sections whose links all failed validation
 * are dropped upstream by `resolvedSections`, so this renders whatever survives
 * rather than empty headings.
 *
 * Still a server component. The only client JS it pulls in is `Logo`, which
 * needs state to fall back to the monogram when a configured logo URL fails to
 * load; everything else here is static markup.
 *
 * Responsive: single column on mobile, two at sm, four at lg. The bottom bar
 * stacks vertically until sm.
 */
export function Footer() {
  const sections = resolvedSections();
  const year = 2026;

  return (
    <footer className="mt-12 border-t border-edge bg-surface-sunken">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(4,1fr)]">
          {/* Brand block spans the full width on mobile, its own column at lg. */}
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <Logo />
              <span className="text-sm font-semibold tracking-tight text-content">{SITE.name}</span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-content-muted">{SITE.tagline}</p>
          </div>

          {sections.map((section) => (
            <nav key={section.heading} aria-labelledby={`footer-${section.heading}`}>
              <h2
                id={`footer-${section.heading}`}
                className="text-2xs font-semibold uppercase tracking-wide text-content-subtle"
              >
                {section.heading}
              </h2>
              <ul className="mt-3 space-y-2">
                {section.links.map((link) => (
                  <li key={link.label}>
                    <FooterLink link={link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-edge pt-6 text-2xs text-content-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; {year} {SITE.name}. Not investment advice.
          </p>
          <p>
            Testnet build — markets settle in test USDC and carry no monetary value.
          </p>
        </div>
      </div>
    </footer>
  );
}

/**
 * One footer link. External links open in a new tab with `rel="noreferrer"` so
 * the destination cannot reach `window.opener` or read the referrer.
 *
 * `href` is non-null by construction here (resolvedSections filtered the rest),
 * but it is re-checked so a future caller passing raw links can't render a
 * broken anchor.
 */
function FooterLink({ link }: { link: SiteLink }) {
  if (!link.href) return null;

  const className =
    'text-xs text-content-muted transition-colors hover:text-content focus-visible:text-content';

  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
        {link.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }

  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}
