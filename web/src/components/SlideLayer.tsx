import { useEffect, useRef, useState } from 'react';
import { type SlideCrop } from './slideCrop';
import { SlidePoseView, type SlideHeadingModel } from './SlidePoseView';
import type { SlideCard } from './SlideObject';
import {
  presentationPerspectivePx, presentationOpacity,
  bounceKeyframes, bounceAnimation,
  type SlidePresentationStyle, type SlidePageStyle, type PresPose,
} from './slideStyles';

/**
 * One animated slide page = one overlay layer. Self-manages its lifecycle from the
 * deck's own IN/HOLD/OUT poses:
 *   entering (exiting=false) — starts at IN, tweens IN→HOLD
 *   exiting  (exiting=true)  — starts at HOLD, tweens HOLD→OUT, then calls onExited
 *
 * Two of these stacked = a per-page carousel with no shared-pose race (BUG-565). Shared by
 * the OBS overlay (SlidesOverlay, scale=1) and the Slides-tab canvas preview
 * (InteractiveSlideCanvas, scale = stageWidth / 1920).
 *
 * `go` is the SYNC GATE: a layer holds at its FROM pose until go=true, so a caller can mount
 * the outgoing + incoming together, preload the incoming image, then flip go once — and both
 * the OUT and IN tweens start on the same frame (simultaneous, not one-after-the-other). The
 * overlay leaves go=true (default) and instead preloads-then-mounts. Timing is deterministic:
 *  - entrance gates on a DETACHED Image preload (`.complete` for cached + fallback), never the
 *    rendered <img>'s onLoad (a cached image fires load before React attaches the handler, which
 *    used to freeze the incoming at IN);
 *  - the tween starts inside a double rAF so the FROM pose paints before it begins (else the
 *    browser teleports straight to the TO pose).
 */

export interface SlideLayerModel {
  key: number;
  src: string;
  // Set on a VIDEO page: the clip plays inside the slide box, `src` is its poster (and still the
  // preload gate, so the entrance tween starts on the poster exactly like an image page).
  videoSrc?: string;
  card?: SlideCard;
  crop: SlideCrop | undefined;
  aspect: number | undefined;
  pageStyle: SlidePageStyle;
  pres: SlidePresentationStyle;
  // This page's heading (its own, or one carried down from an earlier page). Shown only while the
  // layer is resting at HOLD — see below.
  heading?: SlideHeadingModel | null;
  exiting: boolean;
  reverse?: boolean; // a Prev/backward step runs the sequence mirrored: OUT→HOLD→IN instead of IN→HOLD→OUT
}

