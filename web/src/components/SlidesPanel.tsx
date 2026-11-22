import { useEffect, useRef } from 'react';
import { CardFace } from './CardFace';
import { KIND_NAME, type CardKind } from '../lib/cardKinds';
import { cardAccent, resolveCardStyle } from '../lib/cardStyle';
import { fmtTime, isCard, pageAspect } from '../lib/bookModel';
import { segments } from '../lib/segments';
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

/**
 * The open book's slides, grouped by time segment: the timestamp on the left, the segment's slides
 * stacked beside it in the order they step. Click a slide to go to it. "Join above" moves a slide's
 * timestamp onto the segment above it, so it steps inside that segment without its own clip.
 */
export function SlidesPanel({ book, view, live, onGoto, onSegment, onJoin, onHide, onAddFiles, onAddCard, onPaste, onCopy, onDelete, onHideMany, onDeleteMany }: {
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
          <button onClick={() => fileRef.current?.click()} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500`} title="Images or PDFs from disk — or drop them here">＋ Images / PDF</button>
          <button onClick={() => onAddCard('claim')} className={`${tool} border-red-900 text-red-200 hover:border-red-600`}>＋ Claim</button>
          <button onClick={() => onAddCard('fallacy')} className={`${tool} border-violet-900 text-violet-200 hover:border-violet-600`}>＋ Fallacy</button>
          <button onClick={onPaste} className={`${tool} border-slate-700 text-slate-300 hover:border-slate-500`} title="Paste a copied slide or an image (Ctrl+V)">Paste</button>
        </div>
        <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden"
          onChange={e => { const fs = [...(e.target.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); if (fs.length) onAddFiles(fs); e.target.value = ''; }} />
      </div>
      {segs.map((s, si) => {
        const prevSeg = segs[si - 1];
        const canJoin = s.t != null && prevSeg?.t != null;
        return (
          <div key={si} className="flex gap-2 px-2 py-2 border-b border-slate-800/60">
            <div className="w-14 shrink-0 pt-1 text-right">
              {s.t != null
                ? <button onClick={() => onSegment(s.pages[0]!.n)} title="Start this segment: play its video, then step through its slides"
                    className="font-mono text-[15px] text-sky-300 hover:text-white tabular-nums underline decoration-dotted underline-offset-4">▶ {fmtTime(s.t)}</button>
                : <span className="text-[10px] text-slate-600">—</span>}
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
                  <div key={p.id} ref={here ? hereRef : undefined} className="relative group">
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
      {!book.manifest.length && <div className="p-4 text-[11px] text-slate-600">No slides yet.</div>}
    </div>
  );
}
