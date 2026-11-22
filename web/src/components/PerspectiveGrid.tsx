import React from 'react';

/**
 * Editor-only perspective FLOOR grid for the Slides canvas. Its horizon coincides with the
 * reflection-surface line (`surfaceY`, a 0..1 fraction of the stage height) — drag that line and
 * the whole grid re-projects. Orthogonals recede to a central vanishing point ON the horizon and
 * transversals foreshorten toward it, so the band between the surface line and the bottom edge
 * reads as the reflective floor the object stands on and its mirror image lies on. Purely a visual
 * aid — never on the OBS output. pointer-events none so it never blocks dragging.
 */
export function PerspectiveGrid({ w, h, surfaceY = 0.18, count = 12 }: { w: number; h: number; surfaceY?: number; count?: number }) {
  if (w <= 0 || h <= 0) return null;
  const s = Math.max(0.02, Math.min(0.98, surfaceY));
  const horizon = h * s;              // eye level = the reflection surface line
  const floor = h - horizon;          // visible floor band (surface line → bottom edge)
  const vp = { x: w / 2, y: horizon }; // central vanishing point, on the horizon

  const lines: React.ReactNode[] = [];
  const line = (key: string, a: { x: number; y: number }, b: { x: number; y: number }, color: string, op: number) =>
    lines.push(<line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1} opacity={op} vectorEffect="non-scaling-stroke" />);

  // Horizon (the surface line) — the reflection mirrors across this.
  line('hz', { x: 0, y: horizon }, { x: w, y: horizon }, '#94a3b8', 0.5);

  // Orthogonals: from points raked across the bottom edge up to the VP (floor depth lines).
  // The bottom fan spans wider than the stage so the outer lines still cross the floor corners.
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const bx = w * (-0.5 + 2 * t);
    line(`o${i}`, { x: bx, y: h }, vp, '#38bdf8', 0.28);
  }

  // Transversals: horizontal floor lines, perspective-foreshortened (bunching toward the horizon).
  // Equal depth steps projected to screen: y = horizon + floor / (1 + depth).
  for (let i = 1; i <= count; i++) {
    const y = horizon + floor / (1 + i * 0.45);
    line(`t${i}`, { x: 0, y }, { x: w, y }, '#38bdf8', 0.16);
  }

  return (
    <svg className="absolute inset-0 pointer-events-none" width={w} height={h} style={{ zIndex: 15, overflow: 'hidden' }}>
      {lines}
      <circle cx={vp.x} cy={vp.y} r={4} fill="#38bdf8" />
      <text x={vp.x} y={vp.y - 8} fill="#38bdf8" fontSize={11} fontWeight="bold" textAnchor="middle">VP</text>
    </svg>
  );
}
