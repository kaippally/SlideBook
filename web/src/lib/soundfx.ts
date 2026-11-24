import { useEffect, useState } from 'react';
import { api } from './api';
import type { SoundFx } from './types';

export function useSoundFx(): [SoundFx[], () => void] {
  const [lib, setLib] = useState<SoundFx[]>([]);
  const load = () => { api<SoundFx[]>('/api/soundfx').then(setLib).catch(() => {}); };
  useEffect(load, []);
  return [lib, load];
}

const lengths = new Map<string, number>();

/** How long each sound runs, read from the files once and kept for the session. */
export function useSoundLengths(lib: SoundFx[]): Map<string, number> {
  const [, bump] = useState(0);
  useEffect(() => {
    for (const s of lib) {
      if (lengths.has(s.file)) continue;
      lengths.set(s.file, 1);
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => { if (isFinite(a.duration)) { lengths.set(s.file, a.duration); bump(n => n + 1); } };
      a.src = s.url;
    }
  }, [lib]);
  return lengths;
}

export const dbToVolume = (db: number) => Math.pow(10, Math.min(0, db) / 20);
