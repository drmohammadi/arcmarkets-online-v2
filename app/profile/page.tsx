'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Header } from '@/components/Header';
import { ProfileView } from '@/components/ProfileView';
import { EmptyState } from '@/components/ui';

/**
 * The connected wallet's own profile.
 *
 * A convenience route so the header can link to "your" profile without knowing
 * the address at render time. Everything below the connect gate is the same
 * component /profile/[address] uses.
 */
export default function MyProfilePage() {
  const { address, isConnected } = useAccount();

  if (!isConnected || !address) {
    return (
      <main className="flex-1">
        <Header />
        <div id="main" className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
          <EmptyState
            title="Connect a wallet to see your profile"
            hint="Your trades, PnL and username live on-chain, so they follow your wallet."
            action={
              <div className="flex flex-col items-center gap-3">
                <ConnectButton />
                <Link
                  href="/leaderboard"
                  className="text-sm font-medium text-brand hover:underline"
                >
                  See the leaderboard
                </Link>
              </div>
            }
          />
        </div>
      </main>
    );
  }

  return <ProfileView address={address} />;
}
