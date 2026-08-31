'use client';

import { useId, useRef, useState } from 'react';
import { useChainId } from 'wagmi';
import { processImageFile, setMarketImage, clearMarketImage } from '@/lib/marketImages';
import { useMarketImage } from '@/hooks/useMarketImage';

/**
 * Image picker for one market, used from the admin panel.
 *
 * All validation happens in lib/marketImages: signature check, decode, canvas
 * re-encode, size caps. This component only drives it and reports the outcome.
 *
 * The scope limitation is stated in the UI rather than hidden, because an owner
 * who thinks they set a global image would be misled: there is no backend and
 * no on-chain image field, so the value lives in this browser.
 */
export function MarketImageUpload({
  questionId,
  question,
}: {
  questionId: bigint;
  question: string;
}) {
  const chainId = useChainId();
  const current = useMarketImage(questionId);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function handleFile(file: File | undefined) {
    setError('');
    setSaved(false);
    if (!file) return;

    setBusy(true);
    try {
      const result = await processImageFile(file);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const stored = setMarketImage(chainId, questionId, result.dataUrl);
      if (!stored.ok) {
        setError(stored.error);
        return;
      }
      setSaved(true);
    } catch {
      // processImageFile is total, but a browser API can still fail unexpectedly.
      setError('That image could not be processed.');
    } finally {
      setBusy(false);
      // Clear the input so re-picking the same file fires onChange again.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="rounded-lg border border-edge bg-surface p-3">
      <div className="flex items-start gap-3">
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL from
          // canvas re-encode; next/image cannot optimize it and would proxy it.
          <img
            src={current}
            alt=""
            width={48}
            height={48}
            className="h-12 w-12 flex-shrink-0 rounded-md border border-edge object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md border border-dashed border-edge text-2xs text-content-subtle"
          >
            none
          </div>
        )}

        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="block text-xs font-medium text-content">
            Market image
          </label>
          <p className="mt-0.5 text-2xs text-content-subtle">
            PNG, JPEG, GIF or WebP. Resized to 256px and re-encoded on upload.
            Stored in this browser only.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={busy}
              onChange={(e) => void handleFile(e.target.files?.[0])}
              className="block w-full max-w-[15rem] cursor-pointer text-2xs text-content-muted file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-surface-raised file:px-2 file:py-1 file:text-2xs file:text-content hover:file:bg-edge disabled:cursor-not-allowed"
            />
            {current && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  clearMarketImage(chainId, questionId);
                  setSaved(false);
                  setError('');
                }}
                className="rounded border border-edge px-2 py-1 text-2xs text-content-muted transition-colors hover:text-content disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>

          <p className="sr-only">Setting image for market: {question}</p>

          {busy && <p className="mt-2 text-2xs text-content-muted">Processing image…</p>}
          {error && (
            <p role="alert" className="mt-2 text-2xs text-no">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="mt-2 text-2xs text-yes">Image saved for this browser.</p>
          )}
        </div>
      </div>
    </div>
  );
}
