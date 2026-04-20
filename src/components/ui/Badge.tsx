import type { HTMLAttributes, ReactNode } from "react";

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  children: ReactNode;
};

const TONE_STYLES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--color-surface-hover)", fg: "var(--color-text-muted)" },
  accent: { bg: "var(--color-accent-soft)", fg: "var(--color-accent)" },
  success: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
  danger: { bg: "var(--color-danger-soft)", fg: "var(--color-danger)" },
  warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
};

export default function Badge({ tone = "neutral", children, style, ...rest }: Props) {
  const { bg, fg } = TONE_STYLES[tone];
  return (
    <span
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "0.2rem 0.55rem",
        borderRadius: "var(--radius-pill)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        letterSpacing: "0.02em",
        background: bg,
        color: fg,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
