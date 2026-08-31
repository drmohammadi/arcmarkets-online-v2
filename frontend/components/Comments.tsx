'use client';

import { useEffect, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useWriteContract } from 'wagmi';
import { getSocialAddress } from '@/lib/contracts';
import { socialAbi } from '@/lib/abis';
import { useComments, useUsernames, COMMENT_PAGE_SIZE } from '@/hooks/useSocial';
import { MAX_COMMENT_BYTES } from '@/lib/username';
import { byteLength } from '@/lib/metadataFields';
import { formatRelativeTime, formatAbsoluteTime } from '@/lib/time';
import { shortAddress } from '@/lib/sanitize';
import { ErrorNote, EmptyState, Skeleton } from './ui';

/**
 * A market's comment thread.
 *
 * Comments live on-chain in the Social registry, so every visitor sees the same
 * thread — the same reasoning that put descriptions on-chain rather than in
 * localStorage. Two consequences shape this component:
 *
 *  1. **Writes are permissionless**, unlike MarketMetadata. Anyone can post, so
 *     every rendered string is sanitized (in `useComments`) and the contract
 *     enforces a per-author cooldown that this UI has to explain when it fires.
 *  2. **Posting costs gas and takes a block.** The composer stays disabled and
 *     labelled while the transaction is in flight rather than clearing
 *     optimistically, because a failed post that had already vanished from the
 *     textarea would lose what the user wrote.
 */
export function Comments({ questionId }: { questionId: bigint }) {
  const chainId = useChainId();
  const registry = getSocialAddress(chainId);
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  const [page, setPage] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowSec, setNowSec] = useState(BigInt(0));

  const thread = useComments(questionId, page);
  const names = useUsernames(thread.comments.map((c) => c.author ?? ''));
  const { writeContractAsync } = useWriteContract();

  // Set the clock after mount and tick it, so relative timestamps never differ
  // between the server render and the first client render.
  useEffect(() => {
    const tick = () => setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!registry) {
    // Not an error: chains without the registry simply have no comments.
    return null;
  }

  const bytes = byteLength(text);
  const tooLong = bytes > MAX_COMMENT_BYTES;
  const empty = text.trim().length === 0;

  async function handlePost() {
    setError('');
    // Re-checked here rather than relying on the early return above: this is a
    // hoisted function declaration, so TypeScript analyses it without that
    // narrowing. A cast would silence the error while leaving a real null able
    // to reach writeContract.
    if (!registry) return;
    if (empty) {
      setError('Write something first.');
      return;
    }
    if (tooLong) {
      setError(`Comments are limited to ${MAX_COMMENT_BYTES} bytes.`);
      return;
    }

    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: registry,
        abi: socialAbi,
        functionName: 'postComment',
        args: [questionId, text.trim()],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setText('');
      setPage(0);
      thread.refetch();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const visible = thread.comments.filter((c) => !c.deleted);

  return (
    <section className="rounded-card border border-edge bg-surface-raised p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-content">Comments</h2>
        {thread.count > 0 && (
          <span className="text-2xs text-content-subtle tabular-nums">
            {thread.count} total
          </span>
        )}
      </div>

      {isConnected ? (
        <div className="mb-4">
          <label htmlFor="comment-input" className="sr-only">
            Add a comment
          </label>
          <textarea
            id="comment-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder="Share your reasoning…"
            className="w-full resize-y rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-subtle disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span
              className={`text-2xs tabular-nums ${tooLong ? 'text-no' : 'text-content-subtle'}`}
            >
              {bytes}/{MAX_COMMENT_BYTES}
            </span>
            <button
              type="button"
              onClick={handlePost}
              disabled={busy || empty || tooLong}
              className="h-9 rounded-lg bg-brand px-4 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? 'Posting…' : 'Post'}
            </button>
          </div>
          {error && (
            <div className="mt-2">
              <ErrorNote message={error} />
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-content-muted">
          Connect a wallet to comment.
        </p>
      )}

      {thread.isLoading && visible.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title="No comments yet" hint="Be the first to weigh in." />
      ) : (
        <ul className="space-y-3">
          {visible.map((c) => (
            <li key={c.index} className="animate-fade-in">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-content">
                  {names.nameFor(c.author ?? undefined)}
                </span>
                <span className="font-mono text-2xs text-content-subtle">
                  {shortAddress(c.author)}
                </span>
                {c.author && address && c.author === address.toLowerCase() && (
                  <span className="text-2xs text-brand">you</span>
                )}
                <time
                  className="ml-auto shrink-0 text-2xs text-content-subtle"
                  title={formatAbsoluteTime(c.timestamp)}
                >
                  {formatRelativeTime(c.timestamp, nowSec)}
                </time>
              </div>
              {/* sanitizeText collapses newlines, so there is no multi-line
                  formatting to preserve here — only long unbroken tokens to wrap. */}
              <p className="mt-1 break-words text-sm text-content-muted">
                {c.text}
              </p>
            </li>
          ))}
        </ul>
      )}

      {thread.hasMore && (
        <button
          type="button"
          onClick={() => setPage((p) => p + 1)}
          className="mt-4 h-9 w-full rounded-lg border border-edge text-xs font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content"
        >
          Load {COMMENT_PAGE_SIZE} older
        </button>
      )}
    </section>
  );
}

/**
 * Map the registry's custom errors to plain language.
 *
 * Mirrors TradePanel's friendlyError: a raw revert string is unreadable, and the
 * cooldown in particular is a normal condition a user will hit, not a fault.
 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/CooldownActive/.test(msg)) {
    return 'You just posted. Wait a moment before commenting again.';
  }
  // The contract raises one InvalidInput for both empty and over-length text;
  // the composer blocks both before submitting, so reaching this means the
  // input changed under us.
  if (/InvalidInput/.test(msg)) {
    return `Comments must be between 1 and ${MAX_COMMENT_BYTES} bytes.`;
  }
  if (/User rejected|denied transaction/i.test(msg)) return '';
  return 'Could not post your comment. Please try again.';
}
