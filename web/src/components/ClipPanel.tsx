import { useEffect, useRef, useState } from 'react';
import { seekSlideVideos, useSlideVideoClock } from '../lib/slideVideoClock';
import { segmentClip, type ResolvedVideo } from '../lib/videoObject';
import { segments } from '../lib/segments';
import type { Book } from '../lib/types';

const fmt = (s: number) => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60), r = v - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
};

/**
 * Under the canvas: the source video as one timeline, and the clip of the segment you are on.
 * - Transport: previous segment, play / pause the clip on screen (on air too), next segment.
 * - Overview: the whole video, every segment's clip drawn on it, the playhead. Click a clip to start
 *   that segment; click anywhere else to preview that moment on the canvas.
 * - Range: the current segment's clip, zoomed, with a handle at each end. Dragging sets that segment's
 *   own range (kept against its first slide); Reset returns it to the automatic one.
 */
export function ClipPanel({ book, page, video, atClip, onRange, onTransport, onSeek, onSegment, onCue }: {
  /** The scrubber: move the clip on screen to `t`, in every window showing it (on air too). */
  onSeek: (t: number) => void;
  book: Book;
  page: number;
  video: ResolvedVideo;
  /** A clip is on screen (a clip stop): ▶ / ⏸ drive it; otherwise ▶ starts this segment. */
  atClip: boolean;
  onRange: (firstPageId: string, range: { t0: number; t1: number } | null) => void;
  onTransport: (action: 'play' | 'pause') => void;
  onSegment: (firstPage: number) => void;
  onCue: (t: number) => void;
}) {
  const clock = useSlideVideoClock();
  const duration = book.source?.duration || Math.max(...book.manifest.map(p => p.card?.tEnd ?? 0), 60);
  const segs = segments(book).filter(s => s.t != null).map(s => ({ first: s.pages[0]!.n, clip: segmentClip(book, s.pages[0]!.n)! })).filter(s => s.clip);
  const cur = segmentClip(book, page);
  const curIdx = cur ? segs.findIndex(s => s.first === cur.first) : -1;

  // The range being dragged, shown live and saved on release.
  const [draft, setDraft] = useState<{ t0: number; t1: number } | null>(null);
  useEffect(() => setDraft(null), [cur?.first, book.id]);
  const range = draft ?? cur?.range ?? null;
  const draftRef = useRef(draft); draftRef.current = draft;

  const lane = useRef<HTMLDivElement>(null);
  const win = range ? (() => {
    const pad = Math.max(5, (range.t1 - range.t0) * 0.3);
    return { a: Math.max(0, range.t0 - pad), b: Math.min(duration, range.t1 + pad) };
  })() : { a: 0, b: duration };
  const drag = useRef<{ end: 't0' | 't1'; win: { a: number; b: number } } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current, el = lane.current;
      if (!d || !el || !range) return;
      const r = el.getBoundingClientRect();
      const t = d.win.a + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (d.win.b - d.win.a);
      setDraft(prev => {
        const base = prev ?? range;
        return d.end === 't0' ? { t0: Math.min(t, base.t1 - 0.5), t1: base.t1 } : { t0: base.t0, t1: Math.max(t, base.t0 + 0.5) };
      });
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      const d = draftRef.current;
      if (d && cur) onRange(book.manifest[cur.first - 1]!.id, { t0: +d.t0.toFixed(2), t1: +d.t1.toFixed(2) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  });

  // Scrubbing: press on a lane and drag. With a video on screen it seeks there (here at once, every
  // other window through the server, at most ~8 times a second); with none, a click previews the
  // moment on the canvas.
  const scrubRef = useRef<{ el: HTMLElement; a: number; b: number; last: number; t: number } | null>(null);
  const timeAt = (s: { el: HTMLElement; a: number; b: number }, x: number) => {
    const r = s.el.getBoundingClientRect();
    return s.a + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (s.b - s.a);
  };
  const seekTo = (t: number, force = false) => {
    const s = scrubRef.current;
    seekSlideVideos(t);
    if (!s) return;
    s.t = t;
    if (force || performance.now() - s.last > 120) { s.last = performance.now(); onSeek(t); }
  };
  const startScrub = (e: React.MouseEvent<HTMLElement>, a: number, b: number) => {
    if (e.button !== 0) return;
    const s = { el: e.currentTarget, a, b, last: 0, t: 0 };
    const t = timeAt(s, e.clientX);
    if (!clock) { onCue(t); return; }
    scrubRef.current = s;
    seekTo(t, true);
  };
  useEffect(() => {
    const move = (e: MouseEvent) => { const s = scrubRef.current; if (s) seekTo(timeAt(s, e.clientX)); };
    const up = () => { const s = scrubRef.current; if (s) { scrubRef.current = null; onSeek(s.t); } };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  });

  const pct = (t: number, a = 0, b = duration) => `${((t - a) / Math.max(0.001, b - a)) * 100}%`;
  const playing = !!clock?.playing;
  const btn = 'w-9 h-8 grid place-items-center rounded border border-slate-700 bg-black/50 text-slate-200 hover:border-slate-400 disabled:opacity-30 text-[13px]';
  const ticks = Array.from({ length: 11 }, (_, i) => (i * duration) / 10);

  return (
    <div className="shrink-0 border-t border-slate-800 bg-[#08090c] px-3 py-2 flex flex-col gap-2 select-none">
      <div className="flex items-center gap-2 text-[11px]">
        <button className={btn} disabled={curIdx <= 0} onClick={() => onSegment(segs[curIdx - 1]!.first)} title="Previous segment — its clip">⏮</button>
        <button className={`${btn} w-11 ${playing ? 'border-sky-500 text-sky-200' : ''}`}
          onClick={() => (atClip ? onTransport(playing ? 'pause' : 'play') : cur && onSegment(cur.first))}
          title={atClip ? (playing ? 'Pause the clip' : 'Play the clip (from the start if it has ended)') : 'Play this segment’s clip'}>{playing ? '⏸' : '▶'}</button>
        <button className={btn} disabled={curIdx < 0 || curIdx >= segs.length - 1} onClick={() => onSegment(segs[curIdx + 1]!.first)} title="Next segment — its clip">⏭</button>
        {cur && range ? (<>
          <span className="ml-2 text-slate-400">Segment <b className="text-slate-200">{curIdx + 1}</b>/{segs.length}</span>
          <span className="font-mono tabular-nums text-sky-300">{fmt(range.t0)} → {fmt(range.t1)}</span>
          <span className="font-mono tabular-nums text-slate-500">{(range.t1 - range.t0).toFixed(1)} s</span>
          {cur.custom && !draft && <span className="text-amber-300">own range</span>}
          {(cur.custom || draft) && (
            <button onClick={() => { setDraft(null); onRange(book.manifest[cur.first - 1]!.id, null); }}
              className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-slate-500" title="Back to the automatic range: the statements, with Before / After">Reset</button>
          )}
        </>) : <span className="ml-2 text-slate-500">This slide has no clip — pick a timed card.</span>}
        <span className="ml-auto font-mono tabular-nums text-slate-500">{clock ? fmt(clock.t) : '–'} / {fmt(duration)}</span>
      </div>

      {/* The whole video. */}
      <div className="relative h-7 rounded bg-slate-900 border border-slate-800 cursor-col-resize"
        onMouseDown={e => startScrub(e, 0, duration)}
        title="Click or drag to move the video there · double-click a clip to start its segment">
        {ticks.map((t, i) => <span key={i} className="absolute top-0 bottom-0 border-l border-slate-800 pointer-events-none" style={{ left: pct(t) }} />)}
        {segs.map(s => (
          <span key={s.first} onDoubleClick={e => { e.stopPropagation(); onSegment(s.first); }}
            className={`absolute top-1 bottom-1 rounded-sm ${cur?.first === s.first ? 'bg-sky-400' : 'bg-slate-500/70 hover:bg-slate-300'}`}
            style={{ left: pct(s.clip.range.t0), width: `max(3px, ${pct(s.clip.range.t1 - s.clip.range.t0)})` }}
            title={`Segment at ${fmt(s.clip.range.t0)} — double-click to start it`} />
        ))}
        {range && <span className="absolute -top-0.5 -bottom-0.5 border border-sky-300/70 rounded pointer-events-none" style={{ left: pct(win.a), width: pct(win.b - win.a) }} />}
        {clock && <span className="absolute -top-1 -bottom-1 w-0.5 bg-rose-400 pointer-events-none" style={{ left: pct(clock.t) }} />}
      </div>

      {/* The current segment's clip, zoomed, with its two handles. */}
      {range && (
        <div ref={lane} className="relative h-9 rounded bg-slate-900 border border-slate-800 cursor-col-resize"
          onMouseDown={e => startScrub(e, win.a, win.b)} title="Click or drag to move the video there · drag a handle to set the clip's range">
          {Array.from({ length: Math.floor(win.b - win.a) + 1 }, (_, i) => Math.ceil(win.a) + i).filter(t => t % 5 === 0).map(t => (
            <span key={t} className="absolute top-0 bottom-0 border-l border-slate-800 text-[9px] text-slate-600 pl-0.5" style={{ left: pct(t, win.a, win.b) }}>{fmt(t).replace('.0', '')}</span>
          ))}
          {cur && !cur.custom && !draft ? null : cur && (
            <span className="absolute top-6 bottom-1 bg-slate-600/50 rounded-sm pointer-events-none" style={{ left: pct(cur.auto.t0, win.a, win.b), width: pct(cur.auto.t1 - cur.auto.t0, 0, win.b - win.a) }} title="Automatic range" />
          )}
          <span className="absolute top-2 bottom-3 bg-sky-500/40 border-y border-sky-400" style={{ left: pct(range.t0, win.a, win.b), width: pct(range.t1 - range.t0, 0, win.b - win.a) }} />
          {(['t0', 't1'] as const).map(end => (
            <span key={end} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); drag.current = { end, win }; }}
              className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize flex justify-center group" style={{ left: pct(range[end], win.a, win.b) }}
              title={end === 't0' ? 'Drag: where the clip starts' : 'Drag: where the clip ends'}>
              <span className="w-1 h-full rounded bg-sky-300 group-hover:bg-white" />
            </span>
          ))}
          {clock && clock.t >= win.a && clock.t <= win.b && <span className="absolute -top-1 -bottom-1 w-0.5 bg-rose-400 pointer-events-none" style={{ left: pct(clock.t, win.a, win.b) }} />}
        </div>
      )}
    </div>
  );
}
