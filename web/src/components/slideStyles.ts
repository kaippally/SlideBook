import type { CSSProperties } from 'react';
import type { ReflectionParams } from '../clipboard/reflection';

// ── Style vocabulary ──────────────────────────────────────────────────────────
// IN / HOLD / OUT are three keyframe POSES of the whole slide (A / H / B). On play
// the slide tweens IN→HOLD (comes in), rests at HOLD, then HOLD→OUT (goes out).
// Per-page look (reflection / shadow / thickness) is shared across all three states.

export type SlideState = 'in' | 'hold' | 'out';
export const SLIDE_STATES: SlideState[] = ['in', 'hold', 'out'];

// One keyframe pose: the whole slide's position / depth / rotation / scale +
// opacity + the viewer perspective used while at this state.
export interface PresPose {
  x: number; y: number; z: number; scale: number; opacity: number;
  rotateX: number; rotateY: number; perspective: number;
}

export interface SlidePresentationStyle {
  in: PresPose; hold: PresPose; out: PresPose;
  showDuration: number; showEasing: number[]; // IN tween:  in  → hold
  hideDuration: number; hideEasing: number[]; // OUT tween: hold → out
  // Bounce: a gentle, never-decaying 3-axis waft that continues for the whole HOLD (see
  // bounceKeyframes) — the slide drifts as if hanging in moving air until it leaves.
  bounceAmount: number;   // peak displacement px (0 = off)
  bounceCount: number;    // wafts per loop (variety only — never speed)
  bounceDuration: number; // ms per SINGLE waft (the drift speed; loop = bounceDuration × bounceCount)
}

// Deck-level border / rounded corners (edited in the Library, applied to every page).
export interface SlideBorder {
  borderWidth: number;   // px (0 = none)
  borderColor: string;
  borderStyle: string;   // CSS border-style: solid | dashed | dotted | double
  borderRadius: number;  // px
}

// Per-page look — shared across IN/HOLD/OUT (defines the slide; does not animate).
// Border fields are merged in from the deck-level SlideBorder, and the surface-reflection
// fields from the deck-level SlideSurface, at render time — so a resolved SlidePageStyle
// still carries them for the render components, but they are NOT stored per page.
export interface SlidePageStyle extends ReflectionParams, SlideBorder {
  shadowBlur: number; shadowX: number; shadowY: number; shadowColor: string;
  thickness: number;
  reflectionSurfaceY?: number;
  reflectionBlur?: number;
  reflectionGrid?: boolean;
  // Per-slide pose override (this page only) — a FULL independent pose. When `posOverride` is on the
  // slide gets its own X/Y/Z/Scale/Opacity/Pitch/Yaw/Perspective, stored as the delta from the deck's
  // active pose and applied equally to IN/HOLD/OUT (posX/Y/Z/RotateX/RotateY/Opacity ADDED, posScale
  // MULTIPLIED, posPerspective REPLACES when > 0) — so the deck's entrance/exit animation still plays,
  // the slide just rests at its own pose. The Animation panel's main pose sliders + canvas drag edit it.
  posOverride?: boolean;
  posX?: number; posY?: number; posScale?: number;
  posZ?: number; posRotateX?: number; posRotateY?: number; posPerspective?: number; posOpacity?: number;
  // VIDEO pages only: this clip's own playback volume, 0–100 (0 = silent). Stored per page like the
  // rest of this object — i.e. keyed by the page's stable manifest id — so every video slide in a
  // deck keeps its own level. Does not apply to the deck's BACKGROUND video, which is always muted.
  videoVolume?: number;
  /** A video's blur, px in the 1920 space (0 = sharp) — to hide a face or a logo. */
  videoBlur?: number;
  /** The object's own box as % of the 1920×1080 frame (the video object's Width / Height). Unset = its
   *  natural shape, as large as fits. A box of another shape crops the picture; it is never stretched. */
  boxW?: number;
  boxH?: number;
}

export const DEFAULT_SURFACE_Y = 0.85;

// Surface reflection — a SINGLE deck-level look shared by every page (the mirror surface is a
// property of the presentation, not of one page). `reflectionSurfaceY` (0..1 of the 1080-frame)
// is the horizontal "virtual surface" line the reflection mirrors across (also the perspective
// grid's horizon); it is drawn as a draggable line in the editor.
export interface SlideSurface {
  reflection: boolean;
  reflectionSurfaceY: number;
  reflectionOpacityMain: number; // "Object %" — dims the object (and thus its reflection)
  reflectionOpacity: number;     // "Reflect %" — dims the reflection only
  reflectionDistance: number;
  reflectionFeather: number;
  reflectionBlur: number;        // "Blur" — px of blur on the mirrored copy (a matte surface)
  // How the reflection sits. false (default) = a flat 2D flip about the surface line in SCREEN space
  // (the fold always lands on the drawn line). true = a true 3D mirror across the floor PLANE at that
  // line, inside the slide's own perspective — so the reflection recedes onto the perspective grid.
  reflectionGrid: boolean;
}

