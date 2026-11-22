import { useEffect, useRef, type CSSProperties } from 'react';
import { useClipAspect } from '../lib/clipAspect';
import { reportSlideVideo } from '../lib/slideVideoClock';
import { applySink, useAudioSink } from '../lib/audioOut';
import { cropLayout, type SlideCrop } from './slideCrop';
import { shadowCss, borderCss, reflectionMaskCss, reflectionAlpha, type SlidePageStyle } from './slideStyles';
import { CardFace } from './CardFace';
import { cardSize, type CardStyle } from '../lib/cardStyle';
import type { Card, CardKind } from '../lib/types';

/** A claim / fallacy page: the face is the card itself, drawn as DOM inside the slide's box. */
export interface SlideCard { kind: CardKind; card: Card; style: CardStyle }

// Solid fill for the extruded slab's side/back faces (a vector edge, not a copy of
// the slide). The diagonal gradient gives the edge a touch of volume under tilt.
const SLAB_SIDE = 'linear-gradient(135deg, #3a3a3a, #161616)';

/**
 * A video page's clip. It must MOUNT muted — an autoplaying video with sound is blocked outside
 * OBS (whose browser source runs with no-user-gesture-required), and a blocked play() leaves a
 * frozen poster instead of a slide. So it starts muted and unmutes to its own level once playing;
 * if the browser refuses that, it keeps playing silently rather than stopping.
 *
 * **It does NOT loop** (BUG-1738). A clip on a slide is something being shown, not a texture: it
 * runs once and rests on its last frame, and the operator moves the slide on. Looping put the
 * opening of a clip back on air under whoever was still talking about the end of it.
 *
 * **It only ever runs while the slide is resting at HOLD** (BUG-1742) — the caller decides that, and
 * nothing here starts on its own.
 *
 * `playing === false` holds it on its current frame — the transport a presenter drives from the
 * guest page (BUG-1733). It is a hold, not a stop: the position is kept, so resuming carries on.
 * Resuming a clip that has already RUN OUT rewinds it first, because there is nowhere else for
 * PLAY to go.
 */
// The heard copy of each clip, by src — a reflection copy follows it. Two elements started on the
// same frame still drift apart (each buffers and stalls on its own), and a mirror that runs ahead
// of or behind its slide reads as a glitch.
const heardVideos = new Map<string, HTMLVideoElement>();

function SlideVideo({ src, poster, volume, playing = true, style, onLoad, report }: {
  src: string; poster: string; volume: number; playing?: boolean; style: CSSProperties; onLoad?: () => void; report?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const sinkId = useAudioSink();
  // A clip that leaves stops downloading. A detached <video> otherwise keeps buffering its file, and
  // holds the connection the next player of that file is waiting for.
  useEffect(() => () => {
    const el = ref.current;
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
  }, []);
  useEffect(() => { if (ref.current && report) applySink(ref.current); }, [sinkId, report, src]);
  // The heard copy feeds the timeline (BUG-1802); a reflection is the same clip, silent.
  useEffect(() => (report && ref.current ? reportSlideVideo(ref.current) : undefined), [report, src]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (report) {
      heardVideos.set(src, el);
      return () => { if (heardVideos.get(src) === el) heardVideos.delete(src); };
    }
    const id = window.setInterval(() => {
      const lead = heardVideos.get(src);
      if (!lead) return;
      if (lead.paused !== el.paused) { if (lead.paused) el.pause(); else el.play().catch(() => {}); }
      if (!el.seeking && Math.abs(lead.currentTime - el.currentTime) > 0.12) el.currentTime = lead.currentTime;
    }, 250);
    return () => window.clearInterval(id);
  }, [report, src]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    el.muted = volume === 0;
    if (!playing) { el.pause(); return; }
    if (el.ended) el.currentTime = 0;
    if (volume > 0) el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
    else el.play().catch(() => {});
  }, [volume, src, playing]);
  return (
    <video
      // NO `autoPlay` (BUG-1742). The element is driven entirely by the effect above, because the
      // caller decides when a clip may run — SlideLayer only allows it at HOLD — and an `autoPlay`
      // element starts the moment it mounts and is paused a frame or two later, which is exactly the
      // opening of the clip leaking out during the IN tween. `preload="auto"` buys back what autoplay
      // was providing: the clip buffers while the slide is flying in, so it starts on the frame it
      // is allowed to rather than after a stall.
      ref={ref} src={src} poster={poster} preload="auto" muted playsInline
      onLoadedData={onLoad}
      style={style}
    />
  );
}

/**
 * The slide's box. The border is a ring OUTSIDE the picture, never drawn over it (BUG-1790): the
 * picture is fitted into the frame less the ring, and the ring wraps it, so a clip is seen whole
 * and the shadow, slab and heading all hang off the bordered box.
 */
/** An object's own box, as fractions of the frame: a card's from the card look, the video object's
 *  from its Width / Height. Undefined = its natural shape, as large as fits. */
