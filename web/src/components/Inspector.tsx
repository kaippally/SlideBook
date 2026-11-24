import { useState } from 'react';
import { RichTextInput } from './RichTextInput';
import { FontSelect } from './FontSelect';
import { Group, Hint, Row, Section, SectionColumns, SegRow, Slider, Toggle, BTN_OFF } from './slideControls';
import { SlideAnimationPanel } from './SlideAnimationPanel';
import { SlideStylesPanel } from './SlideStylesPanel';
import { SlideNotesPanel } from './SlideNotesPanel';
import { containPct, resolveCardStyle, VERDICTS, type CardStyle } from '../lib/cardStyle';
import { KIND_VERDICTS, VERDICT_WORD } from '../lib/cardKinds';
import { DEFAULT_COUNTER, type CounterStyle } from '../lib/counter';
import { fmtTime, isCard, resolveBookPage } from '../lib/bookModel';
import type { Book, BookSfx, Card, PageEntry } from '../lib/types';
import { SfxTab } from './SfxTab';
import { resolveVideo, videoStyle, type ClipMode, type VideoObjectStyle } from '../lib/videoObject';
import {
  headingForPage, resolveBorder, resolveSurface, type SlideBorder, type PoseLockKey, type PresPose, type SlideAlign, type SlideHeadingStyle,
  type SlidePageHeading, type SlidePageStyle, type SlidePresentationStyle, type SlideState, type SlideSurface,
} from './slideStyles';

type Tab = 'card' | 'cardStyle' | 'motion' | 'look' | 'notes' | 'book' | 'video' | 'sfx';

export interface InspectorActions {
  onCard: (patch: Partial<Card>, kind?: 'claim' | 'fallacy') => void;
  onPageCard: (p: PageEntry, patch: Partial<Card>) => void;
  onCardStyle: (patch: Partial<CardStyle>) => void;
  onBorder: (patch: Partial<SlideBorder>) => void;
  onPose: (patch: Partial<PresPose>) => void;
  onToggleLock: (k: PoseLockKey) => void;
  onTransition: (patch: Partial<SlidePresentationStyle>) => void;
  onPage: (patch: Partial<SlidePageStyle>) => void;
  onOverride: (patch: Partial<SlidePageStyle>) => void;
  onAlign: (side: SlideAlign) => void;
  onAlignPad: (pad: number) => void;
  onSound: (patch: Partial<{ url: string; volume: number }>) => void;
  onHeadingStyle: (patch: Partial<SlideHeadingStyle>) => void;
  onHeading: (patch: Partial<SlidePageHeading>) => void;
  onSurface: (patch: Partial<SlideSurface>) => void;
  onApplyAll: () => void;
  onNote: (html: string) => void;
  onBook: (patch: { title?: string; cardAspect?: number }) => void;
  onCounter: (patch: Partial<CounterStyle>) => void;
  onSaveDefault: () => void;
  /** The Card look tab (card style + border) saved as the default, and put back on this book. */
  onSaveCardLook: () => void;
  onSfx: (next: BookSfx[]) => void;
  onRecallCardLook: (() => void) | null;
  onPlayCard: (p: PageEntry) => void;
}

export interface VideoActions {
  onVideo: (patch: Partial<VideoObjectStyle>) => void;
  onPose: (patch: Partial<PresPose>) => void;
  onToggleLock: (k: PoseLockKey) => void;
  onTransition: (patch: Partial<SlidePresentationStyle>) => void;
  onPage: (patch: Partial<SlidePageStyle>) => void;
  onSurface: (patch: Partial<SlideSurface>) => void;
  onFetch: () => void;
}

// With the video object selected on the canvas, the inspector edits it instead of the slide.
const VIDEO_TABS: { id: Tab; label: string }[] = [{ id: 'video', label: 'Video' }, { id: 'motion', label: 'Motion' }, { id: 'look', label: 'Surface' }, { id: 'sfx', label: 'Sound FX' }];

