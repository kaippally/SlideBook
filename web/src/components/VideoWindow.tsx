import { KIND_NAME, type CardKind } from '../lib/cardKinds';
import { useEffect, useMemo, useRef } from 'react';
import { api, control, useBook, useServerState } from '../lib/api';
import { fmtTime, isCard } from '../lib/bookModel';
import { DEFAULT_CARD_STYLE, cardAccent, resolveCardStyle } from '../lib/cardStyle';

/**
 * The navigator: the book's timed cards and its transcript, in a window of its own. The video itself
 * plays on the canvas, as the video object (lib/videoObject.ts). Clicking a card goes to its page —
 * which plays its clip first, as a step does — and clicking a transcript line plays that moment on the
 * canvas. It follows the book open in SlideBook.
 */
export function VideoWindow() {
  const srv = useServerState();
  const bookId = new URLSearchParams(location.search).get('book') || srv.view?.bookId || null;
  const [book] = useBook(bookId);
  const src = book?.source;
  const style = resolveCardStyle(book?.styles?.card ?? DEFAULT_CARD_STYLE);

  const cards = useMemo(() => (book?.manifest ?? []).map((p, i) => ({ p, n: i + 1 })).filter(x => isCard(x.p) && x.p.card?.t != null), [book]);
  const viewPage = srv.view?.bookId === book?.id ? srv.view?.page : null;
  const livePage = srv.live?.bookId === book?.id ? srv.live?.page : null;
  const current = book && viewPage ? book.manifest[viewPage - 1]?.card : undefined;

  const lines = src?.lines ?? [];
  const anchor = current?.t ?? null;
  const activeLine = anchor == null ? -1 : lines.findIndex((l, i) => anchor >= l.t && (i === lines.length - 1 || anchor < lines[i + 1]!.t));
  const lineRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { lineRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [activeLine]);
  useEffect(() => { cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [viewPage]);

  const cue = (t: number) => { if (book) void api('/api/cue', { method: 'POST', json: { bookId: book.id, t } }).catch(() => {}); };

  if (!book) return <div className="h-full grid place-items-center text-slate-500 text-sm">Open a book in SlideBook.</div>;

  return (
    <div className="h-full flex flex-col bg-[#07080b] text-slate-200 min-h-0">
      <div className="px-3 py-1.5 text-[12px] border-b border-slate-800 truncate"><b>{src?.title || book.title}</b> <span className="text-slate-500">{src?.uploader}</span></div>
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">Cards · click to go to the card</div>
      <div className="max-h-[50%] overflow-y-auto border-b border-slate-800">
        {cards.map(({ p, n }) => {
          const accent = cardAccent(p.kind, p.card!.verdict, style);
          const here = viewPage === n;
          return (
            <div key={p.id} ref={here ? cardRef : undefined} onClick={() => void control('goto', book.id, n)}
              className={`flex gap-2 px-3 py-1.5 cursor-pointer border-l-4 ${here ? 'bg-slate-800/70' : 'hover:bg-slate-900'} ${p.hidden ? 'opacity-40' : ''}`} style={{ borderLeftColor: accent }}>
              <span className="font-mono text-[11px] text-slate-400 w-20 shrink-0">{fmtTime(p.card!.t)}–{fmtTime(p.card!.tEnd)}</span>
              <span className="flex-1 min-w-0 text-[12px] leading-snug">
                <span className="text-[9px] font-bold mr-1" style={{ color: accent }}>{p.kind === 'claim' || p.kind === 'qa' ? p.card!.verdict : KIND_NAME[p.kind as CardKind].toUpperCase()}</span>
                {p.card!.speaker && <span className="text-[10px] text-slate-500 mr-1">{p.card!.speaker}:</span>}
                {p.card!.title.replace(/<[^>]+>/g, '')}
              </span>
              <span className="text-[10px] text-slate-500 w-5 text-right">{n}</span>
              <span className={`text-[11px] w-4 ${livePage === n ? 'text-emerald-400' : here ? 'text-sky-400' : 'text-slate-700'}`} title={livePage === n ? 'On air' : here ? 'Open in SlideBook' : ''}>◉</span>
            </div>
          );
        })}
        {!cards.length && <div className="p-3 text-[11px] text-slate-600">No timed cards in this book.</div>}
      </div>
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-800">Transcript · click to play that moment on the canvas</div>
      <div className="flex-1 min-h-0 overflow-y-auto text-[12px]">
        {lines.map((l, i) => {
          const marks = cards.filter(c => l.t >= (c.p.card!.t ?? 0) - 0.01 && l.t < (c.p.card!.tEnd ?? 0));
          return (
            <div key={i} ref={i === activeLine ? lineRef : undefined} onClick={() => cue(l.t)}
              className={`flex gap-2 px-3 py-0.5 cursor-pointer ${i === activeLine ? 'bg-sky-950/60' : 'hover:bg-slate-900'}`}>
              <span className="font-mono text-[10px] text-slate-500 w-12 shrink-0 pt-0.5">{fmtTime(l.t)}</span>
              <span className="flex gap-0.5 w-3 shrink-0 pt-1.5">{marks.slice(0, 2).map(c => <span key={c.p.id} className="w-1.5 h-1.5 rounded-full" style={{ background: cardAccent(c.p.kind, c.p.card!.verdict, style) }} />)}</span>
              <span className="flex-1">{l.speaker && <b className="text-slate-400 mr-1">{l.speaker}:</b>}{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
