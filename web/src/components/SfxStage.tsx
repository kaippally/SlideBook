import { useEffect, useRef } from 'react';
import { api, fetchBook, playSound, subscribe } from '../lib/api';
import { bookSound } from '../lib/bookModel';
import { resolveVideo } from '../lib/videoObject';
import type { Cursor, ServerState } from '../lib/types';

/**
 * The slide-change sound as an OBS source of its own (`/sfx`), so OBS gives it a fader apart from the
 * video. It draws nothing. While it is open, `/output` stays quiet and this plays the sound on the
 * same beats the output would: a step to a new page, or — before a card whose clip comes first — the
 * moment that card arrives.
 */
export function SfxStage() {
  const prevRef = useRef<Cursor | null>(null);
  const togetherRef = useRef(false);

  useEffect(() => {
    const beat = () => void api('/api/sfx', { method: 'POST', json: {} }).catch(() => {});
    beat();
    const id = setInterval(beat, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => subscribe(async msg => {
    // Keep the cached book current, so a changed sound or clip mode is heard on the next step.
    if (msg.type === 'book' && !msg.deleted) { void fetchBook(msg.id as string, msg.rev as string); return; }
    if (msg.type !== 'state') return;
    const s = msg as unknown as ServerState;
    const prev = prevRef.current, live = s.live;
    prevRef.current = live;
    if (!live || !prev || prev.bookId !== live.bookId || s.event === 'show') { togetherRef.current = false; return; }
    const book = await fetchBook(live.bookId);
    if (!book) return;
    const together = !!live.clip && !live.clip.hold && resolveVideo(book)?.mode === 'together';
    const wasTogether = togetherRef.current;
    togetherRef.current = together;
    const arrives = live.clip ? together && prev.page !== live.page   // together: the card comes with the clip
      : prev.page !== live.page || (!!prev.clip && !wasTogether);     // after: on the reveal
    const snd = bookSound(book);
    if (arrives && snd.url) playSound(snd.url, snd.volume / 100);
  }), []);

  return null;
}