export const DEFAULT_SURFACE: SlideSurface = {
  reflection: false, reflectionSurfaceY: DEFAULT_SURFACE_Y, reflectionOpacityMain: 100,
  reflectionOpacity: 50, reflectionDistance: 0, reflectionFeather: 67, reflectionBlur: 0, reflectionGrid: false,
};

// Every reflection field that used to live on a page — used to strip orphan per-page copies and
// to hoist a legacy deck's reflection up to the deck level (migration in normalizeDeckStyles).
export const SURFACE_KEYS: (keyof SlideSurface | 'reflectionMirrorY' | 'reflectionSkew')[] = [
  'reflection', 'reflectionSurfaceY', 'reflectionOpacityMain', 'reflectionOpacity',
  'reflectionDistance', 'reflectionFeather', 'reflectionBlur', 'reflectionGrid', 'reflectionMirrorY', 'reflectionSkew',
];

// Pose properties that can be "held" constant across IN/HOLD/OUT (and therefore the
// whole deck) via a per-slider toggle in the Animation panel.
export type PoseLockKey = 'x' | 'y' | 'rotateX' | 'rotateY';
export type PoseLocks = Partial<Record<PoseLockKey, boolean>>;

// Deck-level horizontal alignment — every page sits flush to that edge of the frame. Pages can
// differ in aspect (and crop), so they render at different widths and one deck-level pose X can
// never line them up. It is therefore a MODE resolved per page from that page's own rendered box,
// not a baked per-page offset: a page pasted later aligns with the rest, and it stays independent
// of the per-slide position Override.
export type SlideAlign = 'left' | 'right';

export interface DeckStyles {
  presentation?: Partial<Omit<SlidePresentationStyle, 'in' | 'hold' | 'out'>>
    & { in?: Partial<PresPose>; hold?: Partial<PresPose>; out?: Partial<PresPose> };
  poseLocks?: PoseLocks;
  align?: SlideAlign;              // deck-wide left/right alignment (undefined = the poses' own X)
  alignPad?: number;               // px inset from that edge, in the 1920-space (default 0 = flush)
  border?: Partial<SlideBorder>;
  surface?: Partial<SlideSurface>; // deck-level surface reflection (shared by all pages)
  // Keyed by the page's STABLE MANIFEST ID — never its index. The manifest index is mutable: a
  // paste/reorder/delete repoints it at different content, so index-keyed styling stays on the SLOT
  // while the page moves away from it (BUG-701). `notes` was always keyed this way; styles are too.
  pages?: Record<string, Partial<SlidePageStyle>>;
  crops?: Record<string, { x: number; y: number; w: number; h: number }>; // per aspect-ratio group (aspectKey → crop)
  // Per-slide pose Override, keyed by aspect-ratio GROUP (aspectKey) exactly like `crops` — so setting
  // an override on one slide applies to every slide of the SAME dimension, including ones added later.
  overrides?: Record<string, Partial<SlidePageStyle>>;
  notes?: Record<string, string>; // per-slide rich-text notes (HTML) keyed by the page's manifest id
  // Deck-level heading LOOK + appearance animation — one typeface/colour/shadow/padding for every
  // page's heading, so a deck reads as one presentation.
  heading?: Partial<SlideHeadingStyle>;
  // Per-page heading TEXT, keyed by the page's stable manifest id like `notes` and `pages`.
  headings?: Record<string, SlidePageHeading>;
  // Deck-level sound effect played on every slide CHANGE (a page step), shared by all pages.
  // `url` is an audio-library url (/api/titles/audio/<name>, same library the Clipboard uses);
  // empty url = silent. `volume` is 0–100.
  sound?: { url: string; volume: number };
  // Deck-level background music bed — a Music-tab playlist that plays (crossfaded, optionally
  // looping) while the deck is on air. `volume` (0..1) is the bed's own general volume, entirely
  // separate from the slide-change `sound` above. Plays on the operator's machine only, never OBS.
  music?: { playlistId: string | null; volume: number; loop: boolean };
  // Deck-level background video — a Clip Manager clip that plays FULL-SCREEN, looping and muted,
  // in the overlay's video layer behind the slides for as long as the deck is on air. The server
  // starts and stops it with the deck (dispatchOverlayCommand, asset 'slides'), so it follows the
  // timeline as well as the Show in Overlay button.
  backgroundVideo?: { clipId: string | null; title?: string };
}

export const DEFAULT_SLIDE_SOUND: { url: string; volume: number } = { url: '', volume: 100 };
export function resolveSlideSound(s?: DeckStyles['sound']): { url: string; volume: number } {
  return { ...DEFAULT_SLIDE_SOUND, ...(s ?? {}) };
}

export interface SlideMusic { playlistId: string | null; volume: number; loop: boolean }
export const DEFAULT_SLIDE_MUSIC: SlideMusic = { playlistId: null, volume: 0.7, loop: true };
export function resolveSlideMusic(m?: DeckStyles['music']): SlideMusic {
  return { ...DEFAULT_SLIDE_MUSIC, ...(m ?? {}) };
}

