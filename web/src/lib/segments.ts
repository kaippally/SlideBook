import { isCard } from './bookModel';
import type { Book, PageEntry } from './types';

/**
 * Time segments: consecutive pages whose cards sit at the same second of the source video are one
 * segment. The clip plays once, on entering a segment; the slides inside it then step on click or
 * arrow with no clip between them. `app/core.py` (`_seg_groups`) groups exactly the same way, so the
 * canvas and the output agree on when a clip plays.
 */
export const segKey = (p: PageEntry | undefined): number | null =>
  p && isCard(p) && p.card?.t != null ? Math.round(p.card.t) : null;

/** The segment index of every page (0-based by page). An untimed page is a segment of its own. */
export function segGroups(manifest: PageEntry[]): number[] {
  const out: number[] = [];
  let g = -1, prev: number | null = null;
  for (const p of manifest) {
    const k = segKey(p);
    if (k == null || k !== prev) g += 1;
    prev = k;
    out.push(g);
  }
  return out;
}

export interface Segment { t: number | null; pages: { p: PageEntry; n: number }[] }

export function segments(book: Book): Segment[] {
  const groups = segGroups(book.manifest);
  const out: Segment[] = [];
  book.manifest.forEach((p, i) => {
    const g = groups[i]!;
    if (!out[g]) out[g] = { t: p.card?.t != null && isCard(p) ? p.card.t : null, pages: [] };
    out[g]!.pages.push({ p, n: i + 1 });
  });
  return out;
}

/** The video span a segment covers: its earliest start to its latest end. */
export function segmentSpan(book: Book, n: number): { t: number; tEnd: number } | null {
  const groups = segGroups(book.manifest);
  const g = groups[n - 1];
  let t = Infinity, tEnd = -Infinity;
  book.manifest.forEach((p, i) => {
    if (groups[i] !== g || p.card?.t == null) return;
    t = Math.min(t, p.card.t);
    tEnd = Math.max(tEnd, p.card.tEnd ?? p.card.t + 8);
  });
  return Number.isFinite(t) ? { t, tEnd } : null;
}

/** The first page (1-based) of page `n`'s segment — the page a segment's own clip range is kept on. */
export function segmentFirst(book: Book, n: number): number {
  const groups = segGroups(book.manifest);
  const g = groups[n - 1];
  return groups.indexOf(g!) + 1;
}

export const sameSegment = (book: Book, a: number, b: number) => {
  const groups = segGroups(book.manifest);
  return a >= 1 && b >= 1 && groups[a - 1] === groups[b - 1];
};
