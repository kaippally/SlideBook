import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { VideoRecord } from '../lib/types';
import { Dialog, attempt, notify } from './Dialog';

// Claude works from a video's text record, never the video: Re-analyse makes a new versioned analysis
// (optionally refining an earlier one with feedback), Ask answers a question with timestamps.

const field = 'w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600';
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

function useRecord(id: number) {
  const [rec, setRec] = useState<VideoRecord | null>(null);
  useEffect(() => { void attempt(api<VideoRecord>(`/api/records/${id}`), 'Record').then(r => r && setRec(r)); }, [id]);
  return rec;
}

export function ReanalyseDialog({ recordId, onClose }: { recordId: number; onClose: () => void }) {
  const rec = useRecord(recordId);
  const analyses = rec?.runs.filter(r => r.kind === 'analyse') ?? [];
  const [base, setBase] = useState<number | 'fresh' | null>(null);
  const [prompt, setPrompt] = useState('');
  const chosen = base ?? analyses[0]?.id ?? 'fresh';

  const run = async () => {
    const r = await attempt(api(`/api/records/${recordId}/reanalyse`, { method: 'POST', json: { prompt: prompt.trim(), baseRun: chosen === 'fresh' ? undefined : chosen } }), 'Re-analyse');
    if (r) { notify('Queued — Claude is analysing the record. The new version opens as a new book.'); onClose(); }
  };

  return (
    <Dialog title="Re-analyse with Claude" onClose={onClose} onAccept={run} acceptLabel="Run" width="w-[620px]">
      {!rec ? <p className="text-slate-500">Loading…</p> : (
        <div className="flex flex-col gap-3">
          <p className="text-slate-400"><b className="text-slate-200">{rec.title || rec.url}</b> — record v{rec.version}, {rec.lineCount} lines. No download or transcription: Claude reads the saved record.</p>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {analyses.map(a => (
              <label key={a.id} className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer ${chosen === a.id ? 'bg-amber-950/40 border border-amber-700' : 'border border-transparent hover:bg-slate-900'}`}>
                <input type="radio" checked={chosen === a.id} onChange={() => setBase(a.id)} className="mt-0.5" />
                <span className="flex-1 min-w-0">
                  <span className="text-slate-200">Refine v{a.version}</span>
                  <span className="text-slate-500 tabular-nums"> · {day(a.created_at)}</span>
                  <span className="block truncate text-[11px] text-slate-500">{a.prompt || 'first analysis'}</span>
                </span>
              </label>
            ))}
            <label className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer ${chosen === 'fresh' ? 'bg-amber-950/40 border border-amber-700' : 'border border-transparent hover:bg-slate-900'}`}>
              <input type="radio" checked={chosen === 'fresh'} onChange={() => setBase('fresh')} />
              <span className="text-slate-200">Fresh analysis</span><span className="text-slate-500">— ignores earlier versions</span>
            </label>
          </div>
          <textarea autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} className={field}
            placeholder={chosen === 'fresh' ? 'Brief for this analysis (optional) — the house rules always apply' : 'What should change? e.g. "Too soft on the fine-tuning claim at 41:00; add the moral-realism dodge."'} />
        </div>
      )}
    </Dialog>
  );
}

// [HH:MM:SS] in an answer becomes a link to that moment of the YouTube video.
function withLinks(text: string, videoId: string | null): ReactNode[] {
  return text.split(/(\[\d{1,2}:\d{2}:\d{2}\])/).map((part, i) => {
    const m = part.match(/^\[(\d{1,2}):(\d{2}):(\d{2})\]$/);
    if (!m || !videoId) return part;
    const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return <a key={i} href={`https://www.youtube.com/watch?v=${videoId}&t=${s}s`} target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200 underline">{part}</a>;
  });
}

export function AskDialog({ recordId, onClose }: { recordId: number; onClose: () => void }) {
  const rec = useRecord(recordId);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<{ q: string; a: string }[]>([]);
  const past = rec?.runs.filter(r => r.kind === 'ask') ?? [];

  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    const r = await attempt(api<{ answer: string }>(`/api/records/${recordId}/ask`, { method: 'POST', json: { question } }), 'Ask');
    setBusy(false);
    if (r) { setAnswers(cur => [{ q: question, a: r.answer }, ...cur]); setQ(''); }
  };

  return (
    <Dialog title="Ask Claude about this video" onClose={onClose} onAccept={() => void ask()} acceptLabel={busy ? 'Reading…' : 'Ask'} width="w-[720px]">
      {!rec ? <p className="text-slate-500">Loading…</p> : (
        <div className="flex flex-col gap-3">
          <p className="text-slate-400"><b className="text-slate-200">{rec.title || rec.url}</b> — Claude reads the whole record (v{rec.version}) for context. Timestamps open the video at that moment.</p>
          <textarea autoFocus value={q} onChange={e => setQ(e.target.value)} rows={3} className={field} disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void ask(); } }}
            placeholder='e.g. "At 00:20:15 X asked about the fine-tuning argument — how did Y answer?"  (Ctrl+Enter to ask)' />
          {busy && <p className="text-slate-500">Claude is reading the record…</p>}
          {[...answers, ...past.map(p => ({ q: p.prompt, a: p.result }))].map((x, i) => (
            <div key={i} className="border-t border-slate-800 pt-2">
              <p className="text-[11px] text-slate-500 mb-1">Q: {x.q}</p>
              <div className="whitespace-pre-line leading-relaxed text-slate-200">{withLinks(x.a, rec.videoId)}</div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
