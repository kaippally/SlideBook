import type { DeckStyles } from '../components/slideStyles';
import type { CardStyle } from './cardStyle';

import type { CardKind } from './cardKinds';
export type { CardKind };
export type PageKind = 'pdf' | 'image' | CardKind;

export interface Card {
  title: string;
  body: string;
  verdict?: string;
  severity?: string;
  passage?: string;
  sources?: { label: string; note?: string }[];
  t?: number;
  tEnd?: number;
  speaker?: string;
  asker?: string;
  earlierT?: number;
  points?: string[];
  rows?: ScoreRow[];
}

export type ScoreRow = { speaker: string } & Record<string, number | string>;

export interface PageEntry {
  id: string;
  kind: PageKind;
  ref?: string;
  aspect?: number;
  hidden?: boolean;
  label?: string;
  card?: Card;
}

export interface BookStyles extends DeckStyles {
  card?: Partial<CardStyle>;
}

export interface TranscriptLine { t: number; d: number; text: string; speaker?: string }

export interface BookSource {
  url?: string;
  title?: string;
  uploader?: string;
  duration?: number;
  videoId?: string | null;
  start?: number;
  platform?: string;
  video?: string;
  lines?: TranscriptLine[];
  langCode?: string;
  transcriptVia?: string;
  generated?: boolean;
  language?: string;
  stance?: string;
  claims?: number;
  fallacies?: number;
  analysedAt?: number;
}

export interface Book {
  id: string;
  title: string;
  group: string;
  cardAspect: number;
  pageCount: number;
  rev: string;
  createdAt: number;
  updatedAt: number;
  styles: BookStyles;
  manifest: PageEntry[];
  source: BookSource;
}

export interface BookSummary {
  id: string;
  title: string;
  group: string;
  cardAspect: number;
  pageCount: number;
  rev: string;
  createdAt: number;
  updatedAt: number;
  first: PageEntry | null;
  sourceTitle: string;
  cards: number;
}

/** `clip.hold`: "Card after video" — the cursor is parked on a segment's clip stop, before its card.
 *  `frozen`: that clip was already played (Prev back onto it) and shows its last frame. */
export interface Cursor { bookId: string; page: number; clip?: { t0: number; t1: number; seq: number; hold?: boolean; frozen?: boolean } }

export interface ServerState { type: 'state'; view: Cursor | null; live: Cursor | null; event?: string; reverse?: boolean; action?: string; replay?: boolean }

export interface Job {
  id: number;
  url: string;
  origin: 'app' | 'studiomate-bot' | 'telegram' | 'video';
  options?: { video?: number; range?: [number, number]; [k: string]: unknown };
  status: 'awaiting' | 'pending' | 'running' | 'done' | 'failed';
  step: string;
  error: string;
  book_id: string | null;
  mode: string;
  created_at: number;
  updated_at: number;
}

export interface VideoItem {
  id: number;
  url: string;
  origin: string;
  title: string;
  uploader: string;
  duration: number;
  thumb: string;
  video: string;
  status: 'pending' | 'downloading' | 'ready' | 'failed';
  step: string;
  error: string;
  busy: string;
  summaries: { start: number; end: number; text: string; at: number }[];
  shorts: { start: number; end: number; url: string; at: number }[];
  subtitles: { start: number; end: number; lang: string; srt: string; vtt: string; lines: number; at: number }[];
  created_at: number;
}
