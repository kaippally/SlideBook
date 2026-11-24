import { useRef } from 'react';
import { fmtT, outTime, srcTime, type Seg } from '../lib/shorts';
import type { ShortImage, ShortPlan, ShortSfx, SoundFx, Transcript } from '../lib/types';
import { SFX_DRAG } from './AssetBin';

export type ClipSel = { kind: 'sfx' | 'img'; i: number } | null;

const ROWS = ['Character', 'Images', 'Video', 'Sound', 'Subtitles'] as const;
const LABEL_W = 74;

/** The short on its own clock (0 → its length), one row per layer, top layer first. Sound effects are clips:
 *  drag to move, click to edit in the right panel, Delete to remove, drop one from the bin to add it. */
export function ShortTracks({ plan, segs, total, tr, time, lib, lengths, selected, onSelect, onPatch, onSeek }: {
  plan: ShortPlan; segs: Seg[]; total: number; tr: Transcript | null; time: number;
  lib: SoundFx[]; lengths: Map<string, number>; selected: ClipSel;
  onSelect: (c: ClipSel) => void; onPatch: (f: Partial<ShortPlan>) => void; onSeek: (t: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const span = Math.max(1, total);
  const pct = (o: number) => `${(o / span) * 100}%`;
  const outAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect();
    return Math.min(span, Math.max(0, ((clientX - r.left) / r.width) * span));
  };
  const names = new Map(lib.map(s => [s.file, s.name]));
  const head = outTime(time, segs);
  // Sounds that overlap stack into sub-rows, so every clip can be grabbed.
  const lanes: number[] = [];
  const laneEnd: number[] = [];
  plan.sfx.map((s, i) => ({ i, o: outTime(s.t, segs) ?? -1, d: lengths.get(s.file) ?? 1 }))
    .sort((a, b) => a.o - b.o)
    .forEach(({ i, o, d }) => {
      let l = laneEnd.findIndex(e => e <= o + 0.01);
      if (l === -1) { l = laneEnd.length; laneEnd.push(0); }
      laneEnd[l] = o + Math.max(d, span / 60);
      lanes[i] = l;
    });
  const nLanes = Math.max(1, laneEnd.length);
  const images = plan.images ?? [];
  const imgLane: number[] = [];
  const imgEnd: number[] = [];
  images.map((im, i) => ({ i, o: outTime(im.t, segs) ?? -1, d: im.d }))
    .sort((a, b) => a.o - b.o)
    .forEach(({ i, o, d }) => {
      let l = imgEnd.findIndex(e => e <= o + 0.01);
      if (l === -1) { l = imgEnd.length; imgEnd.push(0); }
      imgEnd[l] = o + d;
      imgLane[i] = l;
    });
  const rowH = (r: typeof ROWS[number]) => r === 'Sound' ? 4 + nLanes * 20 : r === 'Images' ? 4 + Math.max(1, imgEnd.length) * 30 : 24;

  const scrub = (e: React.MouseEvent) => {
    e.preventDefault();
    onSeek(srcTime(outAt(e.clientX), segs));
    onSelect(null);
    const move = (ev: MouseEvent) => onSeek(srcTime(outAt(ev.clientX), segs));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const setSfx = (sfx: ShortSfx[]) => onPatch({ sfx });
  const dragSfx = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    onSelect({ kind: 'sfx', i });
    const o0 = outTime(plan.sfx[i].t, segs) ?? 0, x0 = e.clientX;
    const w = lane.current!.getBoundingClientRect().width;
    const start = plan.sfx;
    const move = (ev: MouseEvent) => {
      const o = Math.min(span, Math.max(0, o0 + ((ev.clientX - x0) / w) * span));
      setSfx(start.map((s, k) => k === i ? { ...s, t: Math.round(srcTime(o, segs) * 100) / 100 } : s));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const setImages = (next: ShortImage[]) => onPatch({ images: next });
  // Drag the body to move a picture, its right edge to change how long it stays.
  const dragImg = (i: number, edge: boolean) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    onSelect({ kind: 'img', i });
    const im0 = images[i], o0 = outTime(im0.t, segs) ?? 0, x0 = e.clientX;
    const w = lane.current!.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const dt = ((ev.clientX - x0) / w) * span;
      setImages(images.map((im, k) => k !== i ? im : edge
        ? { ...im, d: Math.round(Math.min(span - o0, Math.max(0.5, im0.d + dt)) * 100) / 100 }
        : { ...im, t: Math.round(srcTime(Math.min(span - 0.5, Math.max(0, o0 + dt)), segs) * 100) / 100 }));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const drop = (e: React.DragEvent) => {
    const file = e.dataTransfer.getData(SFX_DRAG);
    if (!file) return;
    e.preventDefault();
    const s = { t: Math.round(srcTime(outAt(e.clientX), segs) * 100) / 100, file, gain: -4 };
    const next = [...plan.sfx, s].sort((a, b) => a.t - b.t);
    setSfx(next);
    onSelect({ kind: 'sfx', i: next.indexOf(s) });
  };

  const ticks: number[] = [];
  const step = span > 150 ? 15 : span > 60 ? 10 : 5;
  for (let t = 0; t <= span; t += step) ticks.push(t);

  return (
    <div className="flex flex-col text-[10px] select-none">
      <div className="flex">
        <div style={{ width: LABEL_W }} className="shrink-0 text-slate-500 px-1">{fmtT(head ?? 0)} / {fmtT(total)}</div>
        <div className="relative flex-1 h-4 cursor-col-resize" onMouseDown={scrub}>
          {ticks.map(t => (
            <span key={t} className="absolute top-0 h-full border-l border-slate-700 pl-0.5 text-slate-500 tabular-nums" style={{ left: pct(t) }}>{fmtT(t)}</span>
          ))}
        </div>
      </div>
      <div className="relative flex">
        <div style={{ width: LABEL_W }} className="shrink-0 flex flex-col">
          {ROWS.map(r => <div key={r} style={{ height: rowH(r) }} className="flex items-center px-1 text-slate-400 border-b border-slate-800/80">{r}</div>)}
        </div>
        <div ref={lane} className="relative flex-1">
          {ROWS.map(r => (
            <div key={r} onMouseDown={scrub}
              onDragOver={r === 'Sound' ? e => { if (e.dataTransfer.types.includes(SFX_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } } : undefined}
              onDrop={r === 'Sound' ? drop : undefined}
              style={{ height: rowH(r) }}
              className={`relative border-b border-slate-800/80 ${r === 'Video' ? 'bg-slate-900/60' : 'bg-slate-950/40'}`}>
              {r === 'Character' && <span className="absolute inset-0 flex items-center pl-2 text-slate-600">character poses — coming soon</span>}
              {r === 'Images' && !images.length && <span className="absolute inset-0 flex items-center pl-2 text-slate-600">no pictures yet — Fetch pictures in the bin</span>}
              {r === 'Images' && images.map((im, i) => {
                const o = outTime(im.t, segs);
                if (o === null) return null;
                const on = selected?.kind === 'img' && selected.i === i;
                return (
                  <div key={im.id} onMouseDown={dragImg(i, false)} title={`${im.why || im.prompt} · ${im.d.toFixed(1)} s`}
                    className={`absolute rounded-sm overflow-hidden flex items-center gap-1 cursor-grab ${on ? 'bg-amber-400 text-black ring-1 ring-amber-200' : 'bg-cyan-700/80 text-cyan-50 hover:bg-cyan-600'}`}
                    style={{ left: pct(o), width: `max(18px, ${pct(Math.min(im.d, span - o))})`, top: 2 + imgLane[i] * 30, height: 28 }}>
                    <img src={im.url} alt="" draggable={false} className="h-full aspect-square object-cover shrink-0" />
                    <span className="truncate pr-2">{im.why}</span>
                    <span onMouseDown={dragImg(i, true)} title="Drag to change how long it stays"
                      className="absolute right-0 inset-y-0 w-1.5 cursor-ew-resize bg-black/30 hover:bg-white/60" />
                  </div>
                );
              })}
              {r === 'Video' && segs.map((s, k) => (
                <div key={k} title={`${fmtT(s.s)}–${fmtT(s.e)} of the source`}
                  className={`absolute inset-y-0.5 rounded-sm ${k % 2 ? 'bg-emerald-700/70' : 'bg-emerald-600/70'} border-r border-black/60`}
                  style={{ left: pct(s.o), width: pct(s.e - s.s) }} />
              ))}
              {r === 'Sound' && plan.sfx.map((s, i) => {
                const o = outTime(s.t, segs);
                if (o === null) return null;
                const on = selected?.kind === 'sfx' && selected.i === i;
                return (
                  <div key={i} onMouseDown={e => { if (e.button === 0) dragSfx(i)(e); else e.stopPropagation(); }}
                    onContextMenu={e => { e.preventDefault(); onSelect(null); setSfx(plan.sfx.filter((_, k) => k !== i)); }}
                    title={`${names.get(s.file) ?? s.file} · ${s.gain} dB${s.why ? ` — ${s.why}` : ''} · right-click to remove`}
                    className={`absolute rounded-sm px-1 leading-[18px] overflow-hidden whitespace-nowrap cursor-grab ${on ? 'bg-amber-400 text-black ring-1 ring-amber-200' : 'bg-violet-600/80 text-violet-50 hover:bg-violet-500'}`}
                    style={{ left: pct(o), width: `max(14px, ${pct(Math.min(lengths.get(s.file) ?? 1, span - o))})`,
                      top: 2 + lanes[i] * 20, height: 18 }}>
                    {names.get(s.file) ?? s.file}
                  </div>
                );
              })}
              {r === 'Subtitles' && tr && segs.flatMap(seg => {
                const out = [];
                for (let i = seg.a; i <= seg.b; i++) {
                  const a = Math.max(tr.lines[i].t, seg.s), b = Math.min(tr.ends[i], seg.e);
                  if (b <= a) continue;
                  out.push(
                    <div key={i} title={tr.lines[i].text}
                      className="absolute inset-y-0.5 rounded-sm bg-slate-700/80 text-slate-200 px-1 overflow-hidden whitespace-nowrap border-r border-black/60"
                      style={{ left: pct(seg.o + a - seg.s), width: pct(b - a) }}>{tr.lines[i].text}</div>);
                }
                return out;
              })}
            </div>
          ))}
          {head !== null && <div className="absolute inset-y-0 w-0.5 -ml-px bg-white pointer-events-none" style={{ left: pct(head) }} />}
        </div>
      </div>
    </div>
  );
}
