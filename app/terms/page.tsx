'use client';

import Link from 'next/link';
import { ContentPage, Section, Bullets } from '@/components/ContentPage';
import { SITE } from '@/lib/links';

export default function TermsPage() {
  return (
    <ContentPage
      title="Terms of Use"
      intro={`The rules that apply when you use the ${SITE.name} interface.`}
      lastUpdated="9 August 2026"
    >
      <Section heading="1. What you are agreeing to">
        <p>
          By using this interface you accept these terms. If you do not accept them, do not use the
          interface. These terms cover the website only. They do not and cannot govern the
          underlying smart contracts, which run autonomously on a public blockchain and are not
          controlled by this website.
        </p>
      </Section>

      <Section heading="2. This is testnet software">
        <p>
          This deployment operates on a test network. Tokens used here are test tokens with no
          monetary value and cannot be exchanged for money or anything else of value. Test networks
          can be reset, halted or replaced at any time, which would permanently erase all markets,
          balances and positions. Nothing here should be treated as an investment or as a store of
          value.
        </p>
      </Section>

      <Section heading="3. No advice, no guarantees">
        <p>
          Nothing on this site is financial, investment, legal or tax advice. Market prices are
          produced by the trading activity of other participants, not by us, and they are not a
          prediction or endorsement by us of any outcome. Market questions, descriptions and images
          are supplied by whoever created the market and may be inaccurate, incomplete or
          misleading.
        </p>
      </Section>

      <Section heading="4. Your responsibilities">
        <Bullets
          items={[
            'You are solely responsible for your wallet, your private keys and your seed phrase. We never have access to them and cannot recover them.',
            'You are responsible for every transaction you sign. Blockchain transactions are irreversible; we cannot cancel, refund or reverse one.',
            'You are responsible for confirming that using this kind of service is lawful where you are.',
            'You must not use this interface if you are barred from doing so under any law that applies to you.',
          ]}
        />
      </Section>

      <Section heading="5. Things you must not do">
        <Bullets
          items={[
            'Use the interface for money laundering, sanctions evasion, or any other unlawful purpose.',
            'Attempt to manipulate a market by misrepresenting the outcome of an event or by exploiting a resolution source.',
            'Interfere with the site, probe its infrastructure, or attempt to gain unauthorized access to any part of it.',
            'Present the interface as your own, or misrepresent your relationship with it.',
          ]}
        />
      </Section>

      <Section heading="6. Risk">
        <p>
          Trading on prediction markets carries risk, including the total loss of everything you put
          in. A losing share is worth exactly nothing after resolution. In addition, smart contracts
          can contain defects; automated market makers move price against large orders; a market may
          resolve in a way you consider wrong; and network congestion or outages may prevent you from
          trading when you want to.
        </p>
        <p>
          The contracts behind this interface have not been independently audited. Do not use them
          with anything you are not prepared to lose entirely.
        </p>
      </Section>

      <Section heading="7. Resolution is performed by the resolver">
        <p>
          Each market names a resolver — the only address that may report that market&apos;s outcome
          — and a resolution date before which it cannot be resolved. Resolution happens once and
          cannot be undone. We do not adjudicate disputes about a resolution and have no ability to
          reverse one after it is recorded on-chain.
        </p>
      </Section>

      <Section heading="8. Availability">
        <p>
          The interface is provided as-is and as-available. We may change, suspend or discontinue any
          part of it at any time, without notice. We may also stop displaying any market. Because the
          contracts are deployed on a public blockchain, they may remain accessible through other
          means even if this website does not display them.
        </p>
      </Section>

      <Section heading="9. Third-party content">
        <p>
          Market images are loaded from URLs supplied by market creators and hosted by third parties.
          We do not host, review, control or endorse that content, and it may change or disappear at
          any time. Links to third-party sites are provided for convenience only.
        </p>
      </Section>

      <Section heading="10. Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for any loss or damage arising
          from your use of this interface or of the underlying contracts. This includes trading
          losses, lost profits, failed or stuck transactions, smart contract defects, resolution
          outcomes you disagree with, network downtime, and loss of access to your wallet.
        </p>
      </Section>

      <Section heading="11. Changes to these terms">
        <p>
          We may update these terms. The date above shows when they last changed, and continuing to
          use the interface after a change means you accept the updated version.
        </p>
      </Section>

      <Section heading="12. Related documents">
        <p>
          See the <Link href="/privacy" className="text-brand hover:underline">Privacy Policy</Link>{' '}
          for data handling, and <Link href="/about" className="text-brand hover:underline">About</Link>{' '}
          for how the markets actually work.
        </p>
      </Section>
    </ContentPage>
  );
}
