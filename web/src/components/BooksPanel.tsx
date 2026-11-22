import { isCardKind } from '../lib/cardKinds';
import { useMemo, useState } from 'react';
import { api, useJobs } from '../lib/api';
import { CardFace } from './CardFace';
import { DEFAULT_CARD_STYLE } from '../lib/cardStyle';
import { Dialog, attempt, notify } from './Dialog';
import type { BookSummary, Job } from '../lib/types';

const PREF = 'slidebook:library';
type Sort = 'date' | 'name' | 'pages';
interface Prefs { sort: Sort; asc: boolean; size: number; collapsed: string[] }
const MIN = 40;

function loadPrefs(): Prefs {
  try { return { sort: 'date', asc: false, size: 120, collapsed: [], ...JSON.parse(localStorage.getItem(PREF) || '{}') }; }
  catch { return { sort: 'date', asc: false, size: 120, collapsed: [] }; }
}

function Cover({ b, w }: { b: BookSummary; w: number }) {
  const h = Math.round(w * 9 / 16);
  const p = b.first;
  if (!p) return <div className="bg-slate-900 grid place-items-center text-[10px] text-slate-600" style={{ width: w, height: h }}>empty</div>;
  if (isCardKind(p.kind) && p.card) {
    return <div className="relative overflow-hidden bg-black" style={{ width: w, height: h }}><CardFace kind={p.kind} card={p.card} style={DEFAULT_CARD_STYLE} width={w} height={h} scale={h / 1080} /></div>;
  }
  return <img src={`/media/${p.ref}`} className="object-contain bg-slate-900" style={{ width: w, height: h }} draggable={false} />;
}

