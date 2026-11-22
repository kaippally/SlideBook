import { useEffect, useRef, useState } from 'react';
import { BTN_OFF, ColorAlpha, Group, Hint, Row, Section, SectionColumns, Seg, SegRow, Select, Slider, SubHead } from './slideControls';
import { BezierEditor } from '../titles/components/BezierEditor';
import { FontSelect } from './FontSelect';
import { api, playSound } from '../lib/api';
import { DEFAULT_EASING, resolveSlideSound, resolveHeadingStyle, type SlidePresentationStyle, type SlidePageStyle, type SlideState, type PresPose, type PoseLockKey, type PoseLocks, type SlideAlign, type DeckStyles, type SlideHeadingStyle, type SlidePageHeading } from './slideStyles';

const STATE_LABEL: Record<SlideState, string> = { in: 'In', hold: 'Hold', out: 'Out' };
const STATES: { id: SlideState; label: string }[] = [{ id: 'in', label: 'In' }, { id: 'hold', label: 'Hold' }, { id: 'out', label: 'Out' }];

/**
 * Three bands, each saying what it acts on: THIS SLIDE (its title, and the one look every title
 * shares right beside it), MOTION (the IN / HOLD / OUT keyframe poses, waft and tweens — the whole
 * deck, or every slide of this size when the scope switch says so), WHOLE DECK (align, change sound).
 * X / Y / Pitch / Yaw carry a lock that pins the value constant across all three states.
 */
