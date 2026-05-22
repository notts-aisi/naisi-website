"use client";

import { useState } from "react";

/**
 * Two-dropdown month/year picker that emits an ISO "YYYY-MM" string.
 * Holds local state for each select so partial selections are reflected visually
 * (otherwise the selects appear empty until *both* are chosen).
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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
};

type Props = {
  id: string;
  value: string; // ISO month: "YYYY-MM" (empty if unset)
  onChange: (next: string) => void;
  required?: boolean;
  fromYear?: number;
  yearsAhead?: number;
};

function split(value: string): [year: string, month: string] {
  const [y = "", m = ""] = value.split("-");
  return [y, m];
}

export default function GraduationSelect({
  id,
  value,
  onChange,
  required,
  fromYear,
  yearsAhead = 8,
}: Props) {
  const currentYear = new Date().getFullYear();
  const startYear = fromYear ?? currentYear;
  const years = Array.from({ length: yearsAhead }, (_, i) => startYear + i);

  const [initialYear, initialMonth] = split(value);
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  // Sync local state if the parent feeds in a new value (e.g. edit form opens
  // with existing data, or the field is reset). Done during render with a
  // previous-value guard - the React-recommended alternative to a prop-sync
  // effect, which avoids the synchronous-setState-in-effect cascade.
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    const [y, m] = split(value);
    setYear(y);
    setMonth(m);
  }

  function emit(nextYear: string, nextMonth: string) {
    setYear(nextYear);
    setMonth(nextMonth);
    onChange(nextYear && nextMonth ? `${nextYear}-${nextMonth}` : "");
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <select
        id={`${id}-month`}
        value={month}
        onChange={(e) => emit(year, e.target.value)}
        required={required}
        aria-label="Month"
        style={{ ...CONTROL_STYLE, flex: 2 }}
      >
        <option value="">Month</option>
        {MONTHS.map((name, i) => {
          const m = String(i + 1).padStart(2, "0");
          return (
            <option key={m} value={m}>
              {i + 1} · {name}
            </option>
          );
        })}
      </select>
      <select
        id={`${id}-year`}
        value={year}
        onChange={(e) => emit(e.target.value, month)}
        required={required}
        aria-label="Year"
        style={{ ...CONTROL_STYLE, flex: 1 }}
      >
        <option value="">Year</option>
        {years.map((y) => (
          <option key={y} value={String(y)}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
