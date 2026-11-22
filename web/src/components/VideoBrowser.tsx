import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, control, subscribe, useJobs } from '../lib/api';
import type { VideoItem } from '../lib/types';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { Dialog, NoticeHost, attempt, notify } from './Dialog';

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

function RangeBar({ duration, start, end, time, onRange, onSeek }: {
  duration: number; start: number; end: number; time: number;
  onRange: (s: number, e: number) => void; onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const drag = (which: 'start' | 'end' | 'body') => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const t0 = at(e.clientX), s0 = start, e0 = end;
    const move = (ev: MouseEvent) => {
      const t = at(ev.clientX);
      if (which === 'start') onRange(Math.min(t, e0 - 1), e0);
      else if (which === 'end') onRange(s0, Math.max(t, s0 + 1));
      else {
        const d = Math.min(Math.max(t - t0, -s0), duration - e0);
        onRange(s0 + d, e0 + d);
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  return (
    <div ref={ref} onMouseDown={e => onSeek(at(e.clientX))} className="relative h-10 rounded bg-slate-800/70 cursor-pointer select-none">
      <div onMouseDown={drag('body')} className="absolute inset-y-0 bg-amber-400/25 border-y border-amber-400/60 cursor-grab"
        style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
      {(['start', 'end'] as const).map(w => (
        <div key={w} onMouseDown={drag(w)} title={w === 'start' ? 'In' : 'Out'}
          className="absolute inset-y-[-3px] w-2.5 -ml-[5px] rounded-sm bg-amber-400 cursor-ew-resize hover:bg-amber-300"
          style={{ left: pct(w === 'start' ? start : end) }} />
      ))}
      <div className="absolute inset-y-[-4px] w-0.5 -ml-px bg-white pointer-events-none" style={{ left: pct(time) }} />
    </div>
  );
}

export function VideoBrowser() {
  const videos = useVideos();
  const jobs = useJobs();
  const [selId, setSelId] = useState<number | null>(() => Number(getUiSetting('videos:selected')) || null);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [time, setTime] = useState(0);
  const [playRange, setPlayRange] = useState(false);
  const [folderAsk, setFolderAsk] = useState<string | null>(null);
  const [subLang, setSubLang] = useState(() => getUiSetting('videos:subLang') || 'Malayalam');
  const [shownSub, setShownSub] = useState<string | null>(null);
  const vref = useRef<HTMLVideoElement>(null);

  const sel = videos.find(v => v.id === selId) ?? null;
  const duration = sel?.duration || vref.current?.duration || 0;
  useEffect(() => { if (selId) setUiSetting('videos:selected', String(selId)); }, [selId]);
  useEffect(() => { setRange([0, sel?.duration || 0]); setTime(0); setPlayRange(false); }, [selId, sel?.duration]);
  useEffect(() => { setShownSub(null); }, [selId]);
  useEffect(() => { setUiSetting('videos:subLang', subLang); }, [subLang]);
  const newestSub = sel?.subtitles[0]?.vtt;
  const seenSub = useRef<string | undefined>(newestSub);
  useEffect(() => { if (newestSub && newestSub !== seenSub.current) setShownSub(newestSub); seenSub.current = newestSub; }, [newestSub]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? videos.filter(v => `${v.title} ${v.uploader} ${v.url}`.toLowerCase().includes(q)) : videos;
  }, [videos, query]);
  const checks = jobs.filter(j => j.options?.video === selId);

  const seek = useCallback((t: number) => { if (vref.current) vref.current.currentTime = t; setTime(t); }, []);
  const [start, end] = range;
  const setIn = () => setRange([Math.min(time, end - 1), end]);
  const setOut = () => setRange([start, Math.max(time, start + 1)]);
  const playSel = () => { const v = vref.current; if (!v) return; v.currentTime = start; setPlayRange(true); void v.play(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'BUTTON', 'VIDEO'].includes(t.tagName) || folderAsk !== null) return;
      const v = vref.current;
      if (e.key === 'i' || e.key === 'I') setIn();
      else if (e.key === 'o' || e.key === 'O') setOut();
      else if (e.key === ' ' && v) { e.preventDefault(); if (v.paused) void v.play(); else v.pause(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const add = async () => {
    const url = link.trim();
    if (!url) return;
    const v = await attempt(api<VideoItem>('/api/videos', { method: 'POST', json: { url } }), 'Add video');
    if (v) { setLink(''); setSelId(v.id); }
  };
  const run = async (action: 'factcheck' | 'summary' | 'short' | 'clip' | 'subtitles', folder?: string) => {
    if (!sel) return;
    const r = await attempt(api(`/api/videos/${sel.id}/${action}`, { method: 'POST', json: { start, end, folder, lang: subLang } }),
      { factcheck: 'Fact check', summary: 'Summarise', short: 'Make short', clip: 'Clip', subtitles: 'Subtitles' }[action]);
    if (r && action === 'factcheck') notify('Fact check queued: the book appears in the main window when it is done');
  };
  const clip = async () => {
    const last = (await api<{ folder: string }>('/api/videos/clip-folder').catch(() => ({ folder: '' }))).folder;
    if (window.pywebview?.api?.pick_folder) {
      const folder = await window.pywebview.api.pick_folder(last);
      if (folder) void run('clip', folder);
    } else setFolderAsk(last);
  };
  const reveal = (path: string) => void attempt(api('/api/reveal', { method: 'POST', json: { path } }), 'Show in folder');

  const ready = sel?.status === 'ready';
  const canAct = ready && !sel?.busy && end - start >= 1;
  const btn = 'px-3 py-1.5 rounded text-xs font-semibold border disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="h-screen grid grid-cols-[340px_1fr] grid-rows-[minmax(0,1fr)_auto] bg-[#0b0e13] text-slate-200">
      {/* Library */}
      <aside className="row-span-1 flex flex-col min-h-0 border-r border-slate-800">
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
                {v.status !== 'ready' && (
                  <div className="absolute inset-0 grid place-items-center bg-black/60 p-1 text-center text-[10px]">
                    {v.status === 'failed'
                      ? <span className="text-rose-300">Failed <span role="button" onClick={e => { e.stopPropagation(); void api(`/api/videos/${v.id}/retry`, { method: 'POST' }); }} className="underline">retry</span></span>
                      : <span className="text-slate-300">{v.step || 'Queued'}</span>}
                  </div>
                )}
                <span role="button" title="Remove from the library" onClick={e => { e.stopPropagation(); void api(`/api/videos/${v.id}`, { method: 'DELETE' }); if (v.id === selId) setSelId(null); }}
                  className="absolute top-1 right-1 hidden group-hover:block px-1 rounded bg-black/80 text-[10px] text-rose-300">✕</span>
              </div>
              <div className="px-1.5 py-1 text-[11px] leading-tight line-clamp-2">{v.title || v.url}</div>
            </button>
          ))}
          {!videos.length && <div className="col-span-2 p-3 text-[11px] text-slate-500">No videos yet. Links sent to the Telegram bot land here.</div>}
        </div>
      </aside>

      {/* Canvas */}
      <main className="min-h-0 min-w-0 flex flex-col bg-black">
        <div className="px-3 py-1.5 border-b border-slate-800 text-[12px] truncate">
          {sel ? <><span className="font-semibold">{sel.title || sel.url}</span>{sel.uploader && <span className="text-slate-500"> · {sel.uploader}</span>}</> : <span className="text-slate-500">Pick a video</span>}
        </div>
        <div className="flex-1 min-h-0 grid place-items-center">
          {ready && sel ? (
            <video ref={vref} key={sel.id} src={sel.video} controls className="max-w-full max-h-full"
              onTimeUpdate={e => {
                const t = e.currentTarget.currentTime;
                setTime(t);
                if (playRange && t >= end) { e.currentTarget.pause(); setPlayRange(false); }
              }}
              onPause={() => setPlayRange(false)}
              onLoadedMetadata={e => { if (!sel.duration) setRange([0, e.currentTarget.duration]); }}>
              {shownSub && <track key={shownSub} kind="subtitles" src={shownSub} default
                ref={el => { if (el) el.track.mode = 'showing'; }} />}
            </video>
          ) : sel ? <div className="text-slate-500 text-sm">{sel.status === 'failed' ? sel.error : sel.step || 'Downloading…'}</div> : null}
        </div>
      </main>

      {/* Control */}
      <section className="col-span-2 border-t border-slate-800 bg-[#11151c] px-3 py-2 flex flex-col gap-2">
        <RangeBar duration={duration} start={start} end={end} time={time} onRange={(s, e) => setRange([s, e])} onSeek={seek} />
        <div className="flex items-center gap-2 text-[11px]">
          <button onClick={setIn} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Set in <span className="opacity-50">I</span></button>
          <span className="tabular-nums text-amber-300">{fmt(start)}</span>
          <span className="text-slate-600">→</span>
          <span className="tabular-nums text-amber-300">{fmt(end)}</span>
          <button onClick={setOut} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Set out <span className="opacity-50">O</span></button>
          <span className="text-slate-500 tabular-nums">length {fmt(end - start)}</span>
          <button onClick={playSel} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">▶ Range</button>
          <button onClick={() => setRange([0, duration])} disabled={!ready} className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40">Whole video</button>
          <span className="ml-auto tabular-nums text-slate-400">{fmt(time)} / {fmt(duration)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button disabled={!canAct} onClick={() => void run('factcheck')} className={`${btn} border-blue-500 bg-blue-600 hover:bg-blue-500 text-white`}>Fact check</button>
          <button disabled={!canAct} onClick={() => void run('summary')} className={`${btn} border-slate-600 hover:border-slate-400`}>Summarize</button>
          <button disabled={!canAct} onClick={() => void run('short')} className={`${btn} border-slate-600 hover:border-slate-400`}>Make short</button>
          <button disabled={!canAct} onClick={() => void clip()} className={`${btn} border-slate-600 hover:border-slate-400`}>Clip</button>
          <div className="flex items-stretch">
            <button disabled={!canAct} onClick={() => void run('subtitles')} className={`${btn} rounded-r-none border-slate-600 hover:border-slate-400`}>Subtitles</button>
            <select value={subLang} onChange={e => setSubLang(e.target.value)} title="Subtitle language"
              className="rounded-r border border-l-0 border-slate-600 bg-[#0d1117] px-1 text-xs">
              {SUB_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          {sel?.busy && <span className="text-[11px] text-sky-300 animate-pulse">{sel.busy}…</span>}
          <span className="ml-auto text-[10px] text-slate-500">Every button works on the selected range.</span>
        </div>
        {sel && (checks.length > 0 || sel.summaries.length > 0 || sel.shorts.length > 0 || sel.subtitles.length > 0) && (
          <div className="grid grid-cols-4 gap-3 max-h-44 text-[11px]">
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
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Shorts</h4>
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

      {folderAsk !== null && <FolderDialog initial={folderAsk} onClose={() => setFolderAsk(null)} onPick={f => { setFolderAsk(null); void run('clip', f); }} />}
      <NoticeHost />
    </div>
  );
}

/** Outside the desktop window (a plain browser in dev) there is no native folder picker: type the path. */
function FolderDialog({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (f: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog title="Save the clip in…" onClose={onClose} onAccept={() => v.trim() && onPick(v.trim())} acceptLabel="Save">
      <input autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="C:\Users\…\Videos"
        className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] font-mono" />
    </Dialog>
  );
}
