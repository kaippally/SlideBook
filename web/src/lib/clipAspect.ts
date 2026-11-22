import { useEffect, useReducer } from 'react';

/**
 * A VIDEO slide page's true shape.
 *
 * The manifest files every video page at 16:9 — `POST /api/slides/decks/:id/pages/clip` has nothing
 * better to use, and no `sc_video_clips` row carries the clip's dimensions — so the page's stored
 * `aspect` is a guess. Everything the slide renderer draws around the media (the border, the drop
 * shadow, the slab, the surface reflection) is keyed off the box that aspect produces, so a 4:3 or
 * portrait clip got a 16:9 frame drawn around it with the picture floating inside (BUG-1737).
 *
 * The element itself knows: `videoWidth/videoHeight` land on `loadedmetadata`. This probes for it
 * once per URL, off a detached element that is released as soon as it has answered, and CACHES the
 * answer for the life of the page — a clip that comes back on a later slide, and the second consumer
 * of the same clip (the reflection copy is a second render of the same tree), both read it for free.
 *
 * The probe costs one metadata range request. It is deliberately not a whole second download:
 * `preload = 'metadata'` stops as soon as the header is read.
 */

const known = new Map<string, number>();
const asking = new Set<string>();
const waiting = new Set<() => void>();

export function useClipAspect(src: string | undefined): number | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!src || known.has(src)) return;
    waiting.add(bump);
    if (!asking.has(src)) {
      asking.add(src);
      const el = document.createElement('video');
      el.preload = 'metadata';
      el.muted = true;
      const release = () => { el.removeAttribute('src'); el.load(); asking.delete(src); };
      el.addEventListener('loadedmetadata', () => {
        if (el.videoWidth > 0 && el.videoHeight > 0) {
          known.set(src, el.videoWidth / el.videoHeight);
          for (const fn of [...waiting]) fn();
        }
        release();
      }, { once: true });
      // A clip that cannot be read keeps the page's stored aspect — a missing number must never
      // blank the slide.
      el.addEventListener('error', release, { once: true });
      el.src = src;
    }
    return () => { waiting.delete(bump); };
  }, [src]);

  return src ? known.get(src) ?? null : null;
}
