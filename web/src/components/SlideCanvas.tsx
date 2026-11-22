import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlideLayer, type SlideLayerModel } from './SlideLayer';
import { SlidePoseView } from './SlidePoseView';
import { SlideObject } from './SlideObject';
import { ClipLayer } from './ClipLayer';
import { PerspectiveGrid } from './PerspectiveGrid';
import { cropLayout } from './slideCrop';
import { tumbleRotation } from '../lib/tumble';
import { playSound } from '../lib/api';
import { bookSound, layerModel, resolveBookPage } from '../lib/bookModel';
import { clipForStep, clipSrc, posterUrl, resolveVideo, type VideoObjectStyle } from '../lib/videoObject';
import type { Book } from '../lib/types';
import {
  bounceAnimation, bounceKeyframes, cubicBezier, presentationOpacity, presentationPerspectivePx, presentationTransform,
  tweenForTarget, DEFAULT_SURFACE_Y, type PresPose, type SlideState, type SlideSurface, type SlidePresentationStyle,
} from './slideStyles';

const VW = 1920, VH = 1080;

export type StageObject = 'slide' | 'video';

const stablePersp = (p: SlidePresentationStyle, k: number) =>
  Math.max(presentationPerspectivePx(p.in, k) ?? 0, presentationPerspectivePx(p.hold, k) ?? 0, presentationPerspectivePx(p.out, k) ?? 0);

/**
 * The interactive stage: the current page and the book's video object, each at the selected keyframe
 * pose (IN / HOLD / OUT). Click one to select it — the inspector follows — then drag to move, Ctrl+drag
 * to tumble, Shift+wheel for depth, the surface line to drag. A page change plays the same sequence the
 * output plays: the two-layer step, and before a timed fact-check or fallacy card, its clip.
 */
