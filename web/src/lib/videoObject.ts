import {
  DEFAULT_POSE_OVERRIDE, resolveBorder, resolvePage, resolvePresentation, resolveSurface,
  type PoseLocks, type SlidePageStyle, type SlidePresentationStyle, type SlideSurface,
} from '../components/slideStyles';
import type { SlideLayerModel } from '../components/SlideLayer';
import { BLANK, isCard } from './bookModel';
import type { Book } from './types';
import { sameSegment, segmentFirst, segmentKeyPage, segmentSpan, segments } from './segments';

/**
 * The book's video object: the source video as a second thing on the stage, posed, surfaced and
 * reflected exactly like a slide (`styles.video`). Stepping on air to a timed fact-check or fallacy
 * card plays that card's moment in it — PRE seconds before to POST seconds after — and the card
 * follows. The server decides that a step carries a clip (`live.clip`); `/output` plays it and reports
 * the end; the canvas plays the same sequence for the view.
 */
/** `after`: the clip plays, then the card arrives as the video leaves. `together`: both are up at once. */
export type ClipMode = 'after' | 'together';

export interface VideoObjectStyle {
  on?: boolean;
  mode?: ClipMode;
  pre?: number;
  post?: number;
  volume?: number;
  /** Longest clip in seconds; 0 = the whole segment. */
  maxLen?: number;
  /** The video box as % of the frame; unset = the video's own shape, as large as fits. */
  width?: number;
  height?: number;
  /** Blur the picture (to hide a face or a logo): on/off, and how much, px in the 1920 space. */
  blurOn?: boolean;
  blur?: number;
  /** Paused from the transport: the video object fades out until it plays again. */
  hideOnPause?: boolean;
  /** A segment's own clip range, set on the clip timeline, keyed by the segment's first page id. */
  ranges?: Record<string, { t0: number; t1: number }>;
  presentation?: Partial<SlidePresentationStyle>;
  page?: Partial<SlidePageStyle>;
  surface?: Partial<SlideSurface>;
  locks?: PoseLocks;
}

export const DEFAULT_VIDEO = { on: true, pre: 3, post: 3, volume: 100, maxLen: 60, blur: 24 };

// A new video object starts at 60%, so the slide behind it, its reflection and the surface all show.
const base = resolvePresentation();
const DEFAULT_VIDEO_PRES: Partial<SlidePresentationStyle> = {
  in: { ...base.in, scale: 0.6 }, hold: { ...base.hold, scale: 0.6 }, out: { ...base.out, scale: 0.6 },
};

export const videoStyle =(book: Book | null): VideoObjectStyle =>
  ((book?.styles as { video?: VideoObjectStyle } | undefined)?.video) ?? {};

export interface ResolvedVideo {
  file: string;
  on: boolean;
  mode: ClipMode;
  pre: number;
  post: number;
  volume: number;
  maxLen: number;
  blurOn: boolean;
  blur: number;
  hideOnPause: boolean;
  pres: SlidePresentationStyle;
  pageStyle: SlidePageStyle;
  surface: SlideSurface;
}

export function resolveVideo(book: Book | null): ResolvedVideo | null {
  const file = book?.source?.video;
  if (!book || !file) return null;
  const v = videoStyle(book);
  const surface = resolveSurface(v.surface ?? book.styles?.surface);
  return {
    file,
    on: v.on ?? DEFAULT_VIDEO.on,
    mode: v.mode === 'together' ? 'together' : 'after',
    pre: v.pre ?? DEFAULT_VIDEO.pre,
    post: v.post ?? DEFAULT_VIDEO.post,
    volume: v.volume ?? DEFAULT_VIDEO.volume,
    maxLen: v.maxLen ?? DEFAULT_VIDEO.maxLen,
    blurOn: !!v.blurOn,
    blur: v.blur ?? DEFAULT_VIDEO.blur,
    hideOnPause: !!v.hideOnPause,
    pres: resolvePresentation(v.presentation ?? DEFAULT_VIDEO_PRES),
    pageStyle: {
      ...resolvePage(v.page), ...DEFAULT_POSE_OVERRIDE, ...surface, ...resolveBorder(book.styles?.border),
      boxW: v.width, boxH: v.height, videoBlur: v.blurOn ? (v.blur ?? DEFAULT_VIDEO.blur) : 0,
    },
    surface,
  };
}

