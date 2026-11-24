import { useEffect, useState } from 'react';
import { api, playSound } from '../lib/api';
import type { ShortPlan, SoundFx } from '../lib/types';
import { attempt } from './Dialog';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';

type BinTab = 'images' | 'characters' | 'sounds';
export const SFX_DRAG = 'application/x-slidebook-sfx';

/** What can be put into the short: drag an item onto its track (or use + to drop it at the playhead). */
export function AssetBin({ lib, reloadLib, onAddSfx, plan, videoId, busy, selectedImage, onSelectImage }: {
  lib: SoundFx[]; reloadLib: () => void; onAddSfx: (file: string) => void;
  plan: ShortPlan; videoId: number; busy: string; selectedImage: number | null; onSelectImage: (i: number) => void;
}) {
  const [tab, setTab] = useState<BinTab>(() => (getUiSetting('videos:binTab') as BinTab) || 'sounds');
  const [q, setQ] = useState('');
  useEffect(() => { setUiSetting('videos:binTab', tab); }, [tab]);
  const sounds = q ? lib.filter(s => `${s.name} ${s.use}`.toLowerCase().includes(q.toLowerCase())) : lib;
  return (
    <div className="h-full flex flex-col min-h-0 bg-[#0b0e13] text-[11px]">
      <div className="flex border-b border-slate-800">
        {(['images', 'characters', 'sounds'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-1.5 font-semibold ${tab === t ? 'text-amber-300 border-b-2 border-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>
            {{ images: 'Images', characters: 'Characters', sounds: 'Sounds' }[t]}
          </button>
        ))}
      </div>
      {tab === 'sounds' ? <>
        <div className="p-1.5 flex gap-1 border-b border-slate-800">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search sounds"
            className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-0.5" />
          <button onClick={() => void api('/api/soundfx/open', { method: 'POST' })} title="Open the folder for your own sounds"
            className="px-1.5 rounded border border-slate-700 hover:border-slate-500">+ own</button>
          <button onClick={reloadLib} title="Reload the library" className="px-1.5 rounded border border-slate-700 hover:border-slate-500">↻</button>
        </div>
        <div className="flex-1 overflow-auto p-1">
          {sounds.map(s => (
            <div key={s.file} draggable onDragStart={e => { e.dataTransfer.setData(SFX_DRAG, s.file); e.dataTransfer.effectAllowed = 'copy'; }}
              title={`${s.use || s.name} — drag onto the Sound track`}
              className="flex items-center gap-1.5 px-1 py-1 rounded cursor-grab hover:bg-slate-800/70">
              <button onClick={() => playSound(s.url)} className="text-slate-400 hover:text-slate-100">▶</button>
              <span className="flex-1 min-w-0 truncate">{s.name}{s.user && <span className="ml-1 text-[9px] text-sky-300">yours</span>}</span>
              <button onClick={() => onAddSfx(s.file)} title="Add at the playhead" className="px-1 rounded border border-slate-700 hover:border-slate-500 text-[10px]">+</button>
            </div>
          ))}
          {!sounds.length && <p className="p-2 text-slate-500">No sounds{q ? ' match' : ''}.</p>}
        </div>
      </> : tab === 'images' ? <>
        <div className="p-1.5 border-b border-slate-800 flex flex-col gap-1">
          <button disabled={!!busy} onClick={() => void attempt(api(`/api/videos/${videoId}/plans/${plan.id}/pictures`, { method: 'POST' }), 'Fetch pictures')}
            title="Gemini reads this short with the whole video as context, picks the moments that want a picture and draws them"
            className="w-full px-2 py-1 rounded border border-cyan-600 text-cyan-100 hover:bg-cyan-600/15 disabled:opacity-40">
            {(plan.images ?? []).length ? 'Fetch pictures again' : 'Fetch pictures'}
          </button>
          {busy && <span className="text-[10px] text-sky-300 animate-pulse">{busy}…</span>}
        </div>
        <div className="flex-1 overflow-auto p-1.5 grid grid-cols-2 gap-1.5 content-start">
          {(plan.images ?? []).map((im, i) => (
            <button key={im.id} onClick={() => onSelectImage(i)} title={im.prompt}
              className={`text-left rounded overflow-hidden border ${selectedImage === i ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-800 hover:border-slate-600'}`}>
              <img src={im.url} alt="" className="w-full aspect-square object-cover" />
              <div className="px-1 py-0.5 text-[10px] leading-tight line-clamp-2 text-slate-300">{im.why}</div>
              <div className="px-1 pb-0.5 text-[9px] text-slate-500 tabular-nums">{im.d.toFixed(1)} s</div>
            </button>
          ))}
          {!(plan.images ?? []).length && <p className="col-span-2 p-1 text-slate-500 leading-relaxed">No pictures for this short yet.</p>}
        </div>
      </> : (
        <div className="p-3 text-slate-500 leading-relaxed">
          Your characters and their poses land here, ready to drag onto the Character track. Coming after the images.
        </div>
      )}
    </div>
  );
}
