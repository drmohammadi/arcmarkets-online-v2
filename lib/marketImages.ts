/**
 * Per-market image upload, validation, resize and storage.
 *
 * There is no backend and no on-chain image field, so images are processed
 * entirely in the browser and stored per-market in localStorage. That scope is
 * stated plainly in the admin UI: an image set here is visible in THIS browser
 * only. The honest alternative (a shared image) needs a host and a contract
 * field; see DEPENDENCIES.md.
 *
 * ── SECURITY MODEL ───────────────────────────────────────────────────────────
 * The requirement is "do not trust file extensions" and "do not allow
 * executable files". Extension and MIME sniffing are both trivially spoofable,
 * so neither is the control here. Instead:
 *
 *  1. **Magic-byte check.** The first bytes must match a known raster image
 *     signature (PNG/JPEG/GIF/WebP). A renamed .exe fails immediately. SVG is
 *     deliberately NOT accepted — it is an XML document that can carry script,
 *     and it cannot be safely re-encoded by the path below.
 *  2. **Decode as proof.** The bytes must decode via createImageBitmap. Any
 *     file the browser's own image decoder rejects never reaches storage.
 *  3. **Re-encode, never store the original.** The decoded pixels are drawn to
 *     a canvas and re-exported as PNG/WebP. The output contains only pixel
 *     data, so appended payloads, EXIF, colour-profile blobs and polyglot
 *     trailers are all discarded by construction. This is the load-bearing
 *     control: even a valid image with a malicious tail becomes clean pixels.
 *  4. **Bounded size.** Input is capped before decode (a decompression bomb is
 *     rejected on byte length), and output is capped by dimension and by final
 *     encoded length so it cannot exhaust the storage quota.
 *  5. **Data URL only.** Stored values must match a strict data:image/...
 *     pattern before they are ever handed to an <img src>, so a tampered
 *     localStorage entry cannot inject a javascript: or external URL.
 *
 * Every function is total: failures return a typed result instead of throwing,
 * per the repo's "handle every error" rule.
 */

/** Reject before decoding. 8 MB is generous for a market thumbnail. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** Output box. Square, since every render site is a square avatar. */
const MAX_EDGE = 256;
/** Hard cap on the stored string. Keeps localStorage well clear of its quota. */
const MAX_OUTPUT_CHARS = 400_000;
const STORAGE_PREFIX = 'arc-market-img:v1:';

export type UploadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/**
 * Raster image magic bytes. Checked against the actual file head, not the
 * name or the browser-reported type.
 */
const SIGNATURES: { name: string; test: (b: Uint8Array) => boolean }[] = [
  {
    name: 'PNG',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    name: 'JPEG',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    name: 'GIF',
    test: (b) =>
      b.length > 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  {
    name: 'WEBP',
    test: (b) =>
      b.length > 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function detectFormat(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.test(bytes)) return sig.name;
  }
  return null;
}

/**
 * Validate that a stored/incoming string is a bounded raster image data URL.
 * Anything else — including SVG data URLs and remote https URLs — is rejected,
 * because only re-encoded raster output should ever reach an <img>.
 */
export function isSafeImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_OUTPUT_CHARS) return false;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Validate, decode, resize and re-encode a user-selected file.
 *
 * Runs only in the browser: it needs FileReader/createImageBitmap/canvas.
 */
export async function processImageFile(file: File): Promise<UploadResult> {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'Image processing is only available in the browser.' };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'That file could not be read.' };
  }
  if (file.size > MAX_INPUT_BYTES) {
    const mb = (MAX_INPUT_BYTES / (1024 * 1024)).toFixed(0);
    return { ok: false, error: `Image is too large. Maximum size is ${mb} MB.` };
  }

  // 1. Read the real bytes and check the signature.
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, error: 'That file could not be read.' };
  }

  const format = detectFormat(bytes);
  if (!format) {
    return {
      ok: false,
      error:
        'That file is not a PNG, JPEG, GIF or WebP image. The file contents are checked, so renaming a file will not work. SVG is not accepted.',
    };
  }

  // 2. Prove it decodes. A file the browser cannot decode never gets stored.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    return { ok: false, error: 'That image could not be decoded and may be corrupt.' };
  }

  try {
    if (bitmap.width < 1 || bitmap.height < 1) {
      return { ok: false, error: 'That image has no visible content.' };
    }

    // 3. Re-encode through a canvas. Only pixels survive this step.
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { ok: false, error: 'This browser could not process the image.' };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);

    // WebP first for size; PNG is the universal fallback. Both are raster-only.
    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/webp', 0.85);
    } catch {
      dataUrl = '';
    }
    if (!isSafeImageDataUrl(dataUrl)) {
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch {
        return { ok: false, error: 'The image could not be re-encoded.' };
      }
    }

    if (!isSafeImageDataUrl(dataUrl)) {
      return {
        ok: false,
        error: 'The processed image was too large to store. Try a smaller or simpler image.',
      };
    }

    return { ok: true, dataUrl };
  } finally {
    // Release decoder memory regardless of which branch returned.
    bitmap.close();
  }
}

function keyFor(chainId: number, questionId: bigint): string {
  return `${STORAGE_PREFIX}${chainId}:${questionId.toString()}`;
}

/** Read a stored image, re-validating before it can reach an <img src>. */
export function getMarketImage(chainId: number, questionId: bigint): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(keyFor(chainId, questionId));
    if (!raw) return null;
    if (!isSafeImageDataUrl(raw)) {
      // Tampered or from an older format: drop it rather than render it.
      window.localStorage.removeItem(keyFor(chainId, questionId));
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function setMarketImage(
  chainId: number,
  questionId: bigint,
  dataUrl: string
): { ok: true } | { ok: false; error: string } {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'Storage is unavailable.' };
  }
  if (!isSafeImageDataUrl(dataUrl)) {
    return { ok: false, error: 'That image failed validation and was not saved.' };
  }
  try {
    window.localStorage.setItem(keyFor(chainId, questionId), dataUrl);
    notifyImageChange();
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Browser storage is full or unavailable, so the image was not saved.',
    };
  }
}

export function clearMarketImage(chainId: number, questionId: bigint): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(keyFor(chainId, questionId));
    notifyImageChange();
  } catch {
    // Nothing to do: absence is the desired end state anyway.
  }
}

/**
 * Same-tab change notification.
 *
 * The native `storage` event only fires in OTHER tabs, so components in this tab
 * would keep showing a stale icon after an upload. A custom event closes that
 * gap without adding a state-management dependency.
 */
export const IMAGE_CHANGE_EVENT = 'arc-market-image-change';

function notifyImageChange(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(IMAGE_CHANGE_EVENT));
  } catch {
    // Event constructor unavailable: callers just render on next mount.
  }
}
