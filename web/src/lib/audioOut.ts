import { useSyncExternalStore } from 'react';
import { getUiSetting, setUiSetting } from './uiSettings';

/**
 * Where this window's sound goes: the canvas video and the slide-change sound, in the SlideBook
 * window. The pages OBS captures (`/output`, `/sfx`) never pick a device — OBS takes their sound
 * itself, and a page that sent it elsewhere would go silent on air.
 */
const KEY = 'audio:sink';
const captured = /^\/(output|sfx)/.test(location.pathname);
let sink = captured ? '' : (getUiSetting(KEY) ?? '');
const subs = new Set<() => void>();

export function setAudioSink(id: string) {
  if (captured) return;
  sink = id;
  setUiSetting(KEY, id);
  for (const f of subs) f();
}

export function useAudioSink(): string {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => sink);
}

/** Send one element's sound to the chosen device ('' = the Windows default). */
export function applySink(el: HTMLMediaElement) {
  const e = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
  if (captured || !e.setSinkId || e.sinkId === sink) return;
  e.setSinkId(sink).catch(() => { /* device gone: it stays on the default */ });
}

export interface AudioOutput { id: string; label: string }

/** The output devices. Their names are hidden until the page has been allowed a microphone once, so
 *  it asks for one, opens nothing and closes it again; refused, the devices are numbered instead. */
export async function listAudioOutputs(): Promise<AudioOutput[]> {
  const outs = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  let ds = await outs();
  if (ds.every(d => !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      ds = await outs();
    } catch { /* no permission: numbered */ }
  }
  return ds.filter(d => d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Output ${i + 1}` }));
}
