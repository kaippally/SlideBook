import { useEffect, useRef, useState } from 'react';
import { CardFace } from './CardFace';
import { KIND_NAME, type CardKind } from '../lib/cardKinds';
import { cardAccent, resolveCardStyle } from '../lib/cardStyle';
import { fmtTime, isCard, pageAspect } from '../lib/bookModel';
import { segments } from '../lib/segments';
import { segmentClip } from '../lib/videoObject';
import type { Book, PageEntry } from '../lib/types';

const THUMB_W = 196;

function Thumb({ book, p, h }: { book: Book; p: PageEntry; h: number }) {
  const aspect = pageAspect(book, p);
  const w = Math.round(h * aspect);
  if (isCard(p) && p.card) {
    const designH = Math.min(1080, 1920 / aspect);
    return (
      <div className="relative overflow-hidden bg-black" style={{ width: w, height: h }}>
        <CardFace kind={p.kind as CardKind} card={p.card} style={resolveCardStyle(book.styles?.card)} width={w} height={h} scale={h / designH} />
      </div>
    );
  }
  return <img src={`/media/${p.ref}`} draggable={false} className="block object-contain bg-slate-900 pointer-events-none" style={{ width: w, height: h }} />;
}

/** The top-level drop slot on a segment boundary: a full-width line across the timestamp column. */
function TopGap({ active, className, onDragOver, onDrop }: { active: boolean; className: string; onDragOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void }) {
  return (
    <div onDragOver={onDragOver} onDrop={onDrop} className={`absolute left-0 right-0 h-4 z-20 flex items-center ${className}`}>
      <div className={`w-full h-0.5 ${active ? 'bg-amber-400' : 'bg-transparent'}`} />
      {active && <span className="absolute left-2 -top-1.5 px-1 rounded bg-amber-500 text-[9px] font-semibold text-black">new timestamp</span>}
    </div>
  );
}

/**
 * The open book's slides, grouped by time segment: the timestamp on the left, the segment's slides
 * stacked beside it in the order they step. Click a slide to go to it. "Join above" moves a slide's
 * timestamp onto the segment above it, so it steps inside that segment without its own clip.
 */