// ── Slide heading ─────────────────────────────────────────────────────────────
// A line of text ATTACHED to the slide — it sits on the slide's own box (directly above it) and
// rides the slide's pose, so it moves, tilts and scales with the picture. It is shown only once the
// slide is AT HOLD: never during the IN or the OUT, where the slide is travelling and a title
// chasing it reads as a second moving object.
export type SlideHeadingAppear = 'none' | 'fade' | 'blur' | 'rise' | 'drop' | 'slide' | 'zoom' | 'typewriter';
// Where the title sits on the slide's box: over its top edge, just inside the top or bottom, or under it.
export type SlideHeadingAnchor = 'above' | 'top' | 'bottom' | 'below';

// Deck-wide: one look and one appearance for every heading in the deck.
export interface SlideHeadingStyle {
  font: string;          // a BUNDLED family (FontSelect / ensureFont) — never a hand-typed CSS stack
  size: number;          // px in the 1920-space
  color: string;
  shadowBlur: number; shadowX: number; shadowY: number; shadowColor: string;
  padding: number;       // px inset inside the heading box — also its gap from the slide's top edge
  appear: SlideHeadingAppear;
  speed: number;         // 1..100, higher = faster; headingTiming() maps it per appear mode
  anchor: SlideHeadingAnchor;
  align: 'left' | 'center' | 'right';
  offsetX: number; offsetY: number;  // px in the 1920-space, a nudge from the anchor
  scale: number;         // % — scales the whole title box (text, padding, shadow) about its anchor
}

// Per page: the text, and whether it CONTINUES onto the following slides until another page
// carries a heading of its own.
export interface SlidePageHeading { text: string; carry?: boolean }

export const DEFAULT_HEADING_STYLE: SlideHeadingStyle = {
  font: '', size: 56, color: '#ffffff',
  shadowBlur: 12, shadowX: 0, shadowY: 2, shadowColor: 'rgba(0,0,0,0.75)',
  padding: 16, appear: 'blur', speed: 50,
  anchor: 'above', align: 'left', offsetX: 0, offsetY: 0, scale: 100,
};

export function resolveHeadingStyle(h?: Partial<SlideHeadingStyle>): SlideHeadingStyle {
  return { ...DEFAULT_HEADING_STYLE, ...(h ?? {}) };
}

// One Speed slider serves both appearances, because the operator is setting one thing: how fast the
// title arrives. `revealMs` is the blur/fade span, `charMs` the typewriter's per-letter step.
export function headingTiming(h: SlideHeadingStyle): { revealMs: number; charMs: number } {
  const s = Math.max(1, Math.min(100, h.speed ?? DEFAULT_HEADING_STYLE.speed));
  return { revealMs: Math.round(2600 - s * 24), charMs: Math.round(200 - s * 1.9) };
}

export function headingShadowCss(h: SlideHeadingStyle, scale = 1): string | undefined {
  if (!h.shadowBlur && !h.shadowX && !h.shadowY) return undefined;
  return `${h.shadowX * scale}px ${h.shadowY * scale}px ${h.shadowBlur * scale}px ${h.shadowColor}`;
}

/**
 * The heading a page actually SHOWS. Its own text wins; otherwise walk back to the nearest earlier
 * page that has one and take it only if that page said "continue till the next title". A page with
 * text but no carry ENDS the run — the slides after it are bare until another heading starts.
 * Hidden pages are skipped, so hiding a slide can't silently end a run.
 */
export function headingForPage(
  headings: Record<string, SlidePageHeading> | undefined,
  manifest: { id: string; hidden?: boolean }[] | undefined,
  page1: number,
): string {
  if (!headings) return '';
  const own = manifest?.[page1 - 1]?.id ? headings[manifest[page1 - 1]!.id] : undefined;
  if (own?.text) return own.text;
  if (!manifest) return '';
  for (let i = page1 - 2; i >= 0; i--) {
    const entry = manifest[i];
    if (!entry || entry.hidden) continue;
    const h = headings[entry.id];
    if (!h?.text) continue;
    return h.carry ? h.text : '';
  }
  return '';
}

// ── Style presets ────────────────────────────────────────────────────────────────
// A preset is the deck's LOOK, detached from its content. Only these keys travel: they
// are deck-wide scalars/objects that mean the same thing on any deck. `pages`, `crops`
// and `overrides` are keyed by manifest id / aspect group and `notes` / `headings` are per-page text —
// carrying any of them across decks would land styling on unrelated slides (the BUG-701
// slot-vs-page trap, one level up).
export const PRESET_KEYS = ['presentation', 'poseLocks', 'align', 'alignPad', 'border', 'surface', 'sound', 'music', 'heading'] as const;
export type SlidePresetStyles = Pick<DeckStyles, typeof PRESET_KEYS[number]>;

export function pickPresetStyles(ds: DeckStyles): SlidePresetStyles {
  const out: SlidePresetStyles = {};
  for (const k of PRESET_KEYS) if (ds[k] !== undefined) (out as any)[k] = ds[k];
  return out;
}

// Apply a preset over a deck: the preset REPLACES each key it carries and drops the ones
// it doesn't (a preset saved with no align must clear an align already on the deck, or
// applying it leaves a look the preset never described). Content keys pass through.
export function applyPresetStyles(ds: DeckStyles, preset: SlidePresetStyles): DeckStyles {
  const next: DeckStyles = { ...ds };
  for (const k of PRESET_KEYS) delete next[k];
  return { ...next, ...pickPresetStyles(preset as DeckStyles) };
}

