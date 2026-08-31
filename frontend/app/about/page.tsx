'use client';

import Link from 'next/link';
import { ContentPage, Section, Bullets } from '@/components/ContentPage';
import { SITE } from '@/lib/links';

export default function AboutPage() {
  return (
    <ContentPage
      title={`About ${SITE.name}`}
      intro="A prediction market on Circle's Arc network, settled in USDC."
    >
      <Section heading="What this is">
        <p>
          {SITE.name} lets you trade on the outcome of real-world events. Each market asks a
          question with two possible answers — YES or NO — and you buy shares in the outcome you
          expect. If you are right, each share you hold pays out 1 USDC when the market resolves. If
          you are wrong, it pays nothing.
        </p>
        <p>
          The price of a share is therefore also a probability. A YES share trading at 0.65 USDC
          means the market collectively puts the odds at roughly 65%.
        </p>
      </Section>

      <Section heading="How prices are set">
        <p>
          There is no order book and no counterparty to match against. Each market has an automated
          market maker holding a pool of YES and NO shares, and the price comes from the ratio
          between them. Buying YES removes YES shares from the pool, which raises the YES price and
          lowers the NO price by the same amount. The two always sum to 1.
        </p>
        <p>
          This means you can always trade, at any size, without waiting for someone to take the
          other side — but large trades move the price against you. The estimate shown before you
          confirm already accounts for that.
        </p>
      </Section>

      <Section heading="Events with more than two outcomes">
        <p>
          Some questions have several candidate answers. These are presented as a single event with
          one row per outcome, but underneath each row is its own independent YES/NO market. As a
          result the outcome percentages within an event are separate market prices and will not
          necessarily add up to exactly 100%.
        </p>
      </Section>

      <Section heading="Resolution">
        <p>
          Every market has a resolution date and a named resolver — the address permitted to report
          the result. A market cannot be resolved before its resolution date, cannot be resolved
          twice, and cannot be resolved by anyone else. Many markets also list a resolution source,
          which is the reference used to determine the answer.
        </p>
        <p>
          Once resolved, holders of the winning outcome can redeem each share for 1 USDC. Losing
          shares become worthless. You do not have to wait for resolution to exit — you can sell at
          the current market price at any time before then.
        </p>
      </Section>

      <Section heading="What you need to trade">
        <Bullets
          items={[
            'A wallet connected to the Arc network.',
            'USDC for trading. On testnet, use the Faucet button in the header.',
            'A small amount of the network gas token, which on Arc is also USDC.',
          ]}
        />
        <p>
          The first trade you make on a market requires a one-time approval transaction, which
          authorizes the market to move the USDC you are spending. After that, buying and selling
          are a single transaction each.
        </p>
      </Section>

      <Section heading="This is testnet software">
        <p>
          This deployment runs on Arc testnet. The USDC is a test token with no monetary value, the
          markets are for demonstration, and the network may be reset without notice — which would
          clear all markets and balances. Do not treat positions here as an investment.
        </p>
      </Section>

      <Section heading="More">
        <p>
          See the <Link href="/terms" className="text-brand hover:underline">Terms of Use</Link> for
          the rules of using this interface, and the{' '}
          <Link href="/privacy" className="text-brand hover:underline">Privacy Policy</Link> for what
          data it does and does not collect.
        </p>
      </Section>
    </ContentPage>
  );
}
