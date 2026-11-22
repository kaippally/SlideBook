import { useEffect, useRef, useState } from 'react';
import { SlideLayer } from './SlideLayer';
import { seekSlideVideos, useSlideVideoClock } from '../lib/slideVideoClock';
import { api, subscribe } from '../lib/api';
import { clipSrc, posterUrl, videoLayerModel, type ResolvedVideo } from '../lib/videoObject';

/**
 * A segment's clip as the video object: it flies in on its own IN→HOLD tween and plays t0→t1 once
 * settled (SlideLayer runs a clip only at HOLD). Used by `/output` and the canvas alike.
 *
 * - `hold` ("Card after video"): the clip is a stop of its own. At t1 it stays, frozen on its last
 *   frame, and waits; it leaves only when told (`leave`), as the step after it brings the card in.
 * - `frozen`: arriving back on a clip already played (Prev from its first card) — shown on its last
 *   frame, never played again.
 * - otherwise ("Together", a cue): at t1 it flies out by itself; `onEnd` fires as it starts to leave.
 */
export function ClipLayer({ video, t0, t1, volume, frameW, frameH, scale, onEnd, onGone, hold = false, frozen = false, leave = false, seq, role = 'solo' }: {
  video: ResolvedVideo; t0: number; t1: number; volume: number;
  frameW: number; frameH: number; scale: number;
  onEnd?: () => void; onGone: () => void;
  hold?: boolean; frozen?: boolean; leave?: boolean;
  /** The server's id for this clip (a clip stop's `seq`), so a follower knows the lead is the same clip. */
  seq?: number;
  /** `lead` (`/output`, on air): reports its playhead. `follow` (the canvas while on air): keeps to the
   *  lead's — two players loading on their own drift apart. `solo`: plays by itself. */
  role?: 'lead' | 'follow' | 'solo';
}) {
  const [exiting, setExiting] = useState(false);
  // Paused on t1 by this layer. A media fragment's end time is not honoured once playback is started
  // from code, so the clip would otherwise run on past its end.
  const [stopped, setStopped] = useState(false);
  const clock = useSlideVideoClock();
  const key = useRef(Math.random()).current;
  const end = () => setExiting(x => { if (!x) onEnd?.(); return true; });

  useEffect(() => { if (leave) setExiting(true); }, [leave]);
  // The clip panel's ▶ / ⏸, in every window showing a clip. Play on a clip that has ended starts it again.
  const [paused, setPaused] = useState(false);
  const stoppedRef = useRef(stopped); stoppedRef.current = stopped;
  useEffect(() => subscribe(msg => {
    if (msg.type !== 'transport' || frozen) return;
    if (msg.action === 'pause') { setPaused(true); return; }
    if (msg.action === 'seek') {
      // The scrubber: jump there. Inside the clip it plays on from there (unless paused); past its end
      // it simply shows that frame.
      const t = msg.t as number;
      seekSlideVideos(t);
      if (stoppedRef.current && t < t1 - 0.12) setStopped(false);
      return;
    }
    if (stoppedRef.current) { seekSlideVideos(t0); setStopped(false); }
    setPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [frozen, t0, t1]);
  useEffect(() => {
    if (!clock || clock.t < t1 - 0.12 || stopped) return;
    setStopped(true);
    if (!hold && !frozen && !exiting) end();   // a stop waits on its last frame; anything else leaves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock?.t]);
  // A file that never plays (missing, undecodable) must not hold a card back for ever.
  useEffect(() => {
    if (hold || frozen) return;
    const id = setTimeout(end, (t1 - t0) * 1000 + 8000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Frozen: a paused element that is never played may never load, so it silently plays its last third
  // of a second and stops there — on the clip's last frame.
  const start = frozen ? Math.max(t0, t1 - 0.35) : t0;
  // Fixed for the layer's life: a range edit must not reload the element (it would restart from t0),
  // and no fragment end — this layer stops at t1 itself, so the end can move while it plays.
  const [media] = useState(() => ({ src: clipSrc(video.file, start), poster: posterUrl(video.file, start) }));
  const clockRef = useRef(clock); clockRef.current = clock;
  // The range was edited while this clip is on screen: carry on from the playhead, kept inside it.
  const range = useRef({ t0, t1 });
  useEffect(() => {
    if (range.current.t0 === t0 && range.current.t1 === t1) return;
    range.current = { t0, t1 };
    const t = clockRef.current?.t ?? t0;
    if (frozen) seekSlideVideos(Math.max(t0, t1 - 0.05));
    else if (t < t0) seekSlideVideos(t0);
    else if (t > t1) seekSlideVideos(t1);
    else if (stoppedRef.current && t < t1 - 0.12) setStopped(false);
  }, [t0, t1]);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  // Lead: tell everyone where the clip on air is.
  useEffect(() => {
    if (role !== 'lead' || seq == null || frozen) return;
    const id = setInterval(() => {
      const c = clockRef.current;
      if (c) void api('/api/clipclock', { method: 'POST', json: { seq, t: c.t, playing: c.playing } }).catch(() => {});
    }, 250);
    return () => clearInterval(id);
  }, [role, seq, frozen]);
  // Follow: keep to the lead — jump when more than a third of a second off, pause and play with it.
  useEffect(() => {
    if (role !== 'follow' || seq == null || frozen) return;
    return subscribe(msg => {
      if (msg.type !== 'clipclock' || msg.seq !== seq) return;
      const t = msg.t as number, c = clockRef.current;
      if (c && Math.abs(c.t - t) > 0.33) seekSlideVideos(t);
      if (!msg.playing && !pausedRef.current) setPaused(true);
      if (msg.playing && (pausedRef.current || stoppedRef.current)) { setPaused(false); if (t < t1 - 0.12) setStopped(false); }
    });
  }, [role, seq, frozen, t1]);

  return (
    <SlideLayer model={videoLayerModel(video, key, media.src, frozen ? 0 : volume, exiting, media.poster)} videoPlaying={!stopped && !paused}
      frameW={frameW} frameH={frameH} scale={scale} onExited={onGone} />
  );
}
