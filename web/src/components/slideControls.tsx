import React, { createContext, useContext, useState } from 'react';

// A panel wide enough for two columns of controls wraps itself in this; each Section then lays its
// rows out two-up once there is room for two 260px columns, and falls back to one when narrow.
export const SectionColumns = createContext(false);
export const TWO_COL = 'grid gap-x-5 gap-y-2 grid-cols-[repeat(auto-fill,minmax(max(260px,calc(50%_-_0.625rem)),1fr))]';

const BTN = 'px-2 py-0.5 rounded text-[10px] font-semibold border transition';
export const BTN_ON = `${BTN} bg-blue-600/30 text-blue-100 border-blue-500/60`;
export const BTN_OFF = `${BTN} bg-slate-800/50 text-slate-400 border-slate-700 hover:text-slate-200 hover:border-slate-500`;

// What a band of sections acts on. The operator's first question about any control on these panels
// is "does this change this slide or all of them?", so every section group answers it up front.
export function Group({ title, scope, children }: { title: string; scope?: string; children: React.ReactNode }) {
  return (
    <div className="border-b-4 border-black/40">
      <div className="sticky top-0 z-10 flex items-baseline gap-2 px-3 py-1.5 bg-[#131820] border-b border-slate-800">
        <span className="text-[11px] font-bold text-slate-100">{title}</span>
        {scope && <span className="text-[10px] text-slate-500">{scope}</span>}
      </div>
      {children}
    </div>
  );
}

// `collapsible` folds the section behind its own title (the title becomes the button). `actions`
// sit at the right of the title line — a reset or a scope switch belongs next to what it acts on.
export function Section({ title, children, collapsible, defaultOpen = false, actions }: {
  title: string; children: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean; actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useContext(SectionColumns) ? TWO_COL : 'flex flex-col gap-2';
  const shown = !collapsible || open;
  return (
    <div className="border-b border-slate-800/70 px-3 py-2.5 last:border-b-0">
      <div className={`flex items-center gap-2 min-h-[20px] ${shown ? 'mb-2' : ''}`}>
        {collapsible ? (
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200"
          >
            <span className="w-2 text-[8px]">{open ? '▼' : '▶'}</span>
            <span>{title}</span>
          </button>
        ) : (
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {shown && <div className={body}>{children}</div>}
    </div>
  );
}

// A small caption splitting one section's rows into related runs (Text / Placement / Shadow…).
export function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="col-span-full pt-1 text-[9px] font-semibold uppercase tracking-widest text-slate-600">{children}</div>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <div className="col-span-full text-[10px] text-slate-500 leading-snug">{children}</div>;
}

// Label · control · (value) on one fixed grid, so every row in a panel lines up and nothing can push
// its neighbour: the control column is minmax(0,1fr), which a range input cannot overflow.
export function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-[11px] text-slate-300 min-w-0" title={hint}>
      <span className="truncate text-slate-400">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-1 min-w-0 gap-0.5 rounded bg-slate-900 border border-slate-800 p-0.5">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`flex-1 min-w-0 truncate rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
            value === o.id ? 'bg-blue-600/40 text-blue-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function SegRow<T extends string>({ label, value, options, onChange, hint }: {
  label: string; value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void; hint?: string;
}) {
  return <Row label={label} hint={hint}><Seg value={value} options={options} onChange={onChange} /></Row>;
}

export function Select({ label, value, options, onChange }: {
  label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200"
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </Row>
  );
}

// The readout is also an input: drag for feel, type for an exact figure.
export function Slider({ label, value, min, max, step = 1, suffix = '', onChange, hold }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void;
  hold?: { active: boolean; onToggle: () => void };
}) {
  return (
    <Row label={label}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 min-w-0 w-full accent-blue-500" />
      <input type="number" min={min} max={max} step={step} value={value}
        onChange={e => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(n); }}
        className="w-14 shrink-0 bg-transparent border border-transparent hover:border-slate-700 focus:border-slate-500 focus:bg-[#0d1117] rounded px-1 text-right font-mono tabular-nums text-[10px] text-slate-300 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="w-4 shrink-0 text-[10px] text-slate-500">{suffix}</span>
      {hold && (
        <button
          onClick={hold.onToggle}
          title={hold.active
            ? 'Held constant across In / Hold / Out (and all pages) — click to release'
            : 'Hold this value constant across In / Hold / Out (and all pages)'}
          className={`shrink-0 w-5 h-5 grid place-items-center rounded border ${hold.active ? 'bg-blue-600/30 text-blue-100 border-blue-500/60' : 'bg-slate-800/40 text-slate-600 border-slate-700 hover:text-slate-300'}`}
        >
          <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="5.5" width="8" height="5" rx="1" fill="currentColor" />
            <path d={hold.active ? 'M4 5.5V4a2 2 0 0 1 4 0v1.5' : 'M4 5.5V4a2 2 0 0 1 4 0'} />
          </svg>
        </button>
      )}
    </Row>
  );
}

export function Toggle({ label, value, onChange, onLabel = 'On', offLabel = 'Off' }: {
  label: string; value: boolean; onChange: (v: boolean) => void; onLabel?: string; offLabel?: string;
}) {
  return (
    <Row label={label}>
      <button onClick={() => onChange(!value)} className={value ? BTN_ON : BTN_OFF}>{value ? onLabel : offLabel}</button>
    </Row>
  );
}

// rgba(r,g,b,a) <-> hex + alpha helpers
function parseRgba(s: string): { hex: string; a: number } {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(s || '');
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
    return { hex, a: m[4] != null ? Number(m[4]) : 1 };
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s, a: 1 };
  return { hex: '#000000', a: 0.5 };
}
function toRgba(hex: string, a: number): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function ColorAlpha({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { hex, a } = parseRgba(value);
  return (
    <Row label={label}>
      <input type="color" value={hex} onChange={e => onChange(toRgba(e.target.value, a))}
        className="w-7 h-6 shrink-0 rounded bg-transparent border border-slate-700" />
      <input type="range" min={0} max={1} step={0.05} value={a}
        onChange={e => onChange(toRgba(hex, Number(e.target.value)))}
        className="flex-1 min-w-0 w-full accent-blue-500" />
      <span className="w-[4.5rem] shrink-0 text-right font-mono tabular-nums text-[10px] text-slate-400">{Math.round(a * 100)}%</span>
    </Row>
  );
}