export function SlideCanvas({ book, page, state, onState, onPoseChange, onSurfaceChange, onVideoPose, onVideoSurface, selected, onSelect, onVideo, replay, stop, mode, onMode,
  live, noClip, cue, onToggleLive, onStep, onEditCard }: {
  /** Change the video object's settings (clip mode, blur) from the toolbar. */
  onVideo: (patch: Partial<VideoObjectStyle>) => void;
  /** A segment's timestamp was clicked: page `n` plays its segment clip, whatever it was stepped from. */
  replay: { n: number; k: number } | null;
  /** "Card after video": the clip stop the server has parked this page on, or null. */
  stop: { t0: number; t1: number; seq: number; frozen?: boolean } | null;
  mode: 'edit' | 'play';
  onMode: (m: 'edit' | 'play') => void;
  book: Book | null;
  page: number;
  state: SlideState;
  onState: (s: SlideState) => void;
  onPoseChange: (patch: Partial<PresPose>) => void;
  onSurfaceChange: (patch: Partial<SlideSurface>) => void;
  onVideoPose: (patch: Partial<PresPose>) => void;
  onVideoSurface: (patch: Partial<SlideSurface>) => void;
  selected: StageObject;
  onSelect: (o: StageObject) => void;
  live: boolean;
  /** The step that brought this page was a Prev: no clip, as on air. */
  noClip: boolean;
  /** A moment picked in the navigator window: play the video object from there. */
  cue: { t: number; n: number } | null;
  onToggleLive: () => void;
  onStep: (dir: 1 | -1) => void;
  onEditCard?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const [showGrid, setShowGrid] = useState(false);
  const [plain, setPlain] = useState(false);
  const [tween, setTween] = useState<{ ms: number; ease: number[] } | null>(null);
  const [trans, setTrans] = useState<{ out?: SlideLayerModel; in?: SlideLayerModel; key: number } | null>(null);
  const [goToken, setGoToken] = useState(-1);
  // `hold`: a "Card after video" clip stop (the server's `view.clip`) — it stays frozen at its end until
  // the next step; `leave` sends it off; `frozen`: shown on its last frame, not played again.
  const [clipRun, setClipRun] = useState<{ t0: number; t1: number; key: number; card: boolean; hold?: boolean; frozen?: boolean; leave?: boolean; seq?: number } | null>(null);
  const prevRef = useRef<{ bookId: string | null; page: number; stopSeq: number | null }>({ bookId: book?.id ?? null, page, stopSeq: stop?.seq ?? null });
  const tokenRef = useRef(0);

  const count = book?.manifest.length ?? 0;
  const r = book && count ? resolveBookPage(book, Math.min(page, count)) : null;
  const pres = r?.pres;
  // PLAY is what the audience sees: the slide at rest, the video only while its clip plays, nothing to
  // grab. EDIT is for arranging: both objects, their keyframe poses, the surface line.
  const play = mode === 'play';
  const poseState: SlideState = play ? 'hold' : state;
  const pose: PresPose | null = pres ? pres[poseState] : null;
  const video = resolveVideo(book);
  const vPose: PresPose | null = video ? video.pres[poseState] : null;
  const pageClip = book && r ? clipForStep(book, Math.min(page, count), null) : null;
  // Edit: the video object is drawn where it has something to say — on a page that plays a clip, or
  // while it is the thing being edited.
  const showVideo = !play && !!video && (selected === 'video' || !!pageClip);
  const sel: StageObject = !play && selected === 'video' && video ? 'video' : 'slide';

  const poseRef = useRef(pose); poseRef.current = sel === 'video' ? vPose : pose;
  const changeRef = useRef(onPoseChange); changeRef.current = sel === 'video' ? onVideoPose : onPoseChange;
  const surfRef = useRef(onSurfaceChange); surfRef.current = sel === 'video' ? onVideoSurface : onSurfaceChange;
  const presRef = useRef(pres); presRef.current = pres;
  const playRef = useRef(play); playRef.current = play;

  useLayoutEffect(() => {
    const p = presRef.current;
    if (!p) return;
    const t = tweenForTarget(p, state);
    if (t.ms > 0) { setTween(t); const id = setTimeout(() => setTween(null), t.ms); return () => clearTimeout(id); }
    setTween(null);
  }, [state]);

  useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(e => {
      const c = e[0]?.contentRect;
      if (!c || c.width <= 0 || c.height <= 0) return;
      setScale(Math.min(c.width, c.height * (VW / VH)) / VW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A page step inside the same book previews the transition (outgoing HOLD→OUT, incoming IN→HOLD).
  // A step into a new time segment plays its clip, as on air. A clicked timestamp (`replay`) plays the
  // segment's clip even from inside it, or on the page already open.
  const replayDone = useRef(replay?.k ?? 0);
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { bookId: book?.id ?? null, page, stopSeq: stop?.seq ?? null };
    const force = !!replay && replay.k !== replayDone.current && replay.n === page;
    if (force) replayDone.current = replay!.k;
    if (!book || !count || prev.bookId !== book.id || prev.page > count) return;
    const after = play && resolveVideo(book)?.mode !== 'together';

    // "Card after video": the server decides the clip stops (`stop`); the canvas plays what it says.
    if (after) {
      const enter = !!stop && stop.seq !== prev.stopSeq;
      const leave = !stop && prev.stopSeq != null;
      if (prev.page === page && !enter && !leave) return;
      const token = ++tokenRef.current;
      onState('hold');
      if (enter) {
        // The card on screen leaves; the clip comes in, plays, and waits frozen at its end.
        if (prev.stopSeq == null) setTrans({ out: layerModel(book, prev.page, token * 2, true, page < prev.page), key: token });
        else setTrans(null);
        setClipRun({ t0: stop!.t0, t1: stop!.t1, key: token, card: false, hold: true, frozen: !!stop!.frozen, seq: stop!.seq });
        return;
      }
      const snd = bookSound(book);
      if (snd.url) playSound(snd.url, snd.volume / 100);
      if (leave) {
        // The step after a clip: the video leaves, the card it was about comes in.
        setClipRun(c => (c ? { ...c, leave: true } : c));
        setTrans({ in: layerModel(book, page, token * 2 + 1, false, page < prev.page), key: token });
        return;
      }
      setClipRun(null);
      setTrans({ out: layerModel(book, prev.page, token * 2, true, page < prev.page), in: layerModel(book, page, token * 2 + 1, false, page < prev.page), key: token });
      const fb = setTimeout(() => setGoToken(token), 1500);
      return () => clearTimeout(fb);
    }

    if (prev.page === page && !force) return;
    const snd = bookSound(book);
    if (snd.url) playSound(snd.url, snd.volume / 100);
    const token = ++tokenRef.current;
    const reverse = page < prev.page;
    // Edit steps straight between pages; clips belong to Play (and ▶ Clip).
    const clip = !play || (noClip && !force) ? null : clipForStep(book, page, force ? null : prev.page);
    onState('hold');
    const together = resolveVideo(book)?.mode === 'together';
    // Replaying the open card's own segment "together": the card stays up, the clip plays beside it.
    if (clip && together && prev.page === page) { setClipRun({ ...clip, key: token, card: false }); return; }
    if (clip && !together) {
      setTrans({ out: layerModel(book, prev.page, token * 2, true, reverse), key: token });
      setClipRun({ ...clip, key: token, card: true });
      return;
    }
    // Together: the usual step, with the clip playing beside the card.
    setClipRun(clip ? { ...clip, key: token, card: false } : null);
    setTrans({ out: layerModel(book, prev.page, token * 2, true, reverse), in: layerModel(book, page, token * 2 + 1, false, reverse), key: token });
    const p = resolveBookPage(book, page).pres;
    const fb = setTimeout(() => setGoToken(token), 1500);
    const safety = setTimeout(() => setTrans(t => (t && t.key === token ? null : t)), 3000 + Math.max(p.showDuration, p.hideDuration));
    return () => { clearTimeout(fb); clearTimeout(safety); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, book?.id, replay?.k, stop?.seq]);

  useEffect(() => { setTrans(null); setGoToken(-1); setClipRun(null); }, [book?.id]);
  // The clip stop's range was edited: the same clip carries on to its new end, never restarts.
  useEffect(() => {
    if (!stop) return;
    setClipRun(c => (c && c.seq === stop.seq && (c.t0 !== stop.t0 || c.t1 !== stop.t1) ? { ...c, t0: stop.t0, t1: stop.t1 } : c));
  }, [stop?.seq, stop?.t0, stop?.t1]);

  // The navigator window picked a moment: play twenty seconds of the video object from there.
  useEffect(() => {
    if (!cue || !video) return;
    setClipRun({ t0: cue.t, t1: cue.t + 20, key: ++tokenRef.current, card: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.n]);

  // The clip has played: the card arrives while the video leaves.
  const onClipEnd = (run: NonNullable<typeof clipRun>) => {
    if (!book || !run.card) return;
    const token = ++tokenRef.current;
    setTrans({ in: layerModel(book, page, token * 2 + 1), key: token });
    // From here the card is the step's to show; the video only has to leave.
    setClipRun(c => (c && c.key === run.key ? { ...c, card: false } : c));
  };

  // Drag = move, Ctrl+drag = tumble (decided at mousedown, by what is under the cursor).
  const dragRef = useRef<{ mode: 'move' | 'rotate'; sx: number; sy: number; x: number; y: number; rx: number; ry: number } | null>(null);
  const surfaceDrag = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (surfaceDrag.current) {
        const rect = stageRef.current?.getBoundingClientRect();
        if (rect && rect.height > 0) surfRef.current({ reflectionSurfaceY: Math.round(Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) * 1000) / 1000 });
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'rotate') {
        const { rotX, rotY } = tumbleRotation(d.rx, d.ry, e.clientX - d.sx, e.clientY - d.sy, 180);
        changeRef.current({ rotateX: rotX, rotateY: rotY });
        return;
      }
      const k = Math.max(scale, 0.0001);
      changeRef.current({
        x: Math.round(Math.max(-10000, Math.min(10000, d.x + (e.clientX - d.sx) / k))),
        y: Math.round(Math.max(-2500, Math.min(2500, d.y + (e.clientY - d.sy) / k))),
      });
    };
    const up = () => { dragRef.current = null; surfaceDrag.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [scale]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.shiftKey || !poseRef.current || playRef.current) return;
      e.preventDefault();
      setTween(null);
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      changeRef.current({ z: Math.round(Math.max(-4000, Math.min(600, poseRef.current.z - step * 0.5))) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const grab = (o: StageObject, p: PresPose | null) => (e: React.MouseEvent) => {
    if (e.button !== 0 || !p) return;
    e.preventDefault(); e.stopPropagation();
    setTween(null);
    if (o !== sel) onSelect(o);
    const fn = o === 'video' ? onVideoPose : onPoseChange;
    changeRef.current = fn;
    dragRef.current = { mode: e.ctrlKey ? 'rotate' : 'move', sx: e.clientX, sy: e.clientY, x: p.x, y: p.y, rx: p.rotateX, ry: p.rotateY };
  };

  const fw = scale * VW, fh = scale * VH;
  const surfaceY = (sel === 'video' && video ? video.pageStyle.reflectionSurfaceY : r?.pageStyle.reflectionSurfaceY) ?? DEFAULT_SURFACE_Y;
  const surfaceOn = sel === 'video' && video ? video.pageStyle.reflection : r?.pageStyle.reflection;
  const btn = (on: boolean) => `px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide border ${on ? 'bg-blue-600/40 text-blue-100 border-blue-400/60' : 'bg-black/55 text-slate-300 border-slate-700 hover:border-slate-500'}`;
  // The slide waits only for a clip that comes before its card; beside it ("together", a cue) it stays up.
  const busy = !!trans || !!clipRun?.card || (!!clipRun?.hold && !clipRun.leave);
  const videoBusy = !!trans || !!clipRun;
  const hint = 'Click to select · drag: move · Ctrl+drag: tumble · Shift+wheel: depth';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
        {r && (
          <div className="flex flex-wrap items-start gap-1 px-2 pt-2">
            <div className="flex flex-wrap gap-1" onMouseDown={e => e.stopPropagation()}>
              <div className="flex rounded-md overflow-hidden border border-slate-600 mr-2" title="Edit: arrange the slide and the video. Play: see it as the audience will.">
                <button onClick={() => onMode('edit')}
                  className={`px-4 py-1.5 text-[12px] font-bold uppercase tracking-wider ${!play ? 'bg-amber-500 text-black' : 'bg-black/60 text-slate-400 hover:text-white'}`}>✎ Edit</button>
                <button onClick={() => onMode('play')}
                  className={`px-4 py-1.5 text-[12px] font-bold uppercase tracking-wider ${play ? 'bg-sky-500 text-black' : 'bg-black/60 text-slate-400 hover:text-white'}`}>▶ Play</button>
              </div>
              {!play && (<>
                {(['in', 'hold', 'out'] as SlideState[]).map(s => (
                  <button key={s} onClick={() => onState(s)} className={btn(state === s)} title={`Edit the ${s.toUpperCase()} pose`}>{s}</button>
                ))}
                <button onClick={() => changeRef.current({ x: 0, y: 0, z: 0 })} className={`${btn(false)} ml-1`} title="Centre this pose">Center</button>
              </>)}
              <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-700/60">
                <button onClick={() => onStep(-1)} disabled={page <= 1} className={`${btn(false)} disabled:opacity-40`} title="Previous (NUM4 / PageUp / ←)">◀</button>
                <span className="text-[10px] font-mono text-slate-300 tabular-nums select-none px-0.5">{page}/{count}</span>
                <button onClick={() => onStep(1)} disabled={page >= count} className={`${btn(false)} disabled:opacity-40`} title="Next (NUM5 / PageDown / →)">▶</button>
              </div>
              {video && (
                <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-700/60">
                  {!play && <>
                    <button onClick={() => onSelect('slide')} className={btn(sel === 'slide')} title="Edit the slide">Slide</button>
                    <button onClick={() => onSelect('video')} className={btn(sel === 'video')} title="Edit the video">Video</button>
                  </>}
                  <button onClick={() => onVideo({ blurOn: !video.blurOn })} className={btn(video.blurOn)} title="Blur the video, on the canvas and on air">Blur</button>
                  {/* Two named choices, the lit one active — a single flip-flop button read as a command. */}
                  <div className="flex rounded overflow-hidden border border-slate-700" title="How the card and its clip appear">
                    <button onClick={() => onVideo({ mode: 'after' })}
                      className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${video.mode === 'after' ? 'bg-blue-600/60 text-white' : 'bg-black/55 text-slate-400 hover:text-white'}`}>Card after video</button>
                    <button onClick={() => onVideo({ mode: 'together' })}
                      className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide border-l border-slate-700 ${video.mode === 'together' ? 'bg-blue-600/60 text-white' : 'bg-black/55 text-slate-400 hover:text-white'}`}>Together</button>
                  </div>
                  {pageClip && <button onClick={() => setClipRun({ ...pageClip, key: ++tokenRef.current, card: false })} className={btn(false)} title="Play this card's clip on the canvas">▶ Clip</button>}
                </div>
              )}
            </div>
            <div className="flex gap-1 ml-auto" onMouseDown={e => e.stopPropagation()}>
              <button onClick={() => setPlain(v => !v)} className={btn(plain)} title="Read the page flat — canvas only">Plain</button>
              <button onClick={() => setShowGrid(g => !g)} className={btn(showGrid)} title="Perspective grid — canvas only">Grid</button>
              <button onClick={onToggleLive}
                className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide border flex items-center gap-1.5 ${live ? 'bg-emerald-600/40 text-emerald-50 border-emerald-400/70' : 'bg-black/55 text-slate-300 border-slate-700 hover:border-slate-500'}`}
                title={live ? 'On air — click to take it off' : 'Put this book on the output'}>
                <span className={`inline-block w-2 h-2 rounded-full ${live ? 'bg-emerald-300 animate-pulse' : 'bg-slate-500'}`} />
                {live ? 'On Air' : 'Put on air'}
              </button>
            </div>
          </div>
        )}
    <div className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden">
      <div ref={wrapRef} className="relative" style={{ width: fw, height: fh }}>
        <div ref={stageRef} className={`absolute inset-0 bg-black overflow-hidden ${play ? 'outline outline-2 outline-sky-500/60' : ''}`} onDoubleClick={() => r?.card && onEditCard?.()}>
          {r && pres && pose && !busy && !plain && (() => {
            const op = presentationOpacity(pose);
            const bounceCss = bounceKeyframes((pres.bounceAmount || 0) * scale, pres.bounceCount || 0);
            const bounceAnim = poseState === 'hold' ? bounceAnimation(pres, pres.showDuration) : undefined;
            const dim = showVideo && sel === 'video' ? 0.35 : 1;
            return (<>
              <SlidePoseView
                src={r.src} card={r.card} crop={r.crop} aspect={r.aspect} pageStyle={r.pageStyle} pose={pose}
                persp={stablePersp(pres, scale)} opacity={op * dim} scale={scale} frameW={fw} frameH={fh} tween={tween}
                zIndex={1}
                bounceKey={`b-${poseState}`} bounceAnim={bounceAnim} bounceCss={bounceCss}
                heading={r.heading} headingOn={poseState === 'hold'}
                onObjectMouseDown={play ? undefined : grab('slide', pose)} objectCursor={play ? undefined : 'move'}
                objectTitle={play ? undefined : `Slide — ${hint} · double-click a card to edit it`}
              />
              {op < 0.02 && sel === 'slide' && !play && (() => {
                const box = cropLayout(r.crop, r.aspect, fw, fh)?.box;
                return (
                  <div className="absolute inset-0 pointer-events-none" style={{ perspective: `${stablePersp(pres, scale) || 0}px` }}>
                    <div className="absolute inset-0 flex items-center justify-center" style={{ transform: presentationTransform(pose, scale), transformStyle: 'preserve-3d', transition: tween ? `transform ${tween.ms}ms ${cubicBezier(tween.ease)}` : undefined }}>
                      <div className="border-2 border-dashed border-blue-400/90" style={{ width: box?.width ?? fw, height: box?.height ?? fh }} />
                    </div>
                  </div>
                );
              })()}
            </>);
          })()}

          {/* The video object, at rest on this card's opening frame. Silent: it is being placed, not played. */}
          {video && vPose && showVideo && !videoBusy && !plain && (
            <SlidePoseView
              src={posterUrl(video.file, pageClip?.t0 ?? 0)} videoSrc={clipSrc(video.file, pageClip?.t0 ?? 0)} videoPlaying={false}
              crop={undefined} aspect={16 / 9} pageStyle={{ ...video.pageStyle, videoVolume: 0 }} pose={vPose}
              persp={stablePersp(video.pres, scale)} opacity={presentationOpacity(vPose) * (sel === 'video' ? 1 : 0.35)} scale={scale} frameW={fw} frameH={fh} tween={tween}
              // Always above the slide: it is the smaller object, so each stays clickable where it shows.
              zIndex={2}
              onObjectMouseDown={grab('video', vPose)} objectCursor="move" objectTitle={`Video — ${hint}`}
            />
          )}

          {r && !busy && !plain && !play && (showGrid || surfaceOn) && (
            <div onMouseDown={e => { e.preventDefault(); e.stopPropagation(); surfaceDrag.current = true; }}
              className="absolute left-0 right-0 z-20" style={{ top: `${surfaceY * 100}%`, height: 0, cursor: 'ns-resize' }} title={`Surface / horizon of the ${sel} — drag`}>
              <div className="absolute left-0 right-0 -top-2 h-4" />
              <div className="absolute left-0 right-0 top-0 border-t-2 border-dashed border-red-500/80" />
              <span className="absolute right-1 -top-3 text-[9px] font-bold uppercase text-red-400/90 select-none">{sel} surface</span>
            </div>
          )}

          {trans && !plain && (
            <div key={trans.key} className="absolute inset-0 pointer-events-none">
              {trans.out && (
                <SlideLayer model={trans.out} frameW={fw} frameH={fh} scale={scale} go={!trans.in || goToken === trans.key}
                  onExited={() => setTrans(t => (t && t.key === trans.key && !t.in ? null : t))} />
              )}
              {trans.in && (
                <SlideLayer model={trans.in} frameW={fw} frameH={fh} scale={scale} go={!trans.out || goToken === trans.key}
                  onReady={() => setGoToken(trans.key)}
                  onEntered={() => setTrans(t => (t && t.key === trans.key ? null : t))} />
              )}
            </div>
          )}

          {/* While on air the output carries the sound; the canvas copy stays silent so it never doubles it. */}
          {clipRun && video && !plain && (
            <div className="absolute inset-0 pointer-events-none">
              <ClipLayer key={clipRun.key} video={video} t0={clipRun.t0} t1={clipRun.t1} volume={live ? 0 : video.volume / 100}
                frameW={fw} frameH={fh} scale={scale} hold={clipRun.hold} frozen={clipRun.frozen} leave={clipRun.leave}
                // On air, the canvas copy keeps to the output's playhead rather than running on its own.
                seq={clipRun.seq} role={live && clipRun.hold ? 'follow' : 'solo'}
                onEnd={clipRun.hold ? undefined : () => onClipEnd(clipRun)}
                onGone={() => setClipRun(c => (c && c.key === clipRun.key ? null : c))} />
            </div>
          )}

          {r && plain && (
            <div className="absolute inset-0 flex items-center justify-center">
              <SlideObject key={`${book?.id}-${page}`} src={r.src} card={r.card} crop={r.crop} aspect={r.aspect} frameW={fw} frameH={fh}
                page={{ ...r.pageStyle, reflection: false, thickness: 0, shadowBlur: 0, shadowX: 0, shadowY: 0 }} thickness={0} scale={scale} />
            </div>
          )}

          {showGrid && !plain && <PerspectiveGrid w={fw} h={fh} surfaceY={surfaceY} />}

          {!r && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 select-none text-center px-6">
              <span className="text-slate-600 text-3xl">{book ? 'Empty book' : 'Select or create a book'}</span>
              <span className="text-slate-600 text-xs">Paste a video link on the left to analyse it, or add images, PDFs and cards from the strip below.</span>
            </div>
          )}

        </div>
      </div>
    </div>
    </div>
  );
}