// The pose-override fields at their neutral values — spread after the per-page look so a legacy
// per-page override can't leak in; the live aspect-keyed override (DeckStyles.overrides) spreads last.
export const DEFAULT_POSE_OVERRIDE: Partial<SlidePageStyle> = {
  posOverride: false, posX: 0, posY: 0, posScale: 1, posZ: 0, posRotateX: 0, posRotateY: 0, posPerspective: 0, posOpacity: 0,
};

export const DEFAULT_EASING: number[] = [0.4, 0, 0.2, 1];
export const DEFAULT_POSE: PresPose = { x: 0, y: 0, z: 0, scale: 1, opacity: 100, rotateX: 0, rotateY: 0, perspective: 0 };
// Default page transition for a deck with NO custom animation: a horizontal CAROUSEL.
// IN parks the page one full frame to the RIGHT (x +1920), OUT one full frame to the
// LEFT (x -1920), HOLD centered — all opaque (opacity 100). So stepping next slides the
// current page out to the left while the next slides in from the right, one page at rest.
// Show=hide duration keeps the two layers moving in sync (a filmstrip). A configured pose
// (stored with explicit x) overrides these. Fade is optional — set IN/OUT opacity to 0
// in the Animation panel to slide + fade.
export const DEFAULT_CAROUSEL_IN: PresPose = { ...DEFAULT_POSE, x: 1920 };
export const DEFAULT_CAROUSEL_OUT: PresPose = { ...DEFAULT_POSE, x: -1920 };

export const DEFAULT_PRESENTATION: SlidePresentationStyle = {
  in: { ...DEFAULT_CAROUSEL_IN }, hold: { ...DEFAULT_POSE }, out: { ...DEFAULT_CAROUSEL_OUT },
  showDuration: 600, showEasing: DEFAULT_EASING,
  hideDuration: 600, hideEasing: DEFAULT_EASING,
  bounceAmount: 0, bounceCount: 1, bounceDuration: 4000,
};

export const DEFAULT_BORDER: SlideBorder = { borderWidth: 0, borderColor: '#ffffff', borderStyle: 'solid', borderRadius: 0 };

export const DEFAULT_PAGE: SlidePageStyle = {
  reflection: false, reflectionOpacityMain: 100, reflectionOpacity: 50, reflectionDistance: 0, reflectionFeather: 67,
  reflectionSurfaceY: DEFAULT_SURFACE_Y, reflectionBlur: 0, reflectionGrid: false,
  shadowBlur: 0, shadowX: 0, shadowY: 0, shadowColor: 'rgba(0,0,0,0.5)',
  thickness: 0,
  posOverride: false, posX: 0, posY: 0, posScale: 1, posZ: 0, posRotateX: 0, posRotateY: 0, posPerspective: 0, posOpacity: 0,
  videoVolume: 100,
  ...DEFAULT_BORDER,
};

// CSS cubic-bezier() from a stored 4-tuple (x1,y1,x2,y2); undefined if invalid.
export function cubicBezier(e: number[] | undefined): string | undefined {
  if (!Array.isArray(e) || e.length !== 4 || e.some(n => typeof n !== 'number')) return undefined;
  return `cubic-bezier(${e[0]}, ${e[1]}, ${e[2]}, ${e[3]})`;
}

export function resolvePose(p?: Partial<PresPose>, base: PresPose = DEFAULT_POSE): PresPose {
  return { ...base, ...(p ?? {}) };
}
export function resolvePresentation(p?: DeckStyles['presentation']): SlidePresentationStyle {
  return {
    // IN/OUT default to a horizontal carousel (off-right / off-left) so an un-styled deck
    // slides page-to-page instead of hard-cutting or ghosting.
    in: resolvePose(p?.in, DEFAULT_CAROUSEL_IN), hold: resolvePose(p?.hold), out: resolvePose(p?.out, DEFAULT_CAROUSEL_OUT),
    showDuration: p?.showDuration ?? DEFAULT_PRESENTATION.showDuration,
    showEasing: p?.showEasing ?? DEFAULT_PRESENTATION.showEasing,
    hideDuration: p?.hideDuration ?? DEFAULT_PRESENTATION.hideDuration,
    hideEasing: p?.hideEasing ?? DEFAULT_PRESENTATION.hideEasing,
    bounceAmount: p?.bounceAmount ?? DEFAULT_PRESENTATION.bounceAmount,
    bounceCount: p?.bounceCount ?? DEFAULT_PRESENTATION.bounceCount,
    bounceDuration: p?.bounceDuration ?? DEFAULT_PRESENTATION.bounceDuration,
  };
}
export function resolveBorder(b?: Partial<SlideBorder>): SlideBorder {
  return { ...DEFAULT_BORDER, ...(b ?? {}) };
}

// Poses are authored in this space; the canvas and the overlay both scale that stage to their box.
export const SLIDE_FRAME_W = 1920;
export const SLIDE_FRAME_H = 1080;

