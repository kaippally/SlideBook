import { useEffect, useRef } from 'react';
import { playSound } from './api';
import { useSlideVideoClock } from './slideVideoClock';
import { dbToVolume } from './soundfx';
import type { BookSfx } from './types';

export const sfxUrl = (file: string) => `/api/soundfx/file/${encodeURIComponent(file)}`;

/**
 * Plays the book's sound effects as the clip on screen passes them. `on` must be true only while a
 * clip of the book's source video is up: the clock also follows video slides, whose time is their own.
 * A jump (seek, a new clip) fires nothing; only ordinary playback across a mark does.
 */
export function useBookSfx(sfx: BookSfx[] | undefined, on: boolean) {
  const clock = useSlideVideoClock();
  const last = useRef<number | null>(null);
  useEffect(() => {
    const t = on && clock?.playing ? clock.t : null;
    const prev = last.current ?? (t != null ? t - 0.25 : null);
    last.current = t;
    if (t == null || prev == null || !sfx?.length) return;
    const dt = t - prev;
    if (dt <= 0 || dt > 1) return;
    for (const s of sfx) if (s.t > prev && s.t <= t) playSound(sfxUrl(s.file), dbToVolume(s.gain));
  }, [clock?.t, clock?.playing, on]);
}
