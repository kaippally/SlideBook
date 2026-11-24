import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

// Every dialog answers the same two keys: Esc closes, Enter accepts (not inside a textarea).
const stack: number[] = [];
let seq = 0;

export function Dialog({ title, children, onClose, onAccept, acceptLabel = 'OK', danger, width = 'w-[460px]' }: {
  title: string; children: ReactNode; onClose: () => void; onAccept?: () => void; acceptLabel?: string; danger?: boolean; width?: string;
}) {
  const [id] = useState(() => ++seq);
  useEffect(() => {
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      const t = e.target as HTMLElement | null;
      if (e.key === 'Enter' && onAccept && !(t?.tagName === 'TEXTAREA' || t?.isContentEditable)) { e.preventDefault(); e.stopPropagation(); onAccept(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); stack.splice(stack.indexOf(id), 1); };
  }, [id, onClose, onAccept]);
  return createPortal(
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/60" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${width} max-w-[95vw] max-h-[90vh] flex flex-col rounded-lg border border-slate-700 bg-[#11151c] shadow-2xl`}>
        <div className="px-4 py-2.5 border-b border-slate-800 text-sm font-semibold text-slate-100">{title}</div>
        <div className="p-4 overflow-auto text-[13px] text-slate-300">{children}</div>
        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1 rounded text-xs border border-slate-700 text-slate-300 hover:border-slate-500">Cancel <span className="opacity-50">esc</span></button>
          {onAccept && (
            <button onClick={onAccept} className={`px-3 py-1 rounded text-xs font-semibold ${danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-blue-600 hover:bg-blue-500'} text-white`}>{acceptLabel} <span className="opacity-60">↵</span></button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── corner notices ────────────────────────────────────────────────────────────

type Notice = { id: number; text: string; kind: 'info' | 'error' };
let notices: Notice[] = [];
const subs = new Set<(n: Notice[]) => void>();
function emit() { for (const f of subs) f(notices); }

export function notify(text: string, kind: Notice['kind'] = 'info') {
  if (notices.some(n => n.text === text)) return;
  const n = { id: ++seq, text, kind };
  notices = [...notices, n].slice(-4);
  emit();
  setTimeout(() => { notices = notices.filter(x => x.id !== n.id); emit(); }, kind === 'error' ? 7000 : 3500);
}

// ── questions ─────────────────────────────────────────────────────────────────
// askConfirm() resolves true on accept, false on cancel. Drawn by NoticeHost, so every page that mounts
// NoticeHost can ask.

type Ask = { title: string; text: string; label: string; danger: boolean; done: (ok: boolean) => void };
let asking: Ask | null = null;
const askSubs = new Set<(a: Ask | null) => void>();

export function askConfirm(title: string, text: string, { label = 'OK', danger = false } = {}): Promise<boolean> {
  return new Promise(resolve => {
    asking?.done(false);
    asking = { title, text, label, danger, done: ok => { asking = null; for (const f of askSubs) f(null); resolve(ok); } };
    for (const f of askSubs) f(asking);
  });
}

// ── updates ───────────────────────────────────────────────────────────────────
// The app checks GitHub on every launch (app/updater.py). A downloaded update is offered with its change list;
// after it is applied, the new version says once what changed.

type UpdateInfo = { state: string; version: string; notes: string; current: string; applied?: { version: string; notes: string } };

function UpdateNotice() {
  const [u, setU] = useState<UpdateInfo | null>(null);
  const [later, setLater] = useState(false);
  useEffect(() => {
    const load = () => void api<UpdateInfo>('/api/update').then(setU).catch(() => {});
    load();
    const t = window.setInterval(load, 60000);
    return () => window.clearInterval(t);
  }, []);
  if (u?.applied) {
    const close = () => { void api('/api/update/seen', { method: 'POST' }).catch(() => {}); setU({ ...u, applied: undefined }); };
    return (
      <Dialog title={`SlideBook updated to ${u.applied.version}`} onClose={close} onAccept={close} acceptLabel="OK" width="w-[560px]">
        <p className="mb-2 text-slate-400">What changed:</p>
        <div className="whitespace-pre-line">{u.applied.notes || 'No notes for this release.'}</div>
      </Dialog>
    );
  }
  if (u?.state === 'ready' && !later) {
    return (
      <Dialog title={`SlideBook ${u.version} is ready`} onClose={() => setLater(true)} acceptLabel="Restart and update" width="w-[560px]"
        onAccept={() => void api('/api/update/apply', { method: 'POST' }).catch(e => notify(`Update: ${e?.message ?? e}`, 'error'))}>
        <p className="mb-2 text-slate-400">You have {u.current}. It updates now, or by itself the next time SlideBook starts. What changed:</p>
        <div className="whitespace-pre-line">{u.notes || 'No notes for this release.'}</div>
      </Dialog>
    );
  }
  return null;
}

export function NoticeHost() {
  const [list, setList] = useState<Notice[]>([]);
  const [ask, setAsk] = useState<Ask | null>(asking);
  useEffect(() => { subs.add(setList); return () => { subs.delete(setList); }; }, []);
  useEffect(() => { askSubs.add(setAsk); return () => { askSubs.delete(setAsk); }; }, []);
  return <>
    <UpdateNotice />
    {ask && (
      <Dialog title={ask.title} onClose={() => ask.done(false)} onAccept={() => ask.done(true)} acceptLabel={ask.label} danger={ask.danger}>
        <p className="whitespace-pre-line">{ask.text}</p>
      </Dialog>
    )}
    {createPortal(
    <div className="fixed bottom-3 right-3 z-[1100] flex flex-col gap-2 items-end pointer-events-none">
      {list.map(n => (
        <div key={n.id} className={`pointer-events-auto max-w-sm px-3 py-2 rounded border text-xs shadow-lg ${n.kind === 'error' ? 'bg-rose-950/95 border-rose-800 text-rose-100' : 'bg-slate-900/95 border-slate-700 text-slate-100'}`}>{n.text}</div>
      ))}
    </div>,
    document.body,
  )}
  </>;
}

export async function attempt<T>(p: Promise<T>, what: string): Promise<T | undefined> {
  try { return await p; } catch (e: any) {
    if (e?.name !== 'Cancelled') notify(`${what}: ${e?.message ?? e}`, 'error');
    return undefined;
  }
}
