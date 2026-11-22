// Registers a custom L3 font with the document once, so DOM text renders with
// it. Mirrors the old textCanvas.preloadFont path: /api/titles/fonts/<id>.ttf
// (relative — proxied by Vite in both the editor and the OBS display page).
const loaded = new Set<string>();

export function ensureFont(fontId?: string): void {
  if (!fontId || fontId === 'helvetiker' || fontId === 'default' || loaded.has(fontId)) return;
  loaded.add(fontId);
  try {
    new FontFace(fontId, `url(/api/titles/fonts/${fontId}.ttf), url(/api/titles/fonts/${fontId}.otf)`)
      .load()
      .then(f => (document as any).fonts.add(f))
      .catch(() => {});
  } catch {
    /* ignore — fall back to system font */
  }
}

export function fontFamily(fontId?: string): string {
  if (!fontId || fontId === 'helvetiker' || fontId === 'default') return 'Arial, sans-serif';
  return `'${fontId}', Arial, sans-serif`;
}
