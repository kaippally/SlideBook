import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ensureFont, fontFamily } from '../titles/render/fonts';
import { cardAccent, hexA, type CardStyle } from '../lib/cardStyle';
import type { Card, CardKind, ScoreRow } from '../lib/types';
import { EXTRA_COLORS, KIND_LABEL, KIND_VERDICTS, VERDICT_WORD } from '../lib/cardKinds';
import { fmtTime } from '../lib/bookModel';

/**
 * A claim or fallacy drawn as a slide face. It is authored in the 1920 space (the box's own size
 * divided by `scale`) and scaled down as one piece, so the canvas, the page strip and the OBS output
 * lay the text out identically and only the zoom differs. Auto-fit shrinks the type until it fits the
 * box — measured in that design space, so it never depends on how big the preview happens to be.
 */
export function CardFace({ kind, card, style, width, height, scale, asReflection }: {
  kind: CardKind; card: Card; style: CardStyle; width: number; height: number; scale: number; asReflection?: boolean;
}) {
  const W = width / Math.max(scale, 0.0001);
  const H = height / Math.max(scale, 0.0001);
  const accent = cardAccent(kind, card.verdict, style);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);

  useLayoutEffect(() => { ensureFont(style.font); ensureFont(style.bodyFont); }, [style.font, style.bodyFont]);

  const fitKey = `${kind}|${card.title}|${card.body}|${card.passage}|${(card.sources ?? []).length}|${card.speaker}|${(card.points ?? []).join('|')}|${JSON.stringify(card.rows ?? [])}|${W.toFixed(0)}|${H.toFixed(0)}|${style.headSize}|${style.bodySize}|${style.pad}|${style.font}|${style.bodyFont}|${style.autoFit}|${style.showPassage}|${style.showSources}|${card.t}`;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!style.autoFit) { setFit(1); return; }
    let f = 1;
    el.style.setProperty('--fit', '1');
    for (let i = 0; i < 8 && el.scrollHeight > el.clientHeight + 1; i++) {
      f *= Math.max(0.6, Math.sqrt(el.clientHeight / el.scrollHeight) * 0.98);
      el.style.setProperty('--fit', String(f));
    }
    setFit(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const label = kind === 'fallacy' ? style.fallacyLabel : kind === 'claim' ? style.claimLabel : KIND_LABEL[kind] ?? '';
  const hasVerdict = kind === 'claim' || !!KIND_VERDICTS[kind];
  const verdictKey = hasVerdict ? (card.verdict || '').toUpperCase() : '';
  const verdict = VERDICT_WORD[verdictKey] ?? verdictKey;
  const who = kind === 'qa' && card.asker ? `${card.asker} asks ${card.speaker || '…'}` : card.speaker || '';
  const box: CSSProperties = {
    position: 'absolute', left: 0, top: 0, width: W, height: H,
    transform: `scale(${scale})`, transformOrigin: '0 0',
    background: `linear-gradient(135deg, ${hexA(accent, style.tint / 100)}, transparent 60%), ${hexA(style.boxFill, style.boxAlpha / 100)}`,
    backdropFilter: !asReflection && style.blur > 0 ? `blur(${style.blur}px)` : undefined,
    borderRadius: style.radius,
    boxShadow: `inset ${style.edge}px 0 0 ${accent}`,
    color: style.textColor,
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: `${style.pad}px ${style.pad}px ${style.pad}px ${style.pad + style.edge}px`,
    display: 'flex', flexDirection: 'column',
  };
  const head = fontFamily(style.font || undefined);
  const bodyF = fontFamily(style.bodyFont || style.font || undefined);
  const em = (px: number) => `calc(${px}px * var(--fit, ${fit}))`;

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: style.pad * 0.45, flexShrink: 0 }}>
        <span style={{ fontFamily: head, fontWeight: 800, letterSpacing: '0.14em', fontSize: style.bodySize * 0.8, color: accent }}>{label}</span>
        {verdict && (
          <span style={{ fontFamily: head, fontWeight: 800, fontSize: style.bodySize * 0.72, letterSpacing: '0.08em', padding: '6px 20px', borderRadius: 999, background: accent, color: '#0b0b0b' }}>{verdict}</span>
        )}
        {kind === 'claim' && style.showSeverity && card.severity && (
          <span style={{ fontFamily: head, fontWeight: 700, fontSize: style.bodySize * 0.6, letterSpacing: '0.1em', opacity: 0.7 }}>{card.severity} SEVERITY</span>
        )}
        {(kind === 'claim' || kind === 'fallacy') && card.t != null && (
          <span style={{ marginLeft: 'auto', fontFamily: 'Consolas, monospace', fontWeight: 700, fontSize: style.bodySize * 0.62, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>▶ {fmtTime(card.t)}</span>
        )}
      </div>
      {who && kind !== 'scorecard' && (
        <div style={{ fontFamily: head, fontWeight: 700, fontSize: style.bodySize * 0.62, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.75, marginTop: -style.pad * 0.25, marginBottom: style.pad * 0.3, flexShrink: 0 }}>{who}</div>
      )}
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: em(style.bodySize * 0.6) }}>
        {kind === 'scorecard' ? <ScoreTable rows={card.rows ?? []} style={style} head={head} em={em} /> : <>
        {kind === 'contradiction' && card.passage && (
          <div style={{ fontFamily: bodyF, fontSize: em(style.bodySize * 0.9), lineHeight: 1.35, opacity: 0.75 }}><b>Earlier:</b> “{card.passage}”</div>
        )}
        <div style={{ fontFamily: head, fontWeight: 700, fontSize: em(style.headSize), lineHeight: 1.18 }} dangerouslySetInnerHTML={{ __html: (kind === 'contradiction' ? 'Now: ' : '') + (card.title || '<span style="opacity:.35">Heading</span>') }} />
        {kind === 'fallacy' && style.showPassage && card.passage && (
          <div style={{ fontFamily: bodyF, fontStyle: 'italic', fontSize: em(style.bodySize * 0.9), lineHeight: 1.35, opacity: 0.8, borderLeft: `4px solid ${hexA(accent, 0.7)}`, paddingLeft: 24 }}>“{card.passage}”</div>
        )}
        <div style={{ fontFamily: bodyF, fontSize: em(style.bodySize), lineHeight: 1.4, opacity: 0.94 }} dangerouslySetInnerHTML={{ __html: card.body || '' }} />
        {kind === 'qa' && card.passage && (
          <div style={{ fontFamily: bodyF, fontStyle: 'italic', fontSize: em(style.bodySize * 0.85), lineHeight: 1.35, opacity: 0.8, borderLeft: `4px solid ${hexA(accent, 0.7)}`, paddingLeft: 24 }}>{card.passage}</div>
        )}
        {kind === 'moderation' && (card.points?.length ?? 0) > 0 && (
          <div style={{ fontFamily: bodyF, fontSize: em(style.bodySize * 0.85), lineHeight: 1.4, opacity: 0.9 }}>
            {card.points!.map((p, i) => <div key={i}>• {p}</div>)}
          </div>
        )}
        {kind === 'claim' && style.showSources && (card.sources?.length ?? 0) > 0 && (
          <div style={{ fontFamily: bodyF, fontSize: em(style.bodySize * 0.62), lineHeight: 1.35, opacity: 0.65 }}>
            {card.sources!.slice(0, 4).map((s, i) => <div key={i}>• {s.label}{s.note ? ` — ${s.note}` : ''}</div>)}
          </div>
        )}
        </>}
      </div>
    </div>
  );
}