/** The clip a step to page `n` plays, or null. Stepping WITHIN a segment plays none: its clip already
 *  ran on entering it. `from` null = the page's own clip (▶ Clip). Mirrors the server's `_clip_for`. */
export function clipForStep(book: Book | null, n: number, from: number | null): { t0: number; t1: number } | null {
  const v = resolveVideo(book);
  const entry = book?.manifest[n - 1];
  // Every timed card plays its segment's clip — a question as much as a claim.
  if (!book || !v || !v.on || !entry || !segmentSpan(book, n)) return null;
  if (from != null && sameSegment(book, from, n)) return null;
  return playRange(book, n);
}

/** What a step to page `n` plays: its segment's clip, started early enough to run through every hidden
 *  segment just before it — their slides are skipped, their video is not. Mirrors the server's `_play_span`. */
export function playRange(book: Book, n: number): { t0: number; t1: number } | null {
  const own = segmentClip(book, n);
  if (!own) return null;
  let t0 = own.range.t0;
  const segs = segments(book);
  const i = segs.findIndex(s => s.pages.some(x => x.n === n));
  for (let k = i - 1; k >= 0; k--) {
    const s = segs[k]!;
    if (s.t == null || !s.pages.every(x => x.p.hidden)) break;
    const c = segmentClip(book, s.pages[0]!.n);
    if (!c) break;
    t0 = Math.min(t0, c.range.t0);
  }
  return { t0, t1: own.range.t1 };
}

/** A segment's clip: the range it plays (its own, when set on the clip timeline) and the automatic one
 *  (its statements, PRE before and POST after, no longer than `maxLen`). Mirrors `core._clip_span`. */
export function segmentClip(book: Book, n: number): { range: { t0: number; t1: number }; auto: { t0: number; t1: number }; custom: boolean; first: number; keyId: string } | null {
  const v = resolveVideo(book);
  const span = segmentSpan(book, n);
  if (!v || !span) return null;
  const t0 = Math.max(0, span.t - v.pre);
  // A question's span is its whole answer, minutes long; the clip stops at the longest the show wants.
  const auto = { t0, t1: v.maxLen > 0 ? Math.min(span.tEnd + v.post, t0 + v.maxLen) : span.tEnd + v.post };
  const first = segmentFirst(book, n);
  const keyId = segmentKeyPage(book, n)!.id;
  const own = videoStyle(book).ranges?.[keyId];
  return { range: own ?? auto, auto, custom: !!own, first, keyId };
}

/** The frame of `file` at `t` as a JPEG (`/api/poster`, cached): what a clip shows while it flies in
 *  and before its video can play, so it never appears as an empty frame. Rounded as the server rounds. */
export const posterUrl = (file: string, t: number) =>
  `/api/poster/${encodeURIComponent(file.split('/').pop()!)}?t=${(Math.round(Math.max(0, t) * 10) / 10).toFixed(1)}`;

/** A media fragment: the browser starts the file at t0 and pauses it at t1 by itself. */
export const clipSrc = (file: string, t0: number, t1?: number) => `${file}#t=${t0.toFixed(2)}${t1 != null ? `,${t1.toFixed(2)}` : ''}`;

export function videoLayerModel(v: ResolvedVideo, key: number, src: string, volume: number, exiting = false, poster = BLANK): SlideLayerModel {
  return {
    // `src` is the poster: SlideLayer holds the entrance until it has decoded, and the <video> shows it
    // until its own first frame is ready.
    key, src: poster, videoSrc: src, crop: undefined, aspect: 16 / 9,
    // `volume` is 0–1; a page style's `videoVolume` is 0–100. Passing the fraction straight through
    // played every clip at 1%.
    pageStyle: { ...v.pageStyle, videoVolume: Math.round(volume * 100) }, pres: v.pres, heading: null, exiting,
  };
}
