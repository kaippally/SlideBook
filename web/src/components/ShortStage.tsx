import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PANEL_MIN_ZOOM, SHORT_H, SHORT_W, cropBox, pictureBox, splitPanels } from '../lib/shorts';
import type { ShortImage, ShortLayout } from '../lib/types';
import { ensureFont, fontFamily } from '../titles/render/fonts';

type VideoProps = React.VideoHTMLAttributes<HTMLVideoElement>;

/** The vertical 1080x1920 frame, drawn as the render will draw it. Drag the picture to pan it, wheel to zoom,
 *  drag the title or the subtitles to move them up and down. In "split" the same clip fills two stacked panels, each
 *  panned and zoomed on its own, with a draggable divider between them. */
export function ShortStage({ src, vref, videoProps, layout, onLayout, caption, title, images, allImages, selected, onSelectImage, onImages }: {
  src: string;
  vref: React.RefObject<HTMLVideoElement>;
  videoProps: VideoProps;
  layout: ShortLayout;
  onLayout: (l: ShortLayout) => void;
  caption: { words: string[]; spoken: number } | null;
  title: string;
  images: number[];
  allImages: ShortImage[];
  selected: number | null;
  onSelectImage: (i: number) => void;
  onImages: (images: ShortImage[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [sw, setSw] = useState(270);
  const [dims, setDims] = useState<[number, number]>([0, 0]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setSw(Math.max(120, Math.min(el.clientWidth - 24, (el.clientHeight - 24) * SHORT_W / SHORT_H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { ensureFont(layout.sub.font); ensureFont(layout.title.font); }, [layout.sub.font, layout.title.font]);

  // The blurred backdrop of "fit" and the lower panel of "split" are a second, muted copy that follows the main picture.
  useEffect(() => {
    const v = vref.current, b = bg.current;
    if (!v || !b || layout.mode === 'fill') return;
    const sync = () => {
      if (Math.abs(b.currentTime - v.currentTime) > 0.25) b.currentTime = v.currentTime;
      if (v.paused !== b.paused) { if (v.paused) b.pause(); else void b.play().catch(() => {}); }
    };
    const id = window.setInterval(sync, 200);
    return () => window.clearInterval(id);
  }, [layout.mode, vref, src]);

  const sh = sw * SHORT_H / SHORT_W;
  const k = sw / SHORT_W;
  const split = layout.mode === 'split';
  const pic = pictureBox(layout, dims[0], dims[1], sw);
  const panels = splitPanels(layout, sw);
  const crops = panels.map((b, i) => cropBox(layout.panels[i], dims[0], dims[1], sw, b.height, PANEL_MIN_ZOOM));
  const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
  const setPanel = (l: ShortLayout, i: number, p: Partial<ShortLayout['panels'][0]>) => {
    const ps = [...l.panels] as ShortLayout['panels'];
    ps[i] = { ...ps[i], ...p };
    return { ...l, panels: ps };
  };
  const panelAt = (clientY: number) => {
    const r = stage.current?.getBoundingClientRect();
    return r && clientY - r.top >= panels[1].top ? 1 : 0;
  };

  const drag = (what: 'picture' | 'sub' | 'title' | 'divider') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, start = layout;
    const pi = panelAt(e.clientY);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (what === 'divider') onLayout({ ...start, split: clamp(start.split + dy / sh, 0.15, 0.85) });
      else if (what === 'picture' && start.mode === 'split') {
        const b = cropBox(start.panels[pi], dims[0], dims[1], sw, splitPanels(start, sw)[pi].height, PANEL_MIN_ZOOM);
        onLayout(setPanel(start, pi, { x: clamp(start.panels[pi].x - dx / b.width), y: clamp(start.panels[pi].y - dy / b.height) }));
      } else if (what === 'sub') onLayout({ ...start, sub: { ...start.sub, y: clamp(start.sub.y + dy / sh, 0.03, 0.97) } });
      else if (what === 'title') onLayout({ ...start, title: { ...start.title, y: clamp(start.title.y + dy / sh, 0.03, 0.97) } });
      else if (start.mode === 'fill') {
        const b = pictureBox(start, dims[0], dims[1], sw);
        onLayout({ ...start, x: clamp(start.x - dx / b.width), y: clamp(start.y - dy / b.height) });
      } else {
        const b = pictureBox(start, dims[0], dims[1], sw);
        const room = Math.max(1, b.width - sw);
        onLayout({ ...start, x: b.width > sw ? clamp(start.x - dx / room) : start.x, y: clamp(start.y + dy / sh, -0.5, 1.5) });
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const wheel = (e: React.WheelEvent) => {
    if (split) {
      const i = panelAt(e.clientY);
      onLayout(setPanel(layout, i, { zoom: clamp(layout.panels[i].zoom * Math.exp(-e.deltaY * 0.0015), PANEL_MIN_ZOOM, 4) }));
      return;
    }
    const lo = layout.mode === 'fill' ? 1 : 0.3;
    onLayout({ ...layout, zoom: clamp(layout.zoom * Math.exp(-e.deltaY * 0.0015), lo, 4) });
  };

  // A picture: drag to move it, drag its corner or wheel over it to scale it.
  const setImage = (i: number, f: Partial<ShortImage>) => onImages(allImages.map((im, k) => k === i ? { ...im, ...f } : im));
  const dragImage = (i: number, corner: boolean) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    onSelectImage(i);
    const x0 = e.clientX, y0 = e.clientY, im0 = allImages[i];
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (corner) setImage(i, { w: clamp(im0.w + (2 * dx) / sw, 0.08, 1.6) });
      else setImage(i, { x: clamp(im0.x + dx / sw, -0.4, 1.4), y: clamp(im0.y + dy / sh, -0.4, 1.4) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const wheelImage = (i: number) => (e: React.WheelEvent) => {
    e.stopPropagation();
    setImage(i, { w: clamp(allImages[i].w * Math.exp(-e.deltaY * 0.0015), 0.08, 1.6) });
  };

  const loaded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setDims([e.currentTarget.videoWidth, e.currentTarget.videoHeight]);
    videoProps.onLoadedMetadata?.(e);
  };

  const sub = layout.sub, ttl = layout.title;
  const stroke = Math.max(2, sub.size * 0.07) * 2 * k;
  return (
    <div ref={box} className="w-full h-full grid place-items-center">
      <div ref={stage} className="relative overflow-hidden bg-black shadow-[0_0_0_1px_rgba(148,163,184,0.3)] touch-none"
        style={{ width: sw, height: sh }} onPointerDown={drag('picture')} onWheel={wheel}
        title="Drag to move the picture · wheel to zoom">
        {layout.mode === 'fit' && (
          <video ref={bg} src={src} muted playsInline className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={{ filter: `blur(${40 * k}px) brightness(0.92)` }} />
        )}
        <div className="absolute left-0 top-0 w-full overflow-hidden" style={{ height: split ? panels[0].height : sh }}>
          <video ref={vref} src={src} playsInline {...videoProps} onLoadedMetadata={loaded}
            className="absolute max-w-none pointer-events-none"
            style={split ? { left: crops[0].left, top: crops[0].top, width: crops[0].width, height: crops[0].height }
              : { left: pic.left, top: pic.top, width: pic.width, height: pic.height }} />
        </div>
        {split && (
          <div className="absolute left-0 w-full overflow-hidden" style={{ top: panels[1].top, height: panels[1].height }}>
            <video ref={bg} src={src} muted playsInline className="absolute max-w-none pointer-events-none"
              style={{ left: crops[1].left, top: crops[1].top, width: crops[1].width, height: crops[1].height }} />
          </div>
        )}
        {split && (
          <div onPointerDown={drag('divider')} title="Drag to resize the panels"
            className="absolute left-0 w-full h-3 -translate-y-1/2 cursor-row-resize group" style={{ top: panels[1].top }}>
            <div className="absolute inset-x-0 top-1/2 h-px bg-slate-400/40 group-hover:bg-amber-400" />
          </div>
        )}
        {images.map(i => {
          const im = allImages[i];
          if (!im) return null;
          const on = selected === i;
          return (
            <div key={im.id} onPointerDown={dragImage(i, false)} onWheel={wheelImage(i)}
              title="Drag to move · drag the corner or wheel to scale"
              className={`absolute cursor-move ${on ? 'outline outline-2 outline-amber-400' : 'hover:outline hover:outline-1 hover:outline-slate-300/60'}`}
              style={{ left: im.x * sw, top: im.y * sh, width: im.w * sw, transform: 'translate(-50%,-50%)' }}>
              <img src={im.url} alt="" draggable={false} className="block w-full h-auto pointer-events-none" />
              {on && <span onPointerDown={dragImage(i, true)} className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-amber-400 border border-black cursor-nwse-resize" />}
            </div>
          );
        })}
        {ttl.show && title.trim() && (
          <div onPointerDown={drag('title')} className="absolute left-1/2 cursor-ns-resize text-center leading-[1.25]"
            style={{ top: ttl.y * sh, transform: 'translate(-50%,-50%)', maxWidth: (SHORT_W - 160) * k, width: 'max-content' }}>
            <span style={{ fontFamily: fontFamily(ttl.font), fontSize: ttl.size * k, color: ttl.color, background: ttl.bg,
              padding: `0 ${Math.max(10, ttl.size / 4) * k}px`, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone',
              boxShadow: `0 0 0 ${Math.max(10, ttl.size / 4) * k}px ${ttl.bg}` }}>{title}</span>
          </div>
        )}
        {sub.show && (
          <div onPointerDown={drag('sub')} className="absolute left-1/2 cursor-ns-resize text-center leading-[1.25]"
            style={{ top: sub.y * sh, transform: 'translate(-50%,-50%)', maxWidth: (SHORT_W - 140) * k, width: 'max-content',
              minWidth: 60 * k, minHeight: sub.size * k, outline: caption ? undefined : '1px dashed rgba(148,163,184,0.5)' }}>
            {caption && (
              <span style={{ fontFamily: fontFamily(sub.font), fontSize: sub.size * k, paintOrder: 'stroke fill',
                WebkitTextStroke: sub.box ? undefined : `${stroke}px ${sub.outline}`,
                background: sub.box ? 'rgba(0,0,0,0.69)' : undefined, padding: sub.box ? `0 ${sub.size * 0.2 * k}px` : undefined,
                boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }}>
                {caption.words.map((w, i) => (
                  <span key={i} style={{ color: sub.karaoke && i < caption.spoken ? sub.highlight : sub.color }}>{w}{i < caption.words.length - 1 ? ' ' : ''}</span>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
