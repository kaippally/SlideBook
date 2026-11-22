import { COUNTER_COLOR, COUNTER_KEYS, COUNTER_LABEL, DEFAULT_COUNTER, tally, type CounterStyle } from '../lib/counter';
import type { Book } from '../lib/types';

/** The running counter drawn over the output, in the 1920 space, scaled with the stage. Only non-zero
 *  categories are drawn on air, as StudioMate's BullTrackOverlay does. */
export function CounterBar({ book, page, scale }: { book: Book; page: number; scale: number }) {
  const cfg: CounterStyle = { ...DEFAULT_COUNTER, ...((book.styles as { counter?: Partial<CounterStyle> }).counter ?? {}) };
  if (!cfg.on) return null;
  const rows = tally(book, page, cfg.perSpeaker).filter(r => COUNTER_KEYS.some(k => r.counts[k] > 0));
  if (!rows.length) return null;
  return (
    <div className="absolute left-0 w-[1920px] flex flex-col items-center gap-[10px] pointer-events-none"
      style={{ [cfg.position]: 0, padding: '28px 0', transform: `scale(${scale})`, transformOrigin: cfg.position === 'top' ? '0 0' : '0 100%' }}>
      {rows.map(r => (
        <div key={r.speaker} className="flex items-center gap-[10px] rounded-[18px] bg-black/70 px-[18px] py-[10px] font-bold text-white">
          {r.speaker && <span className="pr-[8px] text-[30px] tracking-wide">{r.speaker}</span>}
          {COUNTER_KEYS.filter(k => r.counts[k] > 0).map(k => (
            <span key={k} className="flex items-center gap-[10px] rounded-[12px] px-[16px] py-[6px] text-[26px]" style={{ background: `${COUNTER_COLOR[k]}dd` }}>
              <span className="uppercase tracking-wider">{COUNTER_LABEL[k]}</span>
              <span className="tabular-nums text-[32px]">{r.counts[k]}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
