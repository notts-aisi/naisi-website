"use client";

import { useMemo, useState } from "react";

type Mode = "edit" | "view";

type Props = {
  value: Date | null;
  mode: Mode;
  onChange?: (date: Date | null) => void;
  isOverdue?: boolean;
  /** Disabled while a mutation is in flight. Edit mode only. */
  disabled?: boolean;
  /** `sm` for compact contexts (popovers, tight headers). `md` for modal sections. */
  size?: "sm" | "md";
  /** Optional surrounding label, e.g. "Due date". Rendered above the grid. */
  label?: string;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

function startOfWeekMonday(d: Date): Date {
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const offset = (day + 6) % 7; // Mon-based offset
  return addDays(d, -offset);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export default function TaskCalendar({
  value,
  mode,
  onChange,
  isOverdue = false,
  disabled = false,
  size = "md",
  label,
}: Props) {
  const today = useMemo(() => localMidnight(new Date()), []);
  const [viewMonth, setViewMonth] = useState<Date>(() =>
    startOfMonth(value ?? today),
  );

  const cellPx = size === "sm" ? 30 : 36;
  const headerFont = size === "sm" ? "var(--text-xs)" : "var(--text-sm)";
  const dayFont = size === "sm" ? "var(--text-xs)" : "var(--text-sm)";

  const cells: Date[] = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const gridStart = startOfWeekMonday(first);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [viewMonth]);

  const selectedLabel = value
    ? value.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  function pick(d: Date) {
    if (mode !== "edit" || disabled || !onChange) return;
    if (d.getMonth() !== viewMonth.getMonth()) {
      setViewMonth(startOfMonth(d));
    }
    onChange(localMidnight(d));
  }

  function jumpToMonthOf(d: Date) {
    setViewMonth(startOfMonth(d));
  }

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        opacity: disabled ? 0.6 : 1,
        userSelect: "none",
      }}
      aria-label={label ?? "Date picker"}
    >
      {/* Month header + nav */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2)",
          fontSize: headerFont,
          fontWeight: 600,
          color: "var(--color-text)",
        }}
      >
        <NavBtn
          onClick={() => setViewMonth(addMonths(viewMonth, -1))}
          ariaLabel="Previous month"
          size={size}
        >
          ‹
        </NavBtn>
        <span>
          {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
        </span>
        <NavBtn
          onClick={() => setViewMonth(addMonths(viewMonth, 1))}
          ariaLabel="Next month"
          size={size}
        >
          ›
        </NavBtn>
      </div>

      {/* Weekday strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(7, ${cellPx}px)`,
          gap: "2px",
          fontSize: "var(--text-xs)",
          color: "var(--color-text-subtle)",
          textAlign: "center",
          fontWeight: 500,
        }}
      >
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ padding: "0.2rem 0" }}>
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div
        role="grid"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(7, ${cellPx}px)`,
          gap: "2px",
        }}
      >
        {cells.map((d) => {
          const inMonth = d.getMonth() === viewMonth.getMonth();
          const isToday = sameDay(d, today);
          const isSelected = value !== null && sameDay(d, value);
          const isInteractive = mode === "edit" && !disabled;

          let bg = "transparent";
          let color = inMonth ? "var(--color-text)" : "var(--color-text-subtle)";
          let border = "1px solid transparent";

          if (isSelected) {
            bg = isOverdue
              ? "var(--color-danger)"
              : "var(--color-accent)";
            color = "#ffffff";
            border = "1px solid transparent";
          } else if (isToday) {
            border = "1px solid var(--color-accent)";
          }

          const commonStyle: React.CSSProperties = {
            width: cellPx,
            height: cellPx,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: bg,
            color,
            border,
            borderRadius: "var(--radius-sm)",
            fontSize: dayFont,
            fontWeight: isSelected ? 600 : isToday ? 600 : 400,
            opacity: inMonth ? 1 : 0.5,
            fontFamily: "inherit",
            padding: 0,
          };

          if (!isInteractive) {
            return (
              <span
                key={d.toISOString()}
                role="gridcell"
                aria-selected={isSelected}
                style={commonStyle}
              >
                {d.getDate()}
              </span>
            );
          }

          return (
            <button
              key={d.toISOString()}
              type="button"
              role="gridcell"
              aria-selected={isSelected}
              aria-label={d.toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              onClick={() => pick(d)}
              style={{
                ...commonStyle,
                cursor: "pointer",
                transition: "background 0.12s ease",
              }}
              onMouseEnter={(e) => {
                if (isSelected) return;
                e.currentTarget.style.background = "var(--color-accent-soft)";
              }}
              onMouseLeave={(e) => {
                if (isSelected) return;
                e.currentTarget.style.background = "transparent";
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {/* Selected-date readout */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2)",
          fontSize: "var(--text-xs)",
          color: isOverdue
            ? "var(--color-danger)"
            : "var(--color-text-muted)",
          fontWeight: 500,
          minHeight: "1.4em",
        }}
      >
        <span>
          {selectedLabel ? (
            <>
              {selectedLabel}
              {isOverdue ? " — overdue" : ""}
            </>
          ) : (
            <span style={{ color: "var(--color-text-subtle)" }}>No date set</span>
          )}
        </span>
        {mode === "view" && !sameDay(viewMonth, startOfMonth(today)) && (
          <button
            type="button"
            onClick={() => jumpToMonthOf(today)}
            style={linkBtnStyle}
          >
            Jump to today
          </button>
        )}
      </div>

      {/* Edit-only shortcuts */}
      {mode === "edit" && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-1)",
            paddingTop: "var(--space-1)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <Shortcut
            label="Today"
            disabled={disabled}
            onClick={() => {
              const t = today;
              jumpToMonthOf(t);
              onChange?.(t);
            }}
          />
          <Shortcut
            label="+1 week"
            disabled={disabled}
            onClick={() => {
              const d = addDays(today, 7);
              jumpToMonthOf(d);
              onChange?.(d);
            }}
          />
          <Shortcut
            label="+1 month"
            disabled={disabled}
            onClick={() => {
              const d = addDays(today, 30);
              jumpToMonthOf(d);
              onChange?.(d);
            }}
          />
          {value && (
            <Shortcut
              label="Clear"
              variant="danger"
              disabled={disabled}
              onClick={() => onChange?.(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function NavBtn({
  children,
  onClick,
  ariaLabel,
  size,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  size: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width: size === "sm" ? 22 : 26,
        height: size === "sm" ? 22 : 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm)",
        color: "var(--color-text)",
        fontSize: size === "sm" ? "14px" : "16px",
        lineHeight: 1,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function Shortcut({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}) {
  const isDanger = variant === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.25rem 0.55rem",
        background: isDanger
          ? "var(--color-danger-soft)"
          : "var(--color-accent-soft)",
        color: isDanger ? "var(--color-danger)" : "var(--color-accent)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--color-accent)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  fontFamily: "inherit",
};