const TABS: { id: Tab; label: string }[] = [
  { id: 'card', label: 'Card' }, { id: 'cardStyle', label: 'Card look' }, { id: 'motion', label: 'Motion' },
  { id: 'look', label: 'Surface' }, { id: 'notes', label: 'Notes' }, { id: 'sfx', label: 'Sound FX' }, { id: 'book', label: 'Book' },
];

const TITLE_LABEL: Record<string, string> = { claim: 'Claim', fallacy: 'Fallacy name', qa: 'The question', moderation: 'Summary', contradiction: 'What they say now', scorecard: 'Heading' };

function CardEditor({ page, onCard, onPlay, hasVideo, videoId }: { page: PageEntry; onCard: InspectorActions['onCard']; onPlay: (p: PageEntry) => void; hasVideo: boolean; videoId?: string | null }) {
  const c = page.card!;
  const [sources, setSources] = useState(() => (c.sources ?? []).map(s => (s.note ? `${s.label} — ${s.note}` : s.label)).join('\n'));
  return (
    <div className="flex flex-col gap-3 p-3">
      {(page.kind === 'claim' || page.kind === 'fallacy') && (
        <SegRow label="Kind" value={page.kind as 'claim' | 'fallacy'} options={[{ id: 'claim', label: 'Claim (FactBox)' }, { id: 'fallacy', label: 'Fallacy' }]} onChange={k => onCard({}, k)} />
      )}
      {KIND_VERDICTS[page.kind as 'qa'] && (
        <Row label="Verdict">
          <div className="flex flex-wrap gap-1">
            {KIND_VERDICTS[page.kind as 'qa']!.map(v => (
              <button key={v} onClick={() => onCard({ verdict: v })} className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${c.verdict === v ? 'bg-slate-200 text-black border-slate-200' : 'border-slate-700 text-slate-400 hover:text-white'}`}>{VERDICT_WORD[v] ?? v}</button>
            ))}
          </div>
        </Row>
      )}
      {page.kind !== 'scorecard' && page.kind !== 'moderation' && (
        <Row label={page.kind === 'qa' ? 'Answered by' : 'Speaker'}>
          <input key={`sp-${page.id}`} defaultValue={c.speaker ?? ''} onChange={e => onCard({ speaker: e.target.value })} placeholder="—"
            className="w-full bg-[#0f1318] border border-[#252d3a] rounded px-2 py-1 text-[12px] text-slate-300" />
        </Row>
      )}
      {page.kind === 'qa' && (
        <Row label="Asked by">
          <input key={`as-${page.id}`} defaultValue={c.asker ?? ''} onChange={e => onCard({ asker: e.target.value })} placeholder="—"
            className="w-full bg-[#0f1318] border border-[#252d3a] rounded px-2 py-1 text-[12px] text-slate-300" />
        </Row>
      )}
      {page.kind === 'scorecard' && (
        <div className="text-[11px] text-slate-500">The counts per speaker, made when the book was analysed. The page on air can also carry a live counter (Surface tab).</div>
      )}
      {page.kind === 'claim' && (<>
        <Row label="Verdict">
          <div className="flex flex-wrap gap-1">
            {VERDICTS.map(v => (
              <button key={v} onClick={() => onCard({ verdict: v })} className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${c.verdict === v ? 'bg-slate-200 text-black border-slate-200' : 'border-slate-700 text-slate-400 hover:text-white'}`}>{v}</button>
            ))}
          </div>
        </Row>
        <SegRow label="Severity" value={(c.severity || 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW'} options={[{ id: 'HIGH', label: 'High' }, { id: 'MEDIUM', label: 'Medium' }, { id: 'LOW', label: 'Low' }]} onChange={severity => onCard({ severity })} />
      </>)}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{TITLE_LABEL[page.kind] ?? 'Heading'}</div>
        <RichTextInput key={`t-${page.id}`} initialHtml={c.title} onChange={title => onCard({ title })} minHeight={44} />
      </div>
      {(page.kind === 'fallacy' || page.kind === 'qa' || page.kind === 'contradiction') && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{page.kind === 'qa' ? 'Why (one sentence)' : page.kind === 'contradiction' ? 'What they said earlier' : 'Passage (quoted)'}</div>
          <textarea key={`p-${page.id}`} defaultValue={c.passage} onChange={e => onCard({ passage: e.target.value })} rows={2}
            className="w-full bg-[#0f1318] border border-[#252d3a] rounded px-2 py-1.5 text-[12px] text-slate-300" />
        </div>
      )}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{page.kind === 'qa' ? 'What they actually said' : 'Explanation'}</div>
        <RichTextInput key={`b-${page.id}`} initialHtml={c.body} onChange={body => onCard({ body })} minHeight={110} />
      </div>
      {page.kind === 'moderation' && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Points — one per line</div>
          <textarea key={`pt-${page.id}`} defaultValue={(c.points ?? []).join('\n')} rows={4}
            onChange={e => onCard({ points: e.target.value.split('\n').map(l => l.trim()).filter(Boolean) })}
            className="w-full bg-[#0f1318] border border-[#252d3a] rounded px-2 py-1.5 text-[12px] text-slate-300" />
        </div>
      )}
      {page.kind === 'claim' && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Sources — one per line, "label — note"</div>
          <textarea key={`s-${page.id}`} value={sources} rows={3}
            onChange={e => {
              setSources(e.target.value);
              onCard({ sources: e.target.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, ...rest] = l.split(' — '); return { label: label!, note: rest.join(' — ') || undefined }; }) });
            }}
            className="w-full bg-[#0f1318] border border-[#252d3a] rounded px-2 py-1.5 text-[12px] text-slate-300" />
        </div>
      )}
      {c.t != null && (
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span>In the video at {videoId
            ? <a href={`https://youtu.be/${videoId}?t=${Math.floor(c.t)}`} target="_blank" rel="noreferrer" title="Open the original on YouTube at this moment"
                className="font-mono text-sky-300 underline hover:text-sky-200">{fmtTime(c.t)}–{fmtTime(c.tEnd)}</a>
            : <span className="font-mono text-slate-200">{fmtTime(c.t)}–{fmtTime(c.tEnd)}</span>}</span>
          {hasVideo && <button onClick={() => onPlay(page)} className={BTN_OFF} title="Put this book on air (if it is not) and play this card's clip in the OBS output, with its audio">▶ Play on OBS</button>}
        </div>
      )}
    </div>
  );
}

