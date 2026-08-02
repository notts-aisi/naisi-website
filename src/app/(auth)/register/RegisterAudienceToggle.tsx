"use client";

import { motion } from "motion/react";

export type RegisterAudience = "member" | "collaborator";

const OPTIONS: { value: RegisterAudience; label: string; title: string }[] = [
  {
    value: "member",
    label: "Student / staff",
    title: "Current University of Nottingham students and staff",
  },
  {
    value: "collaborator",
    label: "External collaborator",
    title: "Researchers and partners outside the University of Nottingham",
  },
];

/**
 * Controlled audience toggle for the unified /register entry. Local-state
 * driven (no route change) so flipping it morphs the form in place rather than
 * triggering a page transition. The active pill is a shared-layout `motion.span`
 * (`layoutId`), so it slides fluidly between the two segments.
 */
export default function RegisterAudienceToggle({
  value,
  onChange,
}: {
  value: RegisterAudience;
  onChange: (next: RegisterAudience) => void;
}) {
  return (
    <div style={{ textAlign: "center", marginBottom: "var(--space-6)" }}>
      <p
        style={{
          color: "var(--color-text-subtle)",
          fontSize: "var(--text-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: "var(--space-3)",
        }}
      >
        Registering as
      </p>
      <div
        role="radiogroup"
        aria-label="Choose whether you're a University of Nottingham member or an external collaborator"
        style={{
          display: "inline-flex",
          position: "relative",
          padding: "3px",
          gap: "3px",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        {OPTIONS.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.title}
              onClick={() => onChange(opt.value)}
              style={{
                position: "relative",
                appearance: "none",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "0.4rem 0.85rem",
                fontSize: "var(--text-sm)",
                fontWeight: 500,
                color: active ? "white" : "var(--color-text-muted)",
                borderRadius: "calc(var(--radius-md) - 3px)",
                transition: "color var(--transition-fast)",
                whiteSpace: "nowrap",
              }}
            >
              {active && (
                <motion.span
                  layoutId="register-audience-pill"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "var(--color-accent)",
                    borderRadius: "calc(var(--radius-md) - 3px)",
                    zIndex: 0,
                  }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span style={{ position: "relative", zIndex: 1 }}>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
