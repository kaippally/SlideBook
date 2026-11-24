// The Short builder's arithmetic, mirroring app/shorts.py so the preview cuts, times and places exactly what the
// render will: kept transcript lines → source segments, a caption line → phrases, a layout → where the picture sits.
import type { ShortLayout, ShortPlan, Transcript } from './types';

export const SHORT_W = 1080;
export const SHORT_H = 1920;

export interface Seg { a: number; b: number; s: number; e: number; o: number }

export function editOf(keep: [number, number][], tr: Transcript): { segs: Seg[]; total: number } {
  const segs: Seg[] = [];
  let off = 0;
  for (const [a, b] of keep) {
    if (!tr.lines[a] || tr.ends[b] === undefined) continue;
    let s = Math.max(0, tr.lines[a].t - 0.08);
    if (segs.length) s = Math.max(s, segs[segs.length - 1].e);
    const e = tr.ends[b];
    if (e - s < 0.2) continue;
    segs.push({ a, b, s, e, o: off });
    off += e - s;
  }
  return { segs, total: off };
}

export function normKeep(indices: Iterable<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const i of [...new Set(indices)].sort((x, y) => x - y)) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  return runs;
}

export const keptSet = (keep: [number, number][]) => {
  const s = new Set<number>();
  for (const [a, b] of keep) for (let i = a; i <= b; i++) s.add(i);
  return s;
};

export function phrases(text: string, t0: number, t1: number, words: number): { t0: number; t1: number; words: string[] }[] {
  const ws = text.split(/\s+/).filter(Boolean);
  if (!ws.length || t1 <= t0) return [];
  const n = Math.max(1, words);
  const total = ws.reduce((a, w) => a + w.length + 1, 0);
  const out = [];
  let t = t0;
  for (let i = 0; i < ws.length; i += n) {
    const g = ws.slice(i, i + n);
    const d = (t1 - t0) * g.reduce((a, w) => a + w.length + 1, 0) / total;
    out.push({ t0: t, t1: t + d, words: g });
    t += d;
  }
  return out;
}

/** The caption on screen at source time `t`, with how many of its words have been spoken (for the karaoke fill). */
export function captionAt(t: number, segs: Seg[], tr: Transcript, text: (i: number) => string, words: number) {
  const seg = segs.find(s => t >= s.s && t < s.e);
  if (!seg) return null;
  for (let i = seg.a; i <= seg.b; i++) {
    const a = Math.max(tr.lines[i].t, seg.s), b = Math.min(tr.ends[i], seg.e);
    if (t < a || t >= b) continue;
    const ph = phrases(text(i), a, b, words).find(p => t >= p.t0 && t < p.t1);
    if (!ph) return null;
    const n = ph.words.reduce((x, w) => x + w.length + 1, 0);
    const f = (t - ph.t0) / (ph.t1 - ph.t0);
    let acc = 0, spoken = 0;
    for (const w of ph.words) { if (f >= acc) spoken++; acc += (w.length + 1) / n; }
    return { words: ph.words, spoken };
  }
  return null;
}

export function outTime(t: number, segs: Seg[]): number | null {
  for (const s of segs) {
    if (t < s.s) return s.o;
    if (t <= s.e) return s.o + t - s.s;
  }
  return null;
}

export function srcTime(o: number, segs: Seg[]): number {
  for (const s of segs) if (o <= s.o + (s.e - s.s)) return s.s + Math.max(0, o - s.o);
  return segs.length ? segs[segs.length - 1].e : 0;
}

export const DEFAULT_LAYOUT: ShortLayout = {
  mode: 'fill', zoom: 1, x: 0.5, y: 0.5, split: 0.5, panels: [{ zoom: 1, x: 0.25, y: 0.5 }, { zoom: 1, x: 0.75, y: 0.5 }],
  sub: { show: true, font: 'NotoSansMalayalam-Bold', size: 68, color: '#FFFFFF', highlight: '#FFD21F', outline: '#000000', box: false,
    y: 0.7, words: 4, karaoke: true, lang: 'Original' },
  title: { show: true, text: '', font: 'NotoSansMalayalam-Black', size: 74, color: '#FFFFFF', bg: '#E63946', y: 0.13 },
};

export function layoutOf(p: ShortPlan): ShortLayout {
  const l = p.layout || ({} as ShortLayout);
  return { ...DEFAULT_LAYOUT, ...l, sub: { ...DEFAULT_LAYOUT.sub, ...(l.sub || {}) }, title: { ...DEFAULT_LAYOUT.title, ...(l.title || {}) } };
}

/** Where the picture sits on a stage `sw` px wide, in stage px: the same crop/fit as the render's video filter. */
export function pictureBox(lay: ShortLayout, vw: number, vh: number, sw: number) {
  const sh = sw * SHORT_H / SHORT_W;
  if (!vw || !vh) return { left: 0, top: 0, width: sw, height: sh, scale: 1 };
  if (lay.mode === 'fit') {
    const fw = sw * Math.max(0.3, lay.zoom);
    const fh = fw * vh / vw;
    return { left: sw / 2 - fw / 2 + (0.5 - lay.x) * Math.max(0, fw - sw), top: lay.y * sh - fh / 2, width: fw, height: fh, scale: fw / vw };
  }
  return cropBox(lay, vw, vh, sw, sh);
}

export const PANEL_MIN_ZOOM = 0.3;

/** The source in a pw x ph box, in box px (the render's `_crop`). Zoom 1 just covers the box; below `lo`.. 1 the whole
 *  picture sits centred on black on the axis where it is smaller than the box. */
export function cropBox(p: { zoom: number; x: number; y: number }, vw: number, vh: number, pw: number, ph: number, lo = 1) {
  if (!vw || !vh) return { left: 0, top: 0, width: pw, height: ph, scale: 1 };
  const s = Math.max(pw / vw, ph / vh) * Math.max(lo, p.zoom);
  const dw = vw * s, dh = vh * s;
  const place = (box: number, d: number, f: number) => d >= box ? Math.min(0, Math.max(box - d, box / 2 - f * d)) : (box - d) / 2;
  return { left: place(pw, dw, p.x), top: place(ph, dh, p.y), width: dw, height: dh, scale: s };
}

/** The two stacked panels of a split layout, in stage px. */
export function splitPanels(lay: ShortLayout, sw: number) {
  const sh = sw * SHORT_H / SHORT_W;
  const h1 = Math.round(sh * lay.split);
  return [{ top: 0, height: h1 }, { top: h1, height: sh - h1 }];
}

export const fmtT = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