/**
 * Width of the **Display Viewport** in the 1920-space — the configured output aspect (Settings →
 * Lower Thirds Aspect Ratio, e.g. '1440x1080'), contain-fit into the 16:9 pose stage. This is the
 * dotted rect the canvas draws, i.e. the edge of what the output actually shows, so it is what
 * align measures against: at 16:9 it IS the stage (1920) and align is flush to the frame; at a
 * narrower output the stage is pillarboxed and aligning to 1920 would push the slide out of frame.
 * Mirrored server-side as viewportWidth() in slides/manifest.ts.
 */
export function viewportWidth(aspectRatio: string | undefined): number {
  const [w, h] = (aspectRatio || '1920x1080').split('x').map(Number);
  const a = w && h ? w / h : SLIDE_FRAME_W / SLIDE_FRAME_H;
  return Math.min(SLIDE_FRAME_W, SLIDE_FRAME_H * a);
}

/**
 * Deck-level align: shift all three poses so this page's rendered box sits against the **Display
 * Viewport**'s left/right edge (`vpW` wide, centred in the stage), inset by `pad` px. `boxW` is the
 * page's own width in the 1920-space at scale 1 (cropLayout), so every page of a mixed-aspect deck
 * lands on the same edge however wide it renders — and `pad` is one deck-wide number, so they stay
 * flush with each other as it moves.
 *
 * A page with its own position Override is placed by hand — it opts OUT of the deck's align and
 * keeps its posX (`slidePresentation` below wires that up). Align and Override never combine.
 */
export function applyDeckAlign(
  pres: SlidePresentationStyle,
  align: SlideAlign | undefined,
  boxW: number | undefined,
  pad = 0,
  vpW = SLIDE_FRAME_W,
): SlidePresentationStyle {
  if (!align || !boxW) return pres;
  // `boxW` and a pose's `x` are LOCAL (unprojected); the viewport edge is SCREEN space. A page posed
  // at depth renders foreshortened by `f`, and its local x projects by that same factor — so a local
  // x compared straight against the edge lands at f×(the intended offset) and the deck stops short
  // of the edge (BUG-714). Convert the edge into the pose's local space instead.
  const f = poseForeshorten(pres, pres.hold);
  const halfW = (boxW * pres.hold.scale) / 2;
  const edge = (vpW / 2 - pad) / f - halfW;
  const dx = Math.round((align === 'left' ? -edge : edge) - pres.hold.x);
  if (dx === 0) return pres;
  const adj = (p: PresPose): PresPose => ({ ...p, x: p.x + dx });
  return { ...pres, in: adj(pres.in), hold: adj(pres.hold), out: adj(pres.out) };
}

/**
 * The poses one page actually renders at: the deck's align for a normal page, or the page's own
 * position Override when it has one. The single source of truth for the canvas and (mirrored in
 * the server's resolveSlideStyles) the overlay. `aspectRatio` = the configured output aspect, which
 * sets the Display Viewport edge that align lands on.
 */
export function slidePresentation(
  pres: SlidePresentationStyle,
  ds: Pick<DeckStyles, 'align' | 'alignPad'>,
  boxW: number | undefined,
  page?: Partial<SlidePageStyle> | null,
  aspectRatio?: string,
): SlidePresentationStyle {
  return page?.posOverride
    ? applyPageOffset(pres, page)
    : applyDeckAlign(pres, ds.align, boxW, ds.alignPad ?? 0, viewportWidth(aspectRatio));
}

// Bake a page's per-slide pose override into all three poses. The offsets (posX/posY/posZ/posRotateX/
// posRotateY) are ADDED and the scale multiplier (posScale) is applied EQUALLY to IN/HOLD/OUT, and
// posPerspective (when > 0) REPLACES the pose perspective — so the whole animation trajectory shifts,
// rescales and re-tilts without changing the entrance/exit motion. Returns the presentation unchanged
// when the page has no override.
export function applyPageOffset(pres: SlidePresentationStyle, page?: Partial<SlidePageStyle> | null): SlidePresentationStyle {
  if (!page?.posOverride) return pres;
  const dx = page.posX ?? 0, dy = page.posY ?? 0, sf = page.posScale ?? 1;
  const dz = page.posZ ?? 0, drx = page.posRotateX ?? 0, dry = page.posRotateY ?? 0, pp = page.posPerspective ?? 0, dop = page.posOpacity ?? 0;
  if (dx === 0 && dy === 0 && sf === 1 && dz === 0 && drx === 0 && dry === 0 && pp === 0 && dop === 0) return pres;
  const adj = (p: PresPose): PresPose => ({
    ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz, scale: p.scale * sf,
    rotateX: p.rotateX + drx, rotateY: p.rotateY + dry, perspective: pp > 0 ? pp : p.perspective,
    opacity: Math.max(0, Math.min(100, p.opacity + dop)),
  });
  return { ...pres, in: adj(pres.in), hold: adj(pres.hold), out: adj(pres.out) };
}
export function resolvePage(p?: Partial<SlidePageStyle>): SlidePageStyle {
  return { ...DEFAULT_PAGE, ...(p ?? {}) };
}
export function resolveSurface(s?: Partial<SlideSurface>): SlideSurface {
  return { ...DEFAULT_SURFACE, ...(s ?? {}) };
}

