import styles from "./Skeleton.module.css";

type Props = {
  /** Width of the whole block. Lines fill it (the last of several runs short). */
  width?: string;
  /** Height of each line. */
  height?: string;
  radius?: string;
  lines?: number;
  ariaLabel?: string;
};

/**
 * Loading placeholder for client-listener surfaces. Size it to match the
 * layout it stands in for — a skeleton that doesn't match its real content
 * costs a reflow the moment data arrives, which is the shift it exists to
 * prevent.
 *
 * The wrapper is the live region: one `role="status"` per placeholder with a
 * visually-hidden label, so a screen reader hears "Loading…" once rather than
 * a bar per line.
 */
export default function Skeleton({
  width = "100%",
  height = "1rem",
  radius = "var(--radius-md)",
  lines = 1,
  ariaLabel = "Loading…",
}: Props) {
  const count = Math.max(1, Math.floor(lines));
  return (
    <div className={styles.root} role="status" style={{ width }}>
      <span className={styles.label}>{ariaLabel}</span>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={i === count - 1 && count > 1 ? `${styles.bar} ${styles.short}` : styles.bar}
          style={{ height, borderRadius: radius }}
        />
      ))}
    </div>
  );
}
