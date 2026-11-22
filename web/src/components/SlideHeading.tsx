import { useEffect, useRef, useState } from 'react';
import { ensureFont, fontFamily } from '../titles/render/fonts';
import { headingShadowCss, headingTiming, resolveHeadingStyle, type SlideHeadingStyle } from './slideStyles';

/**
 * The slide's text heading — one box glued to the TOP EDGE of the slide's own cropped box, so it
 * travels, tilts and scales with the picture instead of floating in the frame.
 *
 * `on` is the HOLD gate, owned by whoever drives the slide's lifecycle: SlideLayer turns it on when
 * the IN→HOLD tween has actually finished and off the instant the slide flips to exiting; the canvas
 * editor turns it on while the HOLD keyframe is selected. So the title is never on screen while the
 * slide is travelling.
 *
 * Appearance is deck-wide: `blur` resolves out of a defocus, `typewriter` types the letters in, and
 * one Speed slider sets both (headingTiming). The face is registered HERE — this is the page that
 * draws the text, and the OBS browser source has no fonts of its own (CLAUDE.md rule 18).
 */
export function SlideHeading({ text, style: raw, scale, on, lift = 0 }: {
  text: string;
  style: SlideHeadingStyle;
  scale: number;
  on: boolean;
  lift?: number;  // px toward the viewer — a title placed ON the slide must clear a slab's front face
}) {
  // The overlay gets the look straight off the server, which does not know the newer keys.
  const style = resolveHeadingStyle(raw);
  const typing = style.appear === 'typewriter';
  const { revealMs, charMs } = headingTiming(style);
  const [shown, setShown] = useState(false);
  const [chars, setChars] = useState(0);
  const rafRef = useRef<number[]>([]);

  useEffect(() => { ensureFont(style.font); }, [style.font]);

  useEffect(() => {
    const cancelRafs = () => { for (const id of rafRef.current) cancelAnimationFrame(id); rafRef.current = []; };
    if (!on || !text) { cancelRafs(); setShown(false); setChars(0); return; }
    if (typing) {
      setShown(true);
      setChars(0);
      let i = 0;
      const id = setInterval(() => {
        i += 1;
        setChars(i);
        if (i >= text.length) clearInterval(id);
      }, Math.max(8, charMs));
      return () => clearInterval(id);
    }
    // blur / none: paint the FROM look first (a double rAF), or the browser has no delta left to
    // transition and the title simply appears — the same trap the pose tween guards against.
    setShown(false);
    rafRef.current.push(requestAnimationFrame(() => {
      rafRef.current.push(requestAnimationFrame(() => setShown(true)));
    }));
    return cancelRafs;
  }, [on, text, typing, charMs]);

  if (!text) return null;

  const visible = on && (typing || shown);
  const blurred = style.appear === 'blur' && !shown;
  const em = style.size * scale;
  const entry = shown || typing ? ''
    : style.appear === 'rise' ? ` translateY(${em * 0.6}px)`
    : style.appear === 'drop' ? ` translateY(${-em * 0.6}px)`
    : style.appear === 'slide' ? ` translateX(${-em * 1.2}px)`
    : style.appear === 'zoom' ? ' scale(0.6)'
    : '';
  const originX = style.align === 'right' ? '100%' : style.align === 'center' ? '50%' : '0%';
  const originY = style.anchor === 'above' || style.anchor === 'bottom' ? '100%' : '0%';
  const place = style.anchor === 'above' ? { bottom: '100%' }
    : style.anchor === 'top' ? { top: 0 }
    : style.anchor === 'bottom' ? { bottom: 0 }
    : { top: '100%' };
  // Arriving takes the deck's Speed; LEAVING is always quick — the slide is starting its OUT and the
  // title has to be gone before the travel reads as two moving objects.
  const ms = on ? (style.appear === 'none' ? 0 : revealMs) : 150;

  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, ...place,
        textAlign: style.align,
        transform: `translate3d(${style.offsetX * scale}px, ${style.offsetY * scale}px, ${lift}px) scale(${style.scale / 100})${entry}`,
        transformOrigin: `${originX} ${originY}`,
        padding: style.padding * scale,
        fontFamily: fontFamily(style.font),
        fontSize: style.size * scale,
        lineHeight: 1.15,
        color: style.color,
        textShadow: headingShadowCss(style, scale),
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        filter: blurred ? `blur(${Math.max(2, style.size * scale * 0.2)}px)` : undefined,
        transition: `opacity ${ms}ms ease, filter ${ms}ms ease, transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      }}
    >
      {typing ? text.slice(0, chars) : text}
    </div>
  );
}
