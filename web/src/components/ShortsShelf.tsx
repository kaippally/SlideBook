import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtT } from '../lib/shorts';
import type { ShortRender, VideoItem } from '../lib/types';
import { askConfirm, attempt, notify } from './Dialog';

export interface ShelfItem { video: VideoItem; planId: number; title: string; confirmed: boolean; render: ShortRender }

export function shelfItems(videos: VideoItem[]): ShelfItem[] {
  const out: ShelfItem[] = [];
  for (const video of videos) for (const p of video.plans || []) for (const render of p.renders || [])
    out.push({ video, planId: p.id, title: p.title, confirmed: !!p.confirmed, render });
  return out.sort((a, b) => b.render.at - a.render.at);
}

/** The Shorts tab: every rendered short across the library, newest first. Click one to play it on the canvas. */
export function ShortsShelf({ videos, current, onPlay, onOpen, onPickFolder }: {
  videos: VideoItem[];
  current: string | null;
  onPlay: (url: string) => void;
  onOpen: (videoId: number, planId: number) => void;
  onPickFolder: () => Promise<string>;
}) {
  const [query, setQuery] = useState('');
  const all = useMemo(() => shelfItems(videos), [videos]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter(i => `${i.title} ${i.video.title}`.toLowerCase().includes(q)) : all;
  }, [all, query]);
  const save = async (i: ShelfItem) => {
    const folder = await onPickFolder();
    if (!folder) return;
    const r = await attempt(api<{ path: string }>('/api/export', { method: 'POST', json: { url: i.render.url, folder, name: i.title } }), 'Save the short');
    if (r) notify(`Saved: ${r.path}`);
  };
  const drop = async (i: ShelfItem) => {
    if (!await askConfirm(`Delete the render of “${i.title}”?`, 'The video file is deleted from disk. The short stays in the Short builder, and copies you saved to your own folders are kept.', { label: 'Delete', danger: true })) return;
    await attempt(api(`/api/videos/${i.video.id}/plans/${i.planId}/render`, { method: 'DELETE', json: { url: i.render.url } }), 'Delete the render');
  };
  const link = 'text-[10px] text-slate-400 hover:text-slate-100';

  return (
    <>
      <div className="px-2 py-1.5 flex items-center gap-2 border-b border-slate-800">
        <div className="relative flex-1">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search shorts" className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-[12px]" />
          {query && <button onClick={() => setQuery('')} className="absolute right-1.5 top-1 text-slate-500 hover:text-slate-200 text-[12px]">✕</button>}
        </div>
        <span className="text-[11px] text-slate-500 tabular-nums">{query ? `${shown.length}/${all.length}` : all.length}</span>
      </div>
      <div className="flex-1 overflow-auto p-2 grid grid-cols-2 gap-2 content-start">
        {shown.map(i => (
          <div key={i.render.url} className={`group rounded overflow-hidden border ${current === i.render.url ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-800 hover:border-slate-600'}`}>
            <button onClick={() => onPlay(i.render.url)} className="relative block w-full aspect-[9/16] bg-slate-900">
              <video src={`${i.render.url}#t=1`} preload="metadata" muted className="w-full h-full object-cover pointer-events-none" />
              <span className="absolute bottom-1 right-1 px-1 rounded bg-black/80 text-[10px] tabular-nums">{fmtT(i.render.length)}</span>
              {i.render.full && <span className="absolute top-1 left-1 px-1 rounded bg-emerald-900/90 text-[9px] text-emerald-200" title={`Rendered from ${i.render.source}`}>FULL</span>}
              {i.confirmed && <span className="absolute top-1 right-1 px-1 rounded bg-sky-900/90 text-[9px] text-sky-200" title="Ticked and confirmed in Telegram">✓</span>}
            </button>
            <div className="px-1.5 pt-1 text-[11px] leading-tight line-clamp-2" title={i.title}>{i.title}</div>
            <div className="px-1.5 pb-1 text-[9px] text-slate-500 truncate" title={i.video.title}>{i.video.title}</div>
            <div className="px-1.5 pb-1.5 flex flex-wrap gap-x-2">
              <button onClick={() => void save(i)} className={link}>save to…</button>
              <button onClick={() => void attempt(api('/api/reveal', { method: 'POST', json: { path: i.render.saved || i.render.url } }), 'Show in folder')} className={link}>folder</button>
              <button onClick={() => onOpen(i.video.id, i.planId)} className={link}>edit</button>
              <button onClick={() => drop(i)} className="text-[10px] text-rose-400/80 hover:text-rose-300">delete</button>
            </div>
          </div>
        ))}
        {!all.length && <p className="col-span-2 p-3 text-[11px] text-slate-500">No shorts rendered yet. Confirm shorts in Telegram, or press Render short in the Short builder.</p>}
      </div>
    </>
  );
}
