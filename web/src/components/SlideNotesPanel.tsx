import { useEffect, useRef } from 'react';

// Per-page presenter notes (bold / italic), stored with the book under the page's stable id.
// Editor-only: never drawn on the output.
export function SlideNotesPanel({ pageId, pageLabel, html, onChange }: {
  pageId: string | null; pageLabel: string | null; html: string; onChange: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if (el.innerHTML !== (html || '')) el.innerHTML = html || '';
  }, [pageId, html]);
  if (!pageId) return <div className="p-4 text-[11px] text-slate-600 italic">Pick a page to write its notes.</div>;
  const cmd = (c: string) => { document.execCommand(c); if (ref.current) onChange(ref.current.innerHTML); };
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-800 text-[11px]">
        <span className="text-slate-400 truncate">{pageLabel}</span>
        <button onMouseDown={e => { e.preventDefault(); cmd('bold'); }} className="ml-auto w-6 h-6 rounded border border-slate-700 font-bold">B</button>
        <button onMouseDown={e => { e.preventDefault(); cmd('italic'); }} className="w-6 h-6 rounded border border-slate-700 italic">I</button>
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning
        onInput={e => onChange((e.target as HTMLDivElement).innerHTML)}
        className="flex-1 overflow-auto p-3 text-[13px] leading-relaxed text-slate-200 focus:outline-none" />
    </div>
  );
}
