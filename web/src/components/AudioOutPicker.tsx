import { useEffect, useState } from 'react';
import { listAudioOutputs, setAudioSink, useAudioSink, type AudioOutput } from '../lib/audioOut';

/** The SlideBook window's speaker: where the canvas video and the slide-change sound play here.
 *  OBS takes the output's sound itself, so this never touches what goes on air. */
export function AudioOutPicker() {
  const sink = useAudioSink();
  const [outs, setOuts] = useState<AudioOutput[]>([]);
  const load = () => void listAudioOutputs().then(setOuts).catch(() => {});
  useEffect(() => {
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, []);
  const known = outs.some(o => o.id === sink);
  return (
    <select value={sink} onChange={e => setAudioSink(e.target.value)} onFocus={load}
      title="Where SlideBook plays the canvas video and the slide-change sound in this window. What goes on air is OBS's to route."
      className="max-w-[190px] bg-[#0d1117] border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-slate-500">
      {!outs.some(o => o.id === '') && <option value="">Speaker · Windows default</option>}
      {outs.map(o => <option key={o.id || 'default'} value={o.id}>Speaker · {o.id === '' ? 'Windows default' : o.label}</option>)}
      {!known && sink && <option value={sink}>Speaker · (device not connected)</option>}
    </select>
  );
}