/**
 * Re-key legacy index-keyed page styles onto the page's stable manifest id (BUG-701).
 *
 * `pages` was once `{ "1": …, "2": … }` — the page's 1-based manifest INDEX. That index is mutable,
 * so a reorder left the styling on the slot and it landed on whatever page moved into it. The numeric
 * keys describe the deck's CURRENT order, so this must run against the live manifest; it is a no-op
 * once migrated, and safe to run on every parse. Any style already keyed by id is left untouched, so
 * a half-migrated deck converges.
 *
 * A deck whose order was ALREADY scrambled by a past reorder cannot be recovered — the association
 * this bakes in is whatever the slots currently say. That styling has to be redone by hand once.
 */
export function migratePageStyles(ds: DeckStyles, manifest: { id: string }[] | undefined): DeckStyles {
  const pages = ds.pages;
  if (!pages || !manifest?.length) return ds;
  if (!Object.keys(pages).some(k => /^\d+$/.test(k))) return ds;
  const next: Record<string, Partial<SlidePageStyle>> = {};
  for (const [key, style] of Object.entries(pages)) {
    if (!style) continue;
    const id = /^\d+$/.test(key) ? manifest[Number(key) - 1]?.id : key;
    if (id) next[id] = { ...(next[id] ?? {}), ...style };
  }
  return { ...ds, pages: next };
}

// Migrate/clean a deck's styles: reflection was once stored per page, which let the pages drift
// apart. Hoist a legacy deck's reflection up to the deck-level `surface` (preferring a page that
// had it ON) and STRIP the orphan reflection fields from every page. A no-op once migrated, so it
// is safe to run on every parse; the cleaned shape persists on the deck's next style write.
export function normalizeDeckStyles(ds: DeckStyles): DeckStyles {
  const pages = ds.pages;
  if (!pages) return ds;
  // Iterate the entries as they are: page keys are stable manifest IDS (BUG-701), so the old
  // `Object.keys().map(Number)` would resolve every key to NaN and drop the whole style map.
  const entries = Object.entries(pages).filter(([, pg]) => !!pg);
  let surface = ds.surface;
  let changed = false;

  if (!surface) {
    const pick = (test: (pg: any) => boolean) => entries.find(([, pg]) => test(pg))?.[1];
    const src = pick(pg => !!pg.reflection) ?? pick(pg => SURFACE_KEYS.some(k => k in pg));
    if (src) {
      const s: any = {};
      for (const k of SURFACE_KEYS) if (k in src) s[k] = (src as any)[k];
      surface = s; changed = true;
    }
  }

  const cleaned: Record<string, Partial<SlidePageStyle>> = {};
  for (const [key, pg0] of entries) {
    const pg: any = { ...pg0 };
    for (const k of SURFACE_KEYS) if (k in pg) { delete pg[k]; changed = true; }
    cleaned[key] = pg;
  }

  return changed ? { ...ds, surface, pages: cleaned } : ds;
}

// Tween (duration + easing) for moving INTO a target state: HOLD uses the IN tween,
// OUT uses the OUT tween, IN snaps (it is the entry pose).
export function tweenForTarget(p: SlidePresentationStyle, target: SlideState): { ms: number; ease: number[] } {
  // OUT is on the hold↔out (hide) segment; IN and HOLD are on the in↔hold (show) segment. These
  // buttons are editor previews, so arriving at IN animates over the show tween too (HOLD→IN reverse-
  // animates) instead of snapping — a 0ms "in" was why HOLD→IN had no transition.
  if (target === 'out') return { ms: p.hideDuration, ease: p.hideEasing };
  return { ms: p.showDuration, ease: p.showEasing };
}

// Viewer perspective (CSS `perspective` property, px) for a pose — set on an
// ancestor of the preserve-3d wrapper so tilt + slab thickness read as real 3D.
// A tilt/depth with no explicit perspective falls back to 1200px.
export function presentationPerspectivePx(pose: PresPose, k = 1): number | undefined {
  const needs3d = !!(pose.rotateX || pose.rotateY || pose.z);
  const persp = pose.perspective > 0 ? pose.perspective : (needs3d ? 1200 : 0);
  return persp ? persp * k : undefined;
}

// How much a pose's depth shrinks it on screen. The renderer fixes ONE perspective context for the
// whole tween (the max across the three poses — see SlideLayer), so a pose at depth `z` renders at
// p/(p-z) of its local size and its local x/y offsets project by that same factor. 1 = no depth.
// Mirrored server-side in resolveSlideStyles.
export function poseForeshorten(pres: SlidePresentationStyle, pose: PresPose): number {
  const p = Math.max(
    presentationPerspectivePx(pres.in) ?? 0,
    presentationPerspectivePx(pres.hold) ?? 0,
    presentationPerspectivePx(pres.out) ?? 0,
  );
  const d = p - (pose.z || 0);
  return p > 0 && d > 0 ? p / d : 1;
}

