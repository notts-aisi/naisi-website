"use client";

import type { SubtaskBreakdown as Breakdown } from "@/lib/firestore/tasks";

/**
 * Replaces the old `done/total` pill + flat progress bar. Renders:
 *   - a horizontal segmented bar coloured per-state, so a glance at the
 *     ratio AND the dominant state lands at the same time
 *   - (verbose mode) a textual line below the bar summarising counts
 *
 * Buckets that are zero get omitted from the text line — keeps it tight on
 * tasks with only a couple of states present.
 */
export default function SubtaskBreakdown({
  breakdown,
  variant = "verbose",
}: {
  breakdown: Breakdown;
  variant?: "verbose" | "compact";
}) {
  const { rejected, questioned, approved, done, inReview, pending, total } = breakdown;
  if (total === 0) return null;

  // Order matters — segments render left-to-right in this sequence so the
  // bar reads "good states (left) → flagged (right)" once you internalise
  // the colour palette. Approved+Done fold together as green; in-review,
  // questioned, rejected each get their own segment so you can see
  // exactly where attention is needed.
  const segments: Array<{ key: string; count: number; color: string; label: string }> = [
    { key: "approved", count: approved, color: "var(--color-success, #16a34a)", label: "approved" },
    { key: "done", count: done, color: "var(--color-success, #16a34a)", label: "done" },
    { key: "inReview", count: inReview, color: "var(--color-info, #3b82f6)", label: "in review" },
    { key: "questioned", count: questioned, color: "var(--color-warning, #eab308)", label: "questioned" },
    { key: "rejected", count: rejected, color: "var(--color-danger, #dc2626)", label: "rejected" },
    { key: "pending", count: pending, color: "var(--color-border)", label: "pending" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={approved + done}
        aria-label={ariaLabelFor(breakdown)}
        style={{
          display: "flex",
          height: variant === "compact" ? "4px" : "6px",
          width: "100%",
          borderRadius: "999px",
          background: "var(--color-border)",
          overflow: "hidden",
        }}
      >
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <div
              key={s.key}
              style={{
                width: `${(s.count / total) * 100}%`,
                background: s.color,
                height: "100%",
              }}
              title={`${s.count} ${s.label}`}
            />
          ))}
      </div>
      {variant === "verbose" && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {approved > 0 && <Pill color="var(--color-success, #16a34a)">{approved} ✓ Approved</Pill>}
          {done > 0 && <Pill color="var(--color-success, #16a34a)">{done} ✓ Done</Pill>}
          {inReview > 0 && <Pill color="var(--color-info, #3b82f6)">{inReview} ⏳ In review</Pill>}
          {questioned > 0 && <Pill color="var(--color-warning, #eab308)">{questioned} ? Questioned</Pill>}
          {rejected > 0 && <Pill color="var(--color-danger, #dc2626)">{rejected} ✗ Rejected</Pill>}
          {pending > 0 && <Pill color="var(--color-text-muted)">{pending} Pending</Pill>}
        </div>
      )}
      {/* Reviewer signoff rows are workflow-infra and excluded from the
          per-state buckets above. Surfaced here so a task that reads
          "all approved" but can't be marked Done is no longer mysterious —
          the unticked signoff row is the gate; users see it and know to
          look at the Reviews-for-block section below. */}
      {variant === "verbose" && breakdown.signoffTotal > 0 && breakdown.signoffPending > 0 && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ↳ {breakdown.signoffPending} reviewer signoff
          {breakdown.signoffPending === 1 ? "" : "s"} pending of {breakdown.signoffTotal}
          {" — see “Reviews for…” section below."}
        </div>
      )}
    </div>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        color,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}

function ariaLabelFor(b: Breakdown): string {
  const parts: string[] = [];
  if (b.approved) parts.push(`${b.approved} approved`);
  if (b.done) parts.push(`${b.done} done`);
  if (b.inReview) parts.push(`${b.inReview} in review`);
  if (b.questioned) parts.push(`${b.questioned} questioned`);
  if (b.rejected) parts.push(`${b.rejected} rejected`);
  if (b.pending) parts.push(`${b.pending} pending`);
  return `Subtasks: ${parts.join(", ")} of ${b.total}`;
}
