import { useState } from 'react';
import { api, playSound } from '../lib/api';
import { sfxUrl } from '../lib/bookSfx';
import { useSlideVideoClock } from '../lib/slideVideoClock';
import { dbToVolume, useSoundFx } from '../lib/soundfx';
import type { BookSfx } from '../lib/types';
import { SFX_DRAG } from './AssetBin';
import { Group, Hint, Section, BTN_OFF } from './slideControls';

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** The book's sound effects: the library (SlideBook's own, the Short builder's and the sounds imported
 *  from StudioMate share one folder), dragged onto the Sound lane under the canvas, and the placed list. */
export function SfxTab({ sfx, onSfx }: { sfx: BookSfx[]; onSfx: (next: BookSfx[]) => void }) {
  const [lib, reload] = useSoundFx();
  const clock = useSlideVideoClock();
  const [q, setQ] = useState('');
  const names = new Map(lib.map(s => [s.file, s.name]));
  const shown = q ? lib.filter(s => `${s.name} ${s.use}`.toLowerCase().includes(q.toLowerCase())) : lib;
  const add = (file: string) => { if (clock) onSfx([...sfx, { t: Math.round(clock.t * 100) / 100, file, gain: -4 }].sort((a, b) => a.t - b.t)); };
  const set = (i: number, p: Partial<BookSfx>) => onSfx(sfx.map((s, k) => (k === i ? { ...s, ...p } : s)));
  return (
    <Group title="Sound FX" scope="played over this book's clips">
      <Section title={`In this book · ${sfx.length}`}>
        {!sfx.length && <Hint>None yet. Drag a sound below onto the Sound lane under the canvas, or press + to drop it at the playhead.</Hint>}
        {sfx.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span className="w-12 shrink-0 font-mono tabular-nums text-sky-300">{fmt(s.t)}</span>
            <button onClick={() => playSound(sfxUrl(s.file), dbToVolume(s.gain))} className="text-slate-400 hover:text-white" title="Listen">▶</button>
            <span className="flex-1 min-w-0 truncate text-slate-200" title={s.file}>{names.get(s.file) ?? s.file}</span>
            <input type="range" min={-30} max={0} step={1} value={s.gain} onChange={e => set(i, { gain: Number(e.target.value) })} className="w-16" title="Level" />
            <span className="w-9 text-right font-mono tabular-nums text-slate-500">{s.gain} dB</span>
            <button onClick={() => onSfx(sfx.filter((_, k) => k !== i))} className="text-rose-400 hover:text-rose-300" title="Remove">×</button>
          </div>
        ))}
      </Section>
      <Section title="Library" actions={<>
        <button onClick={() => void api('/api/soundfx/open', { method: 'POST' })} className={BTN_OFF} title="Open the folder for your own sounds">+ own</button>
        <button onClick={reload} className={BTN_OFF} title="Reload the library">↻</button>
      </>}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search sounds"
          className="w-full bg-[#0d1117] border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200" />
        <div className="flex flex-col">
          {shown.map(s => (
            <div key={s.file} draggable onDragStart={e => { e.dataTransfer.setData(SFX_DRAG, s.file); e.dataTransfer.effectAllowed = 'copy'; }}
              className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-slate-800/70 cursor-grab text-[11px]" title={`${s.use || s.name} — drag onto the Sound lane`}>
              <button onClick={() => playSound(s.url)} className="text-slate-400 hover:text-white" title="Listen">▶</button>
              <span className="flex-1 min-w-0 truncate text-slate-200">{s.name}</span>
              {s.use && <span className="max-w-[40%] truncate text-[9px] text-slate-500">{s.use}</span>}
              <button onClick={() => add(s.file)} disabled={!clock} className="px-1 rounded border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-30"
                title={clock ? `Add at ${fmt(clock.t)} (the playhead)` : 'Play a clip to add at the playhead — or drag onto the Sound lane'}>+</button>
            </div>
          ))}
        </div>
      </Section>
    </Group>
  );
}