// A pose's transform (NO perspective — that's the CSS property above). translateZ
// is outermost so `z` is distance-from-camera regardless of tilt. `k` scales px for
// previews rendered smaller than the 1920-space overlay.
//
// Every function is ALWAYS emitted, even at its identity value. CSS only interpolates a
// transition component-wise when the two transform lists have the SAME function list;
// otherwise it decomposes both to matrices and interpolates that (rotation gets
// quaternion-slerped, a negative scale becomes a 180° spin). Omitting identity functions
// made the list shape depend on the pose, so IN→HOLD silently fell back to matrix
// interpolation whenever one endpoint had a rotation/depth the other lacked.
export function presentationTransform(pose: PresPose, k = 1): string {
  return [
    `translateZ(${(pose.z || 0) * k}px)`,
    `translate(${(pose.x || 0) * k}px, ${(pose.y || 0) * k}px)`,
    `rotateX(${pose.rotateX || 0}deg)`,
    `rotateY(${pose.rotateY || 0}deg)`,
    `scale(${pose.scale ?? 1})`,
  ].join(' ');
}

// A pose's opacity as a 0–1 CSS value (stored 0–100 in the pose).
export function presentationOpacity(pose: PresPose): number {
  const o = pose.opacity ?? 100;
  return Math.max(0, Math.min(1, o / 100));
}

// Shared @keyframes name for the Hold-state waft.
export const BOUNCE_KEYFRAME_NAME = 'sm-slide-bounce';

// The waft is a CONTINUATION of HOLD, not a settle on arrival: once the slide reaches its HOLD pose
// it keeps drifting gently on all three axes, as if wafting in moving air, for as long as it holds.
// So the curve must not decay, and it must loop forever without a seam.
//
// Each axis is a plain sine at an INTEGER number of cycles per loop, phase 0. That buys three things
// at once: every axis starts at 0 displacement (the waft begins from the exact HOLD pose, no jump
// when the delay expires), t=0 and t=1 agree in both value AND velocity (so `infinite` loops with no
// visible hitch), and the 1:2:3 frequency ratio keeps the axes out of phase with each other, tracing
// a slow 3D Lissajous drift that reads organic instead of a mechanical throb. Z is the shallowest
// (depth reads as a size pulse under the pose's perspective, which is the most distracting axis).
// `amountPx` is the (already scaled) peak X displacement; `cycles` is the wafts per loop.
/**
 * The waft's displacement at a point in its loop, `t` running 0→1. Exported because the
 * Guests name plate wafts on this same curve but cannot use `bounceKeyframes`: its plate is a
 * pseudo-element inside VDO.Ninja's page, so the drift has to be compiled into the middle of
 * a single composite keyframe rather than run as an animation of its own.
 */
export function waftOffset(t: number, amountPx: number, cycles = 1): { x: number; y: number; z: number } {
  return {
    x: amountPx * Math.sin(2 * Math.PI * cycles * t),
    y: amountPx * 0.6 * Math.sin(2 * Math.PI * 2 * cycles * t),
    z: amountPx * 0.4 * Math.sin(2 * Math.PI * 3 * cycles * t),
  };
}

export function bounceKeyframes(amountPx: number, cycles: number): string {
  if (!amountPx || cycles <= 0) return '';
  // Sample densely enough for the fastest axis (3×cycles) to stay a smooth sine, not a zigzag.
  const steps = Math.min(360, Math.max(24, Math.ceil(cycles * 3 * 12)));
  let body = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const { x, y, z } = waftOffset(t, amountPx, cycles);
    body += `${(t * 100).toFixed(2)}%{transform:translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,${z.toFixed(2)}px)}`;
  }
  return `@keyframes ${BOUNCE_KEYFRAME_NAME}{${body}}`;
}

// CSS `animation` shorthand for the waft, starting once the IN→HOLD tween lands (delayMs) and then
// running for the whole hold. `both` holds the 0% frame (zero displacement) through the delay, so
// the slide flies IN to its exact pose and only then starts drifting.
//
// SPEED is set ONLY by the per-waft time, floored to WAFT_MIN_MS so it always reads as a slow drift,
// never a buzz (BUG-724: a sub-second loop packing several cycles ran the axes at 5–15 Hz). bounceCount
// stretches the loop to hold that many wafts (variety) WITHOUT speeding any cycle up: the keyframe emits
// `bounceCount` X-cycles, so the total duration must scale by the same factor to keep each cycle slow.
export const WAFT_MIN_MS = 3000;
export function bounceAnimation(p: SlidePresentationStyle, delayMs: number): string | undefined {
  if (!p.bounceAmount || p.bounceCount <= 0) return undefined;
  const loopMs = Math.max(WAFT_MIN_MS, p.bounceDuration) * p.bounceCount;
  return `${BOUNCE_KEYFRAME_NAME} ${loopMs}ms linear ${delayMs}ms infinite both`;
}

