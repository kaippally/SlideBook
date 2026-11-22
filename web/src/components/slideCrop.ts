import type { CSSProperties } from 'react';

export interface SlideCrop { x: number; y: number; w: number; h: number }

export const FULL_CROP: SlideCrop = { x: 0, y: 0, w: 1, h: 1 };

export function isCropped(c: SlideCrop | undefined): boolean {
  return !!c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1);
}

// A deck may mix aspect ratios; crops are stored per aspect GROUP keyed by this rounded ratio
// (mirrors the server's slides/manifest.ts aspectKey so client + overlay pick the same crop).
export function aspectKey(aspect: number): string {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return (Math.round(a * 100) / 100).toFixed(2);
}

export function cropForAspect(crops: Record<string, SlideCrop> | undefined, aspect: number | undefined): SlideCrop | undefined {
  if (aspect == null) return crops?.[aspectKey(16 / 9)];
  return crops?.[aspectKey(aspect)];
}

/**
 * Lay out a sub-rectangle (`crop`, fractions of the page) of a page image with
 * aspect `pageAspect` (= pageW/pageH), contained inside a measured frame
 * (`frameW`×`frameH` px). Returns the box (the visible cropped region) and the
 * inner <img> styles that show only the cropped portion. Full crop reduces to a
 * plain object-fit:contain. Returns null when the frame/aspect aren't known yet.
 */
export function cropLayout(
  crop: SlideCrop | undefined,
  pageAspect: number | undefined,
  frameW: number,
  frameH: number,
): { box: CSSProperties; img: CSSProperties } | null {
  if (!pageAspect || frameW <= 0 || frameH <= 0) return null;
  const c = crop ?? FULL_CROP;
  const cw = Math.max(0.01, c.w), ch = Math.max(0.01, c.h);
  const cropAspect = pageAspect * (cw / ch);
  let boxW: number, boxH: number;
  if (frameW / frameH > cropAspect) { boxH = frameH; boxW = frameH * cropAspect; }
  else { boxW = frameW; boxH = frameW / cropAspect; }
  const imgW = boxW / cw, imgH = boxH / ch;
  return {
    box: { width: boxW, height: boxH, position: 'relative', overflow: 'hidden' },
    img: { position: 'absolute', left: -c.x * imgW, top: -c.y * imgH, width: imgW, height: imgH, maxWidth: 'none', objectFit: 'fill' },
  };
}
