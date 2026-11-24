import { api } from '../lib/api';
import { fmtT } from '../lib/shorts';
import type { QueueState, VideoItem } from '../lib/types';
import { attempt } from './Dialog';

const STATE: Record<QueueState, [string, string]> = {
  waiting: ['Waiting', 'text-slate-400'],
  pictures: ['Fetching pictures', 'text-sky-300 animate-pulse'],
  ready: ['Ready', 'text-amber-300'],
  rendering: ['Rendering', 'text-sky-300 animate-pulse'],
  done: ['Rendered', 'text-emerald-300'],
  failed: ['Failed', 'text-rose-300'],
};

/** Shorts waiting to be rendered, from every video, worked first come, first served: each gets its pictures,
 *  then renders at full resolution, with nothing to press. */
export function RenderQueue({ videos, openId, onAdd, canAdd, rangeText, onOpen }: {
  videos: VideoItem[]; openId: number | null; onAdd: () => void; canAdd: boolean; rangeText: string;
  onOpen: (videoId: number, planId: number) => void;
}) {
  const items = videos.flatMap(v => (v.plans || []).filter(p => p.queue).map(p => ({ v, p })))
    .sort((a, b) => (b.p.queue!.at || 0) - (a.p.queue!.at || 0));
  const active = items.filter(x => !['done', 'failed'].includes(x.p.queue!.state)).length;
  return (
    <div className="h-full flex flex-col min-h-0 text-[11px]">
      <div className="p-2 flex flex-col gap-1.5 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Render queue</span>
          <span className="ml-auto text-slate-500 tabular-nums">{items.length}</span>
        </div>
        <button disabled={!canAdd} onClick={onAdd}
          className="w-full px-2 py-1.5 rounded border border-fuchsia-500 text-fuchsia-100 font-semibold hover:bg-fuchsia-500/15 disabled:opacity-40">
          + Add current range <span className="font-normal text-fuchsia-200/70 tabular-nums">{rangeText}</span>
        </button>
        {active > 0 && <span className="text-[10px] text-slate-500">{active} in line · oldest first</span>}
      </div>
      <div className="flex-1 overflow-auto p-1.5 flex flex-col gap-1.5">
        {items.map(({ v, p }) => {
          const [label, cls] = STATE[p.queue!.state] ?? STATE.waiting;
          const pics = p.images || [];
          const on = p.id === openId;
          return (
            <div key={p.id} onClick={() => onOpen(v.id, p.id)}
              className={`group rounded border p-1.5 cursor-pointer ${on ? 'border-amber-400 bg-amber-400/5' : 'border-slate-800 hover:border-slate-600'}`}>
              <div className="flex gap-1.5">
                <div className="w-12 h-12 shrink-0 rounded bg-slate-900 overflow-hidden grid place-items-center">
                  {pics[0] ? <img src={pics[0].url} alt="" className="w-full h-full object-cover" />
                    : v.thumb ? <img src={`/media/${v.thumb}`} alt="" className="w-full h-full object-cover opacity-60" /> : null}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="leading-tight line-clamp-2">{p.title}</div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px]">
                    <span className={cls}>{label}</span>
                    <span className="text-slate-500 tabular-nums">{fmtT(p.length)}</span>
                    <span className="text-slate-500">{pics.length} pic{pics.length === 1 ? '' : 's'}</span>
                  </div>
                </div>
                <button title="Take out of the queue (the short stays)" onClick={e => {
                  e.stopPropagation();
                  void attempt(api(`/api/videos/${v.id}/plans/${p.id}/queue`, { method: 'DELETE' }), 'Remove from the queue');
                }} className="self-start hidden group-hover:block px-1 text-slate-500 hover:text-rose-300">✕</button>
              </div>
              {p.queue!.state === 'failed' && (
                <div className="mt-1 flex items-start gap-1.5 text-[10px]">
                  <span className="flex-1 text-rose-300/90 line-clamp-3" title={p.queue!.error}>{p.queue!.error}</span>
                  <button onClick={e => { e.stopPropagation(); void attempt(api(`/api/videos/${v.id}/plans/${p.id}/queue/retry`, { method: 'POST' }), 'Retry'); }}
                    className="shrink-0 px-1.5 rounded border border-slate-600 hover:border-slate-400">Retry</button>
                </div>
              )}
              {pics.length > 1 && (
                <div className="mt-1 flex gap-0.5 overflow-hidden">
                  {pics.slice(1, 7).map(im => <img key={im.id} src={im.url} alt="" title={im.why} className="w-6 h-6 rounded-sm object-cover" />)}
                </div>
              )}
            </div>
          );
        })}
        {!items.length && <p className="p-2 text-slate-500 leading-relaxed">Set a range on the timeline and add it: it becomes a short, Gemini fetches its pictures, and it waits here to be rendered.</p>}
      </div>
    </div>
  );
}
