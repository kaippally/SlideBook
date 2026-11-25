import { DEFAULT_COUNTER, type CounterStyle } from './lib/counter';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BooksPanel } from './components/BooksPanel';
import { SlideCanvas } from './components/SlideCanvas';
import { AudioOutPicker } from './components/AudioOutPicker';
import { SlidesPanel } from './components/SlidesPanel';
import { ReportView, ReportsPanel } from './components/ReportsPanel';
import { getUiSetting, setUiSetting } from './lib/uiSettings';
import { ClipPanel } from './components/ClipPanel';
import { Inspector, type InspectorActions, type VideoActions } from './components/Inspector';
import type { StageObject } from './components/SlideCanvas';
import { resolveVideo, videoStyle, type VideoObjectStyle } from './lib/videoObject';
import { SettingsDialog, type Settings } from './components/SettingsDialog';
import { useSoundFx } from './lib/soundfx';
import { BotDialog, botNeedsSetup, useBotStatus } from './components/BotDialog';
import { Dialog, NoticeHost, askConfirm, attempt, notify } from './components/Dialog';
import { api, control, subscribe, useBook, useBooks, useServerState } from './lib/api';
import { fmtTime, resolveBookPage } from './lib/bookModel';
import { resolveCardStyle } from './lib/cardStyle';
import { aspectKey } from './components/slideCrop';
import type { Book, BookStyles, Card, PageEntry } from './lib/types';
import {
  PRESET_KEYS, resolveBorder, resolveHeadingStyle, resolvePage, resolvePresentation, resolveSlideSound, resolveSurface,
  type PresPose, type SlidePageStyle, type SlideState, type SlideSurface,
} from './components/slideStyles';

const CLIP_PREFIX = 'slidebook-pages:';

declare global { interface Window { pywebview?: { api: { open_window: (path: string, title: string, w?: number, h?: number) => void; pick_folder: (start?: string) => Promise<string> } } } }

export function openWindow(path: string, title: string, w = 1280, h = 760) {
  if (window.pywebview?.api) window.pywebview.api.open_window(path, title, w, h);
  else window.open(path, title.replace(/\W/g, ''), `width=${w},height=${h}`);
}