const SCORE_GROUPS: [string, [string, string][]][] = [
  ['Claims', [['FALSE', 'False'], ['MISLEADING', 'Misleading'], ['PARTLY TRUE', 'Partly true'], ['TRUE', 'True'], ['UNPROVEN', 'Unproven'], ['FALLACY', 'Fallacies']]],
  ['Questions', [['ANSWERED', 'Answered'], ['PARTIAL', 'Partly'], ['DODGED', 'Dodged'], ['CONTRADICTION', 'Contradicted self']]],
];

function ScoreTable({ rows, style, head, em }: { rows: ScoreRow[]; style: CardStyle; head: string; em: (px: number) => string }) {
  const color = (k: string) => (k === 'FALLACY' ? style.fallacyColor : k === 'CONTRADICTION' ? EXTRA_COLORS.contradiction! : style.verdict[k] ?? EXTRA_COLORS[k] ?? '#94a3b8');
  const cell: CSSProperties = { padding: `${em(12)} ${em(8)}`, textAlign: 'center', fontVariantNumeric: 'tabular-nums' };
  const groups = SCORE_GROUPS.map(([name, cols]) => [name, cols.filter(([k]) => rows.some(r => Number(r[k]) > 0))] as const).filter(([, cols]) => cols.length);
  return (<>
    {groups.map(([name, cols]) => (
      <table key={name} style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontFamily: head, fontSize: em(style.bodySize * 0.85) }}>
        <colgroup><col style={{ width: '24%' }} />{cols.map(([c]) => <col key={c} />)}</colgroup>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left', fontSize: em(style.bodySize * 0.5), letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.55 }}>{name}</th>
            {cols.map(([k, l]) => <th key={k} style={{ ...cell, fontSize: em(style.bodySize * 0.46), letterSpacing: '0.04em', textTransform: 'uppercase', color: color(k), verticalAlign: 'bottom' }}>{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.speaker} style={{ borderTop: '2px solid rgba(255,255,255,.12)' }}>
              <td style={{ ...cell, textAlign: 'left', fontWeight: 800 }}>{r.speaker}</td>
              {cols.map(([k]) => {
                const n = Number(r[k]) || 0;
                return <td key={k} style={{ ...cell, fontWeight: 800, color: n ? color(k) : 'rgba(255,255,255,.25)' }}>{n}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    ))}
  </>);
}
