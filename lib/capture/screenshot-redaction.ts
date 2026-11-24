import type { Asset, RedactionRect } from '@/lib/session/types';

export function validateRedactionRect(rect: RedactionRect): void {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > 1 ||
    rect.y + rect.height > 1
  ) {
    throw new Error('Redaction masks must have a positive size inside the image.');
  }
}

export function normalizeRedactionRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  imageWidth: number,
  imageHeight: number,
): RedactionRect | undefined {
  if (
    ![x1, y1, x2, y2, imageWidth, imageHeight].every(Number.isFinite) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) return undefined;
  const left = Math.max(0, Math.min(imageWidth, Math.min(x1, x2)));
  const top = Math.max(0, Math.min(imageHeight, Math.min(y1, y2)));
  const right = Math.max(0, Math.min(imageWidth, Math.max(x1, x2)));
  const bottom = Math.max(0, Math.min(imageHeight, Math.max(y1, y2)));
  if (right - left < 1 || bottom - top < 1) return undefined;
  return {
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight,
  };
}

export async function flattenRedactions(
  original: Blob,
  rectangles: RedactionRect[],
): Promise<Blob> {
  for (const rect of rectangles) validateRedactionRect(rect);
  if (rectangles.length === 0) return original;
  const bitmap = await createImageBitmap(original);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not prepare the screenshot for redaction.');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#000';
    for (const rect of rectangles) {
      const left = Math.floor(rect.x * bitmap.width);
      const top = Math.floor(rect.y * bitmap.height);
      const right = Math.ceil((rect.x + rect.width) * bitmap.width);
      const bottom = Math.ceil((rect.y + rect.height) * bitmap.height);
      context.fillRect(left, top, right - left, bottom - top);
    }
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Could not encode the redacted screenshot.')),
        'image/png',
      );
    });
    if (result.type !== 'image/png') throw new Error('The redacted screenshot was not encoded as PNG.');
    return result;
  } finally {
    bitmap.close();
  }
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function screenshotRevision(assets: Asset[]): string {
  return assets
    .filter((asset) => asset.kind === 'screenshot' && (asset.localScreenshotRedaction?.revision ?? 0) > 0)
    .map((asset) => `${asset.id}:${asset.localScreenshotRedaction!.revision}`)
    .sort()
    .join('|');
}