export function SlidesPanel({ book, view, live, onGoto, onSegment, onJoin, onHide, onAddFiles, onAddCard, onAddVideoLink, onPaste, onCopy, onDelete, onHideMany, onDeleteMany, onReorder, onUntime, onTime, rangeDraft }: {
  /** A clip range being dragged in the clip panel: shown on its segment as it moves. */
  rangeDraft: { first: number; t0: number; t1: number } | null;
  /** Give an untimed card a video time slot by hand (its range is then set on the clip timeline). */
  onTime: (p: PageEntry, t: number) => void;
  /** Remove a segment's video time: its slides stay, they no longer play a clip. */
  onUntime: (pages: PageEntry[], t: number) => void;
  /** Drag a slide to a new place: `from` and `to` are 1-based positions, `to` as after the move.
   *  `card` is the time the slide takes on when it was dropped INSIDE a timestamp. */
  onReorder: (from: number, to: number, card?: { p: PageEntry; t: number; tEnd: number }) => void;
  /** A video slide from a link: the Videos library's copy, or downloaded. */
  onAddVideoLink: (url: string) => void;
  /** A whole segment: hide or show all its slides, or delete them (through the review dialog). */
  onHideMany: (pages: PageEntry[], hidden: boolean) => void;
  onDeleteMany: (pages: PageEntry[]) => void;
  onAddFiles: (files: File[]) => void;
  onAddCard: (kind: 'claim' | 'fallacy') => void;
  onPaste: () => void;
  onCopy: (p: PageEntry) => void;
  onDelete: (p: PageEntry) => void;
  book: Book;
  view: number;
  live: number | null;
  onGoto: (n: number) => void;
  /** The timestamp: start the segment — its first slide, with its clip, whatever came before. */
  onSegment: (n: number) => void;
  onJoin: (p: PageEntry, t: number) => void;
  onHide: (p: PageEntry) => void;
}) {
  const style = resolveCardStyle(book.styles?.card);
  const segs = segments(book);
  const hereRef = useRef<HTMLDivElement>(null);
  useEffect(() => { hereRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [view, book.id]);

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const [videoAsk, setVideoAsk] = useState(false);
  const [dragN, setDragN] = useState<number | null>(null);
  const [timeAsk, setTimeAsk] = useState<{ id: string; text: string } | null>(null);
  const parseT = (s: string) => {
    const parts = s.trim().split(':').map(Number);
    if (!parts.length || parts.some(x => !Number.isFinite(x) || x < 0)) return null;
    return parts.reduce((a, x) => a * 60 + x, 0);
  };
  const saveTime = (p: PageEntry) => {
    const t = timeAsk ? parseT(timeAsk.text) : null;
    if (t == null) return;
    onTime(p, t);
    setTimeAsk(null);
  };
  // Two kinds of slot: INSIDE a timestamp (before/after one of its slides — the slide takes that
  // segment's time), or a TOP-LEVEL gap before segment `si` (`si === segs.length` = the end) where
  // the slide stands as its own timestamp.
  type Over = { kind: 'in'; n: number; after: boolean } | { kind: 'top'; si: number };
  const [over, setOver] = useState<Over | null>(null);
  const sameOver = (a: Over | null, b: Over) => !!a && a.kind === b.kind
    && (a.kind === 'in' ? b.kind === 'in' && a.n === b.n && a.after === b.after : b.kind === 'top' && a.si === b.si);
  const hover = (e: React.DragEvent, o: Over) => {
    if (dragN == null) return;
    e.preventDefault(); e.stopPropagation();
    if (!sameOver(over, o)) setOver(o);
  };
  const dragged = dragN != null ? book.manifest[dragN - 1] : undefined;
  // Only a card carries a time, so only a card can join a timestamp; anything else, and any untimed
  // segment, takes the top-level slot on the nearer side instead.
  const resolve = (o: Over): Over => {
    if (o.kind === 'top') return o;
    const si = segs.findIndex(s => s.pages.some(x => x.n === o.n));
    const s = segs[si]!;
    if (s.t != null && dragged && isCard(dragged)) return o;
    return { kind: 'top', si: o.after ? si + 1 : si };
  };
  const drop = (e: React.DragEvent, o: Over) => {
    if (dragN == null) return;
    e.preventDefault(); e.stopPropagation();
    const a = dragN, r = resolve(o);
    setDragN(null); setOver(null);
    const last = book.manifest.length;
    const [b, after] = r.kind === 'in' ? [r.n, r.after]
      : r.si < segs.length ? [segs[r.si]!.pages[0]!.n, false] : [last, true];
    const to = after ? (a > b ? b + 1 : b) : (a > b ? b : b - 1);
    let card: { p: PageEntry; t: number; tEnd: number } | undefined;
    if (r.kind === 'in') {
      const s = segs.find(x => x.pages.some(y => y.n === r.n))!;
      const p = book.manifest[a - 1]!;
      if (s.t != null && Math.round(p.card?.t ?? -1) !== Math.round(s.t)) {
        // The segment's span, not the slide's own: a joined card must not stretch the clip.
        const tEnd = Math.max(...s.pages.map(x => x.p.card?.tEnd ?? (x.p.card?.t ?? s.t!) + 8));
        card = { p, t: s.t, tEnd };
      }
    }
    if (to !== a || card) onReorder(a, to, card);
  };
  const [link, setLink] = useState('');
  const addLink = () => { if (link.trim()) { onAddVideoLink(link.trim()); setLink(''); setVideoAsk(false); } };
  const tool = 'px-1.5 py-0.5 rounded border text-[10px]';
  return (
    <div className="h-full overflow-y-auto bg-[#0b0d10] text-slate-300"
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const fs = [...e.dataTransfer.files]; if (fs.length) onAddFiles(fs); }}>
      <div className="sticky top-0 z-10 bg-[#0b0d10] border-b border-slate-800">
        <div className="px-3 pt-1.5 text-[11px] text-slate-500 truncate">
          <b className="text-slate-300">{book.title}</b> · {book.manifest.length} slides · {segs.filter(s => s.t != null).length} segments
        </div>
        <div className="flex flex-wrap gap-1 px-2 py-1.5">
          <button onClick={() => fileRef.current?.click()} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500`} title="Images or PDFs from disk — or drop them (or videos) here">＋ Images / PDF</button>
          <button onClick={() => onAddCard('claim')} className={`${tool} border-red-900 text-red-200 hover:border-red-600`}>＋ Claim</button>
          <button onClick={() => onAddCard('fallacy')} className={`${tool} border-violet-900 text-violet-200 hover:border-violet-600`}>＋ Fallacy</button>
          <button onClick={() => setVideoAsk(a => !a)} className={`${tool} ${videoAsk ? 'border-sky-500 text-sky-100' : 'border-sky-900 text-sky-200 hover:border-sky-600'}`}
            title="A video slide: it plays in the slide when stepped onto. From disk, or from a link">＋ Video</button>
          <button onClick={onPaste} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500`} title="Paste a copied slide or an image (Ctrl+V)">Paste</button>
        </div>
        {videoAsk && (
          <div className="flex gap-1 px-2 pb-1.5">
            <input autoFocus value={link} onChange={e => setLink(e.target.value)} placeholder="Paste a video link"
              onKeyDown={e => { if (e.key === 'Enter') addLink(); if (e.key === 'Escape') setVideoAsk(false); }}
              className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-0.5 text-[10px]" />
            <button onClick={addLink} disabled={!link.trim()} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-40`}>Add</button>
            <button onClick={() => videoRef.current?.click()} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500`}>From disk…</button>
          </div>
        )}
        <input ref={videoRef} type="file" multiple accept="video/*,.mkv" className="hidden"
          onChange={e => { const fs = [...(e.target.files ?? [])]; if (fs.length) { onAddFiles(fs); setVideoAsk(false); } e.target.value = ''; }} />
        <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden"
          onChange={e => { const fs = [...(e.target.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); if (fs.length) onAddFiles(fs); e.target.value = ''; }} />
      </div>
      {segs.map((s, si) => {
        const prevSeg = segs[si - 1];
        const canJoin = s.t != null && prevSeg?.t != null;
        const lastN = s.pages[s.pages.length - 1]!.n;
        return (
          <div key={si} className="relative flex gap-2 px-2 py-2 border-b border-slate-800/60"
            onDragOver={e => hover(e, resolve({ kind: 'in', n: lastN, after: true }))}
            onDrop={e => drop(e, { kind: 'in', n: lastN, after: true })}>
            {dragN != null && <TopGap active={over?.kind === 'top' && over.si === si} className="-top-2"
              onDragOver={e => hover(e, { kind: 'top', si })} onDrop={e => drop(e, { kind: 'top', si })} />}
            <div className="w-14 shrink-0 pt-1 text-right">
              {s.t != null
                ? (() => {
                    const first = s.pages[0]!.n;
                    const clip = segmentClip(book, first);
                    const r = rangeDraft?.first === first ? rangeDraft : clip?.range;
                    return (<>
                      <button onClick={() => onSegment(first)} title="Start this segment: play its video, then step through its slides"
                        className="font-mono text-[15px] text-sky-300 hover:text-white tabular-nums underline decoration-dotted underline-offset-4">▶ {fmtTime(r?.t0 ?? s.t)}</button>
                      {r && <div className={`font-mono text-[10px] tabular-nums ${rangeDraft?.first === first ? 'text-amber-300' : 'text-slate-500'}`} title="The clip's end">→ {fmtTime(r.t1)}</div>}
                    </>);
                  })()
                : s.pages[0] && isCard(s.pages[0].p) ? (
                  timeAsk?.id === s.pages[0].p.id ? (
                    <div className="flex flex-col items-end gap-1">
                      <input autoFocus value={timeAsk.text} onChange={e => setTimeAsk({ ...timeAsk, text: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') saveTime(s.pages[0]!.p); if (e.key === 'Escape') setTimeAsk(null); }}
                        placeholder="m:ss" title="Where in the video it starts (m:ss)"
                        className="w-14 bg-[#0d1117] border border-sky-600 rounded px-1 py-0.5 text-[11px] font-mono text-right" />
                      <button onClick={() => saveTime(s.pages[0]!.p)} disabled={parseT(timeAsk.text) == null}
                        className="px-1.5 py-0.5 rounded border border-sky-700 text-[9px] text-sky-200 disabled:opacity-40">Set</button>
                    </div>
                  ) : (
                    <button onClick={() => {
                      const prev = segs.slice(0, si).reverse().find(x => x.t != null);
                      const end = prev ? Math.max(...prev.pages.map(x => x.p.card?.tEnd ?? (x.p.card?.t ?? 0) + 8)) : 0;
                      setTimeAsk({ id: s.pages[0]!.p.id, text: fmtTime(end) });
                    }} title="Create a video time slot for this card: then set its from–to range on the clip timeline"
                      className="px-1.5 py-0.5 rounded border border-sky-900 text-[9px] text-sky-300 hover:border-sky-600">＋ Time</button>
                  )
                ) : <span className="text-[10px] text-slate-600">—</span>}
              {s.pages.length > 1 && <div className="text-[9px] text-slate-500 mt-0.5">{s.pages.length} slides</div>}
              {(() => {
                const pages = s.pages.map(x => x.p);
                const allHidden = pages.every(p => p.hidden);
                return (
                  <div className="flex flex-col items-end gap-1 mt-1.5">
                    <button onClick={() => onHideMany(pages, !allHidden)}
                      className={`px-1.5 py-0.5 rounded border text-[9px] ${allHidden ? 'border-amber-600 text-amber-300' : 'border-slate-700 text-slate-400 hover:text-white'}`}
                      title={allHidden ? 'Show this segment again' : 'Hide this segment: its clip and slides are skipped when stepping'}>{allHidden ? 'Show' : 'Hide'}</button>
                    <button onClick={() => onDeleteMany(pages)} className="px-1.5 py-0.5 rounded border border-slate-700 text-[9px] text-rose-400 hover:border-rose-600"
                      title="Delete this segment's slides">Delete</button>
                    {s.t != null && (
                      <button onClick={() => onUntime(pages, s.t!)} className="px-1.5 py-0.5 rounded border border-slate-700 text-[9px] text-slate-400 hover:text-white hover:border-slate-500"
                        title="Remove only this video time slot: the slides stay, they stop playing its clip">✕ Time</button>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              {s.pages.map(({ p, n }, pi) => {
                const accent = isCard(p) ? cardAccent(p.kind, p.card?.verdict, style) : '#475569';
                const h = Math.round(THUMB_W / pageAspect(book, p));
                const onAir = live === n, here = view === n;
                return (
                  <div key={p.id} ref={here ? hereRef : undefined}
                    draggable onDragStart={e => { setDragN(n); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-slidebook-slide', String(n)); }}
                    onDragEnd={() => { setDragN(null); setOver(null); }}
                    onDragOver={e => {
                      const r = e.currentTarget.getBoundingClientRect();
                      hover(e, resolve({ kind: 'in', n, after: e.clientY > r.top + r.height / 2 }));
                    }}
                    onDrop={e => { const r = e.currentTarget.getBoundingClientRect(); drop(e, { kind: 'in', n, after: e.clientY > r.top + r.height / 2 }); }}
                    className={`relative group cursor-grab ${dragN === n ? 'opacity-40' : ''}`}>
                    {over?.kind === 'in' && over.n === n && dragN !== n && <div className={`absolute left-0 right-0 h-0.5 bg-sky-400 z-10 pointer-events-none ${over.after ? '-bottom-1' : '-top-1'}`} style={{ maxWidth: THUMB_W }} />}
                    <button onClick={() => onGoto(n)}
                      className={`block rounded overflow-hidden border-2 ${onAir ? 'border-emerald-400' : here ? 'border-sky-400' : 'border-slate-800 hover:border-slate-600'} ${p.hidden ? 'opacity-30' : ''}`}
                      title={`${n}. ${isCard(p) ? (p.card?.title || '').replace(/<[^>]+>/g, '') : p.label || p.kind}${p.hidden ? ' — hidden' : ''}`}>
                      <Thumb book={book} p={p} h={h} />
                    </button>
                    <div className="flex items-center gap-1 mt-0.5 text-[9px] font-mono" style={{ maxWidth: THUMB_W }}>
                      <span className="text-slate-500">{n}</span>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: accent }} />
                      <span className="truncate text-slate-500">{isCard(p) ? (p.kind === 'claim' || p.kind === 'qa' ? (p.card?.verdict || p.kind) : KIND_NAME[p.kind as CardKind]).toLowerCase() : p.kind}</span>
                      {onAir && <span className="ml-auto text-emerald-400">on air</span>}
                    </div>
                    <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-70 group-hover:opacity-100">
                      {/* Join stays a hover action: it is rare, and it would crowd every first slide. */}
                      {pi === 0 && canJoin && (
                        <button onClick={() => onJoin(p, prevSeg!.t!)} className="hidden group-hover:block px-1.5 h-5 rounded bg-black/80 text-[10px] text-slate-200"
                          title={`Put this slide into the ${fmtTime(prevSeg!.t!)} segment above: it steps after those slides, with no clip of its own`}>↑ Join above</button>
                      )}
                      <button onClick={() => onReorder(n, n - 1)} disabled={n === 1} className="w-5 h-5 grid place-items-center rounded bg-black/75 text-[10px] text-slate-200 disabled:opacity-30" title="Move up (an image or video joins the time slot it moves into)">▲</button>
                      <button onClick={() => onReorder(n, n + 1)} disabled={n === book.manifest.length} className="w-5 h-5 grid place-items-center rounded bg-black/75 text-[10px] text-slate-200 disabled:opacity-30" title="Move down">▼</button>
                      <button onClick={() => onHide(p)} className="w-5 h-5 grid place-items-center rounded bg-black/75 text-[10px] text-slate-200" title={p.hidden ? 'Show' : 'Hide (skipped when stepping)'}>{p.hidden ? '◌' : '◉'}</button>
                      <button onClick={() => onCopy(p)} className="w-5 h-5 grid place-items-center rounded bg-black/75 text-[10px] text-slate-200" title="Copy this slide (paste it into any book)">⧉</button>
                      <button onClick={() => onDelete(p)} className="w-5 h-5 grid place-items-center rounded bg-black/75 text-[11px] text-rose-400" title="Delete">×</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {dragN != null && segs.length > 0 && (
        <div className="relative h-6">
          <TopGap active={over?.kind === 'top' && over.si === segs.length} className="top-0"
            onDragOver={e => hover(e, { kind: 'top', si: segs.length })} onDrop={e => drop(e, { kind: 'top', si: segs.length })} />
        </div>
      )}
      {!book.manifest.length &&<div className="p-4 text-[11px] text-slate-600">No slides yet.</div>}
    </div>
  );
}
