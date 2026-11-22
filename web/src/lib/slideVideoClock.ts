import { useSyncExternalStore } from 'react';

/**
 * Where the slide video on the Slides canvas has got to (BUG-1802). The canvas's own <video> reports
 * here, and every timeline in this window — under the canvas, on the status bar — reads it. The
 * canvas copy starts on the same page arrival and follows the same play/pause as the one on air, so
 * its clock is the show's clock without a round trip.
 */
export interface SlideVideoClock { t: number; d: number; playing: boolean }

let clock: SlideVideoClock | null = null;
let owner: HTMLVideoElement | null = null;
const heard = new Set<HTMLVideoElement>();

/** Jump every heard copy in this window to `t`; reflections follow their lead copy on their own. */
export function seekSlideVideos(t: number) {
  for (const el of heard) {
    const to = Number.isFinite(el.duration) ? Math.min(t, el.duration) : t;
    if (Math.abs(el.currentTime - to) > 0.25) el.currentTime = to;
  }
}
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

function read(el: HTMLVideoElement): SlideVideoClock {
  return { t: el.currentTime || 0, d: Number.isFinite(el.duration) ? el.duration : 0, playing: !el.paused && !el.ended };
}

/** Attach a canvas <video>. Returns the detach. The element updated most recently is the one shown. */
export function reportSlideVideo(el: HTMLVideoElement): () => void {
  const on = () => { owner = el; clock = read(el); emit(); };
  const evs = ['timeupdate', 'durationchange', 'play', 'pause', 'ended', 'seeked', 'loadedmetadata'] as const;
  for (const e of evs) el.addEventListener(e, on);
  heard.add(el);
  return () => {
    heard.delete(el);
    for (const e of evs) el.removeEventListener(e, on);
    if (owner === el) { owner = null; clock = null; emit(); }
  };
}

export function useSlideVideoClock(): SlideVideoClock | null {
  return useSyncExternalStore(
    f => { subs.add(f); return () => { subs.delete(f); }; },
    () => clock,
  );
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
