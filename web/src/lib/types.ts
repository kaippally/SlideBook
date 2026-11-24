import type { DeckStyles } from '../components/slideStyles';
import type { CardStyle } from './cardStyle';

import type { CardKind } from './cardKinds';
export type { CardKind };
export type PageKind = 'pdf' | 'image' | 'video' | CardKind;

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
  /** A video slide's file (under media/); `ref` is then its opening frame. */
  video?: string;
  /** An image / video slide's time slot: set when it is moved next to a timed slide, so it steps in that segment. */
  t?: number;
  aspect?: number;
  hidden?: boolean;
  label?: string;
  card?: Card;
}

/** A sound effect on the book's source video: plays when a clip on screen passes `t` (source seconds). */
export interface BookSfx { t: number; file: string; gain: number }

export interface BookStyles extends DeckStyles {
  card?: Partial<CardStyle>;
  sfx?: BookSfx[];
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
  recordId?: number | null;
}

export interface RecordRun {
  id: number; version: number; kind: 'analyse' | 'ask'; prompt: string; base_run: number | null; model: string;
  result: string; book_id: string | null; usage: Record<string, unknown>; created_at: number;
}

export interface VideoRecord {
  id: number; vkey: string; version: number; kind: 'debate' | 'plain'; url: string; title: string; duration: number;
  speakers: string[]; names: Record<string, string>; lineCount: number; videoId: string | null;
  analyses: number; asks: number; runs: RecordRun[];
}

/** `clip.hold`: "Card after video" — the cursor is parked on a segment's clip stop, before its card.
 *  `frozen`: that clip was already played (Prev back onto it) and shows its last frame. */
export interface Cursor { bookId: string; page: number; clip?: { t0: number; t1: number; seq: number; hold?: boolean; frozen?: boolean } }

export interface ServerState { type: 'state'; view: Cursor | null; live: Cursor | null; plain?: boolean; event?: string; reverse?: boolean; action?: string; replay?: boolean }

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
  senders?: { id: string; name: string; username: string; at: number }[];
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
  plans: ShortPlan[];
  transcriptState: 'none' | 'ready' | 'failed';
  transcribing: string;
  created_at: number;
}

export interface ShortPanel { zoom: number; x: number; y: number }

export interface ShortLayout {
  mode: 'fill' | 'fit' | 'split';
  zoom: number;
  x: number;
  y: number;
  split: number;
  panels: [ShortPanel, ShortPanel];
  sub: { show: boolean; font: string; size: number; color: string; highlight: string; outline: string; box: boolean;
    y: number; words: number; karaoke: boolean; lang: string };
  title: { show: boolean; text: string; font: string; size: number; color: string; bg: string; y: number };
}

export interface Virality {
  score: number; hook: number; emotion: number; clarity: number; shareability: number; novelty: number;
  why: string; tips: string; hooks?: string[];
}

export interface ShortRender { url: string; length: number; saved: string; at: number; full?: boolean; source?: string }

export interface ShortSfx { t: number; file: string; gain: number; why?: string }
/** A picture on the short's frame: x, y = its centre and w = its width, as fractions of 1080x1920; t is a source time, d seconds on screen. */
export interface ShortImage { id: number; url: string; prompt: string; why: string; t: number; d: number; x: number; y: number; w: number }
export type QueueState = 'waiting' | 'pictures' | 'ready' | 'rendering' | 'done' | 'failed';

export interface ShortPlan {
  id: number;
  title: string;
  hook: string;
  idea: string;
  span: [number, number];
  keep: [number, number][];
  virality: Virality;
  sfx: ShortSfx[];
  images?: ShortImage[];
  queue?: { state: QueueState; error: string; at: number };
  range?: [number, number];
  layout: ShortLayout;
  renders: ShortRender[];
  thumbPrompt: string;
  subs: Record<string, Record<string, string>>;
  length: number;
  over?: boolean;
  confirmed?: boolean;
  edited: boolean;
  at: number;
}

export interface Transcript { lines: TranscriptLine[]; ends: number[]; langCode: string; via: string; error: string; limit: number }
export interface SoundFx { file: string; name: string; use: string; url: string; user: boolean }