export function objectSize(card: SlideCard | undefined, page: SlidePageStyle): { w: number; h: number } | undefined {
  if (card) return cardSize(card.style);
  return page.boxW && page.boxH ? { w: page.boxW / 100, h: page.boxH / 100 } : undefined;
}

export function slideObjectBox(crop: SlideCrop | undefined, aspect: number | undefined, frameW: number, frameH: number, page: SlidePageStyle, scale: number,
  size?: { w: number; h: number }) {
  const bw = Math.max(0, (page.borderWidth ?? 0) * scale);
  // A card with its own size: the box IS that share of the frame, whatever the card shape.
  if (size) { frameW *= size.w; frameH *= size.h; aspect = frameW / frameH; }
  const layout = cropLayout(crop, aspect, frameW - 2 * bw, frameH - 2 * bw);
  const W = layout ? (layout.box.width as number) + 2 * bw : frameW;
  const H = layout ? (layout.box.height as number) + 2 * bw : frameH;
  return { layout, W, H };
}

/**
 * One PDF page rendered as a styled object: the page image cropped to `crop`,
 * contained in a measured `frameW`×`frameH` frame, with optional surface
 * reflection + drop shadow + slab thickness from the page style. Shared by the
 * Slides canvas preview and the OBS overlay so both look identical.
 *
 * `asReflection` renders this copy as the mirrored one: feathered per face, dimmed to Reflect %,
 * no drop shadow. SlidePoseView flips it about the surface line.
 *
 * `thickness` (already scaled to the render size) extrudes the page into a slab.
 * With square corners the depth is four flat vector side walls + a back face (a
 * preserve-3d cuboid centred on the slide plane, z ∈ [-t/2, +t/2]) behind the bright
 * front face. With rounded corners those walls would cut the curve off square, so the
 * depth is instead a stack of rounded slabs swept through the same z range — cheap
 * solid-colour divs, never darkened image copies (which spawned dozens of filtered
 * <img>s per buffer and crushed the presentation tween, BUG-532).
 */
