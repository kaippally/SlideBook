import { useEffect, useRef, useState } from 'react';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';

/**
 * The bold / italic / underline / colour box every "edit this for display" surface types into.
 *
 * It lived inside AiResultsPanel, where BullTrack's fact-check results are reworded before they
 * are fired at the FactBox. The News Desk's Analysis edits exactly the same thing — a claim and
 * its explanation, on their way to the same two OBS containers — so the widget moved here rather
 * than being written a second time: one editor, one set of swatches, one HTML dialect reaching
 * the box (`FactBoxOverlay` and `FallacyOverlay` both render it as markup).
 *
 * The five swatches are the operator's own, saved in `uiSettings` — click to apply, double-click
 * to change the colour. They are injected as CSS variables rather than written into each button's
 * style so a colour change repaints every editor open at the time.
 */
const SWATCH_SETTING_KEY = 'richText:swatchColors';
const DEFAULT_SWATCHES = ['#000000', '#ffffff', '#64748b', '#94a3b8', '#3b82f6'];

function loadSwatches(): string[] {
  try {
    const saved = getUiSetting(SWATCH_SETTING_KEY);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length === DEFAULT_SWATCHES.length) return arr;
    }
  } catch {}
  return [...DEFAULT_SWATCHES];
}

function injectSwatchVars(colors: string[]) {
  let el = document.getElementById('rt-swatch-vars') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'rt-swatch-vars';
    document.head.appendChild(el);
  }
  el.textContent = `:root { ${colors.map((c, i) => `--rt-swatch-${i}: ${c};`).join(' ')} }`;
}

export function RichTextInput({ initialHtml, onChange, minHeight = 60 }: {
  initialHtml: string;
  onChange: (html: string) => void;
  minHeight?: number;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const editingIdxRef = useRef(-1);
  const [swatches, setSwatches] = useState<string[]>(loadSwatches);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml;
  }, []); // mount-only — dialog always remounts

  useEffect(() => {
    injectSwatchVars(swatches);
  }, [swatches]);

  function exec(cmd: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    onChange(editorRef.current?.innerHTML ?? '');
  }

  function openPicker(idx: number) {
    editingIdxRef.current = idx;
    if (colorInputRef.current) {
      colorInputRef.current.value = swatches[idx] ?? '';
      colorInputRef.current.click();
    }
  }

  function onPickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const idx = editingIdxRef.current;
    if (idx < 0) return;
    const updated = [...swatches];
    updated[idx] = e.target.value;
    setSwatches(updated);
    setUiSetting(SWATCH_SETTING_KEY, JSON.stringify(updated));
    injectSwatchVars(updated);
  }

  return (
    <div className="border border-[#252d3a] rounded-[6px] overflow-hidden">
      <div className="flex items-center gap-[3px] px-[8px] py-[5px] bg-[#080a0c] border-b border-[#252d3a]">
        {(['bold', 'italic', 'underline'] as const).map(cmd => (
          <button key={cmd} type="button" onMouseDown={e => { e.preventDefault(); exec(cmd); }}
            className="w-[22px] h-[22px] flex items-center justify-center bg-transparent border border-[#252d3a] rounded-[3px] text-slate-400 cursor-pointer text-[12px]"
            style={{ fontWeight: cmd === 'bold' ? 700 : 400, fontStyle: cmd === 'italic' ? 'italic' : 'normal', textDecoration: cmd === 'underline' ? 'underline' : 'none' }}>
            {cmd[0]!.toUpperCase()}
          </button>
        ))}
        <button type="button" onMouseDown={e => { e.preventDefault(); exec('removeFormat'); }}
          title="Remove formatting"
          className="w-[22px] h-[22px] flex items-center justify-center bg-transparent border border-[#252d3a] rounded-[3px] text-slate-400 cursor-pointer text-[11px]">
          A
        </button>
        <div className="w-px h-[14px] bg-[#1e2530] mx-[2px]" />
        <input
          ref={colorInputRef}
          type="color"
          onChange={onPickerChange}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
          tabIndex={-1}
        />
        {swatches.map((c, i) => (
          <button key={i} type="button"
            title="Click to apply · Double-click to change"
            onMouseDown={e => { e.preventDefault(); exec('foreColor', c); }}
            onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); openPicker(i); }}
            className="w-[14px] h-[14px] rounded-full cursor-pointer p-0 shrink-0"
            style={{ background: `var(--rt-swatch-${i})`, border: c === '#ffffff' ? '1px solid #334155' : 'none' }}
          />
        ))}
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={() => onChange(editorRef.current?.innerHTML ?? '')}
        className="px-[12px] py-[10px] text-slate-300 text-[12px] leading-[1.6] outline-none bg-[#0f1318] font-[inherit] whitespace-pre-wrap"
        style={{ minHeight }}
      />
    </div>
  );
}
