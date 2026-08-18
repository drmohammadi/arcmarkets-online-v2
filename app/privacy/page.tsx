'use client';

import Link from 'next/link';
import { ContentPage, Section, Bullets } from '@/components/ContentPage';
import { SITE } from '@/lib/links';

export default function PrivacyPage() {
  return (
    <ContentPage
      title="Privacy Policy"
      intro={`What ${SITE.name} does and does not collect.`}
      lastUpdated="9 August 2026"
    >
      <Section heading="The short version">
        <p>
          This interface has no backend server, no database and no user accounts. We do not ask for
          your name, email address or any other personal detail, and there is nowhere for us to
          store one. We do not run analytics or advertising trackers, and we do not sell data —
          there is no data to sell.
        </p>
        <p>
          That is not the same as anonymity, and the rest of this page explains precisely where
          information about you does go.
        </p>
      </Section>

      <Section heading="Everything you do on-chain is public">
        <p>
          Trades, approvals, liquidity, redemptions and your wallet address are recorded on a public
          blockchain. Anyone can read them, they are permanent, and they cannot be edited or deleted
          by us or by you. Your address is pseudonymous rather than anonymous: if it is ever linked
          to your identity — for example through an exchange withdrawal — its entire history can be
          linked to you as well.
        </p>
      </Section>

      <Section heading="Stored in your browser only">
        <p>
          The following is kept in your own browser&apos;s local storage. It never leaves your
          device, is not visible to us or to other users, and is cleared when you clear your browser
          data:
        </p>
        <Bullets
          items={[
            'Your light/dark theme preference.',
            'Any market images uploaded in an earlier version of this app.',
            'Markets an administrator has hidden from their own market list.',
            'A short-lived cache of blockchain data, to avoid re-requesting it on every page load.',
          ]}
        />
      </Section>

      <Section heading="Third parties your browser contacts">
        <p>
          Using this interface causes your browser to make requests directly to services we do not
          operate. Each of those services can see your IP address and standard request details, and
          each has its own privacy policy:
        </p>
        <Bullets
          items={[
            'A blockchain RPC provider, to read market data and submit your transactions.',
            'Your wallet provider, and — for mobile wallets — the WalletConnect relay used to establish the connection.',
            'Whatever image hosts market creators have linked to, when a market image loads.',
            'The hosting provider serving this site.',
          ]}
        />
        <p>
          Market images are the one to be aware of. They are external URLs chosen by whoever created
          the market, so loading a market page tells that third-party host your IP address. We send
          a no-referrer instruction with each image request, so the host is not told which page or
          market you were viewing — but it can still see that a visitor loaded the image. We cannot
          prevent that without hosting the images ourselves.
        </p>
      </Section>

      <Section heading="Cookies">
        <p>
          This site sets no cookies and uses no cookie-based tracking. The browser storage described
          above is functional only, which is why there is no cookie consent banner.
        </p>
      </Section>

      <Section heading="Your choices">
        <Bullets
          items={[
            'Browse without connecting a wallet — markets, prices and charts are all readable without one.',
            'Disconnect your wallet at any time from your wallet application.',
            'Clear this site’s browser storage to erase every local preference described above.',
            'Use a separate wallet address if you do not want activity linked to your main one.',
          ]}
        />
      </Section>

      <Section heading="What we cannot do">
        <p>
          Because there is no account system, there is no profile to access, correct or export. And
          because blockchain records are immutable and not under our control, we cannot delete,
          amend or anonymize your on-chain history — not on request, and not by court order. Please
          take that into account before transacting.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If this policy changes, the date above will change with it. See also the{' '}
          <Link href="/terms" className="text-brand hover:underline">Terms of Use</Link>.
        </p>
      </Section>
    </ContentPage>
  );
}
