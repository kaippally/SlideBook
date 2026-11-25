import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { attempt, notify } from './Dialog';

// The Reports tab: every transcript (video record) with the reports Claude wrote from it, and a box to
// ask for a new one in your own words. Each request also teaches the learned report preferences.

export interface ReportItem { id: number; version: number; request: string; title: string; language: string; createdAt: number; recordId: number; recordTitle: string; url: string }
interface RecordItem { id: number; title: string; url: string; kind: string; reports: number; lineCount: number; created_at: number }

const field = 'w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600';
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

export function ReportsPanel({ selected, onSelect }: { selected: number | null; onSelect: (id: number | null) => void }) {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [recordId, setRecordId] = useState<number | null>(null);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  const load = async () => {
    const [r, p] = await Promise.all([api<RecordItem[]>('/api/records'), api<ReportItem[]>('/api/reports')]);
    setRecords(r); setReports(p);
    setRecordId(cur => cur ?? r[0]?.id ?? null);
  };
  useEffect(() => { void attempt(load(), 'Reports'); }, []);

  const write = async () => {
    if (!recordId || busy) return;
    setBusy(true);
    const r = await attempt(api<{ runId: number }>(`/api/records/${recordId}/report`, { method: 'POST', json: { request: request.trim() } }), 'Report');
    setBusy(false);
    if (r) { setRequest(''); notify('Report ready'); await load(); onSelect(r.runId); }
  };

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return records.map(rec => ({ rec, items: reports.filter(x => x.recordId === rec.id && (!needle || `${x.title} ${x.request} ${rec.title}`.toLowerCase().includes(needle))) }))
      .filter(g => g.items.length || (!needle || g.rec.title.toLowerCase().includes(needle)));
  }, [records, reports, q]);

  return (
    <div className="h-full flex flex-col bg-[#0b0d12] min-w-0">
      <div className="p-2 border-b border-slate-800 flex flex-col gap-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">New report</span>
        <select value={recordId ?? ''} onChange={e => setRecordId(Number(e.target.value))} className={field} disabled={busy}>
          {records.map(r => <option key={r.id} value={r.id}>{r.title || r.url}</option>)}
        </select>
        <textarea value={request} onChange={e => setRequest(e.target.value)} rows={4} className={field} disabled={busy}
          placeholder='How should it be made? e.g. "Evaluate the debate and write a report in English. Highlight the 5 most glaring errors and omissions by both participants."' />
        <button onClick={() => void write()} disabled={!recordId || busy}
          className="self-end px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-[11px] font-semibold text-white"
          title="Always two reports: English, and Malayalam in the speakers' own usage">
          {busy ? 'Claude is writing both… (3–6 min)' : 'Write reports (English + മലയാളം)'}
        </button>
        {!records.length && <p className="text-[11px] text-slate-500">No transcripts yet — analyse a link first.</p>}
      </div>
      <div className="px-2 py-1.5 border-b border-slate-800 flex items-center gap-1">
        <div className="relative flex-1 min-w-0">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search reports" className="w-full bg-[#0d1117] border border-slate-700 rounded pl-2 pr-5 py-0.5 text-[11px] text-slate-200" />
          {q && <button onClick={() => setQ('')} className="absolute right-1 top-0.5 text-[11px] text-slate-500 hover:text-white">✕</button>}
        </div>
        <span className="text-[10px] text-slate-500 tabular-nums">{reports.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.map(({ rec, items }) => (
          <div key={rec.id}>
            <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 bg-[#0e1118] truncate" title={rec.title}>{rec.title || rec.url}</div>
            {!items.length && <div className="px-3 py-1 text-[11px] text-slate-600">No reports yet</div>}
            {items.map(x => (
              <div key={x.id} onClick={() => onSelect(x.id)}
                className={`group px-3 py-1.5 border-l-2 cursor-pointer ${selected === x.id ? 'border-amber-500 bg-amber-950/30' : 'border-transparent hover:bg-slate-900'}`}>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-slate-200 font-semibold">v{x.version}</span>
                  {x.language && <span className="px-1 rounded bg-slate-800 text-[9px] text-slate-300">{x.language === 'Malayalam' ? 'മലയാളം' : 'EN'}</span>}
                  <span className="text-slate-500 tabular-nums">{day(x.createdAt)}</span>
                  <button onClick={e => { e.stopPropagation(); void attempt(api(`/api/runs/${x.id}/telegram`, { method: 'POST' }), 'Send').then(r => r && notify('Sent to Telegram as a PDF')); }}
                    className="ml-auto hidden group-hover:block text-[10px] text-sky-300 hover:text-sky-200" title="StudioMate's bot sends it to you as a phone PDF">Telegram</button>
                </div>
                <div className="text-[11px] text-slate-300 truncate">{x.title}</div>
                <div className="text-[10px] text-slate-500 truncate">{x.request || 'saved preferences'}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReportView({ runId }: { runId: number }) {
  return <iframe key={runId} src={`/api/runs/${runId}/report.html?screen=1`} className="absolute inset-0 z-20 w-full h-full bg-white" title="Report" />;
}
