import { useRef, useState } from 'react';

interface Props {
  value: [number, number, number, number];
  onChange: (v: [number, number, number, number]) => void;
}

// viewBox units; the SVG itself stretches to the panel width via width="100%".
const W = 100;
const H = 64;
const PAD = 12; // headroom so handles dragged above 1 / below 0 stay visible

const sx = (x: number) => PAD + x * (W - 2 * PAD);
const sy = (y: number) => (H - PAD) - y * (H - 2 * PAD);
const invX = (px: number) => (px - PAD) / (W - 2 * PAD);
const invY = (py: number) => ((H - PAD) - py) / (H - 2 * PAD);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function buildPath(p1x: number, p1y: number, p2x: number, p2y: number): string {
  return `M ${sx(0)},${sy(0)} C ${sx(p1x)},${sy(p1y)} ${sx(p2x)},${sy(p2y)} ${sx(1)},${sy(1)}`;
}

const NUM_CLS =
  'w-full bg-[#0b0d10] border border-slate-700/80 rounded px-1 text-right text-slate-300 text-[10px] focus:outline-none focus:border-rose-600 h-5';

export function BezierEditor({ value, onChange }: Props) {
  const [p1x, p1y, p2x, p2y] = value;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<0 | 1 | null>(null);

  function set(i: 0 | 1 | 2 | 3, raw: string) {
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    const next = [...value] as [number, number, number, number];
    next[i] = v;
    onChange(next);
  }

  function moveHandle(handle: 0 | 1, e: React.PointerEvent) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const vy = ((e.clientY - rect.top) / rect.height) * H;
    const x = clamp(invX(vx), 0, 1);          // cubic-bezier x must stay in [0,1]
    const y = clamp(invY(vy), -1, 2);
    const next = [...value] as [number, number, number, number];
    if (handle === 0) { next[0] = +x.toFixed(2); next[1] = +y.toFixed(2); }
    else              { next[2] = +x.toFixed(2); next[3] = +y.toFixed(2); }
    onChange(next);
  }

  return (
    <div className="w-full select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-28 rounded bg-[#0b0d10] border border-slate-700/60 touch-none"
        onPointerMove={e => { if (drag !== null) moveHandle(drag, e); }}
        onPointerUp={e => { if (drag !== null) { (e.target as Element).releasePointerCapture?.(e.pointerId); setDrag(null); } }}
        onPointerLeave={() => setDrag(null)}
      >
        {/* unit box (0..1 region) */}
        <rect x={sx(0)} y={sy(1)} width={sx(1) - sx(0)} height={sy(0) - sy(1)} fill="none" stroke="#1e293b" strokeWidth={0.5} />
        {/* grid thirds */}
        <line x1={sx(1 / 3)} y1={sy(0)} x2={sx(1 / 3)} y2={sy(1)} stroke="#1e293b" strokeWidth={0.4} />
        <line x1={sx(2 / 3)} y1={sy(0)} x2={sx(2 / 3)} y2={sy(1)} stroke="#1e293b" strokeWidth={0.4} />
        {/* guide lines to handles */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(p1x)} y2={sy(p1y)} stroke="#475569" strokeWidth={0.8} strokeDasharray="2 2" />
        <line x1={sx(1)} y1={sy(1)} x2={sx(p2x)} y2={sy(p2y)} stroke="#475569" strokeWidth={0.8} strokeDasharray="2 2" />
        {/* curve */}
        <path d={buildPath(p1x, p1y, p2x, p2y)} fill="none" stroke="#f43f5e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {/* endpoints */}
        <circle cx={sx(0)} cy={sy(0)} r={1.6} fill="#475569" />
        <circle cx={sx(1)} cy={sy(1)} r={1.6} fill="#475569" />
        {/* draggable handles (large transparent hit area + visible dot) */}
        {([[p1x, p1y, 0, '#38bdf8'], [p2x, p2y, 1, '#a78bfa']] as const).map(([hx, hy, h, col]) => (
          <g key={h}
            className="cursor-grab active:cursor-grabbing"
            onPointerDown={e => { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(h as 0 | 1); }}
          >
            <circle cx={sx(hx)} cy={sy(hy)} r={6} fill="transparent" />
            <circle cx={sx(hx)} cy={sy(hy)} r={3.5} fill={col} stroke="#0b0d10" strokeWidth={1} />
          </g>
        ))}
      </svg>

      <div className="grid grid-cols-4 gap-x-1.5 gap-y-0.5 mt-1">
        {([['P1x', p1x, 0, 'text-sky-400/80', 0, 1], ['P1y', p1y, 1, 'text-sky-400/80', -2, 3],
           ['P2x', p2x, 2, 'text-violet-400/80', 0, 1], ['P2y', p2y, 3, 'text-violet-400/80', -2, 3]] as const).map(
          ([lbl, val, idx, col, lo, hi]) => (
            <label key={lbl} className="flex items-center gap-0.5 min-w-0">
              <span className={`text-[9px] ${col} w-6 shrink-0`}>{lbl}</span>
              <input type="number" className={NUM_CLS} value={val} min={lo} max={hi} step={0.01}
                onChange={e => set(idx as 0 | 1 | 2 | 3, e.target.value)} />
            </label>
          ),
        )}
      </div>
    </div>
  );
}
