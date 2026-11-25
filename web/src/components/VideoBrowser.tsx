import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, control, subscribe, useJobs } from '../lib/api';
import { captionAt, editOf, layoutOf, outTime } from '../lib/shorts';
import type { ShortPlan, Transcript, VideoItem } from '../lib/types';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { Dialog, NoticeHost, askConfirm, attempt, notify } from './Dialog';
import { ShortBuilder } from './ShortBuilder';
import { ShortStage } from './ShortStage';
import { RenderQueue } from './RenderQueue';
import { AssetBin } from './AssetBin';
import { ShortTracks, type ClipSel } from './ShortTracks';
import { Splitter, usePanelSize } from './Splitter';
import { useSoundFx, useSoundLengths } from '../lib/soundfx';
import { ShortsShelf } from './ShortsShelf';
import { openWindow } from '../lib/windows';

const SUB_LANGS = ['Original', 'English', 'Malayalam', 'Hindi', 'Arabic', 'Tamil'];

const fmt = (t: number) => {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const ss = sec.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function useVideos(): VideoItem[] {
  const [list, setList] = useState<VideoItem[]>([]);
  useEffect(() => {
    api<VideoItem[]>('/api/videos').then(setList).catch(() => {});
    return subscribe(msg => {
      if (msg.type === 'video') {
        setList(prev => {
          const i = prev.findIndex(v => v.id === msg.video.id);
          if (i === -1) return [msg.video, ...prev];
          const next = prev.slice(); next[i] = msg.video; return next;
        });
      }
      if (msg.type === 'videoGone') setList(prev => prev.filter(v => v.id !== msg.videoId));
      if (msg.type === 'videoError') notify(msg.error, 'error');
      if (msg.type === 'videoClip') notify(`Clip saved: ${msg.path}`);
    });
  }, []);
  return list;
}

function useTranscript(id: number | null, state: string | undefined): Transcript | null {
  const [tr, setTr] = useState<Transcript | null>(null);
  useEffect(() => {
    setTr(null);
    if (!id) return;
    let live = true;
    api<Transcript>(`/api/videos/${id}/transcript`).then(t => { if (live) setTr(t); }).catch(() => {});
    return () => { live = false; };
  }, [id, state]);
  return tr;
}

/** The timeline: drag anywhere on it to scrub, drag the amber handles or band to set the range. Below it, every
 *  short found in the video as a lane of ranges (kept parts solid). */
function Timeline({ duration, start, end, time, onRange, onSeek, onPlayRange, plans, tr, planId, onPlan }: {
  duration: number; start: number; end: number; time: number;
  onRange: (s: number, e: number) => void; onSeek: (t: number) => void; onPlayRange: () => void;
  plans: ShortPlan[]; tr: Transcript | null; planId: number | null; onPlan: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Shift+wheel zooms the whole timeline about the playhead: it keeps its place on screen while the frames on
  // either side grow outward, and the scrollbar below shows how much of the video is in view.
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0);
  const anchor = useRef<{ t: number; x: number } | null>(null);
  const live = useRef({ zoom, time, duration });
  live.current = { zoom, time, duration };
  useEffect(() => { setZoom(1); }, [duration]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const { zoom: z, time: t, duration: d } = live.current;
      if (!d) return;
      const max = Math.max(1, d / 5);
      const next = Math.min(max, Math.max(1, z * Math.exp(-(e.deltaY || e.deltaX) * 0.002)));
      if (next === z) return;
      const w = el.clientWidth * z, px = (t / d) * w - el.scrollLeft;
      // The playhead holds its place; if it is scrolled out of view, the moment under the mouse does instead.
      if (px >= 0 && px <= el.clientWidth) anchor.current = { t, x: px };
      else {
        const mx = e.clientX - el.getBoundingClientRect().left;
        anchor.current = { t: ((el.scrollLeft + mx) / w) * d, x: mx };
      }
      setZoom(next);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current, a = anchor.current;
    if (!el || !a || !duration) return;
    anchor.current = null;
    el.scrollLeft = (a.t / duration) * el.clientWidth * zoom - a.x;
  }, [zoom]);
  // A playhead that runs (or is sent) out of view brings the view with it.
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom <= 1 || !duration || anchor.current) return;
    const px = (time / duration) * el.clientWidth * zoom - el.scrollLeft;
    if (px < 0 || px > el.clientWidth) el.scrollLeft += px - el.clientWidth * 0.1;
  }, [time]);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const follow = (fn: (t: number) => void) => {
    const move = (ev: MouseEvent) => fn(at(ev.clientX));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const drag = (which: 'start' | 'end' | 'body') => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const t0 = at(e.clientX), s0 = start, e0 = end;
    follow(t => {
      if (which === 'start') onRange(Math.min(t, e0 - 1), e0);
      else if (which === 'end') onRange(s0, Math.max(t, s0 + 1));
      else { const d = Math.min(Math.max(t - t0, -s0), duration - e0); onRange(s0 + d, e0 + d); }
    });
  };
  const scrub = (e: React.MouseEvent) => { e.preventDefault(); onSeek(at(e.clientX)); follow(onSeek); };
  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const lanes = useMemo(() => {
    if (!tr) return [];
    const rows: { p: ShortPlan; s: number; e: number; segs: { s: number; e: number }[] }[][] = [];
    for (const p of plans) {
      const s = tr.lines[p.span[0]]?.t ?? 0, e = tr.ends[p.span[1]] ?? s;
      const item = { p, s, e, segs: editOf(p.keep, tr).segs };
      const row = rows.find(r => r.every(x => x.e <= s || x.s >= e));
      if (row) row.push(item); else rows.push([item]);
    }
    return rows.slice(0, 4);
  }, [plans, tr]);
  const thumbDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = scroller.current;
    if (!el) return;
    const x0 = e.clientX, s0 = el.scrollLeft, k = el.scrollWidth / el.clientWidth;
    const move = (ev: MouseEvent) => { el.scrollLeft = s0 + (ev.clientX - x0) * k; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const trackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.scrollLeft = ((e.clientX - r.left) / r.width) * el.scrollWidth - el.clientWidth / 2;
  };
  return (
    <div>
    <div ref={scroller} onScroll={e => setScroll(e.currentTarget.scrollLeft)}
      className="tl-scroll overflow-x-auto overflow-y-hidden -mt-5 pt-5 pb-1"
      title={zoom > 1 ? `Zoom ${zoom.toFixed(1)}× · Shift+wheel to zoom` : 'Shift+wheel to zoom'}>
    <div className="flex flex-col gap-1" style={{ width: `${zoom * 100}%` }}>
      <div ref={ref} onMouseDown={scrub} onMouseMove={e => setHover(at(e.clientX))} onMouseLeave={() => setHover(null)}
        className="relative h-10 rounded bg-slate-800/70 cursor-col-resize select-none">
        <div onMouseDown={drag('body')} onDoubleClick={e => { e.stopPropagation(); onPlayRange(); }}
          title="Double-click to play the range" className="absolute inset-y-0 bg-amber-400/25 border-y border-amber-400/60 cursor-grab"
          style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
        {(['start', 'end'] as const).map(w => (
          <div key={w} onMouseDown={drag(w)} title={w === 'start' ? 'In' : 'Out'}
            className="absolute inset-y-[-3px] w-2.5 -ml-[5px] rounded-sm bg-amber-400 cursor-ew-resize hover:bg-amber-300"
            style={{ left: pct(w === 'start' ? start : end) }} />
        ))}
        <div className="absolute inset-y-[-4px] w-0.5 -ml-px bg-white pointer-events-none" style={{ left: pct(time) }} />
        <div onMouseDown={e => { e.stopPropagation(); scrub(e); }} title="Drag the playhead"
          className="absolute -top-3 w-3.5 h-3.5 -ml-[7px] rounded-full bg-white ring-2 ring-slate-900 shadow cursor-ew-resize hover:scale-125 transition-transform z-10"
          style={{ left: pct(time) }} />
        {hover !== null && (
          <div className="absolute -top-5 -translate-x-1/2 px-1 rounded bg-black/80 text-[10px] tabular-nums pointer-events-none" style={{ left: pct(hover) }}>{fmt(hover)}</div>
        )}
      </div>
      {lanes.map((row, i) => (
        <div key={i} className="relative h-3.5">
          {row.map(({ p, s, e, segs }) => (
            <div key={p.id} onClick={() => onPlan(p.id)} title={`${p.title} — ${Math.round(p.length)} s, score ${p.virality?.score ?? '–'}`}
              className={`absolute inset-y-0 rounded-sm cursor-pointer overflow-hidden ${p.id === planId ? 'bg-amber-400/30 ring-1 ring-amber-400' : 'bg-fuchsia-500/20 hover:bg-fuchsia-500/35'}`}
              style={{ left: pct(s), width: `max(4px, calc(${pct(e)} - ${pct(s)}))` }}>
              {segs.map((g, k) => (
                <div key={k} className={`absolute inset-y-0 ${p.id === planId ? 'bg-amber-400' : 'bg-fuchsia-400/80'}`}
                  style={{ left: `${((g.s - s) / Math.max(0.01, e - s)) * 100}%`, width: `${((g.e - g.s) / Math.max(0.01, e - s)) * 100}%` }} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
    </div>
    {zoom > 1 && (
      <div onMouseDown={trackClick} className="relative h-2.5 mt-0.5 rounded-full bg-slate-800/80 cursor-pointer" title={`Zoom ${zoom.toFixed(1)}×`}>
        <div onMouseDown={thumbDrag} className="absolute inset-y-0 rounded-full bg-slate-500 hover:bg-slate-400 cursor-grab"
          style={{ left: `${(scroll / ((scroller.current?.clientWidth || 1) * zoom)) * 100}%`, width: `${100 / zoom}%` }} />
      </div>
    )}
    </div>
  );
}

const sentBy = (v: VideoItem) => (v.senders || []).map(s => s.name || (s.username ? '@' + s.username : s.id)).join(', ');

export function VideoBrowser() {
  const videos = useVideos();
  const jobs = useJobs();
  const [selId, setSelId] = useState<number | null>(() => Number(getUiSetting('videos:selected')) || null);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [time, setTime] = useState(0);
  const [playRange, setPlayRange] = useState(false);
  const [playEdit, setPlayEdit] = useState(false);
  const [paused, setPaused] = useState(true);
  const [folderAsk, setFolderAsk] = useState<{ initial: string; resolve: (f: string) => void } | null>(null);
  const [subLang, setSubLang] = useState(() => getUiSetting('videos:subLang') || 'Malayalam');
  const [shownSub, setShownSub] = useState<string | null>(null);
  const [builder, setBuilder] = useState(() => getUiSetting('videos:builder') === '1');
  const [view, setView] = useState<'short' | 'source'>('short');
  const [planId, setPlanId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ShortPlan | null>(null);
  const [leftTab, setLeftTab] = useState<'videos' | 'shorts'>(() => getUiSetting('videos:leftTab') === 'shorts' ? 'shorts' : 'videos');
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const openPlan = useRef<number | null>(null);
  const [clipSel, setClip] = useState<ClipSel>(null);
  const [lib, reloadLib] = useSoundFx();
  const lengths = useSoundLengths(lib);
  const [libW, setLibW, resetLibW] = usePanelSize('library', 300, 180, 520);
  const [rightW, setRightW, resetRightW] = usePanelSize('builder', 430, 320, 760);
  const [queueW, setQueueW, resetQueueW] = usePanelSize('queue', 280, 200, 600);
  const [binW, setBinW, resetBinW] = usePanelSize('bin', 260, 160, 560);
  const [bottomH, setBottomH, resetBottomH] = usePanelSize('bottom', 300, 120, 720);
  const vref = useRef<HTMLVideoElement>(null);
  const pending = useRef<Partial<ShortPlan>>({});
  const saveTimer = useRef<number>();

  const sel = videos.find(v => v.id === selId) ?? null;
  const tr = useTranscript(sel?.id ?? null, sel?.transcriptState);
  const duration = sel?.duration || vref.current?.duration || 0;
  useEffect(() => { if (selId) setUiSetting('videos:selected', String(selId)); }, [selId]);
  useEffect(() => { setRange([0, sel?.duration || 0]); setTime(0); setPlayRange(false); setPlayEdit(false); }, [selId, sel?.duration]);
  useEffect(() => { setShownSub(null); setPlanId(openPlan.current); openPlan.current = null; setPaused(true); }, [selId]);
  useEffect(() => { setUiSetting('videos:leftTab', leftTab); if (leftTab === 'videos') setShortUrl(null); }, [leftTab]);
  useEffect(() => { setUiSetting('videos:subLang', subLang); }, [subLang]);
  useEffect(() => { setUiSetting('videos:builder', builder ? '1' : '0'); }, [builder]);
  const newestSub = sel?.subtitles[0]?.vtt;
  const seenSub = useRef<string | undefined>(newestSub);
  useEffect(() => { if (newestSub && newestSub !== seenSub.current) setShownSub(newestSub); seenSub.current = newestSub; }, [newestSub]);

  // The selected short is edited locally and saved shortly after; the server's copy replaces it only when no
  // edit is waiting to be saved, so a drag is never pulled back by its own echo.
  const serverPlan = sel?.plans?.find(p => p.id === planId) ?? null;
  useEffect(() => { setClip(null); }, [planId]);
  useEffect(() => {
    if (!serverPlan) { setDraft(null); return; }
    if (!Object.keys(pending.current).length) setDraft({ ...serverPlan, layout: layoutOf(serverPlan) });
  }, [serverPlan]);
  const flush = useCallback(() => {
    const fields = pending.current;
    if (!sel || !planId || !Object.keys(fields).length) return;
    pending.current = {};
    void attempt(api(`/api/videos/${sel.id}/plans/${planId}`, { method: 'PUT', json: fields }), 'Save the short');
  }, [sel, planId]);
  const patch = (fields: Partial<ShortPlan>) => {
    setDraft(d => d ? { ...d, ...fields } : d);
    pending.current = { ...pending.current, ...fields };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 450);
  };
  useEffect(() => () => { window.clearTimeout(saveTimer.current); flush(); }, [planId, flush]);

  const { segs, total } = useMemo(() => draft && tr ? editOf(draft.keep, tr) : { segs: [], total: 0 }, [draft?.keep, tr]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? videos.filter(v => `${v.title} ${v.uploader} ${v.url} ${sentBy(v)}`.toLowerCase().includes(q)) : videos;
  }, [videos, query]);
  const checks = jobs.filter(j => j.options?.video === selId);

  const seek = useCallback((t: number) => { if (vref.current) vref.current.currentTime = t; setTime(t); }, []);
  const [start, end] = range;
  const setIn = () => setRange([Math.min(time, end - 1), end]);
  const setOut = () => setRange([start, Math.max(time, start + 1)]);
  const playSel = () => { const v = vref.current; if (!v) return; v.currentTime = start; setPlayRange(true); void v.play(); };
  const selectPlan = (id: number | null) => {
    flush();
    setPlanId(id);
    setBuilder(true);
    const p = sel?.plans.find(x => x.id === id);
    if (p && tr) { const s = tr.lines[p.span[0]]?.t ?? 0; setRange([s, tr.ends[p.span[1]] ?? s + 1]); seek(s); }
  };
  // Double-click on a short: select it and play its edit from the first cut, straight away.
  const playPlan = (id: number) => {
    const p = sel?.plans.find(x => x.id === id);
    const v = vref.current;
    if (!p || !tr || !v) return;
    if (id !== planId) selectPlan(id);
    const first = editOf(p.keep, tr).segs[0];
    if (!first) return;
    v.currentTime = first.s;
    setTime(first.s);
    setPlayEdit(true);
    void v.play();
  };
  const togglePlayEdit = () => {
    const v = vref.current;
    if (!v || !segs.length) return;
    if (playEdit) { v.pause(); setPlayEdit(false); return; }
    const inside = segs.find(s => time >= s.s && time < s.e - 0.1);
    v.currentTime = inside ? time : segs[0].s;
    setPlayEdit(true);
    void v.play();
  };

  // Playing the edit skips what is cut: checked every frame, not every timeupdate, so a cut never leaks through.
  useEffect(() => {
    if (!playEdit || !segs.length) return;
    let raf = 0;
    const tick = () => {
      const v = vref.current;
      if (!v) return;
      const t = v.currentTime;
      const i = segs.findIndex(s => t < s.e - 0.02);
      if (i === -1) { v.pause(); setPlayEdit(false); return; }
      if (t < segs[i].s - 0.05) v.currentTime = segs[i].s;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playEdit, segs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO'].includes(t.tagName) || folderAsk !== null) return;
      const v = vref.current;
      if (clipSel && (e.key === 'Delete' || e.key === 'Backspace') && draft) {
        e.preventDefault();
        if (clipSel.kind === 'sfx') patch({ sfx: draft.sfx.filter((_, k) => k !== clipSel.i) });
        if (clipSel.kind === 'img') patch({ images: (draft.images ?? []).filter((_, k) => k !== clipSel.i) });
        setClip(null);
        return;
      }
      if (clipSel && e.key === 'Escape') { setClip(null); return; }
      if (e.key === 'i' || e.key === 'I') setIn();
      else if (e.key === 'o' || e.key === 'O') setOut();
      else if (e.key === ' ' && v) { e.preventDefault(); if (v.paused) void v.play(); else v.pause(); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && v) {
        e.preventDefault();
        seek(Math.min(duration, Math.max(0, v.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1))));
      } else if ((e.key === ',' || e.key === '.') && v) { v.pause(); seek(Math.max(0, v.currentTime + (e.key === ',' ? -1 : 1) / 30)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const deleteVideo = async (v: VideoItem) => {
    const f = await api<{ files: number; bytes: number; renders: number; clips: number; subtitles: number; plans: number; sharedWithBook: boolean }>(`/api/videos/${v.id}/files`).catch(() => null);
    const parts = f ? [
      `${f.files} file${f.files === 1 ? '' : 's'} (${(f.bytes / 1048576).toFixed(0)} MB) will be deleted from disk:`,
      '• the downloaded video' + (f.sharedWithBook ? ' — kept, a slide book still uses it' : ''),
      f.renders ? `• ${f.renders} rendered short${f.renders === 1 ? '' : 's'}` : null,
      f.clips ? `• ${f.clips} clip${f.clips === 1 ? '' : 's'}` : null,
      f.subtitles ? `• ${f.subtitles} subtitle file set${f.subtitles === 1 ? '' : 's'}` : null,
      f.plans ? `• ${f.plans} short${f.plans === 1 ? '' : 's'} in the Short builder, and the transcript` : '• the transcript',
      '',
      'Copies you saved to your own folders are kept. This cannot be undone.',
    ].filter(x => x !== null).join(String.fromCharCode(10)) : 'Its files will be deleted from disk. This cannot be undone.';
    if (!await askConfirm(`Delete “${v.title || v.url}”?`, parts, { label: 'Delete', danger: true })) return;
    if (v.id === selId) setSelId(null);
    const r = await attempt(api<{ files: number }>(`/api/videos/${v.id}`, { method: 'DELETE' }), 'Delete video');
    if (!r) return;
    notify(`Deleted — ${r.files} file${r.files === 1 ? '' : 's'} removed from disk.`);
  };

  const add = async () => {
    const url = link.trim();
    if (!url) return;
    const v = await attempt(api<VideoItem & { existing?: { warning: string } }>('/api/videos', { method: 'POST', json: { url } }), 'Add video');
    if (v) { setLink(''); setSelId(v.id); if (v.existing) notify(v.existing.warning); }
  };
  const pickFolder = async (): Promise<string> => {
    const last = (await api<{ folder: string }>('/api/videos/clip-folder').catch(() => ({ folder: '' }))).folder;
    if (window.pywebview?.api?.pick_folder) return window.pywebview.api.pick_folder(last);
    return new Promise(resolve => setFolderAsk({ initial: last, resolve }));
  };
  const run = async (action: 'factcheck' | 'summary' | 'clip' | 'subtitles', folder?: string) => {
    if (!sel) return;
    const r = await attempt(api(`/api/videos/${sel.id}/${action}`, { method: 'POST', json: { start, end, folder, lang: subLang } }),
      { factcheck: 'Fact check', summary: 'Summarise', clip: 'Clip', subtitles: 'Subtitles' }[action]);
    if (r && action === 'factcheck') notify('Fact check queued: the book appears in the main window when it is done');
  };
  const clip = async () => { const f = await pickFolder(); if (f) void run('clip', f); };
  const addSfxAtPlayhead = (file: string) => {
    if (!draft) return;
    if (outTime(time, segs) === null) { notify('Move the playhead inside this short first', 'error'); return; }
    const s = { t: Math.round(time * 100) / 100, file, gain: -4 };
    const next = [...draft.sfx, s].sort((a, b) => a.t - b.t);
    patch({ sfx: next });
    setClip({ kind: 'sfx', i: next.indexOf(s) });
  };
  const addToQueue = async () => {
    if (!sel) return;
    const p = await attempt(api<ShortPlan>(`/api/videos/${sel.id}/queue`, { method: 'POST', json: { start, end } }), 'Add to the queue');
    if (p) { setPlanId(p.id); setBuilder(true); notify('Added to the queue: Gemini is fetching its pictures'); }
  };
  const reveal = (path: string) => void attempt(api('/api/reveal', { method: 'POST', json: { path } }), 'Show in folder');

  const ready = sel?.status === 'ready';
  const canAct = ready && !sel?.busy && end - start >= 1;
  const btn = 'px-3 py-1.5 rounded text-xs font-semibold border disabled:opacity-40 disabled:cursor-not-allowed';
  const stageOn = builder && !!draft && view === 'short';
  const openShort = (videoId: number, id: number) => {
    setLeftTab('videos');
    setBuilder(true);
    if (videoId === selId) { setPlanId(id); return; }
    openPlan.current = id;
    setSelId(videoId);
  };

  const videoProps: React.VideoHTMLAttributes<HTMLVideoElement> = {
    onTimeUpdate: e => {
      const t = e.currentTarget.currentTime;
      setTime(t);
      if (playRange && t >= end) { e.currentTarget.pause(); setPlayRange(false); }
    },
    onPlay: () => setPaused(false),
    onPause: () => { setPaused(true); setPlayRange(false); setPlayEdit(false); },
    onLoadedMetadata: e => { if (!sel?.duration) setRange([0, e.currentTarget.duration]); if (time) e.currentTarget.currentTime = time; },
  };
  // A smoother clock than timeupdate while the stage shows captions.
  useEffect(() => {
    if (!stageOn) return;
    let raf = 0;
    const tick = () => { const v = vref.current; if (v && !v.paused) setTime(v.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stageOn]);

  // The pictures on screen at the playhead, by their index in the plan.
  const liveImages = useMemo(() => {
    const out: number[] = [];
    const o = outTime(time, segs);
    if (o === null || !draft) return out;
    (draft.images ?? []).forEach((im, i) => { const a = outTime(im.t, segs); if (a !== null && o >= a && o < a + im.d) out.push(i); });
    return out;
  }, [time, segs, draft]);
  const caption = useMemo(() => {
    if (!draft || !tr) return null;
    const lay = draft.layout;
    const subs = lay.sub.lang !== 'Original' ? draft.subs?.[lay.sub.lang] : undefined;
    return captionAt(time, segs, tr, i => subs?.[String(i)] ?? tr.lines[i].text, lay.sub.words);
  }, [time, segs, tr, draft]);

  return (
    <div className="h-screen grid bg-[#0b0e13] text-slate-200"
      style={{ gridTemplateColumns: `${libW}px auto minmax(0,1fr)${builder && sel ? ` auto ${rightW}px` : ''}`, gridTemplateRows: `minmax(0,1fr) auto ${bottomH}px` }}>
      {/* Library */}
      <aside className="flex flex-col min-h-0 border-r border-slate-800">
        <div className="flex border-b border-slate-800 text-[12px]">
          {(['videos', 'shorts'] as const).map(t => (
            <button key={t} onClick={() => setLeftTab(t)}
              className={`flex-1 py-1.5 font-semibold ${leftTab === t ? 'text-amber-300 border-b-2 border-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>
              {t === 'videos' ? 'Videos' : 'Shorts'}
            </button>
          ))}
        </div>
        {leftTab === 'shorts' ? (
          <ShortsShelf videos={videos} current={shortUrl} onPlay={setShortUrl} onOpen={openShort} onPickFolder={pickFolder} />
        ) : <>
        <div className="p-2 flex gap-1 border-b border-slate-800">
          <input value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }}
            placeholder="Paste a video link" className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-[12px]" />
          <button onClick={add} className="px-2 rounded border border-slate-700 text-[11px] hover:border-slate-500">Add</button>
        </div>
        <div className="px-2 py-1.5 flex items-center gap-2 border-b border-slate-800">
          <div className="relative flex-1">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-[12px]" />
            {query && <button onClick={() => setQuery('')} className="absolute right-1.5 top-1 text-slate-500 hover:text-slate-200 text-[12px]">✕</button>}
          </div>
          <span className="text-[11px] text-slate-500 tabular-nums">{query ? `${shown.length}/${videos.length}` : videos.length}</span>
        </div>
        <div className="flex-1 overflow-auto p-2 grid grid-cols-2 gap-2 content-start">
          {shown.map(v => (
            <button key={v.id} onClick={() => setSelId(v.id)}
              className={`group relative text-left rounded overflow-hidden border ${v.id === selId ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-800 hover:border-slate-600'}`}>
              <div className="relative aspect-video bg-slate-900">
                {v.thumb && <img src={`/media/${v.thumb}`} alt="" className="w-full h-full object-cover" />}
                {v.duration > 0 && <span className="absolute bottom-1 right-1 px-1 rounded bg-black/80 text-[10px] tabular-nums">{fmt(v.duration).replace(/\.\d$/, '')}</span>}
                {v.origin !== 'app' && <span className="absolute top-1 left-1 px-1 rounded bg-sky-900/90 text-[9px] text-sky-200" title="Sent by Telegram">TG</span>}
                {v.plans?.length > 0 && <span className="absolute bottom-1 left-1 px-1 rounded bg-fuchsia-800/90 text-[9px] text-fuchsia-100" title="Shorts found">{v.plans.length} shorts</span>}
                {v.status !== 'ready' && (
                  <div className="absolute inset-0 grid place-items-center bg-black/60 p-1 text-center text-[10px]">
                    {v.status === 'failed'
                      ? <span className="text-rose-300">Failed <span role="button" onClick={e => { e.stopPropagation(); void api(`/api/videos/${v.id}/retry`, { method: 'POST' }); }} className="underline">retry</span></span>
                      : <span className="text-slate-300">{v.step || 'Queued'}</span>}
                  </div>
                )}
                <span role="button" title="Delete from the library and from disk" onClick={e => { e.stopPropagation(); void deleteVideo(v); }}
                  className="absolute top-1 right-1 hidden group-hover:block px-1 rounded bg-black/80 text-[10px] text-rose-300">✕</span>
              </div>
              <div className="px-1.5 py-1 text-[11px] leading-tight line-clamp-2">{v.title || v.url}</div>
              {sentBy(v) && <div className="px-1.5 pb-1 -mt-0.5 text-[10px] text-sky-300/80 truncate" title={`Sent on Telegram by ${sentBy(v)}`}>from {sentBy(v)}</div>}
            </button>
          ))}
          {!videos.length && <div className="col-span-2 p-3 text-[11px] text-slate-500">No videos yet. Links sent to the Telegram bot land here.</div>}
        </div>
        </>}
      </aside>
      <Splitter dir="col" size={libW} onSize={setLibW} onReset={resetLibW} />

      {/* Canvas */}
      <main className="min-h-0 min-w-0 flex flex-col bg-black">
        <div className="px-3 py-1.5 border-b border-slate-800 text-[12px] flex items-center gap-2 min-w-0">
          <span className="truncate">
            {sel ? <><span className="font-semibold">{sel.title || sel.url}</span>{sel.uploader && <span className="text-slate-500"> · {sel.uploader}</span>}{sentBy(sel) && <span className="text-sky-300/80"> · sent by {sentBy(sel)}</span>}</> : <span className="text-slate-500">Pick a video</span>}
          </span>
          {builder && draft && (
            <div className="ml-auto flex shrink-0 rounded border border-slate-700 overflow-hidden text-[11px]">
              {(['short', 'source'] as const).map(m => (
                <button key={m} onClick={() => setView(m)} className={`px-2 py-0.5 ${view === m ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {m === 'short' ? 'Short 9:16' : 'Source'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 relative grid place-items-center">
          {leftTab === 'shorts' && shortUrl ? (
            <video key={shortUrl} src={shortUrl} controls autoPlay className="absolute inset-0 w-full h-full object-contain" />
          ) : ready && sel ? (
            <div className="absolute inset-0 flex min-w-0">
              <div style={{ width: queueW }} className="shrink-0 min-w-0 bg-[#0b0e13] border-r border-slate-800">
                <RenderQueue videos={videos} openId={planId} onAdd={() => void addToQueue()} canAdd={ready && end - start >= 1}
                  rangeText={`${fmt(start)}–${fmt(end)}`} onOpen={openShort} />
              </div>
              <Splitter dir="col" size={queueW} onSize={setQueueW} onReset={resetQueueW} />
              <div className="flex-1 min-w-0 relative">
                {stageOn && draft ? (
                  <ShortStage key={`${sel.id}-stage`} src={sel.video} vref={vref} videoProps={videoProps} layout={draft.layout}
                    onLayout={layout => patch({ layout })} caption={caption} title={draft.layout.title.text}
                    images={liveImages} selected={clipSel?.kind === 'img' ? clipSel.i : null}
                    onSelectImage={i => setClip({ kind: 'img', i })} onImages={images => patch({ images })} allImages={draft.images ?? []} />
                ) : (
                  <video ref={vref} key={sel.id} src={sel.video} controls className="absolute inset-0 w-full h-full object-contain" {...videoProps}>
                    {shownSub && <track key={shownSub} kind="subtitles" src={shownSub} default
                      ref={el => { if (el) el.track.mode = 'showing'; }} />}
                  </video>
                )}
              </div>
              {stageOn && draft && <>
                <Splitter dir="col" size={binW} onSize={setBinW} onReset={resetBinW} sign={-1} />
                <div style={{ width: binW }} className="shrink-0 min-w-0 border-l border-slate-800">
                  <AssetBin lib={lib} reloadLib={reloadLib} onAddSfx={addSfxAtPlayhead} plan={draft} videoId={sel.id}
                    busy={sel.busy} selectedImage={clipSel?.kind === 'img' ? clipSel.i : null}
                    onSelectImage={i => { setClip({ kind: 'img', i }); const im = draft.images?.[i]; if (im) seek(im.t + 0.05); }} />
                </div>
              </>}
            </div>
          ) : sel ? <div className="text-slate-500 text-sm">{sel.status === 'failed' ? sel.error : sel.step || 'Downloading…'}</div> : null}
        </div>
      </main>

      {builder && sel && <Splitter dir="col" size={rightW} onSize={setRightW} onReset={resetRightW} sign={-1} />}
      {builder && sel && (
        <ShortBuilder video={sel} tr={tr} plan={draft} segs={segs} total={total} time={time}
          onSelect={selectPlan} onPlayPlan={playPlan} onPatch={patch} onSeek={seek} onPlayEdit={togglePlayEdit} playing={playEdit} onPickFolder={pickFolder}
          lib={lib} reloadLib={reloadLib} clip={clipSel} onClip={setClip} />
      )}

      <div className="col-span-full"><Splitter dir="row" size={bottomH} onSize={setBottomH} onReset={resetBottomH} sign={-1} /></div>

      {/* Control */}
      <section className="col-span-full min-h-0 overflow-auto border-t border-slate-800 bg-[#11151c] px-3 py-2 flex flex-col gap-2">
        {stageOn && draft && (
          <ShortTracks plan={draft} segs={segs} total={total} tr={tr} time={time} lib={lib} lengths={lengths}
            selected={clipSel} onSelect={setClip} onPatch={patch} onSeek={seek} />
        )}
        <Timeline duration={duration} start={start} end={end} time={time} onRange={(s, e) => setRange([s, e])} onSeek={seek} onPlayRange={playSel}
          plans={sel?.plans ?? []} tr={tr} planId={planId} onPlan={selectPlan} />
        <div className="flex items-center gap-2 text-[11px]">
          <button onClick={() => { const v = vref.current; if (v) { if (v.paused) void v.play(); else v.pause(); } }} disabled={!ready}
            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40 w-14">{paused ? '▶' : '❚❚'}</button>
          <button onClick={setIn} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Set in <span className="opacity-50">I</span></button>
          <span className="tabular-nums text-amber-300">{fmt(start)}</span>
          <span className="text-slate-600">→</span>
          <span className="tabular-nums text-amber-300">{fmt(end)}</span>
          <button onClick={setOut} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Set out <span className="opacity-50">O</span></button>
          <span className="text-slate-500 tabular-nums">length {fmt(end - start)}</span>
          <button onClick={playSel} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">▶ Range</button>
          <button onClick={() => setRange([0, duration])} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Whole video</button>
          <span className="text-slate-600 hidden 2xl:inline">← → seek · , . frame · Space play</span>
          <span className="ml-auto tabular-nums text-slate-400">{fmt(time)} / {fmt(duration)}</span>
          <button onClick={() => openWindow('/help', 'SlideBook Help', 900, 900)} className="px-2 py-1 rounded border border-slate-700" title="Help — the same guide the Telegram app shows">? Help</button>
        </div>
        <div className="flex items-center gap-2">
          <button disabled={!canAct} onClick={() => void run('factcheck')} className={`${btn} border-blue-500 bg-blue-600 hover:bg-blue-500 text-white`}>Fact check</button>
          <button disabled={!canAct} onClick={() => void run('summary')} className={`${btn} border-slate-600 hover:border-slate-400`}>Summarize</button>
          <button disabled={!ready || end - start < 1} onClick={() => void addToQueue()} className={`${btn} border-slate-600 hover:border-slate-400`} title="A short from the selected range: it joins the render queue, gets its pictures and renders in turn">Make short</button>
          <button disabled={!canAct} onClick={() => void clip()} className={`${btn} border-slate-600 hover:border-slate-400`}>Clip</button>
          <div className="flex items-stretch">
            <button disabled={!canAct} onClick={() => void run('subtitles')} className={`${btn} rounded-r-none border-slate-600 hover:border-slate-400`}>Subtitles</button>
            <select value={subLang} onChange={e => setSubLang(e.target.value)} title="Subtitle language"
              className="rounded-r border border-l-0 border-slate-600 bg-[#0d1117] px-1 text-xs">
              {SUB_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <span className="w-px h-5 bg-slate-700" />
          <button disabled={!ready} onClick={() => setBuilder(b => !b)}
            className={`${btn} ${builder ? 'border-fuchsia-400 bg-fuchsia-500/15 text-fuchsia-100' : 'border-fuchsia-600 text-fuchsia-200 hover:bg-fuchsia-500/10'}`}>Short builder</button>
          {sel?.busy && <span className="text-[11px] text-sky-300 animate-pulse">{sel.busy}…</span>}
          <span className="ml-auto text-[10px] text-slate-500">The buttons on the left work on the selected range.</span>
        </div>
        {ready && sel && tr && tr.lines.length > 0 && end - start < duration - 0.5 && (
          <RangeSubs tr={tr} start={start} end={end} time={time} title={sel.title} onSeek={seek} />
        )}
        {sel && (checks.length > 0 || sel.summaries.length > 0 || sel.shorts.length > 0 || sel.subtitles.length > 0) && (
          <div className="grid grid-cols-4 gap-3 max-h-36 text-[11px]">
            <div className="overflow-auto">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Fact checks</h4>
              {checks.map(j => (
                <div key={j.id} className="flex items-center gap-2 py-0.5">
                  <span className="tabular-nums text-slate-400">{j.options?.range ? `${fmt(j.options.range[0])}–${fmt(j.options.range[1])}` : 'whole'}</span>
                  <span className={`truncate ${j.status === 'failed' ? 'text-rose-300' : 'text-slate-300'}`} title={j.error}>{j.status === 'failed' ? j.error || 'failed' : j.step || j.status}</span>
                  {j.book_id && <button onClick={() => void control('select', j.book_id)} className="ml-auto shrink-0 px-1.5 rounded border border-slate-700 hover:border-slate-500">Open book</button>}
                </div>
              ))}
            </div>
            <div className="overflow-auto">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Summaries</h4>
              {sel.summaries.map(s => (
                <div key={s.at} className="mb-2">
                  <button onClick={() => setRange([s.start, s.end])} className="tabular-nums text-amber-300/80 hover:text-amber-200">{fmt(s.start)}–{fmt(s.end)}</button>
                  <button onClick={() => { void navigator.clipboard.writeText(s.text); notify('Copied'); }} className="ml-2 text-slate-500 hover:text-slate-200">copy</button>
                  <p className="whitespace-pre-wrap text-slate-300">{s.text}</p>
                </div>
              ))}
            </div>
            <div className="overflow-auto">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Quick crops</h4>
              {sel.shorts.map(s => (
                <div key={s.at} className="flex items-center gap-2 py-0.5">
                  <span className="tabular-nums text-slate-400">{fmt(s.start)}–{fmt(s.end)}</span>
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">play</a>
                  <button onClick={() => reveal(s.url)} className="text-slate-500 hover:text-slate-200">show in folder</button>
                </div>
              ))}
            </div>
            <div className="overflow-auto">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Subtitles</h4>
              {sel.subtitles.map(s => (
                <div key={s.at} className="flex items-center gap-2 py-0.5">
                  <span className="text-slate-300">{s.lang}</span>
                  <span className="tabular-nums text-slate-400">{fmt(s.start)}–{fmt(s.end)}</span>
                  <button onClick={() => setShownSub(shownSub === s.vtt ? null : s.vtt)}
                    className={shownSub === s.vtt ? 'text-amber-300' : 'text-sky-300 hover:underline'}>{shownSub === s.vtt ? 'hide' : 'show'}</button>
                  <a href={s.srt} download className="text-slate-500 hover:text-slate-200">.srt</a>
                  <button onClick={() => reveal(s.srt)} className="text-slate-500 hover:text-slate-200">folder</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {folderAsk && <FolderDialog initial={folderAsk.initial} onClose={() => { folderAsk.resolve(''); setFolderAsk(null); }}
        onPick={f => { folderAsk.resolve(f); setFolderAsk(null); }} />}
      <NoticeHost />
    </div>
  );
}

const srtStamp = (t: number) => {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** The transcript lines inside the selected range, live as the range moves: click a line to seek, copy or save as SRT. */
function RangeSubs({ tr, start, end, time, title, onSeek }: {
  tr: Transcript; start: number; end: number; time: number; title: string; onSeek: (t: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => tr.lines.map((l, i) => ({ t: l.t, e: tr.ends[i] ?? l.t + 3, text: l.text }))
    .filter(r => r.e > start && r.t < end), [tr, start, end]);
  const cur = rows.findIndex(r => time >= r.t && time < r.e);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);
  const copy = () => { void navigator.clipboard.writeText(rows.map(r => r.text).join('\n')); notify('Copied'); };
  const saveSrt = () => {
    const srt = rows.map((r, n) => `${n + 1}\n${srtStamp(Math.max(r.t, start) - start)} --> ${srtStamp(Math.min(r.e, end) - start)}\n${r.text}\n`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([srt], { type: 'text/plain' }));
    a.download = `${(title || 'range').replace(/[<>:"/\\|?*]/g, '').slice(0, 60)} ${fmt(start)}-${fmt(end)}.srt`.replace(/:/g, '.');
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Subtitles in range</h4>
        <span className="text-slate-500 tabular-nums">{rows.length} line{rows.length === 1 ? '' : 's'}</span>
        <button disabled={!rows.length} onClick={copy} className="ml-auto px-1.5 rounded border border-slate-700 hover:border-slate-500 disabled:opacity-40">Copy</button>
        <button disabled={!rows.length} onClick={saveSrt} title="Timed from the range start, so it fits a clip cut from the same range"
          className="px-1.5 rounded border border-slate-700 hover:border-slate-500 disabled:opacity-40">.srt</button>
      </div>
      <div ref={list} className="max-h-32 overflow-auto">
        {rows.map((r, i) => (
          <button key={r.t} data-i={i} onClick={() => onSeek(r.t)}
            className={`w-full flex gap-2 text-left px-1 py-0.5 rounded ${i === cur ? 'bg-amber-400/15 text-amber-100' : 'text-slate-300 hover:bg-slate-800/70'}`}>
            <span className="tabular-nums text-slate-500 shrink-0">{fmt(r.t)}</span>
            <span>{r.text}</span>
          </button>
        ))}
        {!rows.length && <p className="text-slate-500">No speech in this range.</p>}
      </div>
    </div>
  );
}

/** Outside the desktop window (a plain browser in dev) there is no native folder picker: type the path. */
function FolderDialog({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (f: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog title="Save in…" onClose={onClose} onAccept={() => v.trim() && onPick(v.trim())} acceptLabel="Save">
      <input autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="C:\Users\…\Videos"
        className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] font-mono" />
    </Dialog>
  );
}
