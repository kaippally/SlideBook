import { useEffect, useState } from 'react';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';

/** A panel size in px, remembered under `videos:size:<key>`. */
export function usePanelSize(key: string, initial: number, min: number, max: number): [number, (n: number) => void, () => void] {
  const [size, setSize] = useState(() => {
    const n = Number(getUiSetting(`videos:size:${key}`));
    return n ? Math.min(max, Math.max(min, n)) : initial;
  });
  useEffect(() => { setUiSetting(`videos:size:${key}`, String(Math.round(size))); }, [key, size]);
  const set = (n: number) => setSize(Math.min(max, Math.max(min, n)));
  return [size, set, () => setSize(initial)];
}

/** A drag handle between two panels. `sign` is +1 when dragging right/down grows the panel, -1 when it shrinks it.
 *  Double-click resets. */
export function Splitter({ dir, size, onSize, onReset, sign = 1 }: {
  dir: 'col' | 'row'; size: number; onSize: (n: number) => void; onReset: () => void; sign?: 1 | -1;
}) {
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    const p0 = dir === 'col' ? e.clientX : e.clientY, s0 = size;
    const move = (ev: MouseEvent) => onSize(s0 + sign * ((dir === 'col' ? ev.clientX : ev.clientY) - p0));
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = dir === 'col' ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div onMouseDown={down} onDoubleClick={onReset} title="Drag to resize · double-click to reset"
      className={`group relative shrink-0 z-10 ${dir === 'col' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} bg-slate-900 hover:bg-amber-400/40`}>
      <div className={`absolute bg-slate-700 group-hover:bg-amber-400 ${dir === 'col' ? 'inset-y-0 left-1/2 w-px' : 'inset-x-0 top-1/2 h-px'}`} />
    </div>
  );
}
