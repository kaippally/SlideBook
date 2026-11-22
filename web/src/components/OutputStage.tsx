import { useEffect, useRef, useState } from 'react';
import { fetchBook, onReconnect, playSound, subscribe, api } from '../lib/api';
import { bookSound, layerModel } from '../lib/bookModel';
import type { Book, Cursor, ServerState } from '../lib/types';
import { SlideLayer, type SlideLayerModel } from './SlideLayer';
import { CounterBar } from './CounterBar';
import { ClipLayer } from './ClipLayer';
import { resolveVideo, type ResolvedVideo } from '../lib/videoObject';

/**
 * What OBS captures: the live book's page, two independently-posed layers on a step (outgoing
 * HOLD→OUT, incoming IN→HOLD), the same renderer the canvas uses. It follows the server's `state`
 * broadcasts and never decides a page itself.
 */
const VW = 1920, VH = 1080;

export function OutputStage() {
  const [layers, setLayers] = useState<SlideLayerModel[]>([]);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [onAir, setOnAir] = useState<{ book: Book; page: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keySeq = useRef(0);
  const liveRef = useRef<Cursor | null>(null);
  const bookRef = useRef<Book | null>(null);
  const seq = useRef(0);
  const nextKey = () => (keySeq.current += 1);
  // `hold`: a "Card after video" clip stop — it plays, then waits frozen until the next step sends it off
  // (`leaving`). `frozen`: back onto a clip already played, shown on its last frame.
  const [clip, setClipState] = useState<{ seq: number; t0: number; t1: number; bookId: string; page: number; video: ResolvedVideo; ending: boolean;
    hold: boolean; frozen: boolean; leaving: boolean } | null>(null);
  const clipRef = useRef(clip);
  const togetherRef = useRef(false);
  // The slide-change sound plays in `/sfx` when that OBS source is open, so it has its own fader.
  const sfxElsewhere = useRef(false);
  const setClip = (c: typeof clip) => { clipRef.current = c; setClipState(c); };

  // Tell the server this output will play the clip before a card; with no output open, a card
  // shows at once.
  useEffect(() => {
    const beat = () => void api<{ sfx?: boolean }>('/api/clip', { method: 'POST', json: { phase: 'here' } })
      .then(r => { sfxElsewhere.current = !!r.sfx; }).catch(() => {});
    beat();
    const id = setInterval(beat, 3000);
    return () => clearInterval(id);
  }, []);
  const clipDone = (c: { bookId: string; page: number; seq: number }) =>
    void api('/api/clip', { method: 'POST', json: { phase: 'done', bookId: c.bookId, page: c.page, seq: c.seq } }).catch(() => {});

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(e => { const r = e[0]?.contentRect; if (r) setFrame({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const apply = async (s: ServerState, restore = false) => {
      const prev = liveRef.current;
      const live = s.live;
      liveRef.current = live;
      // The clip on screen is no longer the cursor's. A clip stop leaves on its own OUT tween as the
      // step after it brings the card in (a new clip simply replaces it, below). A "together" clip
      // still playing goes at once rather than finish under the next page; one that has ended is
      // already on its way out.
      const c = clipRef.current;
      if (c && live?.clip?.seq !== c.seq) {
        if (c.hold) { if (!live?.clip && !c.leaving) setClip({ ...c, leaving: true }); }
        else if (!c.ending) setClip(null);
      }
      if (!live) {
        bookRef.current = null;
        setOnAir(null);
        setLayers(ls => ls.map(l => (l.exiting ? l : { ...l, exiting: true })));
        return;
      }
      const mine = ++seq.current;
      const book = await fetchBook(live.bookId);
      if (!book || mine !== seq.current) return;
      bookRef.current = book;
      setOnAir({ book, page: live.page });
      // A fact-check or fallacy step plays its clip in the video source first: the old page leaves
      // now, and the card arrives on the `reveal` that follows (the same page, its clip gone).
      // In "together" mode the card arrives with the clip, so its `reveal` changes nothing on screen.
      const video = live.clip ? resolveVideo(book) : null;
      const hold = !!live.clip?.hold;
      const together = !hold && video?.mode === 'together';
      const wasTogether = togetherRef.current;
      togetherRef.current = !!live.clip && together;
      const cur = clipRef.current;
      if (live.clip && cur?.seq === live.clip.seq && (cur.t0 !== live.clip.t0 || cur.t1 !== live.clip.t1))
        setClip({ ...cur, t0: live.clip.t0, t1: live.clip.t1 });   // range edited: same clip, runs on to its new end
      if (live.clip && clipRef.current?.seq !== live.clip.seq) {
        if (!video) { if (!hold) clipDone({ bookId: live.bookId, page: live.page, seq: live.clip.seq }); }
        else setClip({ ...live.clip, bookId: live.bookId, page: live.page, video, ending: false, hold, frozen: !!live.clip.frozen, leaving: false });
      }
      if (live.clip && !together) {
        setLayers(ls => ls.map(l => (l.exiting ? l : { ...l, exiting: true })));
        return;
      }
      const fresh = restore || !prev || prev.bookId !== live.bookId || s.event === 'show';
      if (fresh) { setLayers([layerModel(book, live.page, nextKey())]); return; }
      if (prev.page === live.page && (!prev.clip || wasTogether)) return;
      const reverse = prev.page === live.page ? false : s.reverse ?? live.page < prev.page;
      const incoming = layerModel(book, live.page, nextKey(), false, reverse);
      const snd = bookSound(book);
      if (snd.url && !sfxElsewhere.current) playSound(snd.url, snd.volume / 100);
      const mount = () => {
        if (mine !== seq.current) return;
        setLayers(ls => {
          const front = ls.find(l => !l.exiting);
          return front ? [{ ...front, exiting: true, reverse }, incoming] : [incoming];
        });
      };
      const im = new Image();
      im.src = incoming.src;
      im.decode().then(mount, mount);
    };

    const restore = () => api<ServerState>('/api/state').then(s => apply(s, true)).catch(() => {});
    const unsub = subscribe(msg => {
      if (msg.type === 'state') { void apply(msg); return; }
      // The live book was edited (a card reworded, a style changed, a page inserted): repaint the
      // page in place. Same slide, so no transition — re-running IN/OUT for an unchanged slide is a
      // glitch on air.
      if (msg.type === 'book' && liveRef.current && msg.id === liveRef.current.bookId && !msg.deleted) {
        fetchBook(msg.id, msg.rev).then(b => {
          const live = liveRef.current;
          if (!b || !live || live.bookId !== b.id) return;
          bookRef.current = b;
          setOnAir({ book: b, page: live.page });
          setLayers(ls => ls.map(l => (l.exiting ? l : { ...layerModel(b, live.page, l.key), key: l.key })));
        });
      }
    });
    restore();
    const unre = onReconnect(restore);
    return () => { unsub(); unre(); };
  }, []);

  const onExited = (key: number) => setLayers(ls => ls.filter(l => l.key !== key));
  const scale = frame.w > 0 && frame.h > 0 ? Math.min(frame.w / VW, frame.h / VH) : 0;
  const w = scale * VW, h = scale * VH;
  return (
    <div ref={rootRef} className="relative w-full h-full overflow-hidden">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: w, height: h }}>
        {scale > 0 && layers.map(l => (
          <SlideLayer key={l.key} model={l} frameW={w} frameH={h} scale={scale} onExited={onExited} />
        ))}
        {scale > 0 && clip && (
          <ClipLayer key={clip.seq} video={clip.video} t0={clip.t0} t1={clip.t1} volume={clip.video.volume / 100}
            frameW={w} frameH={h} scale={scale} hold={clip.hold} frozen={clip.frozen} leave={clip.leaving} seq={clip.seq} role="lead"
            onEnd={clip.hold ? undefined : () => { const c = clipRef.current; if (c?.seq === clip.seq) { setClip({ ...c, ending: true }); clipDone(c); } }}
            onGone={() => { if (clipRef.current?.seq === clip.seq) setClip(null); }} />
        )}
        {scale > 0 && onAir && <CounterBar book={onAir.book} page={onAir.page} scale={scale} />}
      </div>
    </div>
  );
}
