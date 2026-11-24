import { useEffect, useMemo, useRef, useState } from 'react';
import { api, playSound } from '../lib/api';
import { PANEL_MIN_ZOOM, fmtT, keptSet, normKeep, outTime, srcTime, type Seg } from '../lib/shorts';
import type { ShortImage, ShortLayout, ShortPlan, ShortSfx, SoundFx, Transcript, VideoItem } from '../lib/types';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { askConfirm, attempt, notify } from './Dialog';
import { FontSelect } from './FontSelect';
import type { ClipSel } from './ShortTracks';
import { dbToVolume } from '../lib/soundfx';

const SUB_LANGS = ['Original', 'English', 'Malayalam', 'Hindi', 'Arabic', 'Tamil'];
const LIMIT = 180;
type Tab = 'edit' | 'layout' | 'sound' | 'reach';

const scoreTone = (s: number) => s >= 70 ? 'bg-emerald-600 text-white' : s >= 45 ? 'bg-amber-500 text-black' : 'bg-slate-600 text-white';

export function ShortBuilder({ video, tr, plan, segs, total, time, onSelect, onPlayPlan, onPatch, onSeek, onPlayEdit, playing, onPickFolder, lib, reloadLib, clip, onClip }: {
  video: VideoItem;
  tr: Transcript | null;
  plan: ShortPlan | null;
  segs: Seg[];
  total: number;
  time: number;
  onSelect: (id: number | null) => void;
  onPlayPlan: (id: number) => void;
  onPatch: (fields: Partial<ShortPlan>) => void;
  onSeek: (t: number) => void;
  onPlayEdit: () => void;
  playing: boolean;
  onPickFolder: () => Promise<string>;
  lib: SoundFx[];
  reloadLib: () => void;
  clip: ClipSel;
  onClip: (c: ClipSel) => void;
}) {
  const [tab, setTab] = useState<Tab>(() => (getUiSetting('videos:shortTab') as Tab) || 'edit');
  useEffect(() => { setUiSetting('videos:shortTab', tab); }, [tab]);
  const [full, setFull] = useState(() => getUiSetting('videos:fullRes') !== '0');
  useEffect(() => { setUiSetting('videos:fullRes', full ? '1' : '0'); }, [full]);
  const busy = !!video.busy;
  const act = (path: string, what: string, json?: unknown) =>
    void attempt(api(`/api/videos/${video.id}/${path}`, { method: 'POST', json: json ?? {} }), what);

  const plans = video.plans || [];
  const btn = 'px-2 py-1 rounded text-[11px] border border-slate-600 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <aside className="min-h-0 flex flex-col border-l border-slate-800 bg-[#0e1218] text-[12px]">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <h3 className="font-semibold">Short builder</h3>
        <button disabled={busy || video.status !== 'ready'} onClick={() => act('shorts/find', 'Find shorts')}
          className="ml-auto px-2.5 py-1 rounded text-[11px] font-semibold bg-fuchsia-600 hover:bg-fuchsia-500 text-white disabled:opacity-40">
          {plans.length ? 'Find again' : 'Find shorts'}
        </button>
      </div>
      <div className="px-3 py-1 text-[10px] text-slate-500 border-b border-slate-800 flex items-center gap-2">
        {video.transcribing ? <span className="text-sky-300 animate-pulse">{video.transcribing}…</span>
          : video.transcriptState === 'ready' ? <span>Transcript: {tr?.lines.length ?? '…'} lines{tr?.via ? ` (${tr.via})` : ''}</span>
          : video.transcriptState === 'failed' ? <span className="text-rose-300" title={tr?.error}>Transcript failed</span>
          : <span>Transcript queued</span>}
        {!video.transcribing && video.transcriptState !== 'none' && (
          <button onClick={async () => {
            if (!await askConfirm('Transcribe again?', `The transcript is made again, in 1-minute parts so the subtitles line up with the speech.${plans.length ? ` Your ${plans.length} short${plans.length === 1 ? ' is' : 's are'} kept: each is found again in the new transcript by its words. Translated subtitles are made again when needed.` : ''}`, { label: 'Re-transcribe' })) return;
            act('transcribe', 'Transcribe', { force: true });
          }} className="ml-auto hover:text-slate-200">re-transcribe</button>
        )}
      </div>

      <div className="max-h-[32%] overflow-auto border-b border-slate-800">
        {plans.map(p => (
          <div key={p.id} onClick={() => onSelect(p.id)} onDoubleClick={() => onPlayPlan(p.id)} title="Double-click to play the edit"
            className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer border-l-2 ${p.id === plan?.id ? 'bg-amber-400/10 border-amber-400' : 'border-transparent hover:bg-slate-800/50'}`}>
            <span className={`shrink-0 w-7 text-center rounded text-[10px] font-bold tabular-nums ${scoreTone(p.virality?.score ?? 0)}`}
              title="Virality score">{p.virality?.score ?? '–'}</span>
            <span className="flex-1 min-w-0 truncate" title={p.idea}>{p.title}</span>
            {p.confirmed && <span className="text-[10px] text-sky-300" title="Ticked and confirmed in Telegram">✓</span>}
            {p.renders?.length > 0 && <span className="text-[9px] text-emerald-400" title="Rendered">●</span>}
            <span className={`tabular-nums text-[10px] ${p.length > LIMIT - 1 ? 'text-rose-400' : 'text-slate-400'}`}>{fmtT(p.length)}</span>
            <span role="button" title="Delete this short" onClick={async e => {
              e.stopPropagation();
              const n = p.renders?.length ?? 0;
              if (!await askConfirm(`Delete the short “${p.title}”?`, n ? `Its ${n} rendered file${n === 1 ? '' : 's'} will be deleted from disk too. Copies you saved to your own folders are kept.` : 'It has not been rendered, so no file is deleted.', { label: 'Delete', danger: true })) return;
              if (p.id === plan?.id) onSelect(null);
              void attempt(api(`/api/videos/${video.id}/plans/${p.id}`, { method: 'DELETE' }), 'Delete the short');
            }}
              className="invisible group-hover:visible text-rose-300 text-[10px]">✕</span>
          </div>
        ))}
        {!plans.length && (
          <p className="px-3 py-3 text-[11px] text-slate-500">
            Find shorts reads the whole transcript and marks every complete idea that can be told in under 3 minutes on the timeline.
            Or set a range and press <b>New short from range</b>.
          </p>
        )}
      </div>

      {plan && tr ? (
        <>
          <div className="flex border-b border-slate-800 text-[11px]">
            {(['edit', 'layout', 'sound', 'reach'] as Tab[]).map(t => (
              <button key={t} onClick={() => { setTab(t); onClip(null); }}
                className={`flex-1 py-1.5 ${tab === t ? 'text-amber-300 border-b-2 border-amber-400' : 'text-slate-400 hover:text-slate-200'}`}>
                {{ edit: 'Edit', layout: 'Layout', sound: 'Sound', reach: 'Virality & thumbnail' }[t]}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {clip?.kind === 'sfx' && plan.sfx[clip.i] && (
              <SfxClipPanel sfx={plan.sfx} i={clip.i} lib={lib} segs={segs} onPatch={onPatch} onSeek={onSeek} onClose={() => onClip(null)} />
            )}
            {clip?.kind === 'img' && plan.images?.[clip.i] && (
              <ImageClipPanel images={plan.images} i={clip.i} segs={segs} onPatch={onPatch} onSeek={onSeek} onClose={() => onClip(null)} />
            )}
            {!clip && tab === 'edit' && <EditTab plan={plan} tr={tr} total={total} time={time} onPatch={onPatch} onSeek={onSeek} onPlayEdit={onPlayEdit} playing={playing} />}
            {!clip && tab === 'layout' && <LayoutTab plan={plan} onPatch={onPatch} onTranslate={lang => act(`plans/${plan.id}/translate`, 'Translate', { lang })} busy={busy} />}
            {!clip && tab === 'sound' && <SoundTab plan={plan} lib={lib} reloadLib={reloadLib} segs={segs} time={time} onPatch={onPatch} onSeek={onSeek} />}
            {!clip && tab === 'reach' && <ReachTab plan={plan} busy={busy} onPatch={onPatch}
              onCheck={() => act(`plans/${plan.id}/virality`, 'Check virality')} onPrompt={() => act(`plans/${plan.id}/thumbprompt`, 'Thumbnail prompt')} />}
          </div>
          <div className="border-t border-slate-800 p-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <button disabled={busy || total > LIMIT - 1 || !segs.length} onClick={() => act(`plans/${plan.id}/render`, 'Render', { full })}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">Render short</button>
              <button disabled={busy || total > LIMIT - 1 || !segs.length} className={btn}
                onClick={async () => { const f = await onPickFolder(); if (f) act(`plans/${plan.id}/render`, 'Render', { folder: f, full }); }}>Render &amp; save to…</button>
              <label className="ml-auto flex items-center gap-1 text-[10px] text-slate-400" title="Render from the best copy of the source (up to 4K, downloaded once) instead of the 720p canvas copy"><input type="checkbox" checked={full} onChange={e => setFull(e.target.checked)} className="accent-amber-400" />full resolution</label>
            </div>
            {plan.renders?.map(r => (
              <div key={r.at} className="flex items-center gap-2 text-[11px]">
                <span className="tabular-nums text-slate-400">{fmtT(r.length)}</span>
                {r.full && <span className="px-1 rounded bg-emerald-900/70 text-[9px] text-emerald-200" title={`from ${r.source}`}>FULL</span>}
                <a href={r.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">play</a>
                <button onClick={() => void attempt(api('/api/reveal', { method: 'POST', json: { path: r.saved || r.url } }), 'Show in folder')}
                  className="text-slate-500 hover:text-slate-200">show in folder</button>
                <span className="ml-auto text-[10px] text-slate-600">{new Date(r.at * 1000).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </>
      ) : plan ? <p className="p-3 text-slate-500">Loading the transcript…</p> : null}
    </aside>
  );
}

function EditTab({ plan, tr, total, time, onPatch, onSeek, onPlayEdit, playing }: {
  plan: ShortPlan; tr: Transcript; total: number; time: number;
  onPatch: (f: Partial<ShortPlan>) => void; onSeek: (t: number) => void; onPlayEdit: () => void; playing: boolean;
}) {
  const kept = useMemo(() => keptSet(plan.keep), [plan.keep]);
  const funny = useMemo(() => new Map(plan.sfx.map(s => [s.t, s])), [plan.sfx]);
  const [a, b] = plan.span;
  const n = tr.lines.length;
  const listRef = useRef<HTMLDivElement>(null);
  const toggle = (i: number) => {
    const next = new Set(kept);
    if (next.has(i)) next.delete(i); else next.add(i);
    onPatch({ keep: normKeep(next) });
  };
  const setSpan = (na: number, nb: number) => {
    na = Math.max(0, Math.min(na, nb)); nb = Math.min(n - 1, Math.max(nb, na));
    const next = new Set([...kept].filter(i => i >= na && i <= nb));
    if (na < a) for (let i = na; i < a; i++) next.add(i);
    if (nb > b) for (let i = b + 1; i <= nb; i++) next.add(i);
    onPatch({ span: [na, nb], keep: normKeep(next) });
  };
  const over = total > LIMIT - 1;
  const current = tr.lines.findIndex((l, i) => time >= l.t && time < tr.ends[i]);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Title</span>
        <input value={plan.title} onChange={e => onPatch({ title: e.target.value })} className="bg-[#0d1117] border border-slate-700 rounded px-2 py-1" />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Hook (on-screen title)</span>
        <input value={plan.layout?.title?.text ?? plan.hook}
          onChange={e => onPatch({ hook: e.target.value, layout: { ...plan.layout, title: { ...plan.layout.title, text: e.target.value } } })}
          className="bg-[#0d1117] border border-slate-700 rounded px-2 py-1" />
      </label>
      {plan.idea && <p className="text-[11px] text-slate-400 italic">{plan.idea}</p>}
      <div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className={`tabular-nums font-semibold ${over ? 'text-rose-400' : 'text-emerald-300'}`}>{fmtT(total)}</span>
          <span className="text-slate-500">of 3:00</span>
          <button onClick={onPlayEdit} className="ml-auto px-2 py-0.5 rounded border border-slate-600 hover:border-slate-400">{playing ? '■ Stop' : '▶ Play edit'}</button>
        </div>
        <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
          <div className={over ? 'h-full bg-rose-500' : 'h-full bg-emerald-500'} style={{ width: `${Math.min(100, total / LIMIT * 100)}%` }} />
        </div>
        {over && <p className="mt-1 text-[11px] text-rose-300">Over 3 minutes: untick lines until it fits.</p>}
      </div>
      <div className="flex gap-1 text-[10px]">
        <button onClick={() => setSpan(a - 1, b)} disabled={a === 0} className="px-1.5 py-0.5 rounded border border-slate-700 disabled:opacity-40">+ line before</button>
        <button onClick={() => setSpan(a + 1, b)} disabled={a >= b} className="px-1.5 py-0.5 rounded border border-slate-700 disabled:opacity-40">− first</button>
        <button onClick={() => setSpan(a, b - 1)} disabled={a >= b} className="px-1.5 py-0.5 rounded border border-slate-700 disabled:opacity-40">− last</button>
        <button onClick={() => setSpan(a, b + 1)} disabled={b >= n - 1} className="px-1.5 py-0.5 rounded border border-slate-700 disabled:opacity-40">+ line after</button>
      </div>
      <div ref={listRef} className="flex flex-col">
        {tr.lines.slice(a, b + 1).map((l, k) => {
          const i = a + k, on = kept.has(i);
          const fx = funny.get(tr.ends[i]);
          return (
            <div key={i} className={`flex gap-2 items-start py-0.5 px-1 rounded ${i === current ? 'bg-sky-500/15' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(i)} className="mt-0.5 accent-amber-400" title={on ? 'Kept — untick to cut' : 'Cut — tick to keep'} />
              <button onClick={() => onSeek(l.t)} className="tabular-nums text-[10px] text-slate-500 hover:text-slate-200 mt-0.5 w-9 text-left shrink-0">{fmtT(l.t)}</button>
              <span onClick={() => onSeek(l.t)} className={`flex-1 cursor-pointer leading-snug ${on ? 'text-slate-200' : 'text-slate-600 line-through'}`}>
                {l.text}{fx && <span className="ml-1 text-[10px] text-fuchsia-300" title={fx.why}>♪ {fx.file.replace(/\.\w+$/, '')}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center gap-2 py-0.5"><span className="w-20 shrink-0 text-[11px] text-slate-400">{label}</span>{children}</div>;
}

function LayoutTab({ plan, onPatch, onTranslate, busy }: {
  plan: ShortPlan; onPatch: (f: Partial<ShortPlan>) => void; onTranslate: (lang: string) => void; busy: boolean;
}) {
  const lay = plan.layout;
  const set = (l: Partial<ShortLayout>) => onPatch({ layout: { ...lay, ...l } });
  const sub = (s: Partial<ShortLayout['sub']>) => set({ sub: { ...lay.sub, ...s } });
  const ttl = (s: Partial<ShortLayout['title']>) => set({ title: { ...lay.title, ...s } });
  const field = 'bg-[#0d1117] border border-slate-700 rounded px-1.5 py-0.5 text-[11px]';
  const color = (v: string, on: (c: string) => void, title: string) => <input type="color" value={v} onChange={e => on(e.target.value)} title={title} className="w-7 h-6 bg-transparent" />;
  const needsTranslation = lay.sub.lang !== 'Original' && !(plan.subs?.[lay.sub.lang] && plan.keep.every(([a, b]) => {
    for (let i = a; i <= b; i++) if (!plan.subs[lay.sub.lang][String(i)]) return false;
    return true;
  }));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] text-slate-500">On the frame: drag the picture to move it, the mouse wheel zooms, drag the title or subtitles up and down.</p>
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Picture</h4>
        <Row label="Layout">
          <select value={lay.mode} onChange={e => set({ mode: e.target.value as ShortLayout['mode'], zoom: 1, x: 0.5, y: 0.5 })} className={field}>
            <option value="fill">Fill the frame (crop)</option>
            <option value="fit">Whole picture on a blurred backdrop</option>
            <option value="split">Split: the clip twice, one above the other</option>
          </select>
        </Row>
        {lay.mode === 'split' ? <>
          {lay.panels.map((pn, i) => {
            const put = (p: Partial<typeof pn>) => { const ps = [...lay.panels] as ShortLayout['panels']; ps[i] = { ...pn, ...p }; set({ panels: ps }); };
            return (
              <Row key={i} label={i ? 'Bottom zoom' : 'Top zoom'}>
                <input type="range" min={PANEL_MIN_ZOOM} max={4} step={0.01} value={pn.zoom} onChange={e => put({ zoom: Number(e.target.value) })} className="flex-1" />
                <span className="tabular-nums text-[10px] w-9">{pn.zoom.toFixed(2)}×</span>
                <button onClick={() => put({ zoom: 1, x: i ? 0.75 : 0.25, y: 0.5 })} className="text-[10px] text-slate-500 hover:text-slate-200">reset</button>
              </Row>
            );
          })}
          <Row label="Top panel">
            <input type="range" min={0.15} max={0.85} step={0.01} value={lay.split} onChange={e => set({ split: Number(e.target.value) })} className="flex-1" />
            <span className="tabular-nums text-[10px] w-9">{Math.round(lay.split * 100)}%</span>
            <button onClick={() => set({ panels: [lay.panels[1], lay.panels[0]] })} title="Swap what the two panels show"
              className="text-[10px] text-slate-500 hover:text-slate-200">swap</button>
          </Row>
          <p className="text-[10px] text-slate-500">Drag inside a panel to move its picture, the mouse wheel over it zooms in and out, drag the line between them to resize.</p>
        </> : <Row label="Zoom">
          <input type="range" min={lay.mode === 'fill' ? 1 : 0.3} max={4} step={0.01} value={lay.zoom} onChange={e => set({ zoom: Number(e.target.value) })} className="flex-1" />
          <span className="tabular-nums text-[10px] w-9">{lay.zoom.toFixed(2)}×</span>
          <button onClick={() => set({ zoom: 1, x: 0.5, y: 0.5 })} className="text-[10px] text-slate-500 hover:text-slate-200">reset</button>
        </Row>}
      </section>
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-2">
          Subtitles <input type="checkbox" checked={lay.sub.show} onChange={e => sub({ show: e.target.checked })} className="accent-amber-400" />
        </h4>
        <Row label="Language">
          <select value={lay.sub.lang} onChange={e => sub({ lang: e.target.value })} className={field}>
            {SUB_LANGS.map(l => <option key={l}>{l}</option>)}
          </select>
          {needsTranslation && <button disabled={busy} onClick={() => onTranslate(lay.sub.lang)} className="text-[10px] text-sky-300 hover:underline disabled:opacity-40">translate now</button>}
        </Row>
        <Row label="Font"><FontSelect value={lay.sub.font} onChange={f => sub({ font: f })} className={`${field} flex-1 min-w-0`} /></Row>
        <Row label="Size">
          <input type="range" min={32} max={120} value={lay.sub.size} onChange={e => sub({ size: Number(e.target.value) })} className="flex-1" />
          <span className="tabular-nums text-[10px] w-6">{lay.sub.size}</span>
        </Row>
        <Row label="Words">
          <input type="range" min={1} max={8} value={lay.sub.words} onChange={e => sub({ words: Number(e.target.value) })} className="flex-1" />
          <span className="tabular-nums text-[10px] w-6">{lay.sub.words}</span>
        </Row>
        <Row label="Colours">
          {color(lay.sub.color, c => sub({ color: c }), 'Text')}
          {color(lay.sub.highlight, c => sub({ highlight: c }), 'Spoken word (karaoke)')}
          {color(lay.sub.outline, c => sub({ outline: c }), 'Outline')}
        </Row>
        <Row label="Style">
          <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={lay.sub.karaoke} onChange={e => sub({ karaoke: e.target.checked })} className="accent-amber-400" />word highlight</label>
          <label className="flex items-center gap-1 text-[11px]"><input type="checkbox" checked={lay.sub.box} onChange={e => sub({ box: e.target.checked })} className="accent-amber-400" />dark box</label>
        </Row>
      </section>
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-2">
          Title <input type="checkbox" checked={lay.title.show} onChange={e => ttl({ show: e.target.checked })} className="accent-amber-400" />
        </h4>
        <Row label="Text"><input value={lay.title.text} onChange={e => onPatch({ hook: e.target.value, layout: { ...lay, title: { ...lay.title, text: e.target.value } } })} className={`${field} flex-1`} /></Row>
        <Row label="Font"><FontSelect value={lay.title.font} onChange={f => ttl({ font: f })} className={`${field} flex-1 min-w-0`} /></Row>
        <Row label="Size">
          <input type="range" min={36} max={140} value={lay.title.size} onChange={e => ttl({ size: Number(e.target.value) })} className="flex-1" />
          <span className="tabular-nums text-[10px] w-6">{lay.title.size}</span>
        </Row>
        <Row label="Colours">{color(lay.title.color, c => ttl({ color: c }), 'Text')}{color(lay.title.bg, c => ttl({ bg: c }), 'Box')}</Row>
      </section>
    </div>
  );
}

function SoundTab({ plan, lib, reloadLib, segs, time, onPatch, onSeek }: {
  plan: ShortPlan; lib: SoundFx[]; reloadLib: () => void; segs: Seg[]; time: number;
  onPatch: (f: Partial<ShortPlan>) => void; onSeek: (t: number) => void;
}) {
  const setSfx = (sfx: ShortSfx[]) => onPatch({ sfx: [...sfx].sort((a, b) => a.t - b.t) });
  const inside = outTime(time, segs) !== null;
  const add = (file: string) => {
    if (!inside) { notify('Move the playhead inside this short first', 'error'); return; }
    setSfx([...plan.sfx, { t: Math.round(time * 100) / 100, file, gain: -4 }]);
  };
  const byFile = new Map(lib.map(s => [s.file, s]));
  return (
    <div className="flex flex-col gap-3">
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">In this short</h4>
        {plan.sfx.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 py-0.5">
            <button onClick={() => onSeek(Math.max(0, s.t - 2))} className="tabular-nums text-[10px] text-slate-400 hover:text-slate-200 w-9 text-left"
              title="Jump to two seconds before it">{fmtT(outTime(s.t, segs) ?? 0)}</button>
            <select value={s.file} onChange={e => setSfx(plan.sfx.map((x, k) => k === i ? { ...x, file: e.target.value } : x))}
              className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-[11px]" title={s.why}>
              {!byFile.has(s.file) && <option value={s.file}>{s.file} — missing</option>}
              {lib.map(f => <option key={f.file} value={f.file}>{f.name}</option>)}
            </select>
            <input type="range" min={-24} max={6} value={s.gain} onChange={e => setSfx(plan.sfx.map((x, k) => k === i ? { ...x, gain: Number(e.target.value) } : x))}
              className="w-16" title={`${s.gain} dB`} />
            <button onClick={() => { const f = byFile.get(s.file); if (f) playSound(f.url, Math.pow(10, Math.min(0, s.gain) / 20)); }} className="text-[11px] text-slate-400 hover:text-slate-100" title="Listen">▶</button>
            <button onClick={() => setSfx(plan.sfx.filter((_, k) => k !== i))} className="text-[10px] text-rose-300" title="Remove">✕</button>
          </div>
        ))}
        {!plan.sfx.length && <p className="text-[11px] text-slate-500">None yet. Add one at the playhead from the library below.</p>}
      </section>
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-2">
          Library <span className="normal-case font-normal">({lib.length})</span>
          <button onClick={() => void api('/api/soundfx/open', { method: 'POST' })} className="ml-auto normal-case font-normal text-slate-500 hover:text-slate-200">add your own…</button>
          <button onClick={reloadLib} className="normal-case font-normal text-slate-500 hover:text-slate-200">reload</button>
        </h4>
        {lib.map(f => (
          <div key={f.file} className="flex items-center gap-2 py-0.5" title={f.use}>
            <button onClick={() => playSound(f.url)} className="text-[11px] text-slate-400 hover:text-slate-100">▶</button>
            <span className="flex-1 min-w-0 truncate">{f.name}{f.user && <span className="ml-1 text-[9px] text-sky-300">yours</span>}</span>
            <span className="hidden xl:inline text-[10px] text-slate-500 truncate max-w-[45%]">{f.use}</span>
            <button onClick={() => add(f.file)} className="px-1.5 rounded border border-slate-700 hover:border-slate-500 text-[10px]">+ at playhead</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function ReachTab({ plan, busy, onPatch, onCheck, onPrompt }: {
  plan: ShortPlan; busy: boolean; onPatch: (f: Partial<ShortPlan>) => void; onCheck: () => void; onPrompt: () => void;
}) {
  const v = plan.virality;
  const bar = (label: string, x: number) => (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-24 text-slate-400">{label}</span>
      <div className="flex-1 h-1.5 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-fuchsia-500" style={{ width: `${x * 10}%` }} /></div>
      <span className="w-6 tabular-nums text-right">{x}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-2 py-0.5 rounded text-sm font-bold tabular-nums ${scoreTone(v?.score ?? 0)}`}>{v?.score ?? '–'}</span>
          <span className="text-[11px] text-slate-400">virality score</span>
          <button disabled={busy} onClick={onCheck} className="ml-auto px-2 py-1 rounded text-[11px] border border-fuchsia-500 text-fuchsia-200 hover:bg-fuchsia-500/10 disabled:opacity-40">Check virality</button>
        </div>
        {v && <>
          {bar('Hook (first 3 s)', v.hook)}{bar('Emotion', v.emotion)}{bar('Clarity', v.clarity)}{bar('Shareability', v.shareability)}{bar('Novelty', v.novelty)}
          {v.why && <p className="mt-1.5 text-[11px] text-slate-300">{v.why}</p>}
          {v.tips && <p className="mt-1 text-[11px] text-amber-200/90">Tip: {v.tips}</p>}
          {!!v.hooks?.length && (
            <div className="mt-1.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Stronger hooks — click to use</div>
              {v.hooks.map(h => (
                <button key={h} onClick={() => onPatch({ hook: h, layout: { ...plan.layout, title: { ...plan.layout.title, text: h } } })}
                  className="block text-left w-full py-0.5 text-sky-300 hover:underline">{h}</button>
              ))}
            </div>
          )}
        </>}
        <p className="mt-1 text-[10px] text-slate-500">Edited the cut? Check again: the score is for the edit as it stands.</p>
      </section>
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Thumbnail prompt for ChatGPT</h4>
          <button disabled={busy} onClick={onPrompt} className="ml-auto px-2 py-1 rounded text-[11px] border border-slate-600 hover:border-slate-400 disabled:opacity-40">
            {plan.thumbPrompt ? 'Write again' : 'Write prompt'}
          </button>
        </div>
        {plan.thumbPrompt ? (
          <>
            <textarea readOnly value={plan.thumbPrompt} rows={9} className="w-full bg-[#0d1117] border border-slate-700 rounded p-2 text-[11px] leading-snug" />
            <button onClick={() => { void navigator.clipboard.writeText(plan.thumbPrompt); notify('Prompt copied: paste it into ChatGPT'); }}
              className="mt-1 px-2 py-1 rounded text-[11px] bg-sky-700 hover:bg-sky-600 text-white">Copy</button>
          </>
        ) : <p className="text-[11px] text-slate-500">Gemini looks at three frames of the short and writes a 9:16 cover prompt with the headline in the video's language.</p>}
      </section>
    </div>
  );
}

/** A sound-effect clip picked on the Sound track: what it is, how loud, and where. */
function SfxClipPanel({ sfx, i, lib, segs, onPatch, onSeek, onClose }: {
  sfx: ShortSfx[]; i: number; lib: SoundFx[]; segs: Seg[];
  onPatch: (f: Partial<ShortPlan>) => void; onSeek: (t: number) => void; onClose: () => void;
}) {
  const s = sfx[i];
  const f = lib.find(x => x.file === s.file);
  const put = (p: Partial<ShortSfx>) => onPatch({ sfx: sfx.map((x, k) => k === i ? { ...x, ...p } : x) });
  const o = outTime(s.t, segs) ?? 0;
  const nudge = (d: number) => put({ t: Math.round(srcTime(Math.max(0, o + d), segs) * 100) / 100 });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-violet-300">Sound effect</h4>
        <button onClick={onClose} className="ml-auto text-[11px] text-slate-500 hover:text-slate-200" title="Back to the tabs (Esc)">✕</button>
      </div>
      <Row label="Sound">
        <select value={s.file} onChange={e => put({ file: e.target.value })}
          className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-0.5 text-[11px]">
          {!f && <option value={s.file}>{s.file} — missing</option>}
          {lib.map(x => <option key={x.file} value={x.file}>{x.name}</option>)}
        </select>
      </Row>
      <div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-20 shrink-0 text-slate-400">Volume</span>
          <input type="range" min={-30} max={12} step={0.5} value={s.gain} onChange={e => put({ gain: Number(e.target.value) })} className="flex-1" />
          <input type="number" min={-30} max={12} step={0.5} value={s.gain} onChange={e => put({ gain: Number(e.target.value) })}
            className="w-14 bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-right tabular-nums" />
          <span className="text-slate-500">dB</span>
        </div>
        <div className="ml-[88px] mt-1 h-2 rounded bg-slate-800 overflow-hidden" title="Level against the speech (0 dB = as recorded)">
          <div className={`h-full ${s.gain > 0 ? 'bg-rose-500' : 'bg-violet-500'}`} style={{ width: `${((s.gain + 30) / 42) * 100}%` }} />
        </div>
        <div className="ml-[88px] mt-1 flex gap-1">
          {[-12, -6, -4, 0].map(g => <button key={g} onClick={() => put({ gain: g })} className="px-1.5 rounded border border-slate-700 hover:border-slate-500 text-[10px]">{g} dB</button>)}
          <button onClick={() => f && playSound(f.url, dbToVolume(s.gain))} className="ml-auto px-2 rounded border border-slate-700 hover:border-slate-500 text-[10px]">▶ listen</button>
        </div>
      </div>
      <Row label="At">
        <span className="tabular-nums">{fmtT(o)}</span>
        <button onClick={() => nudge(-0.1)} className="px-1.5 rounded border border-slate-700 text-[10px]">−0.1 s</button>
        <button onClick={() => nudge(0.1)} className="px-1.5 rounded border border-slate-700 text-[10px]">+0.1 s</button>
        <button onClick={() => onSeek(Math.max(0, s.t - 2))} className="px-1.5 rounded border border-slate-700 text-[10px]" title="Play from two seconds before it">hear in place</button>
      </Row>
      {s.why && <p className="text-[11px] text-slate-500 italic">{s.why}</p>}
      <button onClick={() => { onPatch({ sfx: sfx.filter((_, k) => k !== i) }); onClose(); }}
        className="self-start px-2 py-1 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-[11px]">Remove (Delete)</button>
    </div>
  );
}

function ImageClipPanel({ images, i, segs, onPatch, onSeek, onClose }: {
  images: ShortImage[]; i: number; segs: Seg[];
  onPatch: (f: Partial<ShortPlan>) => void; onSeek: (t: number) => void; onClose: () => void;
}) {
  const im = images[i];
  const put = (p: Partial<ShortImage>) => onPatch({ images: images.map((x, k) => k === i ? { ...x, ...p } : x) });
  const o = outTime(im.t, segs) ?? 0;
  const nudge = (d: number) => put({ t: Math.round(srcTime(Math.max(0, o + d), segs) * 100) / 100 });
  const slider = (label: string, key: 'w' | 'x' | 'y', min: number, max: number, show: (v: number) => string) => (
    <Row label={label}>
      <input type="range" min={min} max={max} step={0.005} value={im[key]} onChange={e => put({ [key]: Number(e.target.value) })} className="flex-1" />
      <span className="w-12 text-right tabular-nums text-slate-400">{show(im[key])}</span>
    </Row>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Picture</h4>
        <button onClick={onClose} className="ml-auto text-[11px] text-slate-500 hover:text-slate-200" title="Back to the tabs (Esc)">✕</button>
      </div>
      <img src={im.url} alt="" className="w-40 rounded border border-slate-700" />
      {im.why && <p className="text-[11px] text-slate-400">{im.why}</p>}
      {slider('Size', 'w', 0.08, 1.6, v => `${Math.round(v * 100)}%`)}
      {slider('Across', 'x', -0.4, 1.4, v => `${Math.round(v * 100)}%`)}
      {slider('Down', 'y', -0.4, 1.4, v => `${Math.round(v * 100)}%`)}
      <Row label="At">
        <span className="tabular-nums">{fmtT(o)}</span>
        <button onClick={() => nudge(-0.5)} className="px-1.5 rounded border border-slate-700 text-[10px]">−0.5 s</button>
        <button onClick={() => nudge(0.5)} className="px-1.5 rounded border border-slate-700 text-[10px]">+0.5 s</button>
        <button onClick={() => onSeek(im.t + 0.05)} className="px-1.5 rounded border border-slate-700 text-[10px]">go to</button>
      </Row>
      <Row label="Stays">
        <input type="range" min={0.5} max={15} step={0.1} value={im.d} onChange={e => put({ d: Number(e.target.value) })} className="flex-1" />
        <span className="w-12 text-right tabular-nums text-slate-400">{im.d.toFixed(1)} s</span>
      </Row>
      <button onClick={() => put({ x: 0.5, y: 0.4, w: 0.8 })} className="self-start px-2 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-[10px]">Reset place and size</button>
      <details className="text-[10px] text-slate-500"><summary className="cursor-pointer">Prompt Gemini drew it from</summary><p className="mt-1 whitespace-pre-wrap">{im.prompt}</p></details>
      <button onClick={() => { onPatch({ images: images.filter((_, k) => k !== i) }); onClose(); }}
        className="self-start px-2 py-1 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-[11px]">Remove (Delete)</button>
    </div>
  );
}