function CardStyleEditor({ s, onChange, aspect, border, onBorder, onSaveLook, onRecallLook }: {
  onSaveLook: () => void; onRecallLook: (() => void) | null;
  s: CardStyle; onChange: (p: Partial<CardStyle>) => void; aspect: number; border: SlideBorder; onBorder: (p: Partial<SlideBorder>) => void;
}) {
  const start = containPct(aspect);
  const w = s.width ?? start.width, h = s.height ?? start.height;
  const input = 'flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200';
  const color = (label: string, v: string, set: (v: string) => void) => (
    <Row label={label}><input type="color" value={v} onChange={e => set(e.target.value)} className="w-7 h-6 rounded bg-transparent border border-slate-700" /><span className="font-mono text-[10px] text-slate-500 uppercase">{v}</span></Row>
  );
  return (
    <SectionColumns.Provider value={false}>
      <Group title="Card look" scope="every card in this book">
        <div className="flex gap-1.5 px-3 pt-2">
          <button onClick={onSaveLook} className={BTN_OFF} title="Save everything on this tab — size, border, type, box, content, colours — as the default">Save as default</button>
          <button onClick={onRecallLook ?? undefined} disabled={!onRecallLook} className={`${BTN_OFF} disabled:opacity-40`}
            title={onRecallLook ? 'Put the saved default card look on this book' : 'Nothing saved yet — use Save as default first'}>Default</button>
        </div>
        <Section title="Size" actions={s.width ? <button onClick={() => onChange({ width: undefined, height: undefined })} className={BTN_OFF} title="Back to the card shape, as large as fits">Reset</button> : undefined}>
          <Slider label="Width" value={w} min={20} max={100} suffix="%" onChange={width => onChange({ width, height: h })} />
          <Slider label="Height" value={h} min={15} max={100} suffix="%" onChange={height => onChange({ width: w, height })} />
          <Hint>The box of every fact-check and fallacy card, as a share of the 1920×1080 frame. The text shrinks to fit when Auto-fit is on.</Hint>
        </Section>
        <Section title="Border · every slide and the video">
          <Slider label="Width" value={border.borderWidth} min={0} max={40} suffix="px" onChange={borderWidth => onBorder({ borderWidth })} />
          {border.borderWidth > 0 && (<>
            {color('Colour', border.borderColor, borderColor => onBorder({ borderColor }))}
            <Slider label="Rounding" value={border.borderRadius} min={0} max={120} suffix="px" onChange={borderRadius => onBorder({ borderRadius })} />
            <SegRow label="Line" value={border.borderStyle} options={[{ id: 'solid', label: 'Solid' }, { id: 'dashed', label: 'Dashed' }, { id: 'dotted', label: 'Dotted' }, { id: 'double', label: 'Double' }]}
              onChange={borderStyle => onBorder({ borderStyle })} />
          </>)}
          <Hint>The ring drawn outside each slide, card and the video object. 0 removes it.</Hint>
        </Section>
        <Section title="Type">
          <Row label="Heading"><FontSelect value={s.font} onChange={font => onChange({ font })} allowInherit inheritLabel="Default (Arial)" className={input} /></Row>
          <Row label="Body"><FontSelect value={s.bodyFont} onChange={bodyFont => onChange({ bodyFont })} allowInherit inheritLabel="Same as heading" className={input} /></Row>
          <Slider label="Head size" value={s.headSize} min={20} max={160} suffix="px" onChange={headSize => onChange({ headSize })} />
          <Slider label="Body size" value={s.bodySize} min={14} max={110} suffix="px" onChange={bodySize => onChange({ bodySize })} />
          <Toggle label="Auto-fit" value={s.autoFit} onChange={autoFit => onChange({ autoFit })} onLabel="Shrink to fit" offLabel="Fixed size" />
          {color('Text', s.textColor, textColor => onChange({ textColor }))}
        </Section>
        <Section title="Box">
          {color('Fill', s.boxFill, boxFill => onChange({ boxFill }))}
          <Slider label="Solid" value={s.boxAlpha} min={0} max={100} suffix="%" onChange={boxAlpha => onChange({ boxAlpha })} />
          <Slider label="Tint" value={s.tint} min={0} max={60} suffix="%" onChange={tint => onChange({ tint })} />
          <Slider label="Blur" value={s.blur} min={0} max={40} suffix="px" onChange={blur => onChange({ blur })} />
          <Slider label="Edge" value={s.edge} min={0} max={60} suffix="px" onChange={edge => onChange({ edge })} />
          <Slider label="Round" value={s.radius} min={0} max={120} suffix="px" onChange={radius => onChange({ radius })} />
          <Slider label="Padding" value={s.pad} min={10} max={200} suffix="px" onChange={pad => onChange({ pad })} />
        </Section>
        <Section title="Content">
          <Toggle label="Severity" value={s.showSeverity} onChange={showSeverity => onChange({ showSeverity })} onLabel="Shown" offLabel="Hidden" />
          <Toggle label="Sources" value={s.showSources} onChange={showSources => onChange({ showSources })} onLabel="Shown" offLabel="Hidden" />
          <Toggle label="Passage" value={s.showPassage} onChange={showPassage => onChange({ showPassage })} onLabel="Shown" offLabel="Hidden" />
          <Row label="Claim label"><input value={s.claimLabel} onChange={e => onChange({ claimLabel: e.target.value })} className={input} /></Row>
          <Row label="Fallacy label"><input value={s.fallacyLabel} onChange={e => onChange({ fallacyLabel: e.target.value })} className={input} /></Row>
        </Section>
        <Section title="Colours">
          {color('Fallacy', s.fallacyColor, fallacyColor => onChange({ fallacyColor }))}
          {VERDICTS.map(v => color(v, s.verdict[v] ?? '#94a3b8', c => onChange({ verdict: { ...s.verdict, [v]: c } })))}
        </Section>
      </Group>
    </SectionColumns.Provider>
  );
}