// Surface reflection (slides) — the slide MIRRORED in the floor, about the horizontal SURFACE line at
// reflectionSurfaceY (fraction of the 1080 frame): the same line the editor draws and the perspective
// grid vanishes to. The slide sits `d` above the line, its reflection `d` below it, upside down.
//
// It is a 2D flip of the slide's RENDERED image, applied by a wrapper OUTSIDE the slide's perspective
// context (which is duplicated inside it — see SlidePoseView). Two consequences, both wanted:
//   • Exact. The reflection is a mirror of whatever the slide looks like on that frame, so it cannot
//     drift mid-tween. The original code folded the mirror into a pre-computed `reflectedY` number that
//     CSS then transitioned LINEARLY, so it was only a mirror at the IN/HOLD/OUT endpoints (invisible
//     at 600ms, glaring at 8000ms — BUG-617).
//   • The fold lands on the DRAWN line at any depth. A true 3D mirror plane at world-y=d projects to
//     screen y = d·P/(P−z), so its fold would climb toward the horizon as the slide recedes and the
//     reflection would ride up above the line.
// The reflection lives in the FLOOR plane, never in the slide's own tilted plane — tilt the slide and
// its reflection tilts the opposite way, as a mirror does, instead of running off with it.
//
// `distance` (manual Distance) pushes it further below the line; `k` scales px for previews.
const FRAME_H_1080 = 1080;
export function surfaceMirrorTransform(surfaceY: number, distance = 0, frameH = FRAME_H_1080, k = 1): string {
  const s = Math.max(0, Math.min(1, surfaceY));
  // Flip about the frame centre (transform-origin), then drop by twice the centre→surface gap, so the
  // surface line is the flip's fixed point: screen y ↦ 2·surfaceY·frameH − y. Measured off the REAL
  // frame height, not 1080·k — those agree only while the stage is exactly 16:9.
  const mirrorY = (2 * s - 1) * frameH + distance * k;
  return `translateY(${mirrorY}px) scaleY(-1)`;
}

// Screen y of the surface line, plus the manual Distance gap. The reflection is clipped to below it:
// a floor doesn't reflect into the air. Tilt a slide far enough (high Yaw, low Pitch) and its near
// bottom corner drops BELOW the line; that corner's reflection rises above the line, where the opaque
// slide paints over it — the reflection then looks sliced along the slide's own edge.
export function surfaceLinePx(surfaceY: number, distance = 0, frameH = FRAME_H_1080, k = 1): number {
  const s = Math.max(0, Math.min(1, surfaceY));
  return s * frameH + distance * k;
}

// Reflect % — the reflection's alpha at the edge that touches the slide.
export function reflectionAlpha(p: SlidePageStyle): number {
  return Math.max(0, Math.min(100, p.reflectionOpacity ?? 50)) / 100;
}

// Blur — softens the mirrored copy, as a matte floor does. Belongs on the mirror wrapper, which sits
// OUTSIDE the perspective context: `filter` is a CSS grouping property, so anywhere inside the 3D chain
// it would force transform-style:flat and collapse the slab's edge-on side walls. `k` scales px for
// previews, so the canvas and the overlay blur by the same visual amount.
export function reflectionBlurCss(p: SlidePageStyle, k = 1): string | undefined {
  const b = (p.reflectionBlur ?? 0) * k;
  return b > 0 ? `blur(${b.toFixed(2)}px)` : undefined;
}

// Feather + Reflect % as ONE mask, applied to each face of the reflected slab. The mask lives in each
// face's own (unflipped) local box, and the flip puts the local BOTTOM edge against the slide — so
// hold `Reflect %` alpha at local-bottom and fade to nothing upward, away from the slide.
//
// `feather` is how much of the reflection is HELD at full Reflect % before the fade begins, measured
// from the edge touching the slide: 100 % = no fade, the whole reflection is visible top to bottom;
// 50 % = the near half solid, the far half fading out; 0 % = fading the entire way.
export function reflectionMaskCss(p: SlidePageStyle): CSSProperties {
  const feather = Math.max(0, Math.min(100, p.reflectionFeather ?? 67));
  const alpha = reflectionAlpha(p);
  const grad = `linear-gradient(to top, rgba(0,0,0,${alpha}) ${feather}%, transparent)`;
  return {
    WebkitMaskImage: grad, maskImage: grad,
    WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
    WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
  };
}

// Border / rounded-corner CSS for a slide's front face (and its reflection). `k` scales
// px for previews rendered smaller than the overlay.
export function borderCss(p: SlidePageStyle, k = 1): CSSProperties {
  const w = (p.borderWidth ?? 0) * k;
  const r = (p.borderRadius ?? 0) * k;
  const out: CSSProperties = {};
  if (w > 0) { out.border = `${w}px ${p.borderStyle || 'solid'} ${p.borderColor || '#ffffff'}`; out.boxSizing = 'border-box'; }
  if (r > 0) out.borderRadius = r;
  return out;
}

// Drop-shadow box-shadow string for a page's slide image (opaque rectangle).
export function shadowCss(p: SlidePageStyle): CSSProperties {
  if (!p.shadowBlur && !p.shadowX && !p.shadowY) return {};
  return { boxShadow: `${p.shadowX}px ${p.shadowY}px ${p.shadowBlur}px ${p.shadowColor || 'rgba(0,0,0,0.5)'}` };
}
