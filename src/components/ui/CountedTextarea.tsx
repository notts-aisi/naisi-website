"use client";

import type { TextareaHTMLAttributes } from "react";
import { Textarea } from "./Input";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "maxLength" | "value"> & {
  value: string;
  max: number;
};

export default function CountedTextarea({ value, max, ...rest }: Props) {
  const used = value.length;
  const nearLimit = used >= max * 0.9;
  return (
    <div style={{ position: "relative" }}>
      <Textarea {...rest} value={value} maxLength={max} />
      <div
        aria-live="polite"
        style={{
          textAlign: "right",
          fontSize: "var(--text-xs)",
          color: nearLimit ? "var(--color-warning)" : "var(--color-text-subtle)",
          marginTop: "var(--space-1)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {used} / {max}
      </div>
    </div>
  );
}
