'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ProfileView } from '@/components/ProfileView';
import { EmptyState } from '@/components/ui';
import { safeAddress } from '@/lib/sanitize';

/**
 * Any wallet's public profile.
 *
 * The address comes from the URL, so it is untrusted: it goes through
 * `safeAddress` before it is used in a contract read or rendered. An unparseable
 * one gets the invalid-link empty state rather than a failed RPC call.
 */
export default function ProfileAddressPage() {
  const params = useParams<{ address: string }>();
  const address = safeAddress(params?.address);

  if (!address) {
    return (
      <main className="flex-1">
        <Header />
        <div id="main" className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
          <EmptyState
            title="That is not a valid wallet address"
            hint="Profile links use a full 0x address."
            action={
              <Link href="/leaderboard" className="text-sm font-medium text-brand hover:underline">
                Back to the leaderboard
              </Link>
            }
          />
        </div>
      </main>
    );
  }

  return <ProfileView address={address} />;
}
