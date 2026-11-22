// Per-viewer UI conveniences (swatches, panel sizes). Kept in the browser: none of it is show data.
export function getUiSetting(key: string): string | null {
  try { return localStorage.getItem(`slidebook:${key}`); } catch { return null; }
}

export function setUiSetting(key: string, value: string) {
  try { localStorage.setItem(`slidebook:${key}`, value); } catch { /* storage unavailable */ }
}
