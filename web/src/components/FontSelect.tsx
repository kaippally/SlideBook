import { useEffect, useState } from 'react';
import { ensureFont } from '../titles/render/fonts';

// The font library is the `fonts/` folder beside the app, served at /api/fonts — a face is picked from
// it, never typed, because the OBS browser source can only draw faces the page registers itself.

interface Font { family: string; label: string }
let cache: Promise<Font[]> | null = null;
const loadFonts = () => (cache ??= fetch('/api/fonts').then(r => r.json()).catch(() => []));

export function useFontList(): Font[] {
  const [fonts, setFonts] = useState<Font[]>([]);
  useEffect(() => { loadFonts().then(setFonts); }, []);
  return fonts;
}

export function FontSelect({ value, onChange, className = '', allowInherit, inheritLabel = 'Default' }: {
  value: string; onChange: (family: string) => void; className?: string; allowInherit?: boolean; inheritLabel?: string;
}) {
  const fonts = useFontList();
  useEffect(() => { for (const f of fonts) ensureFont(f.family); }, [fonts]);
  const known = fonts.some(f => f.family === value);
  return (
    <select className={className} value={value} onChange={e => { ensureFont(e.target.value); onChange(e.target.value); }} style={{ fontFamily: value || undefined }}>
      {allowInherit && <option value="">{inheritLabel}</option>}
      {!known && value && <option value={value}>{value} — not installed</option>}
      {fonts.map(f => <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>{f.label}</option>)}
    </select>
  );
}
