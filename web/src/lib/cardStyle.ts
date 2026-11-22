import { EXTRA_COLORS } from './cardKinds';

// The look of every claim / fallacy card in a book — one book-level setting, the FactBox palette and
// the News Desk debunk designer's Box / Heading / Body blocks merged. Sizes are px in the 1920 space.

export interface CardStyle {
  font: string;
  bodyFont: string;
  headSize: number;
  bodySize: number;
  textColor: string;
  boxFill: string;
  boxAlpha: number;    // 0–100
  blur: number;        // px of backdrop blur behind the card
  edge: number;        // accent bar width
  radius: number;
  pad: number;
  tint: number;        // 0–100 — how much of the accent colour washes the box
  showPassage: boolean;
  showSources: boolean;
  showSeverity: boolean;
  autoFit: boolean;
  claimLabel: string;
  fallacyLabel: string;
  fallacyColor: string;
  verdict: Record<string, string>;
  /** The card box as % of the 1920×1080 frame. Unset = the book's card shape, as large as fits. */
  width?: number;
  height?: number;
}

/** The card box as fractions of the frame, when the look sets one. */
export function cardSize(s: Pick<CardStyle, 'width' | 'height'> | undefined): { w: number; h: number } | undefined {
  return s?.width && s?.height ? { w: s.width / 100, h: s.height / 100 } : undefined;
}

/** The size a card shape takes when it is as large as fits, as % of the frame — the sliders' start. */
export function containPct(aspect: number): { width: number; height: number } {
  const a = aspect || 16 / 9;
  return a >= 16 / 9 ? { width: 100, height: Math.round((1920 / a / 1080) * 100) } : { width: Math.round((1080 * a / 1920) * 100), height: 100 };
}

export const VERDICTS = ['FALSE', 'MISLEADING', 'PARTLY TRUE', 'UNPROVEN', 'TRUE'] as const;

export const DEFAULT_CARD_STYLE: CardStyle = {
  font: '', bodyFont: '',
  headSize: 92, bodySize: 56,
  textColor: '#f1f5f9',
  boxFill: '#0b1020', boxAlpha: 90, blur: 0,
  edge: 14, radius: 28, pad: 70, tint: 14,
  showPassage: true, showSources: true, showSeverity: true, autoFit: true,
  claimLabel: 'FACT CHECK', fallacyLabel: 'LOGICAL FALLACY',
  fallacyColor: '#7c3aed',
  verdict: { FALSE: '#ef4444', MISLEADING: '#f97316', 'PARTLY TRUE': '#eab308', UNPROVEN: '#94a3b8', TRUE: '#10b981' },
};

export function resolveCardStyle(s?: Partial<CardStyle>): CardStyle {
  return { ...DEFAULT_CARD_STYLE, ...(s ?? {}), verdict: { ...DEFAULT_CARD_STYLE.verdict, ...(s?.verdict ?? {}) } };
}

export function cardAccent(kind: string, verdict: string | undefined, s: CardStyle): string {
  if (kind === 'fallacy') return s.fallacyColor;
  if (kind === 'contradiction' || kind === 'scorecard') return EXTRA_COLORS[kind]!;
  if (kind === 'qa' || kind === 'moderation') return EXTRA_COLORS[(verdict || '').toUpperCase()] ?? '#94a3b8';
  return s.verdict[(verdict || 'UNPROVEN').toUpperCase()] ?? s.verdict.UNPROVEN ?? '#94a3b8';
}

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
}
