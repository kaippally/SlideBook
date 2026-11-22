import { useEffect, useState } from 'react';
import { api, subscribe } from '../lib/api';
import { Dialog, notify } from './Dialog';

export interface BotStatus {
  studiomate: 'unknown' | 'ok' | 'down' | 'nologin';
  own: 'off' | 'running' | 'failed';
  ownName: string; ownError: string; configured: boolean; userId: string;
}

export function useBotStatus(): BotStatus | null {
  const [s, setS] = useState<BotStatus | null>(null);
  useEffect(() => {
    api<BotStatus>('/api/bot').then(setS).catch(() => {});
    return subscribe(msg => { if (msg.type === 'bot') setS(msg as BotStatus); });
  }, []);
  return s;
}

/** StudioMate's bot is unusable and SlideBook's own bot is not running in its place. */
export const botNeedsSetup = (s: BotStatus | null) =>
  !!s && (s.studiomate === 'down' || s.studiomate === 'nologin') && (!s.configured || s.own === 'failed');

export function botSummary(s: BotStatus | null) {
  if (!s) return '';
  if (s.studiomate === 'ok') return "Links arrive through StudioMate's bot.";
  if (s.own === 'running') return `StudioMate's bot is ${s.studiomate === 'down' ? 'not running' : 'not logged in'}; SlideBook's own bot @${s.ownName} is taking links.`;
  return `StudioMate's bot is ${s.studiomate === 'down' ? 'not running' : s.studiomate === 'nologin' ? 'not logged in' : 'being checked'}, and SlideBook's own bot is ${s.own === 'failed' ? 'unable to log in' : 'not set up'}.`;
}

export function BotDialog({ status, onClose }: { status: BotStatus | null; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [userId, setUserId] = useState(status?.userId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await api<BotStatus>('/api/bot', { method: 'PUT', json: { token: token.trim(), userId: userId.trim() } });
      if (r.own === 'failed') setError(`Telegram refused the bot: ${r.ownError}`);
      else { notify(r.own === 'running' ? `Bot @${r.ownName} is online` : "Saved. It takes over whenever StudioMate's bot is unavailable."); onClose(); }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally { setBusy(false); }
  };

  const field = 'w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100';
  return (
    <Dialog title="Telegram bot" onClose={onClose} onAccept={save} acceptLabel={busy ? 'Logging in…' : 'Save'} width="w-[520px]">
      <div className="flex flex-col gap-3">
        <p className="text-slate-400">{botSummary(status)} Enter a bot of SlideBook&apos;s own and it takes links while StudioMate&apos;s bot is unavailable.</p>
        {status?.own === 'failed' && status.ownError && !error && <p className="text-rose-300 text-[12px]">Last login failed: {status.ownError}</p>}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Bot token</span>
          <input type="password" autoFocus value={token} onChange={e => setToken(e.target.value)}
            placeholder={status?.configured ? 'Token saved — paste to replace' : '123456789:AA… from @BotFather'} className={`${field} font-mono`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Your Telegram user id</span>
          <input value={userId} onChange={e => setUserId(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
            placeholder="e.g. 123456789 — ask @userinfobot" className={`${field} font-mono`} />
          <span className="text-[10px] text-slate-500">Only this account can send links or step the slides. The bot also replies with the id to anyone it refuses.</span>
        </label>
        {error && <p className="text-rose-300 text-[12px]">{error}</p>}
      </div>
    </Dialog>
  );
}
