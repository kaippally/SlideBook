import { isCardKind, type CardKind } from './cardKinds';
import { aspectKey, cropForAspect, cropLayout, type SlideCrop } from '../components/slideCrop';
import {
  DEFAULT_POSE_OVERRIDE, SLIDE_FRAME_H, SLIDE_FRAME_W, headingForPage, resolveBorder, resolveHeadingStyle,
  resolvePage, resolvePresentation, resolveSlideSound, resolveSurface, slidePresentation,
  type SlidePageStyle, type SlidePresentationStyle,
} from '../components/slideStyles';
import type { SlideHeadingModel } from '../components/SlidePoseView';
import type { SlideCard } from '../components/SlideObject';
import type { SlideLayerModel } from '../components/SlideLayer';
import { cardSize, resolveCardStyle } from './cardStyle';
import type { Book, PageEntry } from './types';

// The ONE resolver from (book, page) to what the renderer draws. The canvas, the page strip and the
// OBS output all go through it, so a page cannot look one way in the editor and another on air.

export const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const isCard = (p: PageEntry | undefined | null) => !!p && isCardKind(p.kind);

export function pageSrc(p: PageEntry | undefined): string {
  return p?.ref ? `/media/${p.ref}` : BLANK;
}

export function pageAspect(book: Book, p: PageEntry | undefined): number {
  if (isCard(p)) return book.cardAspect || 16 / 9;
  return p?.aspect || 16 / 9;
}

export interface ResolvedPage {
  entry: PageEntry | undefined;
  src: string;
  videoSrc?: string;
  card?: SlideCard;
  crop: SlideCrop | undefined;
  aspect: number;
  pageStyle: SlidePageStyle;
  rawPres: SlidePresentationStyle;
  pres: SlidePresentationStyle;
  heading: SlideHeadingModel | null;
}

export function resolveBookPage(book: Book, n: number): ResolvedPage {
  const styles = book.styles ?? {};
  const entry = book.manifest[n - 1];
  const aspect = pageAspect(book, entry);
  const crop = isCard(entry) ? undefined : cropForAspect(styles.crops, aspect);
  const override = styles.overrides?.[aspectKey(aspect)];
  const pageStyle: SlidePageStyle = {
    ...resolvePage(entry ? styles.pages?.[entry.id] : undefined), ...DEFAULT_POSE_OVERRIDE,
    ...resolveSurface(styles.surface), ...resolveBorder(styles.border), ...(override ?? {}),
  };
  const rawPres = resolvePresentation(styles.presentation);
  const size = isCard(entry) ? cardSize(styles.card) : undefined;
  const box = cropLayout(crop, aspect, SLIDE_FRAME_W, SLIDE_FRAME_H)?.box;
  const boxW = size ? SLIDE_FRAME_W * size.w : typeof box?.width === 'number' ? box.width : undefined;
  const pres = slidePresentation(rawPres, styles, boxW, pageStyle, '1920x1080');
  const text = headingForPage(styles.headings, book.manifest, n);
  const card: SlideCard | undefined = isCard(entry) && entry!.card
    ? { kind: entry!.kind as CardKind, card: entry!.card, style: resolveCardStyle(styles.card) }
    : undefined;
  return {
    entry, src: pageSrc(entry), videoSrc: entry?.kind === 'video' && entry.video ? `/media/${entry.video}` : undefined, card, crop, aspect, pageStyle, rawPres, pres,
    heading: text ? { text, style: resolveHeadingStyle(styles.heading) } : null,
  };
}

/** `muted`: a video slide plays silent (the canvas while the output is on air carries the sound). */
export function layerModel(book: Book, n: number, key: number, exiting = false, reverse = false, muted = false): SlideLayerModel {
  const r = resolveBookPage(book, n);
  return { key, src: r.src, videoSrc: r.videoSrc, card: r.card, crop: r.crop, aspect: r.aspect, pageStyle: muted ? { ...r.pageStyle, videoVolume: 0 } : r.pageStyle, pres: r.pres, heading: r.heading, exiting, reverse };
}

export function bookSound(book: Book) {
  return resolveSlideSound(book.styles?.sound);
}

export function fmtTime(sec: number | undefined): string {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
