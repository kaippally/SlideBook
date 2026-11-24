import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Book, BookSummary, Job, ServerState } from './types';
import { applySink } from './audioOut';

// Every call is relative: the page is always served by the app's own localhost server.

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const r = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  // An AI action that was already done: ask before calling Gemini again, then resend with `force`.
  if (r.status === 409 && data?.already) {
    const { askConfirm } = await import('../components/Dialog');
    if (await askConfirm('Already done', `${data.already}${String.fromCharCode(10, 10)}Run it again? This calls Gemini again.`, { label: 'Run again' })) {
      const body = json !== undefined && json !== null && typeof json === 'object' ? json : {};
      return api<T>(path, { ...init, json: { ...body, force: true } });
    }
    const e = new Error('Cancelled');
    e.name = 'Cancelled';
    throw e;
  }
  if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`);
  return data as T;
}

/** `replay`: play the page's segment clip even when stepping from inside that segment.
 *  `edit`: the canvas is in Edit mode — step straight between pages, no clip stops. */
export const control = (action: string, bookId?: string | null, page?: number, opts: { replay?: boolean; edit?: boolean } = {}) =>
  api<ServerState>('/api/control', { method: 'POST', json: { action, bookId, page, ...opts } });

// ── one WebSocket per window ──────────────────────────────────────────────────

type Listener = (msg: any) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let ws: WebSocket | null = null;
let connected = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    if (connected) for (const f of reconnectListeners) f();
    connected = true;
  };
  ws.onmessage = e => {
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state') setState(msg);
    for (const f of listeners) f(msg);
  };
  ws.onclose = () => { ws = null; setTimeout(connect, 1000); };
}

export function subscribe(fn: Listener): () => void {
  if (!ws) connect();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => { reconnectListeners.delete(fn); };
}

// ── server cursor (view + live) ───────────────────────────────────────────────

let serverState: ServerState = { type: 'state', view: null, live: null };
const stateSubs = new Set<() => void>();
function setState(s: ServerState) { serverState = s; for (const f of stateSubs) f(); }

export function useServerState(): ServerState {
  useEffect(() => subscribe(() => {}), []);
  return useSyncExternalStore(f => { stateSubs.add(f); return () => { stateSubs.delete(f); }; }, () => serverState);
}

// ── books ─────────────────────────────────────────────────────────────────────

const bookCache = new Map<string, Book>();
const bookWaiters = new Map<string, Promise<Book | null>>();

export function fetchBook(id: string, rev?: string): Promise<Book | null> {
  const hit = bookCache.get(id);
  if (hit && (!rev || hit.rev === rev)) return Promise.resolve(hit);
  const key = `${id}:${rev ?? ''}`;
  const pending = bookWaiters.get(key);
  if (pending) return pending;
  const p = api<Book>(`/api/books/${id}`).then(b => { bookCache.set(id, b); return b; }).catch(() => null)
    .finally(() => bookWaiters.delete(key));
  bookWaiters.set(key, p);
  return p;
}

export function putBookCache(b: Book) { bookCache.set(b.id, b); }

export function useBook(id: string | null | undefined): [Book | null, (b: Book) => void] {
  const [book, setBook] = useState<Book | null>(id ? bookCache.get(id) ?? null : null);
  useEffect(() => {
    if (!id) { setBook(null); return; }
    let live = true;
    setBook(bookCache.get(id) ?? null);
    fetchBook(id).then(b => { if (live) setBook(b); });
    const unsub = subscribe(msg => {
      if (msg.type === 'book' && msg.id === id) {
        if (msg.deleted) { bookCache.delete(id); setBook(null); return; }
        fetchBook(id, msg.rev).then(b => {
          if (!live || !b) return;
          // A reply that only echoes our own edit is already on screen; anything newer replaces it.
          setBook(cur => (cur && cur.updatedAt > b.updatedAt ? cur : b));
        });
      }
    });
    const unre = onReconnect(() => { bookCache.delete(id); fetchBook(id).then(b => { if (live) setBook(b); }); });
    return () => { live = false; unsub(); unre(); };
  }, [id]);
  const set = (b: Book) => { bookCache.set(b.id, b); setBook(b); };
  return [book, set];
}

export function useBooks(): BookSummary[] {
  const [books, setBooks] = useState<BookSummary[]>([]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => api<BookSummary[]>('/api/books').then(setBooks).catch(() => {});
    load();
    const unsub = subscribe(msg => {
      if (msg.type === 'book') { if (t) clearTimeout(t); t = setTimeout(load, 150); }
    });
    const unre = onReconnect(load);
    return () => { unsub(); unre(); if (t) clearTimeout(t); };
  }, []);
  return books;
}

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    api<Job[]>('/api/jobs').then(setJobs).catch(() => {});
    return subscribe(msg => {
      if (msg.type !== 'job') return;
      setJobs(prev => {
        const i = prev.findIndex(j => j.id === msg.job.id);
        if (i === -1) return [msg.job, ...prev].slice(0, 30);
        const next = prev.slice(); next[i] = msg.job; return next;
      });
    });
  }, []);
  return jobs;
}

export function playSound(url: string, volume = 1) {
  try { const a = new Audio(url); a.volume = Math.max(0, Math.min(1, volume)); applySink(a); a.play().catch(() => {}); } catch { /* no audio */ }
}
