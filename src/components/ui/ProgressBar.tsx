type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

type Props = {
  value: number;
  max: number;
  ariaLabel?: string;
  tone?: Tone;
  showLabel?: boolean;
  size?: "sm" | "md";
};

const TRACK_COLOR = "var(--color-surface-hover)";
const TONE_FG: Record<Tone, string> = {
  neutral: "var(--color-text-muted)",
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  danger: "var(--color-danger)",
  warning: "var(--color-warning)",
};

export default function ProgressBar({
  value,
  max,
  ariaLabel,
  tone = "accent",
  showLabel = false,
  size = "md",
}: Props) {
  const safeMax = Math.max(1, max);
  const clamped = Math.max(0, Math.min(value, safeMax));
  const pct = Math.round((clamped / safeMax) * 100);
  const height = size === "sm" ? 4 : 6;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
      }}
    >
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        style={{
          flex: 1,
          height,
          background: TRACK_COLOR,
          borderRadius: "var(--radius-pill)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: TONE_FG[tone],
            transition: "width var(--transition-base)",
          }}
        />
      </div>
      {showLabel && (
        <span
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
            fontVariantNumeric: "tabular-nums",
            minWidth: "2.5rem",
            textAlign: "right",
          }}
        >
          {clamped}/{max}
        </span>
      )}
    </div>
  );
}
