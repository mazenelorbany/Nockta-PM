/**
 * Inline SVG sparkline of the last-7-days open-task series. Width ~80px,
 * height ~20px. Brand-coloured stroke, no chart library — just a polyline
 * over the N points (with min/max normalised to the bounding box).
 */
export function Sparkline({ series }: { series: number[] }): JSX.Element {
  const W = 80;
  const H = 20;
  const PAD = 1;
  const pts = series.length > 0 ? series : [0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const coords = pts.map((v, i) => {
    const x = PAD + i * stepX;
    // Invert Y so larger values sit at the top.
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });
  // If every value is the same, draw a flat horizontal mid-line so the row
  // still feels alive (the path would otherwise be at y=PAD because of the
  // 1-(v-min)/range collapse).
  const flat = min === max;
  const path = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${flat ? (H / 2).toFixed(1) : y.toFixed(1)}`)
    .join(' ');
  const last = coords[coords.length - 1];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-brand shrink-0"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last && (
        <circle
          cx={last[0]}
          cy={flat ? H / 2 : last[1]}
          r={1.6}
          fill="currentColor"
        />
      )}
    </svg>
  );
}
