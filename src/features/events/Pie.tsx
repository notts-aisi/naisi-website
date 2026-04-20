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
 * Minimalist SVG pie chart. No runtime chart-library dependency.
 * Feed it slices with labels + colors, it renders the pie and a legend to match.
 */
export default function Pie({ slices, size = 140 }: Props) {
  const total = slices.reduce((acc, s) => acc + s.count, 0);
  if (total === 0) {
    return (
      <div className={styles.wrap}>
        <div
          className={styles.empty}
          style={{ width: size, height: size, borderRadius: "50%" }}
        >
          <span>0</span>
        </div>
        <ul className={styles.legend}>
          {slices.map((s) => (
            <li key={s.label} className={styles.legendRow}>
              <span className={styles.swatch} style={{ background: s.color }} />
              <span className={styles.legendLabel}>{s.label}</span>
              <span className={styles.legendCount}>0</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const radius = size / 2;
  const cx = radius;
  const cy = radius;

  let cursor = 0;
  const arcs = slices
    .filter((s) => s.count > 0)
    .map((s) => {
      const start = cursor;
      const fraction = s.count / total;
      cursor += fraction;
      const end = cursor;
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
      return { label: s.label, color: s.color, count: s.count, d };
    });

  return (
    <div className={styles.wrap}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {arcs.map((a) => (
          <path key={a.label} d={a.d} fill={a.color} />
        ))}
      </svg>
      <ul className={styles.legend}>
        {slices.map((s) => {
          const pct = total === 0 ? 0 : Math.round((s.count / total) * 100);
          return (
            <li key={s.label} className={styles.legendRow}>
              <span className={styles.swatch} style={{ background: s.color }} />
              <span className={styles.legendLabel}>{s.label}</span>
              <span className={styles.legendCount}>
                {s.count} · {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
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
