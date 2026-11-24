import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { attempt, notify } from './Dialog';
import { botSummary, type BotStatus } from './BotDialog';

interface Stance { id: string; name: string; standing: string }
interface Critique { stances: Stance[]; activeId: string; ridicule: number; temperature: number; maxResults: number; language: string; customInstruction: string }
export interface Settings { hasGeminiKey: boolean; critique: Critique; port: number; cardLook?: { card?: unknown; border?: unknown } | null }

const LANGS = ['', 'English', 'Malayalam', 'Hindi', 'Tamil', 'Arabic', 'Urdu'];

export function SettingsDialog({ onClose, onSaved, bot, onBot }: { onClose: () => void; onSaved: (s: Settings) => void; bot: BotStatus | null; onBot: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [gemini, setGemini] = useState('');
  const [crit, setCrit] = useState<Critique | null>(null);
  const [stanceId, setStanceId] = useState('');
  const [rules, setRules] = useState<{ text: string; default: string } | null>(null);

  useEffect(() => {
    api<Settings>('/api/settings').then(v => { setS(v); setCrit(v.critique); setStanceId(v.critique.activeId); });
    api<{ text: string; default: string }>('/api/house-rules').then(setRules).catch(() => {});
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async () => {
    if (!crit) return;
    const body: any = { critique: { ...crit, activeId: stanceId } };
    if (gemini.trim()) body.geminiKey = gemini.trim();
    const r = await attempt(api<Settings>('/api/settings', { method: 'PUT', json: body }), 'Save settings');
    if (rules) await attempt(api('/api/house-rules', { method: 'PUT', json: { text: rules.text === rules.default ? '' : rules.text } }), 'Save house rules');
    if (r) { setS(r); setGemini(''); onSaved(r); notify('Settings saved'); }
  };

  const stance = crit?.stances.find(x => x.id === stanceId);
  const setStance = (patch: Partial<Stance>) => crit && setCrit({ ...crit, stances: crit.stances.map(x => (x.id === stanceId ? { ...x, ...patch } : x)) });
  const field = 'w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100';
  const outputUrl = `http://127.0.0.1:${s?.port ?? 8780}/output`;

  return createPortal(
    <div className="fixed inset-0 z-[900] grid place-items-center bg-black/60" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[760px] max-w-[95vw] max-h-[92vh] flex flex-col rounded-lg border border-slate-700 bg-[#11151c] shadow-2xl">
        <div className="px-4 py-2.5 border-b border-slate-800 text-sm font-semibold text-slate-100">Settings</div>
        {!s || !crit ? <div className="p-6 text-slate-500 text-sm">Loading…</div> : (
          <div className="p-4 overflow-auto grid grid-cols-2 gap-x-6 gap-y-4 text-[12px] text-slate-300">
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">OBS</h3>
              <p className="text-slate-400">Add a <b>Browser Source</b> (1920×1080) with this URL. It shows the book that is on air.</p>
              <div className="flex gap-1">
                <input readOnly value={outputUrl} className={`${field} font-mono`} />
                <button onClick={() => { void navigator.clipboard.writeText(outputUrl); notify('Copied'); }} className="px-2 rounded border border-slate-700 text-[11px]">Copy</button>
              </div>
              <h3 className="mt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Gemini</h3>
              <input type="password" value={gemini} onChange={e => setGemini(e.target.value)} placeholder={s.hasGeminiKey ? 'Key saved — paste to replace' : 'Paste your Gemini API key'} className={field} />
              <h3 className="mt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Telegram</h3>
              <p className="text-slate-400">Links arrive through StudioMate&apos;s bot: <b>Analyse and send to SlideBook</b> on its link menu, for anyone with the <b>SlideBook</b> grant. Step the book on air with <b>/sb next</b> and <b>/sb prev</b>.</p>
              <p className="text-slate-400">{botSummary(bot)}</p>
              <button onClick={onBot} className="self-start px-2 py-1 rounded border border-slate-700 text-[11px]">SlideBook&apos;s own bot…</button>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Critique</h3>
              <div className="flex gap-1">
                <select value={stanceId} onChange={e => setStanceId(e.target.value)} className={field}>
                  {crit.stances.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button onClick={() => { const id = `s${Date.now()}`; setCrit({ ...crit, stances: [...crit.stances, { id, name: 'New stance', standing: '' }] }); setStanceId(id); }} className="px-2 rounded border border-slate-700 text-[11px]">＋</button>
                {crit.stances.length > 1 && <button onClick={() => { const rest = crit.stances.filter(x => x.id !== stanceId); setCrit({ ...crit, stances: rest }); setStanceId(rest[0]!.id); }} className="px-2 rounded border border-rose-900 text-rose-300 text-[11px]">✕</button>}
              </div>
              {stance && (<>
                <input value={stance.name} onChange={e => setStance({ name: e.target.value })} className={field} />
                <textarea value={stance.standing} onChange={e => setStance({ standing: e.target.value })} rows={6} placeholder="Empty = the generic misinformation brief" className={field} />
                <p className="text-[10px] text-slate-500">Write a posture — what is examined and by which standard — not the conclusion you want. A mandate that names its finding gets it back whether or not it is there.</p>
              </>)}
              <label className="flex items-center gap-2">Ridicule <input type="range" min={0} max={1} step={0.05} value={crit.ridicule} onChange={e => setCrit({ ...crit, ridicule: Number(e.target.value) })} className="flex-1" /><span className="w-8 text-right font-mono">{crit.ridicule.toFixed(2)}</span></label>
              <label className="flex items-center gap-2">Temperature <input type="range" min={0} max={1} step={0.05} value={crit.temperature} onChange={e => setCrit({ ...crit, temperature: Number(e.target.value) })} className="flex-1" /><span className="w-8 text-right font-mono">{crit.temperature.toFixed(2)}</span></label>
              <label className="flex items-center gap-2">Max claims <input type="number" min={0} max={40} value={crit.maxResults} onChange={e => setCrit({ ...crit, maxResults: Number(e.target.value) })} className="w-16 bg-[#0d1117] border border-slate-700 rounded px-1" /><span className="text-slate-500">0 = no limit</span></label>
              <label className="flex items-center gap-2">Verdicts in
                <select value={crit.language} onChange={e => setCrit({ ...crit, language: e.target.value })} className="bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5">
                  {LANGS.map(l => <option key={l} value={l}>{l || 'Auto (the video\'s language)'}</option>)}
                </select>
              </label>
              <textarea value={crit.customInstruction} onChange={e => setCrit({ ...crit, customInstruction: e.target.value })} rows={2} placeholder="Extra instruction for every run (optional)" className={field} />
            </section>
            {rules && (
              <section className="col-span-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">House rules — Claude</h3>
                  {rules.text !== rules.default && <button onClick={() => setRules({ ...rules, text: rules.default })} className="ml-auto text-[10px] text-slate-400 hover:text-white">Reset to draft</button>}
                </div>
                <p className="text-slate-400">The standing standard every Claude analysis and answer follows, for every video. Gemini only transcribes; Claude does all the thinking from the text record.</p>
                <textarea value={rules.text} onChange={e => setRules({ ...rules, text: e.target.value })} rows={12} className={`${field} font-mono text-[11px] leading-snug`} />
              </section>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1 rounded text-xs border border-slate-700 text-slate-300">Close <span className="opacity-50">esc</span></button>
          <button onClick={save} className="px-3 py-1 rounded text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white">Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
