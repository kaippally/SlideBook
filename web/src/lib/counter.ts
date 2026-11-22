import type { Book } from './types';

// The fallacy counter — StudioMate's BullTrack BS Score panel (docs/BT_SCORE_PANEL.md, computeScores),
// with the playhead replaced by the page on air: every card up to and including it is counted, so the
// tally climbs as the presenter steps and falls back when they step back. SLIDEBOOK_PLAN.md §11.4.

export interface CounterStyle { on: boolean; position: 'top' | 'bottom'; perSpeaker: boolean }
export const DEFAULT_COUNTER: CounterStyle = { on: false, position: 'top', perSpeaker: true };

export const COUNTER_KEYS = ['FALSE', 'MISLEADING', 'PARTLY TRUE', 'TRUE', 'UNPROVEN', 'FALLACY', 'DODGED'] as const;
export type CounterKey = typeof COUNTER_KEYS[number];

// StudioMate's score colours, so the two counters read as one family on air.
export const COUNTER_COLOR: Record<CounterKey, string> = {
  FALSE: '#dc2626', MISLEADING: '#ea580c', 'PARTLY TRUE': '#ca8a04', TRUE: '#16a34a', UNPROVEN: '#475569', FALLACY: '#7c3aed', DODGED: '#be123c',
};
export const COUNTER_LABEL: Record<CounterKey, string> = {
  FALSE: 'False', MISLEADING: 'Misleading', 'PARTLY TRUE': 'Partly true', TRUE: 'True', UNPROVEN: 'Unproven', FALLACY: 'Fallacies', DODGED: 'Dodged',
};

export interface CounterRow { speaker: string; counts: Record<CounterKey, number> }

export function tally(book: Book, page: number, perSpeaker: boolean): CounterRow[] {
  const rows = new Map<string, CounterRow>();
  const row = (who: string) => {
    let r = rows.get(who);
    if (!r) { r = { speaker: who, counts: Object.fromEntries(COUNTER_KEYS.map(k => [k, 0])) as Record<CounterKey, number> }; rows.set(who, r); }
    return r;
  };
  book.manifest.slice(0, Math.max(0, page)).forEach(p => {
    if (p.hidden || !p.card) return;
    const key: CounterKey | null =
      p.kind === 'claim' ? ((p.card.verdict || 'UNPROVEN').toUpperCase() as CounterKey)
        : p.kind === 'fallacy' ? 'FALLACY'
          : p.kind === 'qa' && (p.card.verdict || '').toUpperCase() === 'DODGED' ? 'DODGED' : null;
    if (!key || !(COUNTER_KEYS as readonly string[]).includes(key)) return;
    row(perSpeaker ? p.card.speaker || '' : '').counts[key] += 1;
  });
  return [...rows.values()];
}