export function Inspector({ book, page, state, onState, a, hasVideo, stage, va, fetching }: {
  book: Book | null; page: number; state: SlideState; onState: (s: SlideState) => void; a: InspectorActions; hasVideo: boolean;
  stage: 'slide' | 'video'; va: VideoActions; fetching: boolean;
}) {
  const [slideTab, setSlideTab] = useState<Tab>('card');
  const [videoTab, setVideoTab] = useState<Tab>('video');
  const [open, setOpen] = useState(true);
  const isVideo = stage === 'video';
  const tab = isVideo ? videoTab : slideTab;
  const setTab = isVideo ? setVideoTab : setSlideTab;
  const tabs = isVideo ? VIDEO_TABS : TABS;
  if (!open) {
    return <button onClick={() => setOpen(true)} className="w-6 shrink-0 border-l border-slate-800 bg-[#0b0d10] text-slate-500 hover:text-white text-xs" title="Show the inspector">‹</button>;
  }
  const entry = book?.manifest[page - 1];
  const r = book && entry ? resolveBookPage(book, page) : null;
  const styles = book?.styles ?? {};
  const pageHeading = entry ? styles.headings?.[entry.id] : undefined;

  return (
    <div className="w-[360px] shrink-0 border-l border-slate-800 bg-[#0b0d10] flex flex-col min-h-0">
      <div className="flex items-center border-b border-slate-800">
        <div className="flex flex-wrap flex-1">
          {isVideo && <span className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-sky-300">Video ·</span>}
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`px-2.5 py-1.5 text-[11px] ${tab === t.id ? 'text-white border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t.label}</button>
          ))}
        </div>
        <button onClick={() => setOpen(false)} className="px-2 text-slate-500 hover:text-white" title="Hide">›</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!book && <div className="p-4 text-[11px] text-slate-600 italic">Open a book.</div>}
        {book && isVideo && (() => {
          const v = resolveVideo(book)!;
          const raw = videoStyle(book);
          return (<>
            {tab === 'video' && (
              <SectionColumns.Provider value={false}>
                <Group title="Video" scope="the clip before each card">
                  <Section title="Clip before the card">
                    <SegRow label="Play" value={v.on ? 'on' : 'off'} options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]} onChange={x => va.onVideo({ on: x === 'on' })} />
                    <SegRow label="Card" value={v.mode}
                      options={[{ id: 'after', label: 'After the video', hint: 'The clip plays, then the card arrives as the video leaves' },
                        { id: 'together', label: 'Together', hint: 'The card arrives with the clip; both are up while it plays' }]}
                      onChange={x => va.onVideo({ mode: x as ClipMode })} />
                    <Slider label="Before" value={v.pre} min={0} max={15} step={0.5} suffix="s" onChange={x => va.onVideo({ pre: x })} />
                    <Slider label="After" value={v.post} min={0} max={15} step={0.5} suffix="s" onChange={x => va.onVideo({ post: x })} />
                    <Slider label="Longest" value={v.maxLen} min={0} max={300} step={5} suffix="s" onChange={x => va.onVideo({ maxLen: x })} />
                    <Hint>Longest clip: a question card spans its whole answer, which can run minutes. 0 plays the whole segment.</Hint>
                    <Slider label="Volume" value={v.volume} min={0} max={100} step={1} suffix="%" onChange={x => va.onVideo({ volume: x })} />
                    <Hint>Stepping to a fact-check or fallacy card plays the moment it is about in this video — before the card, or beside it. Prev never plays it. While the book is on air the canvas copy is silent: the output carries the sound.</Hint>
                  </Section>
                  <Section title="Size" actions={raw.width ? <button onClick={() => va.onVideo({ width: undefined, height: undefined })} className={BTN_OFF} title="Back to the video's own shape">Reset</button> : undefined}>
                    <Slider label="Width" value={raw.width ?? 100} min={10} max={100} suffix="%" onChange={x => va.onVideo({ width: x, height: raw.height ?? 100 })} />
                    <Slider label="Height" value={raw.height ?? 100} min={10} max={100} suffix="%" onChange={x => va.onVideo({ width: raw.width ?? 100, height: x })} />
                    <Hint>The video's box as a share of the frame. A box of another shape crops the picture to fill it; it is never stretched. Motion → Scale still sizes the whole object.</Hint>
                  </Section>
                  <Section title="Blur">
                    <SegRow label="Blur" value={v.blurOn ? 'on' : 'off'} options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]} onChange={x => va.onVideo({ blurOn: x === 'on' })} />
                    <Slider label="Amount" value={v.blur} min={2} max={80} suffix="px" onChange={x => va.onVideo({ blur: x, blurOn: true })} />
                  </Section>
                  <Section title="File">
                    <div className="text-[10px] text-slate-500 break-all">{v.file}</div>
                    <button onClick={va.onFetch} disabled={fetching} className={`${BTN_OFF} disabled:opacity-40`}>{fetching ? 'Fetching…' : 'Fetch again'}</button>
                  </Section>
                </Group>
              </SectionColumns.Provider>
            )}
            {tab === 'motion' && (
              <SlideAnimationPanel deckLabel={`${book.title} · video`} pageNum={null} state={state} presentation={v.pres} page={v.pageStyle}
                locks={raw.locks ?? {}} sizeScope={false}
                onStateChange={onState} onPoseChange={va.onPose} onToggleLock={va.onToggleLock} onTransitionChange={va.onTransition} onPageChange={va.onPage} />
            )}
            {tab === 'look' && (
              <SlideStylesPanel pageNum={1} pageCount={1} page={v.pageStyle} surface={v.surface} title="Video" scope="the video object"
                onChange={va.onPage} onSurfaceChange={va.onSurface} />
            )}
          </>);
        })()}
        {book && !isVideo && tab === 'card' && (entry && isCard(entry) && entry.card
          ? <CardEditor key={entry.id} page={entry} onCard={a.onCard} onPlay={a.onPlayCard} hasVideo={hasVideo} videoId={book?.source?.videoId} />
          : <div className="p-4 text-[11px] text-slate-500">{entry ? 'This page is a picture — pick a claim or fallacy page to edit its text.' : 'No page selected.'}</div>)}
        {book && tab === 'sfx' && <SfxTab sfx={styles.sfx ?? []} onSfx={a.onSfx} />}
        {book && !isVideo && tab === 'cardStyle' && <CardStyleEditor s={resolveCardStyle(styles.card)} onChange={a.onCardStyle} aspect={book.cardAspect} border={resolveBorder(styles.border)} onBorder={a.onBorder} onSaveLook={a.onSaveCardLook} onRecallLook={a.onRecallCardLook} />}
        {book && !isVideo && tab === 'motion' && (
          <SlideAnimationPanel
            deckLabel={book.title} pageNum={entry ? page : null} pageId={entry?.id ?? null} state={state}
            presentation={r ? (r.pageStyle.posOverride ? r.pres : r.rawPres) : null} page={r?.pageStyle ?? null}
            locks={styles.poseLocks ?? {}} align={styles.align} alignPad={styles.alignPad} sound={styles.sound}
            heading={styles.heading} headingText={pageHeading?.text ?? ''} headingCarry={!!pageHeading?.carry}
            headingInherited={headingForPage(styles.headings, book.manifest, page)}
            onStateChange={onState} onPoseChange={a.onPose} onToggleLock={a.onToggleLock} onTransitionChange={a.onTransition}
            onPageChange={a.onOverride} onAlign={a.onAlign} onAlignPad={a.onAlignPad} onSoundChange={a.onSound}
            onHeadingStyleChange={a.onHeadingStyle} onHeadingChange={a.onHeading}
          />
        )}
        {book && !isVideo && tab === 'look' && (
          <SlideStylesPanel pageNum={entry ? page : null} pageCount={book.manifest.length} page={r?.pageStyle ?? null}
            surface={resolveSurface(styles.surface)} onChange={a.onPage} onSurfaceChange={a.onSurface} onApplyAll={a.onApplyAll} />
        )}
        {book && !isVideo && tab === 'notes' && (
          <SlideNotesPanel pageId={entry?.id ?? null} pageLabel={entry ? `Page ${page}` : null} html={(entry && styles.notes?.[entry.id]) || ''} onChange={a.onNote} />
        )}
        {book && !isVideo && tab === 'book' && (
          <SectionColumns.Provider value={false}>
            <Group title="Book" scope={book.title}>
              <Section title="Title">
                <input key={book.id} defaultValue={book.title} onBlur={e => e.target.value.trim() && e.target.value !== book.title && a.onBook({ title: e.target.value.trim() })}
                  className="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-100" />
              </Section>
              <Section title="Card shape">
                <SegRow label="Aspect" value={String(book.cardAspect.toFixed(4))}
                  options={[{ id: (16 / 9).toFixed(4), label: '16:9' }, { id: (4 / 3).toFixed(4), label: '4:3' }, { id: (1).toFixed(4), label: '1:1' }, { id: (4 / 5).toFixed(4), label: '4:5' }]}
                  onChange={v => a.onBook({ cardAspect: Number(v) })} />
                <Hint>One shape for every card in the book. Pictures keep their own shape.</Hint>
              </Section>
              {book.source?.url && (
                <Section title="Source">
                  <div className="text-[11px] text-slate-300 break-all">{book.source.title}</div>
                  <div className="text-[10px] text-slate-500 break-all">{book.source.url}</div>
                  <div className="text-[10px] text-slate-500">
                    {book.source.claims ?? 0} claims · {book.source.fallacies ?? 0} fallacies · {book.source.language} · {book.source.stance}
                    {book.source.transcriptVia && ` · transcript from ${book.source.transcriptVia}${book.source.generated ? ' (auto)' : ''}`}
                  </div>
                </Section>
              )}
              <Section title="Video">
                {book.source?.video
                  ? <Hint>The source video is on the canvas. Click it, or press <b>Video</b> above the canvas, to place it and set its clip, motion and surface.</Hint>
                  : book.source?.url
                    ? <>
                        <button onClick={va.onFetch} disabled={fetching} className={`${BTN_OFF} disabled:opacity-40`}>{fetching ? 'Fetching the video…' : 'Fetch the video for the canvas'}</button>
                        <Hint>This book was analysed before the video was kept. Fetch it once, up to 720p, and each fact-check and fallacy card will play its moment before it appears.</Hint>
                      </>
                    : <Hint>This book has no source video.</Hint>}
              </Section>
              <Section title="Counter on air">
                {(() => {
                  const c = { ...DEFAULT_COUNTER, ...((styles as { counter?: Partial<CounterStyle> }).counter ?? {}) };
                  return (<>
                    <SegRow label="Show" value={c.on ? 'on' : 'off'} options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]} onChange={v => a.onCounter({ on: v === 'on' })} />
                    <SegRow label="Where" value={c.position} options={[{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }]} onChange={v => a.onCounter({ position: v as 'top' | 'bottom' })} />
                    <SegRow label="Count" value={c.perSpeaker ? 'speaker' : 'all'} options={[{ id: 'speaker', label: 'Per speaker' }, { id: 'all', label: 'Together' }]} onChange={v => a.onCounter({ perSpeaker: v === 'speaker' })} />
                  </>);
                })()}
                <Hint>A running tally of the verdicts, fallacies and dodged questions on the cards up to the page on air. It climbs as you step and falls when you step back.</Hint>
              </Section>
              <Section title="Default look">
                <button onClick={a.onSaveDefault} className={BTN_OFF}>Use this book's look for new books</button>
                <Hint>Copies motion, surface, border, heading style, sound and card look — never page content.</Hint>
              </Section>
            </Group>
          </SectionColumns.Provider>
        )}
      </div>
    </div>
  );
}