export function SlideObject({ src, videoSrc, card, videoPlaying = true, crop, aspect, frameW, frameH, page, thickness = 0, scale = 1, onLoad, asReflection = false }: {
  src: string;
  card?: SlideCard;
  // A VIDEO page: the clip plays in the slide's own box, cropped and posed exactly like a page
  // image, with `src` as its poster. The box is the CLIP's shape, not the page's stored 16:9.
  videoSrc?: string;
  /** The transport a presenter drives (BUG-1733) — false holds the clip on its frame. */
  videoPlaying?: boolean;
  crop: SlideCrop | undefined;
  aspect: number | undefined;
  frameW: number;
  frameH: number;
  page: SlidePageStyle;
  thickness?: number;
  scale?: number; // scales border width/radius for previews smaller than the overlay
  onLoad?: () => void;
  // This copy IS the reflection: feathered, dimmed to Reflect %, and no drop shadow. SlidePoseView
  // owns the flip about the surface line.
  asReflection?: boolean;
}) {
  // The box is built from the CLIP's own shape once the element has reported it, not from the page's
  // stored 16:9 (BUG-1737) — so the border, the drop shadow, the slab and the reflection all wrap the
  // picture instead of a frame it happens to sit inside. It resolves before `loadeddata`, which is the
  // gate SlideLayer holds a layer's entrance on, so nothing reflows in view.
  const measured = useClipAspect(videoSrc);
  const size = objectSize(card, page);
  const { layout, W: boxW, H: boxH } = slideObjectBox(crop, videoSrc ? (measured ?? aspect) : aspect, frameW, frameH, page, scale, size);
  const blur = (page.videoBlur ?? 0) * scale;
  // A video page's own level (0–100, per page). The REFLECTION copy is always silent — two elements
  // play the same clip and only one of them may be heard.
  const volume = asReflection ? 0 : Math.max(0, Math.min(100, page.videoVolume ?? 100)) / 100;
  // The page's media: an <img>, or the clip itself on a video page. Both take the same cropped
  // layout box, so a video page poses, crops, borders and reflects like any other slide.
  const media = (style: CSSProperties, withOnLoad: boolean) => (card
    ? <CardFace kind={card.kind} card={card.card} style={card.style} width={typeof style.width === 'number' ? style.width : boxW} height={typeof style.height === 'number' ? style.height : boxH} scale={scale} asReflection={asReflection} />
    : videoSrc
    ? <SlideVideo
        src={videoSrc} poster={src} volume={volume} playing={videoPlaying} report={!asReflection}
        onLoad={withOnLoad ? onLoad : undefined}
        // A CLIP IS NEVER STRETCHED (BUG-1736). The crop layout hands its media `object-fit: fill` —
        // right for an <img>, whose element box is built from the page's own aspect, so filling it is
        // a no-op; wrong for a video. With the box now measured from the clip this is an exact fit,
        // and it stays the safety net for the frames before metadata arrives and for a clip that
        // never reports its size: contained, centred, stood on the bottom edge the reflection is
        // mirrored from.
        // A box given its own Width / Height is filled and the picture cropped (still never stretched).
        // A blurred clip is grown a little so the blur's soft rim falls outside the box, not inside it.
        style={{
          ...style, objectFit: size ? 'cover' : 'contain', objectPosition: size ? '50% 50%' : '50% 100%',
          ...(blur > 0 ? { filter: `blur(${blur}px)`, transform: `scale(${1 + Math.min(0.2, (blur * 3) / Math.max(1, boxW))})` } : {}),
        }}
      />
    : <img src={src} alt="" draggable={false} onLoad={withOnLoad ? onLoad : undefined} style={style} />);
  if (!layout) {
    return media({ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }, true);
  }
  const slab = thickness > 0;
  const border = borderCss(page, scale);
  const radius = (page.borderRadius ?? 0) * scale;
  const featherOn = (page.reflectionFeather ?? 67) > 0;
  // The reflection's feather is masked onto each FACE, never onto a wrapper. A mask is a CSS grouping
  // property: on a wrapper it forces `transform-style: flat`, severing the 3D context and collapsing the
  // slab's side walls to nothing (a rotateY(90deg) plane has zero width without perspective) — which is
  // why the reflection used to show no thickness. Every face's local box shares the slide's y axis, so
  // one gradient feathers them all consistently.
  const faceMask = reflectionMaskCss(page);
  const clip = (masked: boolean): CSSProperties => ({
    position: 'absolute', inset: 0, overflow: 'hidden', ...border, ...(masked ? faceMask : {}),
  });
  const frame: CSSProperties = {
    position: 'relative',
    width: boxW, height: boxH,
    ...(asReflection ? {} : shadowCss(page)),
    ...(slab ? { transformStyle: 'preserve-3d' } : {}),
  };

  // Bright front face — the page image at the front of the slab (z = +t/2).
  const front = (withOnLoad: boolean, masked: boolean) => (
    <div style={{ ...clip(masked), ...(slab ? { transform: `translateZ(${thickness / 2}px)` } : {}) }}>
      {media(layout.img, withOnLoad)}
    </div>
  );

  // Rounded slab: sweep the rounded silhouette through the depth. Opaque slices ≤2px apart, so from
  // any tilt their union reads as one solid body with the corners still curved. The sweep stops SHORT
  // of the front plane (z ∈ [-t/2, +t/2)): a slice coplanar with the front face z-fights it, and the
  // opaque dark slice wins often enough to paint the slide out entirely.
  const sweptDepth = (masked: boolean) => {
    const t = thickness;
    const n = Math.max(2, Math.min(24, Math.ceil(t / 2)));
    return Array.from({ length: n }, (_, i) => (
      <div key={`s${i}`} style={{
        position: 'absolute', inset: 0, borderRadius: radius, background: SLAB_SIDE,
        transform: `translateZ(${-t / 2 + (t * i) / n}px)`, ...(masked ? faceMask : {}),
      }} />
    ));
  };

  // Square slab: four flat vector walls + a back face.
  const walledDepth = (masked: boolean) => {
    const t = thickness;
    const W = boxW, H = boxH;
    const wall = (key: string, s: CSSProperties) => (
      <div key={key} style={{ position: 'absolute', top: 0, left: 0, transformOrigin: '0 0', background: SLAB_SIDE, ...s }} />
    );
    const m = masked ? faceMask : {};
    // The top and bottom walls are only `t` tall, so the shared gradient — which is calibrated to the
    // slide's full height — can't say anything useful inside them. They are the two extremes of it: the
    // bottom wall is the seam against the slide (full Reflect % alpha), the top wall is the far edge,
    // past the fade-out (gone, unless the feather is off).
    const alpha = reflectionAlpha(page);
    const capTop = masked ? { opacity: featherOn ? 0 : alpha } : {};
    const capBottom = masked ? { opacity: alpha } : {};
    return (<>
      <div style={{ ...clip(masked), transform: `translateZ(${-t / 2}px)`, background: '#161616' }} />
      {wall('r', { width: t, height: H, transform: `translate3d(${W}px,0,${t / 2}px) rotateY(90deg)`, ...m })}
      {wall('l', { width: t, height: H, transform: `translateZ(${t / 2}px) rotateY(90deg)`, ...m })}
      {wall('t', { width: W, height: t, transform: `translate3d(0,0,${-t / 2}px) rotateX(90deg)`, ...capTop })}
      {wall('b', { width: W, height: t, transform: `translate3d(0,${H}px,${-t / 2}px) rotateX(90deg)`, ...capBottom })}
    </>);
  };

  const renderContent = (withOnLoad: boolean, masked: boolean) => {
    if (!slab) return front(withOnLoad, masked);
    return (
      <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}>
        {radius > 0 ? sweptDepth(masked) : walledDepth(masked)}
        {front(withOnLoad, masked)}
      </div>
    );
  };

  return <div style={frame}>{renderContent(!asReflection, asReflection)}</div>;
}