export function App() {
  const srv = useServerState();
  const books = useBooks();
  const viewId = srv.view?.bookId ?? null;
  const [book, setBook] = useBook(viewId);
  const page = book ? Math.max(1, Math.min(srv.view?.page ?? 1, book.manifest.length || 1)) : 1;
  const live = !!book && srv.live?.bookId === book.id;
  const [slideState, setSlideState] = useState<SlideState>('hold');
  const [stageSel, setStageSel] = useState<StageObject>('slide');
  const [leftTab, setLeftTab] = useState<'books' | 'slides' | 'reports'>(() => {
    const t = getUiSetting('leftTab');
    return t === 'books' || t === 'reports' ? t : 'slides';
  });
  useEffect(() => { setUiSetting('leftTab', leftTab); }, [leftTab]);
  const [reportId, setReportId] = useState<number | null>(null);
  const [sfxLib] = useSoundFx();
  const [rangeDraft, setRangeDraft] = useState<{ first: number; t0: number; t1: number } | null>(null);
  const [cue, setCue] = useState<{ t: number; n: number } | null>(null);
  const [replay, setReplay] = useState<{ n: number; k: number } | null>(null);
  // Edit arranges the slide and the video; Play shows the canvas as the audience will see it.
  const [canvasMode, setCanvasModeState] = useState<'edit' | 'play'>(() => (getUiSetting('canvasMode') === 'play' ? 'play' : 'edit'));
  const setCanvasMode = (m: 'edit' | 'play') => {
    setCanvasModeState(m);
    setUiSetting('canvasMode', m);
    if (m === 'play') { setSlideState('hold'); setStageSel('slide'); }
  };
  const [fetching, setFetching] = useState<string | null>(null);
  useEffect(() => subscribe(msg => {
    if (msg.type === 'state' && msg.replay) {
      const v = msg.view as { page: number } | null;
      if (v) setReplay(r => ({ n: v.page, k: (r?.k ?? 0) + 1 }));
    }
    if (msg.type === 'cue' && msg.bookId === bookRef.current?.id) setCue(c => ({ t: msg.t as number, n: (c?.n ?? 0) + 1 }));
    if (msg.type === 'videoFetch') {
      setFetching(msg.status === 'running' ? (msg.bookId as string) : null);
      if (msg.status === 'failed') notify(`Could not fetch the video: ${msg.error}`, 'error');
      if (msg.status === 'done') notify('The video is ready on the canvas');
    }
  }), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null);
  const botStatus = useBotStatus();
  const [botOpen, setBotOpen] = useState(false);
  const [botDismissed, setBotDismissed] = useState('');
  const botKey = botStatus ? `${botStatus.studiomate}|${botStatus.own}|${botStatus.ownError}` : '';
  useEffect(() => { if (botNeedsSetup(botStatus) && botKey !== botDismissed && !settingsOpen) setBotOpen(true); }, [botStatus, botKey, botDismissed, settingsOpen]);

  useEffect(() => { api<Settings>('/api/settings').then(s => { setSettings(s); if (!s.hasGeminiKey) setSettingsOpen(true); }).catch(() => {}); }, []);
  useEffect(() => { setStageSel('slide'); }, [viewId]);

  // ── writes: optimistic locally, coalesced to the server ─────────────────────
  const bookRef = useRef<Book | null>(book); bookRef.current = book;
  const stylesTimer = useRef<{ id: string; t: ReturnType<typeof setTimeout>; styles: BookStyles } | null>(null);
  const flushStyles = useCallback(() => {
    const p = stylesTimer.current;
    if (!p) return;
    clearTimeout(p.t); stylesTimer.current = null;
    void attempt(api(`/api/books/${p.id}`, { method: 'PATCH', json: { styles: p.styles } }), 'Save');
  }, []);
  useEffect(() => flushStyles, [viewId, flushStyles]);

  const mutateStyles = (fn: (s: BookStyles) => BookStyles) => {
    const b = bookRef.current;
    if (!b) return;
    const styles = fn(b.styles ?? {});
    const next = { ...b, styles, updatedAt: Date.now() / 1000 + 5 };
    bookRef.current = next;
    setBook(next);
    if (stylesTimer.current && stylesTimer.current.id !== b.id) flushStyles();
    if (stylesTimer.current) clearTimeout(stylesTimer.current.t);
    stylesTimer.current = { id: b.id, styles, t: setTimeout(flushStyles, 300) };
  };

  const cardTimers = useRef(new Map<string, { t: ReturnType<typeof setTimeout>; body: any }>());
  const patchPage = (pid: string, body: any, immediate = false) => {
    const b = bookRef.current;
    if (!b) return;
    const key = `${b.id}:${pid}`;
    const prev = cardTimers.current.get(key);
    if (prev) clearTimeout(prev.t);
    const merged = { ...(prev?.body ?? {}), ...body, card: body.card ? { ...(prev?.body?.card ?? {}), ...body.card } : prev?.body?.card };
    if (!merged.card) delete merged.card;
    const send = () => { cardTimers.current.delete(key); void attempt(api(`/api/books/${b.id}/pages/${pid}`, { method: 'PATCH', json: merged }), 'Save page'); };
    if (immediate) { send(); return; }
    cardTimers.current.set(key, { body: merged, t: setTimeout(send, 400) });
  };

  const current = book?.manifest[page - 1];
  const r = book && current ? resolveBookPage(book, page) : null;

  const changePose = (patch: Partial<PresPose>) => mutateStyles(cur => {
    const pres = resolvePresentation(cur.presentation);
    const locks = cur.poseLocks ?? {};
    const held: Partial<PresPose> = {}, local: Partial<PresPose> = {};
    for (const k of Object.keys(patch) as (keyof PresPose)[]) ((locks as any)[k] ? held : local)[k] = patch[k] as never;
    const next = { in: { ...pres.in, ...held }, hold: { ...pres.hold, ...held }, out: { ...pres.out, ...held } };
    next[slideState] = { ...next[slideState], ...local };
    return { ...cur, presentation: { ...pres, ...next } };
  });

  const changeOverride = (patch: Partial<SlidePageStyle>) => {
    if (!r) return;
    const key = aspectKey(r.aspect);
    mutateStyles(cur => ({ ...cur, overrides: { ...(cur.overrides ?? {}), [key]: { ...(cur.overrides?.[key] ?? {}), ...patch } } }));
  };

  // Canvas drag and the pose sliders: the book's poses, or — with "This size" on — this size's own pose.
  const onSlidePose = (patch: Partial<PresPose>) => {
    if (!r?.pageStyle.posOverride) { changePose(patch); return; }
    const raw = r.rawPres[slideState];
    const pp: Partial<SlidePageStyle> = {};
    for (const k of Object.keys(patch) as (keyof PresPose)[]) {
      const v = patch[k] as number;
      if (k === 'x') pp.posX = Math.round(v - raw.x);
      else if (k === 'y') pp.posY = Math.round(v - raw.y);
      else if (k === 'z') pp.posZ = Math.round(v - raw.z);
      else if (k === 'scale') pp.posScale = raw.scale ? v / raw.scale : v;
      else if (k === 'rotateX') pp.posRotateX = Math.round(v - raw.rotateX);
      else if (k === 'rotateY') pp.posRotateY = Math.round(v - raw.rotateY);
      else if (k === 'perspective') pp.posPerspective = Math.round(v);
      else if (k === 'opacity') pp.posOpacity = Math.round(v - raw.opacity);
    }
    changeOverride(pp);
  };

  // The video object's own styles (`styles.video`): its poses, its surface and its slab and shadow.
  const mutateVideo = (fn: (v: VideoObjectStyle) => VideoObjectStyle) =>
    mutateStyles(cur => ({ ...cur, video: fn((cur as { video?: VideoObjectStyle }).video ?? {}) }));
  const onVideoPose = (patch: Partial<PresPose>) => mutateVideo(v => {
    const pres = resolveVideo(bookRef.current)!.pres;
    const locks = v.locks ?? {};
    const held: Partial<PresPose> = {}, local: Partial<PresPose> = {};
    for (const k of Object.keys(patch) as (keyof PresPose)[]) ((locks as any)[k] ? held : local)[k] = patch[k] as never;
    const next = { in: { ...pres.in, ...held }, hold: { ...pres.hold, ...held }, out: { ...pres.out, ...held } };
    next[slideState] = { ...next[slideState], ...local };
    return { ...v, presentation: { ...pres, ...next } };
  });
  const onVideoSurface = (patch: Partial<SlideSurface>) =>
    mutateVideo(v => ({ ...v, surface: { ...resolveSurface(v.surface ?? bookRef.current?.styles?.surface), ...patch } }));
  const videoActions: VideoActions = {
    onVideo: patch => mutateVideo(v => ({ ...v, ...patch })),
    onPose: onVideoPose,
    onToggleLock: key => mutateVideo(v => {
      const locks = { ...(v.locks ?? {}) };
      const enabling = !locks[key]; locks[key] = enabling;
      if (!enabling) return { ...v, locks };
      const pres = resolveVideo(bookRef.current)!.pres; const val = pres[slideState][key];
      return { ...v, locks, presentation: { ...pres, in: { ...pres.in, [key]: val }, hold: { ...pres.hold, [key]: val }, out: { ...pres.out, [key]: val } } };
    }),
    onTransition: patch => mutateVideo(v => ({ ...v, presentation: { ...resolveVideo(bookRef.current)!.pres, ...patch } })),
    onPage: patch => mutateVideo(v => ({ ...v, page: { ...(v.page ?? {}), ...patch } })),
    onSurface: onVideoSurface,
    onFetch: () => { if (book) { setFetching(book.id); void attempt(api(`/api/books/${book.id}/video/fetch`, { method: 'POST' }), 'Fetch video'); } },
  };

  const actions: InspectorActions = {
    onCard: (patch: Partial<Card>, kind) => {
      const b = bookRef.current;
      if (!b || !current?.card) return;
      const manifest = b.manifest.map(p => (p.id === current.id ? { ...p, kind: kind ?? p.kind, card: { ...p.card!, ...patch } } : p));
      const next = { ...b, manifest, updatedAt: Date.now() / 1000 + 5 };
      bookRef.current = next; setBook(next);
      patchPage(current.id, { card: patch, ...(kind ? { kind } : {}) });
    },
    onPageCard: (p, patch) => {
      const b = bookRef.current;
      if (!b || !p.card) return;
      const next = { ...b, manifest: b.manifest.map(x => (x.id === p.id ? { ...x, card: { ...x.card!, ...patch } } : x)), updatedAt: Date.now() / 1000 + 5 };
      bookRef.current = next; setBook(next);
      patchPage(p.id, { card: patch }, true);
    },
    onBorder: patch => mutateStyles(cur => ({ ...cur, border: { ...resolveBorder(cur.border), ...patch } })),
    onCardStyle: patch => mutateStyles(cur => ({ ...cur, card: { ...resolveCardStyle(cur.card), ...patch } })),
    onCounter: patch => mutateStyles(cur => ({ ...cur, counter: { ...DEFAULT_COUNTER, ...((cur as { counter?: Partial<CounterStyle> }).counter ?? {}), ...patch } })),
    onPose: onSlidePose,
    onToggleLock: key => mutateStyles(cur => {
      const locks = { ...(cur.poseLocks ?? {}) };
      const enabling = !locks[key]; locks[key] = enabling;
      if (!enabling) return { ...cur, poseLocks: locks };
      const pres = resolvePresentation(cur.presentation); const v = pres[slideState][key];
      return { ...cur, poseLocks: locks, presentation: { ...pres, in: { ...pres.in, [key]: v }, hold: { ...pres.hold, [key]: v }, out: { ...pres.out, [key]: v } } };
    }),
    onTransition: patch => mutateStyles(cur => ({ ...cur, presentation: { ...resolvePresentation(cur.presentation), ...patch } })),
    onPage: patch => { if (current) mutateStyles(cur => ({ ...cur, pages: { ...(cur.pages ?? {}), [current.id]: { ...resolvePage(cur.pages?.[current.id]), ...patch } } })); },
    onOverride: changeOverride,
    onAlign: side => mutateStyles(cur => { const align = cur.align === side ? undefined : side; return align ? { ...cur, align, overrides: {} } : { ...cur, align }; }),
    onAlignPad: pad => mutateStyles(cur => ({ ...cur, alignPad: pad })),
    onSound: patch => mutateStyles(cur => ({ ...cur, sound: { ...resolveSlideSound(cur.sound), ...patch } })),
    onHeadingStyle: patch => mutateStyles(cur => ({ ...cur, heading: { ...resolveHeadingStyle(cur.heading), ...patch } })),
    onHeading: patch => {
      if (!current) return;
      mutateStyles(cur => {
        const next = { text: '', ...(cur.headings?.[current.id] ?? {}), ...patch };
        const headings = { ...(cur.headings ?? {}) };
        if (!next.text.trim() && !next.carry) delete headings[current.id]; else headings[current.id] = next;
        return { ...cur, headings };
      });
    },
    onSurface: patch => mutateStyles(cur => ({ ...cur, surface: { ...resolveSurface(cur.surface), ...patch } })),
    onApplyAll: () => {
      const b = bookRef.current;
      if (!b || !current) return;
      mutateStyles(cur => {
        const s = resolvePage(cur.pages?.[current.id]);
        const one = { thickness: s.thickness, shadowBlur: s.shadowBlur, shadowX: s.shadowX, shadowY: s.shadowY, shadowColor: s.shadowColor };
        const pages: Record<string, Partial<SlidePageStyle>> = {};
        for (const p of b.manifest) pages[p.id] = { ...(cur.pages?.[p.id] ?? {}), ...one };
        return { ...cur, pages };
      });
    },
    onNote: html => { if (current) mutateStyles(cur => ({ ...cur, notes: { ...(cur.notes ?? {}), [current.id]: html } })); },
    onBook: patch => { if (book) void attempt(api(`/api/books/${book.id}`, { method: 'PATCH', json: patch }).then(setBook), 'Save book'); },
    onSfx: next => mutateStyles(cur => ({ ...cur, sfx: next })),
    onSaveCardLook: () => {
      const b = bookRef.current;
      if (!b) return;
      const cardLook = { card: b.styles?.card ?? null, border: b.styles?.border ?? null };
      void attempt(api<Settings>('/api/settings', { method: 'PUT', json: { cardLook } }), 'Save card look').then(v => { if (v) { setSettings(v); notify('Card look saved as the default'); } });
    },
    onRecallCardLook: settings?.cardLook ? () => {
      const d = settings.cardLook!;
      mutateStyles(cur => ({ ...cur, card: (d.card ?? undefined) as BookStyles['card'], border: (d.border ?? undefined) as BookStyles['border'] }));
    } : null,
    onSaveDefault: () => {
      if (!book) return;
      const s: any = {};
      for (const k of [...PRESET_KEYS, 'card'] as string[]) if ((book.styles as any)[k] !== undefined) s[k] = (book.styles as any)[k];
      void attempt(api('/api/settings', { method: 'PUT', json: { defaultStyles: s } }), 'Save default').then(v => v && notify('New books will start with this look'));
    },
    // The OBS output only plays a clip on the LIVE book's goto — the old /api/cue reached the editor
    // canvas alone, which is muted whenever the book is live.
    onPlayCard: async p => {
      const b = bookRef.current;
      const n = b ? b.manifest.findIndex(x => x.id === p.id) + 1 : 0;
      if (!b || !n) return;
      if (!live) await control('air', b.id, n);
      setCanvasMode('play');
      await control('goto', b.id, n, { replay: true });
    },
  };

  const hasVideo = !!book?.source?.video;
  const openVideo = () => openWindow('/video', 'SlideBook Navigator', 440, 820);

  // ── navigation: a command, never a local move ───────────────────────────────
  // Edit steps straight between pages; Play (and OBS, Telegram) stop on each segment's clip.
  const editRef = useRef(canvasMode === 'edit'); editRef.current = canvasMode === 'edit';
  const step = useCallback((dir: 1 | -1) => { if (bookRef.current) void control(dir > 0 ? 'next' : 'prev', bookRef.current.id, undefined, { edit: editRef.current }); }, []);
  const goto = (n: number) => { if (book) void control('goto', book.id, n, { edit: editRef.current }); };

  // ── page operations ─────────────────────────────────────────────────────────
  const addFiles = async (files: File[]) => {
    if (!book) return;
    const fd = new FormData();
    fd.append('afterIndex', String(page));
    for (const f of files) fd.append('file', f, f.name);
    notify(`Adding ${files.length} file${files.length > 1 ? 's' : ''}…`);
    const res = await attempt(api<{ book: Book; added: number }>(`/api/books/${book.id}/pages/files`, { method: 'POST', body: fd }), 'Add files');
    if (res) { setBook(res.book); void control('goto', book.id, page + 1); }
  };
  const addCard = async (kind: 'claim' | 'fallacy') => {
    if (!book) return;
    const res = await attempt(api<{ book: Book }>(`/api/books/${book.id}/pages/card`, { method: 'POST', json: { kind, afterIndex: book.manifest.length ? page : 0, card: { title: kind === 'claim' ? 'New claim' : 'New fallacy', body: '' } } }), 'Add card');
    if (res) { setBook(res.book); void control('goto', book.id, book.manifest.length ? page + 1 : 1); }
  };
  const doDelete = async (ids: string[]) => {
    if (!book) return;
    const res = await attempt(api<Book>(`/api/books/${book.id}/pages/delete`, { method: 'POST', json: { pageIds: ids } }), 'Delete');
    if (res) setBook(res);
  };
  const copyPages = (ids: string[]) => {
    if (!book || !ids.length) return;
    void navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify({ bookId: book.id, pageIds: ids }));
    notify(`Copied ${ids.length} page${ids.length > 1 ? 's' : ''}`);
  };
  const paste = async () => {
    if (!book) return;
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find(t => t.startsWith('image/'));
        if (img) { const blob = await it.getType(img); await addFiles([new File([blob], `pasted.${img.split('/')[1]}`, { type: img })]); return; }
        if (it.types.includes('text/plain')) {
          const text = await (await it.getType('text/plain')).text();
          if (text.startsWith(CLIP_PREFIX)) {
            const { bookId, pageIds } = JSON.parse(text.slice(CLIP_PREFIX.length));
            const res = await attempt(api<Book>(`/api/books/${book.id}/pages/copy`, { method: 'POST', json: { fromBookId: bookId, pageIds, afterIndex: page } }), 'Paste');
            if (res) setBook(res);
            return;
          }
        }
      }
      notify('Nothing to paste — copy pages or an image first');
    } catch { notify('Clipboard not readable — use Ctrl+V', 'error'); }
  };

  // ── keys ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };
    const key = (e: KeyboardEvent) => {
      if (typing(e.target) || document.querySelector('.fixed.inset-0')) return;
      const k = e.code;
      if (['Numpad4', 'PageUp', 'ArrowLeft'].includes(k) || (k === 'Space' && e.shiftKey)) { e.preventDefault(); step(-1); }
      else if (['Numpad5', 'Numpad6', 'PageDown', 'ArrowRight'].includes(k) || (k === 'Space' && !e.shiftKey)) { e.preventDefault(); step(1); }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target) || !bookRef.current) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (files.length) { e.preventDefault(); void addFiles(files); }
      else if (text.startsWith(CLIP_PREFIX)) { e.preventDefault(); void paste(); }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('paste', onPaste); };
  });

  return (
    <div className="app-body h-full flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <div className="w-[300px] shrink-0 min-h-0 flex flex-col border-r border-slate-800">
          <div className="flex border-b border-slate-800 bg-[#0b0d10]">
            {(['books', 'slides', 'reports'] as const).map(t => (
              <button key={t} onClick={() => setLeftTab(t)} disabled={t === 'slides' && !book}
                className={`flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide disabled:opacity-30 ${leftTab === t ? 'text-white border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>
                {t === 'books' ? 'Book' : t === 'slides' ? 'Slides' : 'Reports'}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {leftTab === 'reports'
              ? <ReportsPanel selected={reportId} onSelect={setReportId} />
              : leftTab === 'slides' && book
              ? <SlidesPanel book={book} rangeDraft={rangeDraft} view={page} live={live ? srv.live!.page : null} onGoto={goto}
                  onSegment={n => { setCanvasMode('play'); void control('goto', book.id, n, { replay: true }); }}
                  onJoin={(p, t) => actions.onPageCard(p, { t })} onHide={p => patchPage(p.id, { hidden: !p.hidden }, true)}
                  onAddFiles={files => void addFiles(files)} onAddCard={k => void addCard(k)}
                  onUntime={async (pages, t) => {
                    const n = pages.length;
                    if (!await askConfirm(`Remove the ${fmtTime(t)} time slot?`, `Its ${n} slide${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} in the book; ${n === 1 ? 'it' : 'they'} no longer play${n === 1 ? 's' : ''} that video clip.`, { label: 'Remove time' })) return;
                    const ranges = { ...(videoStyle(bookRef.current).ranges ?? {}) };
                    const keyed = pages.find(p => p.card?.t != null);
                    for (const p of pages) {
                      if (p.card) { actions.onPageCard(p, { t: null, tEnd: null } as unknown as Partial<Card>); continue; }
                      const b = bookRef.current;
                      if (!b || p.t == null) continue;
                      const next = { ...b, manifest: b.manifest.map(x => (x.id === p.id ? { ...x, t: undefined } : x)), updatedAt: Date.now() / 1000 + 5 };
                      bookRef.current = next; setBook(next);
                      patchPage(p.id, { t: null }, true);
                    }
                    if (keyed && ranges[keyed.id]) { delete ranges[keyed.id]; videoActions.onVideo({ ranges }); }
                  }}
                  onTime={(p, t) => actions.onPageCard(p, { t, tEnd: t + 8 })}
                  onReorder={async (from, to, card) => {
                    if (to !== from) {
                      const b = await attempt(api<Book>(`/api/books/${book.id}/pages/reorder`, { method: 'POST', json: { from, to } }), 'Move slide');
                      if (!b) return;
                      bookRef.current = b; setBook(b);
                    }
                    // After the move lands, so the reorder's response cannot overwrite the new time.
                    if (card) actions.onPageCard(card.p, { t: card.t, tEnd: card.tEnd });
                  }}
                  onAddVideoLink={url => void attempt(api(`/api/books/${book.id}/pages/video`, { method: 'POST', json: { url } }), 'Add video').then(r => r && notify('Fetching the video: it lands at the end of the book'))} onPaste={() => void paste()}
                  onCopy={p => copyPages([p.id])} onDelete={p => setConfirmDel([p.id])}
                  onHideMany={(pages, hidden) => {
                    const b = bookRef.current;
                    if (!b) return;
                    const ids = new Set(pages.map(p => p.id));
                    const next = { ...b, manifest: b.manifest.map(p => (ids.has(p.id) ? { ...p, hidden } : p)), updatedAt: Date.now() / 1000 + 5 };
                    bookRef.current = next; setBook(next);
                    for (const p of pages) patchPage(p.id, { hidden }, true);
                  }}
                  onDeleteMany={pages => setConfirmDel(pages.map(p => p.id))} />
              : <BooksPanel books={books} viewId={viewId} liveId={srv.live?.bookId ?? null}
                  stances={settings?.critique.stances ?? []} activeStance={settings?.critique.activeId ?? 'neutral'}
                  onOpen={id => { void control('select', id); setLeftTab('slides'); }} onSettings={() => setSettingsOpen(true)} />}
          </div>
        </div>
        <div className="relative flex-1 min-w-0 min-h-0 flex flex-col bg-[#08090c]">
          {leftTab === 'reports' && (reportId
            ? <ReportView runId={reportId} />
            : <div className="absolute inset-0 z-20 grid place-items-center bg-[#08090c] text-[12px] text-slate-500">Pick a report on the left, or write a new one.</div>)}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-[12px]">
            <span className="font-semibold text-slate-100 truncate">{book?.title ?? 'No book open'}</span>
            {book?.source?.url && <span className="text-slate-500 truncate" title={book.source.url}>· {book.source.claims ?? 0} claims · {book.source.fallacies ?? 0} fallacies</span>}
            <div className="ml-auto flex items-center gap-1.5">
              {srv.live && !live && <span className="text-[11px] text-emerald-300">On air: {books.find(b => b.id === srv.live!.bookId)?.title ?? '…'} p{srv.live.page}</span>}
              {srv.live && <button onClick={() => void control('unair')} className="px-2 py-0.5 rounded border border-slate-700 text-[11px] text-slate-300 hover:border-slate-500">Take off air</button>}
              <AudioOutPicker />
              <button onClick={() => openWindow('/videos', 'SlideBook Videos', 1400, 900)} className="px-2 py-0.5 rounded border border-slate-700 text-[11px] text-slate-300 hover:border-slate-500" title="Videos sent by Telegram: pick a range, then fact-check, summarise, make a short or save a clip">Videos</button>
              <button onClick={openVideo} className="px-2 py-0.5 rounded border border-slate-700 text-[11px] text-slate-300 hover:border-slate-500" title="The cards and the transcript in a separate window — click to go to a card or play a moment on the canvas">Navigator</button>
              <button onClick={() => openWindow('/output', 'SlideBook Output', 960, 560)} className="px-2 py-0.5 rounded border border-slate-700 text-[11px] text-slate-300 hover:border-slate-500" title="Preview what OBS shows">Output</button>
            </div>
          </div>
          <SlideCanvas
            book={book} page={page} state={slideState} onState={setSlideState}
            onPoseChange={onSlidePose} onSurfaceChange={actions.onSurface}
            onVideoPose={onVideoPose} onVideoSurface={onVideoSurface} selected={stageSel} onSelect={setStageSel} onVideo={videoActions.onVideo} replay={replay} mode={canvasMode} onMode={setCanvasMode}
            stop={srv.view?.bookId === book?.id && srv.view?.clip?.hold ? srv.view.clip : null}
            noClip={srv.action === 'prev'} cue={cue}
            plain={!!srv.plain} onPlain={on => void api('/api/plain', { method: 'POST', json: { on } })}
            live={live} onToggleLive={() => book && void control(live ? 'unair' : 'air', book.id)}
            onStep={step}
          />
          {book && resolveVideo(book) && (
            <ClipPanel book={book} page={page} video={resolveVideo(book)!}
              atClip={!!(srv.view?.bookId === book.id && srv.view?.clip?.hold)}
              onDraft={setRangeDraft}
              sfxLib={sfxLib} onSfx={actions.onSfx}
              onRange={(id, range) => mutateVideo(v => {
                const ranges = { ...(v.ranges ?? {}) };
                if (range) ranges[id] = range; else delete ranges[id];
                return { ...v, ranges };
              })}
              onTransport={action => void api('/api/transport', { method: 'POST', json: { bookId: book.id, action } })}
              onSeek={t => void api('/api/transport', { method: 'POST', json: { bookId: book.id, action: 'seek', t } })}
              onSegment={n => { setCanvasMode('play'); void control('goto', book.id, n, { replay: true }); }}
              onCue={t => void api('/api/cue', { method: 'POST', json: { bookId: book.id, t } })} />
          )}
        </div>
        <Inspector book={book} page={page} state={slideState} onState={setSlideState} a={actions} hasVideo={hasVideo}
          stage={book?.source?.video && canvasMode === 'edit' ? stageSel : 'slide'} va={videoActions} fetching={fetching === book?.id} />
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={setSettings} bot={botStatus} onBot={() => setBotOpen(true)} />}
      {botOpen && <BotDialog status={botStatus} onClose={() => { setBotOpen(false); setBotDismissed(botKey); }} />}
      {confirmDel && book && (
        <Dialog title={`Delete ${confirmDel.length} page${confirmDel.length > 1 ? 's' : ''}?`} danger acceptLabel="Delete"
          onClose={() => setConfirmDel(null)} onAccept={() => { void doDelete(confirmDel); setConfirmDel(null); }}>
          <ul className="list-disc pl-5 max-h-60 overflow-auto">
            {book.manifest.filter(p => confirmDel.includes(p.id)).map(p => (
              <li key={p.id}>{book.manifest.indexOf(p) + 1}. {p.card ? p.card.title.replace(/<[^>]+>/g, '') : p.label || p.kind}</li>
            ))}
          </ul>
          <p className="mt-2 text-slate-500">This cannot be undone.</p>
        </Dialog>
      )}
      <NoticeHost />
    </div>
  );
}
