"use client";

import { useState } from "react";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";

/**
 * Two-dropdown month/year picker that emits an ISO "YYYY-MM" string.
 * Holds local state for each select so partial selections are reflected
 * visually (otherwise the selects appear empty until *both* are chosen).
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
  value,
  onChange,
  fromYear,
  yearsAhead = 8,
}: Props) {
  const currentYear = new Date().getFullYear();
  const startYear = fromYear ?? currentYear;
  const years = Array.from({ length: yearsAhead }, (_, i) => startYear + i);

  const [initialYear, initialMonth] = split(value);
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);

  // Sync local state if the parent feeds in a new value (e.g. edit form
  // opens with existing data, or the field is reset). Done during render
  // with a previous-value guard - the React-recommended alternative to a
  // prop-sync effect, which avoids the synchronous-setState-in-effect
  // cascade.
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

  const monthOptions: ResponsiveSelectOption[] = [
    { value: "", label: "Month" },
    ...MONTHS.map((name, i) => {
      const m = String(i + 1).padStart(2, "0");
      return { value: m, label: `${i + 1} · ${name}` };
    }),
  ];
  const yearOptions: ResponsiveSelectOption[] = [
    { value: "", label: "Year" },
    ...years.map((y) => ({ value: String(y), label: String(y) })),
  ];

  return (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <div style={{ flex: 2 }}>
        <ResponsiveSelect
          value={month}
          onChange={(next) => emit(year, next)}
          options={monthOptions}
          ariaLabel="Month"
        />
      </div>
      <div style={{ flex: 1 }}>
        <ResponsiveSelect
          value={year}
          onChange={(next) => emit(next, month)}
          options={yearOptions}
          ariaLabel="Year"
        />
      </div>
    </div>
  );
}
