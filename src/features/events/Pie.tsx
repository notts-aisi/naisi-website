import styles from "./Pie.module.css";

export type PieSlice = {
  label: string;
  count: number;
  color: string;
};

type Props = {
  slices: PieSlice[];
  size?: number;
};

/**
 * Minimalist SVG pie chart. No printed legend — each slice carries a hover
 * tooltip (native SVG <title>) so the chart stays compact. Renders nothing when
 * there is no data; callers show their own empty state.
 */
export default function Pie({ slices, size = 140 }: Props) {
  const total = slices.reduce((acc, s) => acc + s.count, 0);
  if (total === 0) return null;

  const radius = size / 2;
  const cx = radius;
  const cy = radius;

  const visible = slices.filter((s) => s.count > 0);
  const arcs = visible.map((s, i) => {
    const start =
      visible.slice(0, i).reduce((sum, x) => sum + x.count, 0) / total;
    const fraction = s.count / total;
    const end = start + fraction;
    const startAngle = start * Math.PI * 2 - Math.PI / 2;
    const endAngle = end * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const largeArc = fraction > 0.5 ? 1 : 0;
    // Single-slice (100%) needs a full circle, not a degenerate arc.
    const d =
      fraction >= 1
        ? `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    return {
      label: s.label,
      color: s.color,
      count: s.count,
      pct: Math.round(fraction * 100),
      d,
    };
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      className={styles.pie}
    >
      {arcs.map((a) => (
        <path key={a.label} d={a.d} fill={a.color}>
          <title>{`${a.label}: ${a.count} (${a.pct}%)`}</title>
        </path>
      ))}
    </svg>
  );
}

/**
 * Deterministic color palette for pie slices. Cycles through a small set of
 * theme-friendly hues so repeated renders stay stable.
 */
export const PIE_PALETTE = [
  "#4f46e5", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

export function pickColor(i: number): string {
  return PIE_PALETTE[i % PIE_PALETTE.length];
}
