import type { CSSProperties } from 'react';
import { SlideObject, objectSize, slideObjectBox, type SlideCard } from './SlideObject';
import { SlideHeading } from './SlideHeading';
import { reflectionObjectStyle } from '../clipboard/reflection';
import { useClipAspect } from '../lib/clipAspect';
import { type SlideCrop } from './slideCrop';
import {
  presentationTransform, surfaceMirrorTransform, surfaceLinePx, reflectionBlurCss, cubicBezier, DEFAULT_SURFACE_Y,
  type SlidePageStyle, type PresPose, type SlideHeadingStyle,
} from './slideStyles';

// The slide's heading, as the renderer needs it: the resolved text, the deck-wide look, and whether
// the slide is AT HOLD right now (the caller owns that — see SlideHeading).
export interface SlideHeadingModel { text: string; style: SlideHeadingStyle }

/**
 * THE single renderer for a posed slide — perspective context + virtual-surface reflection + slab +
 * bounce + the SlideObject. Used by BOTH:
 *   - SlideLayer (the OBS overlay and the canvas page-change carousel), which drives `pose`/`tween`
 *     through its IN→HOLD→OUT lifecycle, and
 *   - the canvas IN/HOLD/OUT editor, which drives `pose` from the selected keyframe + a tween on switch.
 * There is exactly ONE implementation of the visual so the button preview, the canvas carousel, and the
 * overlay are guaranteed identical (they used to be two copies that drifted).
 *
 * Pure presentational — the caller supplies pose, opacity, the STABLE perspective (never animate it,
 * that zooms), the tween, and optional bounce + object interaction (drag) for the editor.
 */
export interface SlidePoseViewProps {
  src: string;
  videoSrc?: string;   // a video page: the clip plays in the slide's own box (poster = src)
  card?: SlideCard;    // a claim / fallacy page
  videoPlaying?: boolean;              // false holds that clip on its frame (BUG-1733)
  crop: SlideCrop | undefined;
  aspect: number | undefined;
  pageStyle: SlidePageStyle;
  pose: PresPose;
  persp: number;                       // stable perspective px (already scaled); 0 = none
  opacity: number;                     // root opacity 0..1 (caller gates on load / pose opacity)
  scale: number;
  frameW: number;
  frameH: number;
  tween: { ms: number; ease: number[] } | null;
  zIndex?: number;
  bounceKey?: string | number;         // remount key that replays the bounce
  bounceAnim?: string;                 // CSS `animation` shorthand for the bounce
  bounceCss?: string;                  // the bounce @keyframes body (emitted in a <style>)
  // The heading rides the slide's own box (never the reflection copy, which has no text of its own
  // to feather). `headingOn` is the HOLD gate.
  heading?: SlideHeadingModel | null;
  headingOn?: boolean;
  // Editor only — drag the object to edit the active pose.
  onObjectMouseDown?: (e: React.MouseEvent) => void;
  objectCursor?: CSSProperties['cursor'];
  objectTitle?: string;
}