export function SlideAnimationPanel({ deckLabel, pageNum, pageId, state, presentation, page, locks, align, alignPad, sound, heading, headingText, headingCarry, headingInherited, onStateChange, onPoseChange, onToggleLock, onTransitionChange, onPageChange, onAlign, onAlignPad, onSoundChange, onHeadingStyleChange, onHeadingChange, sizeScope: allowSizeScope = true }: {
  /** False for an object with no page sizes (the video object): no "Applies to" switch. */
  sizeScope?: boolean;
  deckLabel: string | null;
  pageNum: number | null;
  pageId?: string | null;                  // the page's stable manifest id — re-seeds the text box
  state: SlideState;
  presentation: SlidePresentationStyle | null;
  page: SlidePageStyle | null;
  locks: PoseLocks;
  align?: SlideAlign;
  alignPad?: number;
  sound?: DeckStyles['sound'];             // deck-wide slide-change sound (shared by all pages)
  heading?: DeckStyles['heading'];         // deck-wide heading look + appearance
  headingText?: string;                    // THIS page's own heading text ('' = none of its own)
  headingCarry?: boolean;                  // …and whether it continues onto the following slides
  headingInherited?: string;               // the heading this page shows from an earlier slide, if any
  onStateChange?: (s: SlideState) => void;
  onPoseChange: (patch: Partial<PresPose>) => void;
  onToggleLock: (key: PoseLockKey) => void;
  onTransitionChange: (patch: Partial<SlidePresentationStyle>) => void;
  onPageChange: (patch: Partial<SlidePageStyle>) => void;
  onAlign?: (side: SlideAlign) => void;   // deck-wide edge alignment (click the active side to release)
  onAlignPad?: (pad: number) => void;     // px inset from that edge, deck-wide
  onSoundChange?: (patch: Partial<{ url: string; volume: number }>) => void;
  onHeadingStyleChange?: (patch: Partial<SlideHeadingStyle>) => void; // deck-wide
  onHeadingChange?: (patch: Partial<SlidePageHeading>) => void;       // this page only
}) {
  const audioRef = useRef<HTMLInputElement>(null);
  const uploadSound = async (f: File | undefined) => {
    if (!f || !onSoundChange) return;
    const fd = new FormData(); fd.append('file', f);
    const r = await api<{ url: string }>('/api/media/audio', { method: 'POST', body: fd });
    onSoundChange({ url: r.url });
  };
  // The text box is local and re-seeded per page: typing straight into the deck's styles would
  // rewrite the decks array on every keystroke and move the caret.
  const [headingDraft, setHeadingDraft] = useState(headingText ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setHeadingDraft(headingText ?? ''); }, [pageId]);

  if (!presentation) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0b0d10] text-slate-600 text-[11px] italic px-4 text-center">
        Select a book on the left, then pick a page.
      </div>
    );
  }
  const p = presentation[state];
  const tuple = (e: number[]) => (e.length === 4 ? e : DEFAULT_EASING) as [number, number, number, number];
  const h = resolveHeadingStyle(heading);
  const sizeScope = allowSizeScope && !!page?.posOverride;

  return (
    <SectionColumns.Provider value>
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[#0b0d10] text-slate-300">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-800">
        <span className="min-w-0 truncate text-[11px] text-slate-400">{deckLabel}</span>
        <div className="flex-1" />
        {onStateChange ? (
          <div className="w-40 shrink-0 flex" title="Which keyframe pose the Motion controls edit — the canvas follows">
            <Seg value={state} options={STATES} onChange={onStateChange} />
          </div>
        ) : (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-blue-600/30 text-blue-200 border border-blue-500/50">{STATE_LABEL[state]}</span>
        )}
      </div>

      {onHeadingChange && (
        <Group title={`Slide ${pageNum ?? '—'}`} scope="this slide only">
          <Section title="Title">
            <input
              value={headingDraft}
              onChange={e => { setHeadingDraft(e.target.value); onHeadingChange({ text: e.target.value }); }}
              placeholder={headingInherited ? `Showing “${headingInherited}” from an earlier slide — type to replace` : 'Title for this slide'}
              className="col-span-full w-full bg-[#0d1117] border border-slate-700 rounded px-2.5 py-2 text-[13px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-blue-500/70"
            />
            <SegRow
              label="Shows on"
              value={headingCarry ? 'carry' : 'this'}
              options={[
                { id: 'this', label: 'This slide', hint: 'The title shows on this slide only' },
                { id: 'carry', label: 'Until next title', hint: 'Stays up on the following slides until another slide has its own title' },
              ]}
              onChange={v => onHeadingChange({ carry: v === 'carry' })}
            />
            <Hint>
              Appears once the slide reaches <span className="text-blue-300">Hold</span> — never during In or Out.
              {!headingDraft && headingInherited && <> Right now it shows <span className="text-blue-300">“{headingInherited}”</span>, carried from an earlier slide.</>}
            </Hint>
          </Section>

          {/* The look sits under the words it styles, but it is one look for the whole deck — said in its title. */}
          {onHeadingStyleChange && (
            <Section title="Title style · every slide" collapsible defaultOpen={!!(headingText || headingInherited)}>
              <SubHead>Text</SubHead>
              <Row label="Font">
                <FontSelect
                  value={h.font}
                  onChange={font => onHeadingStyleChange({ font })}
                  allowInherit
                  inheritLabel="Default (Arial)"
                  className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200"
                />
              </Row>
              <Row label="Colour">
                <input
                  type="color" value={h.color}
                  onChange={e => onHeadingStyleChange({ color: e.target.value })}
                  className="w-7 h-6 shrink-0 rounded bg-transparent border border-slate-700"
                />
                <span className="font-mono text-[10px] text-slate-500 uppercase">{h.color}</span>
              </Row>
              <Slider label="Size" value={h.size} min={12} max={220} step={2} suffix="px" onChange={size => onHeadingStyleChange({ size })} />
              <Slider label="Padding" value={h.padding} min={0} max={160} step={2} suffix="px" onChange={padding => onHeadingStyleChange({ padding })} />

              <SubHead>Placement</SubHead>
              <SegRow
                label="Position"
                value={h.anchor}
                options={[
                  { id: 'above', label: 'Above', hint: 'Above the slide' }, { id: 'top', label: 'Top', hint: 'Inside the slide, at the top' },
                  { id: 'bottom', label: 'Bottom', hint: 'Inside the slide, at the bottom' }, { id: 'below', label: 'Below', hint: 'Below the slide' },
                ]}
                onChange={anchor => onHeadingStyleChange({ anchor })}
              />
              <SegRow
                label="Align"
                value={h.align}
                options={[{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Right' }]}
                onChange={a => onHeadingStyleChange({ align: a })}
              />
              <Slider label="Nudge X" value={h.offsetX} min={-960} max={960} step={2} suffix="px" onChange={offsetX => onHeadingStyleChange({ offsetX })} />
              <Slider label="Nudge Y" value={h.offsetY} min={-540} max={540} step={2} suffix="px" onChange={offsetY => onHeadingStyleChange({ offsetY })} />
              <Slider label="Scale" value={h.scale} min={25} max={300} step={5} suffix="%" onChange={scale => onHeadingStyleChange({ scale })} />

              <SubHead>Shadow</SubHead>
              <ColorAlpha label="Colour" value={h.shadowColor} onChange={shadowColor => onHeadingStyleChange({ shadowColor })} />
              <Slider label="Blur" value={h.shadowBlur} min={0} max={60} step={1} suffix="px" onChange={shadowBlur => onHeadingStyleChange({ shadowBlur })} />
              <Slider label="Offset X" value={h.shadowX} min={-40} max={40} step={1} suffix="px" onChange={shadowX => onHeadingStyleChange({ shadowX })} />
              <Slider label="Offset Y" value={h.shadowY} min={-40} max={40} step={1} suffix="px" onChange={shadowY => onHeadingStyleChange({ shadowY })} />

              <SubHead>Entrance</SubHead>
              <Select
                label="Appears"
                value={h.appear}
                options={[
                  { id: 'none', label: 'Straight on' }, { id: 'fade', label: 'Fade in' }, { id: 'blur', label: 'Blur in' },
                  { id: 'rise', label: 'Rise up' }, { id: 'drop', label: 'Drop down' }, { id: 'slide', label: 'Slide in' },
                  { id: 'zoom', label: 'Zoom in' }, { id: 'typewriter', label: 'Typewriter' },
                ]}
                onChange={v => onHeadingStyleChange({ appear: v as SlideHeadingStyle['appear'] })}
              />
              {h.appear !== 'none' && (
                <Slider label="Speed" value={h.speed} min={1} max={100} step={1} onChange={speed => onHeadingStyleChange({ speed })} />
              )}
            </Section>
          )}
        </Group>
      )}

      <Group title="Motion" scope={!allowSizeScope ? 'the video object' : sizeScope ? 'every slide of this size' : 'every page in the book'}>
        {/* Per-size override, keyed by aspect (like crops). ON = a full independent pose: the sliders
            and canvas drag/tumble/depth edit slides of this size; the deck's in/out tween still plays. */}
        <Section
          title={`${STATE_LABEL[state]} pose`}
          actions={<>
            <button onClick={() => onPoseChange({ rotateX: 0, rotateY: 0 })} className={BTN_OFF} title="Zero Pitch and Yaw">Reset tilt</button>
            {sizeScope && (
              <button
                onClick={() => onPageChange({ posX: 0, posY: 0, posScale: 1, posZ: 0, posRotateX: 0, posRotateY: 0, posPerspective: 0, posOpacity: 0 })}
                className={BTN_OFF}
                title="Clear this size's own pose"
              >Reset size</button>
            )}
          </>}
        >
          {allowSizeScope && <div className="col-span-full"><SegRow
            label="Applies to"
            value={sizeScope ? 'size' : 'deck'}
            options={[
              { id: 'deck', label: 'All pages', hint: 'The pose sliders and canvas drag edit the whole book' },
              { id: 'size', label: 'This size', hint: 'Slides of this size get their own pose; the book in/out tween still plays' },
            ]}
            onChange={v => onPageChange({ posOverride: v === 'size' })}
          /></div>}
          <Slider label="X" value={p.x} min={-10000} max={10000} step={5} suffix="px" onChange={v => onPoseChange({ x: v })} hold={{ active: !!locks.x, onToggle: () => onToggleLock('x') }} />
          <Slider label="Y" value={p.y} min={-2500} max={2500} step={5} suffix="px" onChange={v => onPoseChange({ y: v })} hold={{ active: !!locks.y, onToggle: () => onToggleLock('y') }} />
          <Slider label="Depth Z" value={p.z} min={-4000} max={600} step={20} suffix="px" onChange={v => onPoseChange({ z: v })} />
          <Slider label="Scale" value={p.scale} min={0.05} max={2} step={0.05} suffix="×" onChange={v => onPoseChange({ scale: v })} />
          <Slider label="Pitch X" value={p.rotateX} min={-180} max={180} suffix="°" onChange={v => onPoseChange({ rotateX: v })} hold={{ active: !!locks.rotateX, onToggle: () => onToggleLock('rotateX') }} />
          <Slider label="Yaw Y" value={p.rotateY} min={-180} max={180} suffix="°" onChange={v => onPoseChange({ rotateY: v })} hold={{ active: !!locks.rotateY, onToggle: () => onToggleLock('rotateY') }} />
          <Slider label="Opacity" value={p.opacity} min={0} max={100} step={1} suffix="%" onChange={v => onPoseChange({ opacity: v })} />
          <Slider label="Perspective" value={p.perspective} min={0} max={2000} step={20} suffix="px" onChange={v => onPoseChange({ perspective: v })} />
          {sizeScope && (
            <Hint>
              These sliders and canvas drag / Ctrl+drag / Shift+wheel now set <span className="text-blue-300">every slide of this size</span>. Other sizes, and same-size slides added later, follow automatically.
            </Hint>
          )}
        </Section>

        {state === 'hold' && (
          <Section title="Waft · drift while holding">
            <Slider label="Amount" value={presentation.bounceAmount} min={0} max={400} step={5} suffix="px" onChange={v => onTransitionChange({ bounceAmount: v })} />
            <Slider label="Wafts" value={presentation.bounceCount} min={1} max={4} step={1} onChange={v => onTransitionChange({ bounceCount: v })} />
            <Slider label="Waft time" value={presentation.bounceDuration} min={3000} max={12000} step={250} suffix="ms" onChange={v => onTransitionChange({ bounceDuration: v })} />
          </Section>
        )}

        <Section title="Tween · duration + easing">
          {([
            ['In → Hold', 'text-sky-300/80', presentation.showDuration, presentation.showEasing,
              (d: number) => onTransitionChange({ showDuration: d }), (e: number[]) => onTransitionChange({ showEasing: e })],
            ['Hold → Out', 'text-violet-300/80', presentation.hideDuration, presentation.hideEasing,
              (d: number) => onTransitionChange({ hideDuration: d }), (e: number[]) => onTransitionChange({ hideEasing: e })],
          ] as const).map(([label, col, dur, ease, onDur, onEase]) => (
            <div key={label} className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] font-semibold ${col}`}>{label}</span>
                <input type="number" min={0} max={4000} step={50} value={dur}
                  onChange={e => onDur(Number(e.target.value))}
                  className="ml-auto w-16 bg-[#0d1117] border border-slate-700 rounded px-1 text-right font-mono tabular-nums text-slate-300 text-[10px] h-5 focus:outline-none focus:border-slate-500" />
                <span className="text-[10px] text-slate-500">ms</span>
              </div>
              <BezierEditor value={tuple(ease)} onChange={onEase} />
            </div>
          ))}
        </Section>
      </Group>

      {(onAlign || onSoundChange) && (
        <Group title="Whole book" scope="every slide">
          {/* Every page — including ones added later — is placed from its OWN rendered width, so a
              mixed-aspect deck still lines up. A size with its own pose opts out and keeps its X. */}
          {onAlign && (
            <Section title="Align">
              <SegRow
                label="Edge"
                value={align ?? 'centre'}
                options={[
                  { id: 'left', label: '⇤ Left', hint: 'Every slide flush to the left edge' },
                  { id: 'centre', label: 'Pose X', hint: 'No edge — each slide sits where its pose puts it' },
                  { id: 'right', label: 'Right ⇥', hint: 'Every slide flush to the right edge' },
                ]}
                onChange={v => { if (v === 'centre') { if (align) onAlign(align); } else if (v !== align) onAlign(v); }}
              />
              {align && onAlignPad && (
                <Slider label="Inset" value={alignPad ?? 0} min={0} max={960} step={5} suffix="px" onChange={onAlignPad} />
              )}
            </Section>
          )}

          {/* A sound on every slide CHANGE, picked from the shared audio library through the same
              file picker. */}
          {onSoundChange && (() => {
            const snd = resolveSlideSound(sound);
            const name = snd.url ? decodeURIComponent(snd.url.split('/').pop() ?? '') : '';
            return (
              <Section title="Slide change sound">
                <Row label="Effect">
                  <button
                    onClick={() => audioRef.current?.click()}
                    title="Choose a sound file for every page change"
                    className={`flex-1 min-w-0 truncate text-left bg-[#0d1117] border border-slate-700 hover:border-slate-500 rounded px-1.5 py-1 text-[11px] ${name ? 'text-slate-200' : 'text-slate-600'}`}
                  >{name || 'None — click to pick'}</button>
                  <button
                    onClick={() => { if (snd.url) playSound(snd.url, snd.volume / 100); }}
                    disabled={!snd.url}
                    title="Play the selected sound at this volume"
                    className={`${BTN_OFF} shrink-0 disabled:opacity-40`}
                  >▶</button>
                  {snd.url && (
                    <button onClick={() => onSoundChange({ url: '' })} title="Clear"
                      className="shrink-0 text-slate-600 hover:text-rose-400 text-xs px-1">✕</button>
                  )}
                </Row>
                {snd.url && (
                  <Slider label="Volume" value={snd.volume} min={0} max={100} step={1} suffix="%" onChange={v => onSoundChange({ volume: v })} />
                )}
              </Section>
            );
          })()}
        </Group>
      )}

      <input ref={audioRef} type="file" accept="audio/*" className="hidden" onChange={e => { void uploadSound(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
    </SectionColumns.Provider>
  );
}