export function SlideLayer({ model, frameW, frameH, scale = 1, go = true, videoPlaying = true, onExited, onReady, onEntered }: {
  model: SlideLayerModel;
  frameW: number;
  frameH: number;
  scale?: number;
  go?: boolean;
  /** A video page's transport (BUG-1733) — a prop, not part of the model, so a pause never rekeys the layer. */
  videoPlaying?: boolean;
  onExited?: (key: number) => void;
  onReady?: (key: number) => void;   // entering: its image has loaded (caller can release the sync gate)
  onEntered?: (key: number) => void; // entering: the IN→HOLD tween has finished (caller can end the transition)
}) {
  const { src, videoSrc, card, crop, aspect, pageStyle, pres, heading, exiting, reverse } = model;
  // Direction-aware poses: a FORWARD (Next) step runs a page IN→HOLD→OUT; a REVERSE (Prev / earlier
  // page) step runs it mirrored, OUT→HOLD→IN. So on Prev the entering page loads from the OUT side and
  // the leaving page exits toward the IN side.
  const fromPose = exiting ? pres.hold : (reverse ? pres.out : pres.in);
  const toPose   = exiting ? (reverse ? pres.in : pres.out) : pres.hold;
  // Tween segment: the SHOW timing spans IN↔HOLD, the HIDE timing spans HOLD↔OUT — pick by which
  // segment this move actually traverses so the two layers stay in sync in both directions.
  const seg = exiting
    ? (reverse ? { ms: pres.showDuration, ease: pres.showEasing } : { ms: pres.hideDuration, ease: pres.hideEasing })
    : (reverse ? { ms: pres.hideDuration, ease: pres.hideEasing } : { ms: pres.showDuration, ease: pres.showEasing });
  const [pose, setPose] = useState<PresPose>(fromPose);
  const [tween, setTween] = useState<{ ms: number; ease: number[] } | null>(null);
  const [loaded, setLoaded] = useState(exiting); // exiting is already-visible; entering waits for its image
  // AT HOLD — the layer is resting, not travelling. Two things hang off it.
  //
  // The heading is HOLD-only. A layer mounted already exiting was resting at HOLD a moment ago with
  // its title up, so it starts on and goes off when the OUT tween actually begins (not when the step
  // was clicked — the two layers wait on the sync gate first, and a title blinking out before
  // anything moves reads as a fault). An entering layer starts off and turns on when its IN→HOLD
  // tween has finished.
  //
  // **A video page's clip runs only here** (BUG-1742). A clip that started on the IN tween had
  // already given away its opening seconds while the slide was still flying in, half-transparent and
  // tumbling — and one that kept running through OUT carried on talking off the side of the canvas.
  // The clip waits at its poster until the slide has settled, and stops the moment it leaves.
  const [atHold, setAtHold] = useState(exiting);
  const [bounceToken, setBounceToken] = useState(0);
  // Enter and exit are guarded SEPARATELY so a layer can enter, settle at HOLD, then later flip to
  // exiting on the SAME instance and tween HOLD→OUT — no remount. Remounting the outgoing layer to
  // force the exit tween tore down and re-decoded the composited 3D/reflection/slab subtree, blinking
  // one frame on every step (BUG-611; same class as BUG-347). A single guard used to block the exit,
  // which is why the overlay had resorted to remounting.
  const enterStartedRef = useRef(false);
  const exitStartedRef = useRef(false);
  const exitedRef = useRef(false);
  const readyRef = useRef(exiting);
  const goRef = useRef(go); goRef.current = go;
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start the FROM→TO tween once per phase — only when released (go) and, for entering, ready
  // (exiting layers are ready immediately; entering ones once the image has preloaded). `seg`/`toPose`
  // are direction- and phase-aware, so the exit branch reads the HOLD→OUT values once `exiting` is true.
  const maybeStart = () => {
    if (exitedRef.current || !goRef.current) return;
    if (exiting) {
      if (exitStartedRef.current) return;
      exitStartedRef.current = true;
      setAtHold(false);
      if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (exitedRef.current) return;
        setLoaded(true); // stay visible while it exits (a mid-enter flip may still be pre-reveal)
        setTween(seg);
        setPose(toPose);
      }));
      exitTimer.current = setTimeout(() => { exitedRef.current = true; onExited?.(model.key); }, seg.ms + 120);
    } else {
      if (enterStartedRef.current || !readyRef.current) return;
      enterStartedRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (exitedRef.current || exitStartedRef.current) return; // a flip-to-exit superseded this enter
        setLoaded(true);
        setTween(seg);
        setPose(toPose);
        setBounceToken(t => t + 1);
      }));
      // Signal the caller when the entrance has settled (so it can end the transition only after the
      // animation truly finishes — never on a fixed timer from the click).
      enterTimer.current = setTimeout(() => { setAtHold(true); onEntered?.(model.key); }, seg.ms + 120);
    }
  };

  // Entering: preload the image (detached), then reveal + attempt start.
  useEffect(() => {
    if (exiting) return;
    let done = false;
    const ready = () => {
      if (done) return; done = true;
      readyRef.current = true;
      setLoaded(true);
      onReady?.(model.key); // tell the caller the image is ready → it releases the sync gate
      maybeStart();
    };
    const im = new Image();
    im.src = src;
    // decode() reliably resolves once the image can paint (onload/.complete race on cached
    // spdy responses and can miss, stalling the start until the fallback).
    im.decode().then(ready).catch(ready);
    const fb = setTimeout(ready, 600);
    return () => clearTimeout(fb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attempt start on mount and whenever the gate (go) or role (exiting) changes.
  useEffect(() => {
    maybeStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, exiting]);

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); if (enterTimer.current) clearTimeout(enterTimer.current); }, []);

  // The perspective CONTEXT must stay CONSTANT for the whole IN→HOLD/OUT tween. Deriving it from the
  // current (animating) pose and transitioning the CSS `perspective` property makes the object appear
  // to ZOOM in Z: when one endpoint has depth/tilt (persp 1200) and the other doesn't (persp none),
  // the property interpolates 1200→none mid-flight. Take a fixed context from all three poses so
  // translateZ/rotate animate as real depth inside a stable projection — no perspective zoom.
  const persp = Math.max(
    presentationPerspectivePx(pres.in, scale) ?? 0,
    presentationPerspectivePx(pres.hold, scale) ?? 0,
    presentationPerspectivePx(pres.out, scale) ?? 0,
  );
  const op = loaded ? presentationOpacity(pose) : 0;

  // The waft runs for the layer's whole life, exit included. It must not be torn off at the exit
  // flip: it never settles, so dropping it would snap the slide back from mid-drift to its pose in
  // one frame. Letting it run means the drift simply rides along on top of the HOLD→OUT tween (the
  // waft and the pose live on separate elements, so they compose).
  //
  // The delay is pinned at mount rather than read from `seg`, which retargets to the hide tween on
  // the exit flip: this layer does NOT remount (BUG-611), so a rewritten `animation` shorthand would
  // restart the CSS animation from 0% — the very snap this avoids.
  const bounceDelay = useRef(exiting ? 0 : seg.ms).current;
  const bounceCss = bounceKeyframes(pres.bounceAmount * scale, pres.bounceCount);
  const bounceAnim = bounceAnimation(pres, bounceDelay);

  // Render through the shared SlidePoseView (same renderer as the canvas editor + overlay).
  return (
    <SlidePoseView
      src={src} videoSrc={videoSrc} card={card} videoPlaying={videoPlaying && atHold} crop={crop} aspect={aspect} pageStyle={pageStyle} pose={pose}
      persp={persp} opacity={op} scale={scale} frameW={frameW} frameH={frameH} tween={tween}
      heading={heading} headingOn={atHold}
      zIndex={exiting ? 1 : 2} // the entering page sits above the one leaving
      bounceKey={`bounce-${bounceToken}`} bounceAnim={bounceAnim} bounceCss={bounceCss}
    />
  );
}