export function SlidePoseView({
  src, videoSrc, card, videoPlaying, crop, aspect, pageStyle, pose, persp, opacity, scale, frameW, frameH, tween, zIndex,
  bounceKey, bounceAnim, bounceCss, heading, headingOn, onObjectMouseDown, objectCursor, objectTitle,
}: SlidePoseViewProps) {
  const cb = tween ? cubicBezier(tween.ease) : undefined;
  const presTransform = presentationTransform(pose, scale);
  const headingText = heading?.text ?? '';
  // The slide's rendered box — the heading hangs off its top edge. A page with no resolvable crop
  // layout fills the frame, so the frame IS its box.
  // A video page's box is the CLIP's shape (BUG-1737); SlideObject resolves the same number from the
  // same cache, so the heading's anchor box and the slide it hangs off can never be two sizes.
  const measured = useClipAspect(videoSrc);
  const objectAspect = videoSrc ? (measured ?? aspect) : aspect;
  const { W, H } = slideObjectBox(crop, objectAspect, frameW, frameH, pageStyle, scale, objectSize(card, pageStyle));
  const objectBox = { width: W, height: H };

  // "Object %" dims the slide and its reflection together. It is applied on the flat root below rather
  // than on the slide's own wrapper: an opacity < 1 is a CSS grouping property and would flatten the
  // slab's 3D exactly as a mask does.
  const objectDim = reflectionObjectStyle(pageStyle).opacity ?? 1;
  const surfaceY = pageStyle.reflectionSurfaceY ?? DEFAULT_SURFACE_Y;
  const distance = pageStyle.reflectionDistance ?? 0;
  const lineY = surfaceLinePx(surfaceY, distance, frameH, scale); // flat mode: fold line + distance gap
  // Grid mode: the HORIZON is the red surface line ONLY — never shifted by distance. The clip AND the
  // vanishing point both sit here, so Distance moves the reflection's Y WITHOUT moving the horizon
  // (BUG-746): the earlier clip at redLine+distance sat BELOW the horizon and chopped the reflection's top.
  const redLineY = surfaceLinePx(surfaceY, 0, frameH, scale);
  // Two reflection looks (BUG-746): the default FLAT mirror is a 2D flip in screen space (fold pinned
  // on the drawn line); GRID mode is a true 3D mirror on the perspective grid floor.
  const gridMode = !!pageStyle.reflection && !!pageStyle.reflectionGrid;
  const flatMirror = pageStyle.reflection && !gridMode
    ? surfaceMirrorTransform(surfaceY, distance, frameH, scale)
    : null;
  // Grid: fold the slide across the fixed horizon (red line), then push the reflection DOWN by `distance`
  // — a pure Y control that never touches the horizon. `scaleY(-1)` mirrors, the translate places it below.
  const floorMirror = gridMode ? `translateY(${2 * redLineY - frameH + distance * scale}px) scaleY(-1)` : undefined;

  // The perspective CONTEXT and the posed slide inside it. Rendered twice — once for real, once as the
  // reflection — from one function, so the reflection is driven by the same `pose`, `persp`, tween and
  // bounce as the slide and cannot drift from it on any frame. `innerMirror` (grid mode) is a 3D
  // reflection applied INSIDE the perspective so the mirror foreshortens with the slide.
  const posed = (asReflection: boolean, innerMirror?: string) => {
    // Transform wrapper is the STABLE parent (never keyed) so its pose transform transition actually
    // animates. The bounce restart keys the INNER child only — keying an ancestor of the transitioning
    // element would remount it and the pose would jump to the target with no tween.
    const body = (
      <div
        style={{
          position: 'absolute', inset: 0, transformOrigin: 'center', transformStyle: 'preserve-3d',
          transform: presTransform,
          transition: tween ? `transform ${tween.ms}ms ${cb}` : undefined,
          cursor: asReflection ? undefined : objectCursor,
          // Editable: only the object's own box takes the mouse (below), so of two objects on the stage
          // the one actually under the cursor is the one picked — never whichever covers the frame.
          pointerEvents: onObjectMouseDown ? 'none' : undefined,
        }}
        onMouseDown={asReflection ? undefined : onObjectMouseDown}
        title={asReflection ? undefined : objectTitle}
      >
        <div key={bounceKey} style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', animation: bounceAnim }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transformStyle: 'preserve-3d' }}>
            {/* With a heading the object is wrapped in a box of its OWN rendered size, so the title
                can anchor to the slide's top edge (bottom:100%) rather than to the frame. The wrapper
                matches SlideObject's own root exactly, so nothing about the slide changes. */}
            {(headingText || onObjectMouseDown) && !asReflection ? (
              <div style={{ position: 'relative', width: objectBox.width, height: objectBox.height, transformStyle: 'preserve-3d', pointerEvents: onObjectMouseDown ? 'auto' : undefined }}>
                <SlideObject src={src} card={card} videoSrc={videoSrc} videoPlaying={videoPlaying} crop={crop} aspect={aspect} frameW={frameW} frameH={frameH} page={pageStyle} thickness={(pageStyle.thickness ?? 0) * scale} scale={scale} asReflection={asReflection} />
                {headingText && <SlideHeading text={headingText} style={heading!.style} scale={scale} on={!!headingOn} lift={(pageStyle.thickness ?? 0) * scale / 2 + 1} />}
              </div>
            ) : (
              <SlideObject src={src} card={card} videoSrc={videoSrc} videoPlaying={videoPlaying} crop={crop} aspect={aspect} frameW={frameW} frameH={frameH} page={pageStyle} thickness={(pageStyle.thickness ?? 0) * scale} scale={scale} asReflection={asReflection} />
            )}
          </div>
        </div>
      </div>
    );
    // The real slide + flat reflection render the ORIGINAL structure (perspective → pose wrapper) so the
    // slide's mousedown hit-testing is untouched. Only the GRID reflection wraps `body` in the extra
    // preserve-3d floor-mirror layer — and it is pointer-events:none, so hit-testing there doesn't matter.
    // The grid reflection's vanishing point is moved to the surface line (`perspectiveOrigin` at lineY =
    // the grid's own horizon), so the reflection recedes TOWARD the red line and stays BELOW it, instead
    // of receding toward the frame centre (above the line) and climbing over it.
    return (
      <div style={{ position: 'absolute', inset: 0, perspective: persp ? `${persp}px` : undefined, perspectiveOrigin: innerMirror ? `50% ${redLineY}px` : undefined }}>
        {innerMirror
          ? <div style={{ position: 'absolute', inset: 0, transformOrigin: 'center', transformStyle: 'preserve-3d', transform: innerMirror }}>{body}</div>
          : body}
      </div>
    );
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex,
      // Editable: the frame-sized wrappers let clicks through, so only the object's own box (which sets
      // `auto` again) takes the mouse. Without this, an object drawn on top swallowed every click on the
      // whole canvas and the slide beneath it could not be grabbed.
      pointerEvents: onObjectMouseDown ? 'none' : undefined,
      // Opacity on the root (non-3D) container so a faded slide keeps its slab/tilt — setting opacity on
      // a preserve-3d wrapper would flatten the 3D. Only opacity transitions here.
      opacity: opacity * objectDim,
      transition: tween ? `opacity ${tween.ms}ms ${cb}` : undefined,
    }}>
      {bounceCss && <style>{bounceCss}</style>}
      {/* FLAT — a plain 2D flip, deliberately OUTSIDE any perspective context: it mirrors the reflection's
          already-composited image, so the fold lands exactly on the drawn surface line however deep in Z
          the slide sits. Outer box clips to below the line (SCREEN space); the inner box is pulled back up
          to the frame rect so the flip's transform-origin stays the frame centre. */}
      {flatMirror && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: lineY, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          <div style={{
            position: 'absolute', left: 0, right: 0, top: -lineY, height: frameH, transformOrigin: 'center',
            transform: flatMirror, filter: reflectionBlurCss(pageStyle, scale),
          }}>
            {posed(true)}
          </div>
        </div>
      )}
      {/* GRID — a true 3D mirror across the floor plane at the surface line, receding onto the perspective
          grid. Its vanishing point is the surface line (posed() sets perspectiveOrigin at lineY), so the
          reflection stays BELOW the red line; the clip-path below the line is a hard guarantee of that. */}
      {gridMode && (
        <div style={{ position: 'absolute', inset: 0, clipPath: `inset(${redLineY}px 0 0 0)`, filter: reflectionBlurCss(pageStyle, scale), pointerEvents: 'none' }}>
          {posed(true, floorMirror)}
        </div>
      )}
      {posed(false)}
    </div>
  );
}
