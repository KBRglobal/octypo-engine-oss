/**
 * Image delivery.
 *
 * The engine stores generated media as a web-optimised 1536x1024 WebP. When an
 * installation has an image resizing service, this module also emits responsive
 * AVIF/WebP URLs through its configured prefix.
 *
 * Self-hosters have no resizing prefix; they get the original URL, which is
 * correct-but-heavy rather than broken.
 */

/** What gpt-image-1 actually renders. Emitting these keeps CLS at 0. */
export const HERO_INTRINSIC = { width: 1536, height: 1024 } as const;

export interface ResizeOptions {
  width: number;
  quality?: number;
  prefix: string | null;
}

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function resizedImageUrl(url: string | null | undefined, opts: ResizeOptions): string {
  if (!url) return '';
  if (!opts.prefix) return url;
  if (url.startsWith(opts.prefix)) return url; // already wrapped
  if (!isRemote(url)) return url;

  const quality = opts.quality ?? 80;
  return `${opts.prefix}/width=${opts.width},format=auto,quality=${quality}/${url}`;
}

export function buildSrcset(
  url: string | null | undefined,
  widths: readonly number[],
  prefix: string | null
): string {
  if (!url || !prefix) return '';
  return widths.map(w => `${resizedImageUrl(url, { width: w, prefix })} ${w}w`).join(', ');
}
