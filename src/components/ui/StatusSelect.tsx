"use client";

import { STATUS_LABELS, type AffiliationStatus } from "@/lib/firestore/users";

const CONTROL_STYLE: React.CSSProperties = {
  padding: "0.85rem 2.25rem 0.85rem 1rem",
  background:
    "var(--color-bg-elevated) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%238b94ac' d='M6 8.5 1.5 4h9z'/></svg>\") no-repeat calc(100% - 0.85rem) center",
  backgroundSize: "12px 12px",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-text)",
  fontSize: "var(--text-base)",
  lineHeight: 1.4,
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  minHeight: "2.9rem",
  width: "100%",
};

type Props = {
  id: string;
  value: AffiliationStatus | "";
  onChange: (next: AffiliationStatus | "") => void;
  required?: boolean;
};

const ORDER: AffiliationStatus[] = [
  "foundation",
  "undergraduate",
  "masters",
  "phd",
  "postdoc",
  "employee",
  "other",
];

export default function StatusSelect({ id, value, onChange, required }: Props) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as AffiliationStatus | "")}
      required={required}
      style={CONTROL_STYLE}
    >
      <option value="">Select your status</option>
      {ORDER.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