function JobRow({ j, onOpen }: { j: Job; onOpen: (id: string) => void }) {
  const col = j.status === 'done' ? 'text-emerald-300' : j.status === 'failed' ? 'text-rose-300' : 'text-sky-300';
  return (
    <div className="px-2 py-1 border-b border-slate-800/60 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className={`${col} shrink-0`}>{j.status === 'done' ? '✓' : j.status === 'failed' ? '✕' : j.status === 'awaiting' ? '…' : '⟳'}</span>
        <span className="truncate text-slate-300 flex-1" title={j.url}>{j.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
        {j.origin !== 'app' && <span className="text-[9px] text-sky-400" title="Sent from Telegram">TG</span>}
      </div>
      <div className="flex items-center gap-1.5 pl-4">
        <span className={`truncate flex-1 ${j.status === 'failed' ? 'text-rose-300/80' : 'text-slate-500'}`} title={j.error}>{j.status === 'failed' ? j.error || j.step : j.step}</span>
        {j.status === 'done' && j.book_id && <button onClick={() => onOpen(j.book_id!)} className="text-sky-300 hover:text-sky-200">open</button>}
        {j.status === 'failed' && <button onClick={() => attempt(api(`/api/jobs/${j.id}/retry`, { method: 'POST' }), 'Retry')} className="text-slate-300 hover:text-white">retry</button>}
      </div>
    </div>
  );
}

const ALL_EXAMINE = ['claims', 'fallacies', 'answers', 'moderation', 'tally', 'contradictions'];

export function BooksPanel({ books, viewId, liveId, stances, activeStance, onOpen, onSettings }: {
  books: BookSummary[];
  viewId: string | null;
  liveId: string | null;
  stances: { id: string; name: string }[];
  activeStance: string;
  onOpen: (id: string) => void;
  onSettings: () => void;
}) {
  const jobs = useJobs();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const save = (p: Partial<Prefs>) => setPrefs(cur => { const n = { ...cur, ...p }; try { localStorage.setItem(PREF, JSON.stringify(n)); } catch { /* ok */ } return n; });
  const [q, setQ] = useState('');
  const [url, setUrl] = useState('');
  const [into, setInto] = useState<'new' | 'open'>('new');
  const [stance, setStance] = useState(activeStance);
  const [kind, setKind] = useState<'single' | 'debate' | 'panel'>('single');
  const [rename, setRename] = useState<BookSummary | null>(null);
  const [regroup, setRegroup] = useState<BookSummary | null>(null);
  const [del, setDel] = useState<BookSummary | null>(null);
  const [text, setText] = useState('');
  const listMode = prefs.size <= MIN;

  const analyse = async () => {
    const u = url.trim();
    if (!u) return;
    const r = await attempt(api('/api/analyse', { method: 'POST', json: { url: u, bookId: into === 'open' ? viewId : null, stanceId: stance, kind, examine: kind === 'single' ? ['claims', 'fallacies'] : ALL_EXAMINE } }), 'Analyse');
    if (r) { setUrl(''); notify('Queued for analysis'); }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = books.filter(b => !needle || b.title.toLowerCase().includes(needle) || b.sourceTitle.toLowerCase().includes(needle));
    const dir = prefs.asc ? 1 : -1;
    list.sort((a, b) => dir * (prefs.sort === 'name' ? a.title.localeCompare(b.title) : prefs.sort === 'pages' ? a.pageCount - b.pageCount : a.createdAt - b.createdAt));
    return list;
  }, [books, q, prefs.sort, prefs.asc]);

  const groups = useMemo(() => {
    if (q.trim()) return [{ name: '', items: shown }];
    const m = new Map<string, BookSummary[]>();
    for (const b of shown) { const g = b.group || ''; if (!m.has(g)) m.set(g, []); m.get(g)!.push(b); }
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))).map(([name, items]) => ({ name, items }));
  }, [shown, q]);

  const tile = (b: BookSummary) => {
    const live = b.id === liveId, open = b.id === viewId;
    const ring = live ? 'border-emerald-500 ring-1 ring-emerald-500/60' : open ? 'border-sky-500' : 'border-slate-800 hover:border-slate-600';
    const actions = (
      <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5">
        <button onClick={e => { e.stopPropagation(); setText(b.title); setRename(b); }} className="w-5 h-5 rounded bg-black/75 text-[10px]" title="Rename">✎</button>
        <button onClick={e => { e.stopPropagation(); setText(b.group); setRegroup(b); }} className="w-5 h-5 rounded bg-black/75 text-[10px]" title="Group">▤</button>
        <button onClick={e => { e.stopPropagation(); setDel(b); }} className="w-5 h-5 rounded bg-black/75 text-[11px] text-rose-400" title="Delete">×</button>
      </div>
    );
    if (listMode) {
      return (
        <div key={b.id} onClick={() => onOpen(b.id)} className={`group relative grid grid-cols-[minmax(0,1fr)_3rem_3rem] gap-2 px-2 py-1 border-l-2 cursor-pointer text-[11px] ${live ? 'border-emerald-500 bg-emerald-950/30' : open ? 'border-sky-500 bg-sky-950/20' : 'border-transparent hover:bg-slate-900'}`}>
          <span className="truncate text-slate-200" title={b.sourceTitle}>{b.title}</span>
          <span className="text-right tabular-nums text-slate-400">{b.pageCount}</span>
          <span className="text-right tabular-nums text-slate-500">{b.cards}</span>
          {actions}
        </div>
      );
    }
    return (
      <div key={b.id} onClick={() => onOpen(b.id)} className={`group relative rounded border-2 overflow-hidden cursor-pointer bg-[#0d1016] ${ring}`} style={{ width: prefs.size }}>
        <Cover b={b} w={prefs.size - 4} />
        <div className="px-1.5 py-1">
          <div className="text-[11px] text-slate-200 leading-tight line-clamp-2" title={b.title}>{b.title}</div>
          <div className="text-[9px] text-slate-500 mt-0.5">{b.pageCount} pages · {b.cards} cards</div>
        </div>
        {live && <span className="absolute top-1 left-1 px-1.5 rounded bg-emerald-600 text-[9px] font-bold text-white">ON AIR</span>}
        {actions}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0d12] border-r border-slate-800 min-w-0">
      <div className="p-2 border-b border-slate-800 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-100 tracking-wide">SlideBook</span>
          <button onClick={onSettings} className="ml-auto text-slate-400 hover:text-white text-sm" title="Settings">⚙</button>
        </div>
        <div className="flex gap-1">
          <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void analyse(); }}
            placeholder="Paste a video link to analyse…" className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
          <button onClick={() => void analyse()} disabled={!url.trim()} className="px-2.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-[11px] font-semibold text-white">Analyse</button>
        </div>
        <div className="flex gap-1 text-[10px]">
          <select value={into} onChange={e => setInto(e.target.value as 'new' | 'open')} className="bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-slate-300">
            <option value="new">into a new book</option>
            <option value="open" disabled={!viewId}>into the open book</option>
          </select>
          <select value={kind} onChange={e => setKind(e.target.value as 'single' | 'debate' | 'panel')} className="bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-slate-300" title="What kind of video — a debate or panel is transcribed with speakers and judged on its answers">
            <option value="single">one speaker</option>
            <option value="debate">debate / interview</option>
            <option value="panel">panel</option>
          </select>
          <select value={stance} onChange={e => setStance(e.target.value)} className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-slate-300" title="Critique stance">
            {stances.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {jobs.filter(j => j.status !== 'done' || Date.now() / 1000 - j.updated_at < 3600).slice(0, 5).length > 0 && (
        <div className="border-b border-slate-800 max-h-40 overflow-y-auto">
          {jobs.filter(j => j.status !== 'done' || Date.now() / 1000 - j.updated_at < 3600).slice(0, 5).map(j => <JobRow key={j.id} j={j} onOpen={onOpen} />)}
        </div>
      )}

      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-800">
        <button onClick={async () => { const b = await attempt(api('/api/books', { method: 'POST', json: { title: 'Untitled book' } }), 'New book'); if (b) onOpen(b.id); }}
          className="px-2 py-0.5 rounded border border-slate-700 text-[11px] text-slate-200 hover:border-slate-500">＋ Book</button>
        <div className="relative flex-1 min-w-0">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" className="w-full bg-[#0d1117] border border-slate-700 rounded pl-2 pr-5 py-0.5 text-[11px] text-slate-200" />
          {q && <button onClick={() => setQ('')} className="absolute right-1 top-0.5 text-[11px] text-slate-500 hover:text-white">✕</button>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-slate-800 text-[10px]">
        <select value={prefs.sort} onChange={e => save({ sort: e.target.value as Sort })} className="bg-[#0d1117] border border-slate-700 rounded px-1 py-0.5 text-slate-300">
          <option value="date">Date added</option><option value="name">Name</option><option value="pages">Pages</option>
        </select>
        <button onClick={() => save({ asc: !prefs.asc })} className="px-1 text-slate-400 hover:text-white" title="Direction">{prefs.asc ? '▲' : '▼'}</button>
        <span className="text-slate-500" title="List mode at the far left">{listMode ? '☰' : '▦'}</span>
        <input type="range" min={MIN} max={220} value={prefs.size} onChange={e => save({ size: Number(e.target.value) })} className="w-20" title="Tile size — far left is list mode" />
        <span className="ml-auto text-slate-500 tabular-nums">{q ? `${shown.length}/${books.length}` : books.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {listMode && <div className="grid grid-cols-[minmax(0,1fr)_3rem_3rem] gap-2 px-2 py-1 text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800"><span>Title</span><span className="text-right">Pages</span><span className="text-right">Cards</span></div>}
        {groups.map(g => {
          const collapsed = prefs.collapsed.includes(g.name);
          return (
            <div key={g.name || '_'}>
              {(groups.length > 1 || g.name) && (
                <button onClick={() => save({ collapsed: collapsed ? prefs.collapsed.filter(c => c !== g.name) : [...prefs.collapsed, g.name] })}
                  className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 bg-[#0e1118]">
                  <span>{collapsed ? '▶' : '▼'}</span><span>{g.name || 'Ungrouped'}</span><span className="text-slate-600">{g.items.length}</span>
                </button>
              )}
              {!collapsed && (listMode
                ? <div>{g.items.map(tile)}</div>
                : <div className="flex flex-wrap gap-2 p-2">{g.items.map(tile)}</div>)}
            </div>
          );
        })}
        {!books.length && <div className="p-4 text-[11px] text-slate-600">No books yet. Paste a link above, or send one to StudioMate's Telegram bot.</div>}
      </div>

      {rename && (
        <Dialog title="Rename book" onClose={() => setRename(null)} onAccept={async () => { await attempt(api(`/api/books/${rename.id}`, { method: 'PATCH', json: { title: text.trim() || rename.title } }), 'Rename'); setRename(null); }}>
          <input autoFocus value={text} onChange={e => setText(e.target.value)} className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-100" />
        </Dialog>
      )}
      {regroup && (
        <Dialog title="Group" onClose={() => setRegroup(null)} onAccept={async () => { await attempt(api(`/api/books/${regroup.id}`, { method: 'PATCH', json: { group: text.trim() } }), 'Group'); setRegroup(null); }}>
          <input autoFocus value={text} onChange={e => setText(e.target.value)} list="groups" placeholder="Group name (empty = ungrouped)" className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-100" />
          <datalist id="groups">{[...new Set(books.map(b => b.group).filter(Boolean))].map(g => <option key={g} value={g} />)}</datalist>
        </Dialog>
      )}
      {del && (
        <Dialog title="Delete book?" danger acceptLabel="Delete" onClose={() => setDel(null)} onAccept={async () => { await attempt(api(`/api/books/${del.id}`, { method: 'DELETE' }), 'Delete'); setDel(null); }}>
          <p><b className="text-slate-100">{del.title}</b> — {del.pageCount} pages{del.id === liveId ? ', currently ON AIR' : ''}. This cannot be undone.</p>
        </Dialog>
      )}
    </div>
  );
}
