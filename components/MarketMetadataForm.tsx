'use client';

import { useEffect, useState } from 'react';
import { useChainId, usePublicClient, useWriteContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { getMetadataAddress } from '@/lib/contracts';
import { marketMetadataAbi } from '@/lib/abis';
import { useMarketMetadata } from '@/hooks/useMarketMetadata';
import { sanitizeText } from '@/lib/sanitize';
import { safeImageUrl } from '@/lib/links';
import { ErrorNote } from './ui';
import {
  MAX_DESCRIPTION_BYTES,
  MAX_SOURCE_BYTES,
  MAX_URL_BYTES,
  byteLength,
  validateMetadataFields,
} from '@/lib/metadataFields';

/**
 * Edit one market's on-chain description / image URL / resolution source.
 *
 * Used in the admin market list, which makes it the BACKFILL path: markets
 * created before the metadata registry existed (including everything currently
 * live on testnet) get their details here, since the factory itself has no such
 * fields and cannot be changed.
 *
 * Collapsed by default — the list is long, and a permanently-expanded three-
 * field form per row would bury the resolve and liquidity controls.
 */
export function MarketMetadataForm({
  questionId,
  question,
}: {
  questionId: bigint;
  question: string;
}) {
  const chainId = useChainId();
  const registry = getMetadataAddress(chainId);
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const meta = useMarketMetadata(questionId);

  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [resolutionSource, setResolutionSource] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const { writeContractAsync } = useWriteContract();

  // Seed the form from chain state once it arrives, and re-seed whenever the
  // panel is reopened, so an abandoned edit never persists as a phantom value.
  useEffect(() => {
    if (!open) return;
    setDescription(meta.descriptionText);
    setImageUrl(meta.imageUrl ?? '');
    setResolutionSource(meta.resolutionSource);
    setError('');
    setSaved(false);
    // Intentionally keyed on `open` only: re-seeding on every metadata refetch
    // would overwrite what the admin is currently typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!registry) {
    return (
      <p className="rounded-lg bg-surface-sunken px-3 py-2 text-2xs text-content-muted">
        No metadata registry is deployed on this network, so descriptions and images cannot be
        saved. Deploy it with{' '}
        <span className="font-mono text-content">npm run deploy:metadata:testnet</span>.
      </p>
    );
  }

  async function handleSave() {
    setError('');
    setSaved(false);

    const check = validateMetadataFields({ description, imageUrl, resolutionSource });
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: registry as `0x${string}`,
        abi: marketMetadataAbi,
        functionName: 'setMetadata',
        args: [questionId, check.description, check.imageUrl, check.resolutionSource],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setSaved(true);
      meta.refetch();
      void queryClient.invalidateQueries();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(sanitizeText(msg).slice(0, 200) || 'Could not save market details.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 rounded-lg border border-edge px-3 text-xs font-medium text-content-muted transition-colors hover:border-edge-strong hover:text-content"
      >
        {meta.isSet ? 'Edit details' : 'Add description & image'}
      </button>
    );
  }

  const descBytes = byteLength(description);
  const urlValid = imageUrl.trim() === '' || safeImageUrl(imageUrl) !== null;

  return (
    <div className="rounded-lg border border-edge p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-content">Market details</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-2xs text-content-muted hover:text-content"
        >
          Close
        </button>
      </div>

      <label className="block">
        <span className="mb-1 block text-2xs font-medium text-content-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          disabled={busy}
          placeholder={`How "${question}" resolves, and on what evidence.`}
          className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm leading-relaxed text-content placeholder:text-content-subtle disabled:opacity-60"
        />
        <span
          className={`mt-1 block text-2xs tabular-nums ${
            descBytes > MAX_DESCRIPTION_BYTES ? 'text-no' : 'text-content-subtle'
          }`}
        >
          {descBytes}/{MAX_DESCRIPTION_BYTES} bytes
        </span>
      </label>

      <label className="mt-2 block">
        <span className="mb-1 block text-2xs font-medium text-content-muted">Image URL</span>
        <div className="flex items-center gap-2">
          <input
            type="url"
            inputMode="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            disabled={busy}
            placeholder="https://example.com/image.png"
            className="h-9 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-content placeholder:text-content-subtle disabled:opacity-60"
          />
          <ImageUrlPreview url={imageUrl} />
        </div>
        <span
          className={`mt-1 block text-2xs ${urlValid ? 'text-content-subtle' : 'text-no'}`}
        >
          {urlValid
            ? `https only, max ${MAX_URL_BYTES} bytes. Displayed cropped to a square.`
            : 'Must be an https:// URL.'}
        </span>
      </label>

      <label className="mt-2 block">
        <span className="mb-1 block text-2xs font-medium text-content-muted">
          Resolution source
        </span>
        <input
          type="text"
          value={resolutionSource}
          onChange={(e) => setResolutionSource(e.target.value)}
          disabled={busy}
          placeholder="e.g. Official results published by the AP"
          className="h-9 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-content placeholder:text-content-subtle disabled:opacity-60"
        />
        <span className="mt-1 block text-2xs text-content-subtle">
          Max {MAX_SOURCE_BYTES} bytes. Shown on the public market page.
        </span>
      </label>

      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
      {saved && !error && (
        <p role="status" className="mt-2 text-2xs text-yes">
          Saved on-chain. Every visitor sees this.
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={busy}
        className="mt-3 h-9 w-full rounded-lg bg-brand text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save details'}
      </button>
    </div>
  );
}

/**
 * Live thumbnail of the entered URL.
 *
 * Deliberately renders nothing until the URL passes safeImageUrl, so typing a
 * partial address never triggers a request to a half-formed host.
 */
function ImageUrlPreview({ url }: { url: string }) {
  const safe = safeImageUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [safe]);

  if (!safe) {
    return (
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-edge text-2xs text-content-subtle"
      >
        ?
      </span>
    );
  }

  if (failed) {
    return (
      <span
        title="This URL did not load as an image."
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-no text-2xs text-no"
      >
        !
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- untrusted third-party
    // URL; routing it through next/image would make our server fetch it.
    <img
      src={safe}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded-lg border border-edge object-cover object-center"
    />
  );
}
