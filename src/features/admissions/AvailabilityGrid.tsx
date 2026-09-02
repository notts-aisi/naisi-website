"use client";

import { useEffect, useRef, useState } from "react";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import {
  AVAILABILITY_DAYS,
  slotCountFor,
  type AvailabilityGrid as GridConfig,
} from "@/lib/admissions/availability";
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  clearDay,
  markedCount,
  rowLabels,
  setCell,
  setRange,
  type DayColumns,
} from "./availabilityModel";
import styles from "./AvailabilityGrid.module.css";

/**
 * The in-person availability grid: seven days, fifteen-minute slots, drawn
 * rather than ticked.
 *
 * ## Built mobile-first, and that is not a slogan here
 *
 * The two days that decide the intake are the freshers' fairs, where every
 * application is started on a phone in a queue. A 252-cell grid laid out for a
 * desktop and then "adapted" is a grid nobody can use standing up. So the
 * phone layout is the one this component is designed around: ONE DAY at a
 * time, chosen from a week strip, with cells at a real touch size. The seven
 * columns appear from 48rem, where there is room for them.
 *
 * Both layouts are the SAME DOM. The week strip toggles `data-active` on each
 * day column and the stylesheet hides the inactive ones below 48rem. Rendering
 * one column on mobile and seven on desktop would mean two pointer surfaces,
 * two keyboard models, and a roving tabindex that resets whenever the viewport
 * crossed the breakpoint.
 *
 * ## One delegated pointer handler
 *
 * `pointerdown` is caught on the cell container, not on 252 listeners. The
 * container captures the pointer, so a drag that leaves the grid keeps
 * painting, and `elementFromPoint` resolves which cell the pointer is over.
 * A fast drag that skips cells is filled in with `setRange` along the column,
 * so painting is continuous rather than dotted.
 *
 * ## Touch, scrolling, and the honest compromise
 *
 * The cells carry `touch-action: none`, because a touch drag must paint rather
 * than scroll: that is the whole gesture. The TIME RAIL down the left keeps
 * `touch-action: pan-y` and is the scroll handle inside the grid, which is why
 * it is wide enough to be one and why the hint below the grid says so. While a
 * drag is in flight the document is pinned with `useBodyScrollLock`, so a drag
 * that runs off the bottom edge does not take the page with it, and the pin is
 * released the moment the pointer comes up.
 *
 * ## Keyboard
 *
 * Roving tabindex: exactly one cell is tabbable, arrows move the focus (and
 * move the visible day on mobile when they leave the column), Space and Enter
 * toggle, and Shift with an arrow paints as it moves. Everything the pointer
 * can do, a keyboard can do, which for a form that decides who gets a place is
 * not optional.
 */

type Props = {
  /** The ROUND's geometry. Row count and labels come from here. */
  grid: GridConfig;
  columns: DayColumns;
  onChange: (next: DayColumns) => void;
  /** View-only rendering after submit: no painting, no focus ring, no hint. */
  readOnly?: boolean;
  disabled?: boolean;
};

type Cursor = { day: number; slot: number };

function cellFromPoint(x: number, y: number): Cursor | null {
  const el = document.elementFromPoint(x, y);
  const cell = el instanceof Element ? el.closest("[data-day][data-slot]") : null;
  if (!(cell instanceof HTMLElement)) return null;
  const day = Number(cell.dataset.day);
  const slot = Number(cell.dataset.slot);
  if (!Number.isInteger(day) || !Number.isInteger(slot)) return null;
  return { day, slot };
}

export default function AvailabilityGrid({
  grid,
  columns,
  onChange,
  readOnly,
  disabled,
}: Props) {
  const rows = rowLabels(grid);
  const slots = slotCountFor(grid);
  const locked = Boolean(readOnly || disabled);

  const [activeDay, setActiveDay] = useState(1);
  const [cursor, setCursor] = useState<Cursor>({ day: 1, slot: 0 });
  const [dragging, setDragging] = useState(false);

  /**
   * Mutable scratch for a live drag, written ONLY inside event handlers (never
   * during render, which is what the compiler's ref rule is about).
   *
   * `workingRef` matters: several `pointermove` events can land between two
   * React renders, so a handler reading the `columns` prop would repaint from
   * a stale copy and drop every paint but the last of each frame. The drag
   * therefore carries its own copy forward and hands each new version to the
   * parent as it goes.
   */
  const paintRef = useRef(true);
  const lastRef = useRef<Cursor | null>(null);
  const anchorRef = useRef<Cursor | null>(null);
  const workingRef = useRef<DayColumns | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Pinned only WHILE dragging: a drag that runs off the bottom of the grid
  // must not scroll the page out from under the gesture.
  useBodyScrollLock(dragging);

  function paint(to: Cursor) {
    const from = lastRef.current;
    lastRef.current = to;
    const value = paintRef.current;
    const current = workingRef.current ?? columns;
    // Same column and a gap between events: fill it, so a fast drag paints a
    // run rather than a dotted line.
    const next =
      from && from.day === to.day
        ? setRange(current, to.day, from.slot, to.slot, value)
        : setCell(current, to.day, to.slot, value);
    if (next === current) return;
    workingRef.current = next;
    onChange(next);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (locked) return;
    const hit =
      event.target instanceof Element
        ? event.target.closest("[data-day][data-slot]")
        : null;
    if (!(hit instanceof HTMLElement)) return;
    const day = Number(hit.dataset.day);
    const slot = Number(hit.dataset.slot);
    if (!Number.isInteger(day) || !Number.isInteger(slot)) return;

    event.preventDefault();
    setCursor({ day, slot });

    const anchor = anchorRef.current;
    if (event.shiftKey && anchor && anchor.day === day) {
      // Shift-click paints the whole run from the last cell touched to this
      // one, taking its value from the anchor rather than from this cell, so
      // "select nine to eleven" is two clicks and reads the same both ways.
      const value = columns[day]?.[anchor.slot] ?? true;
      const next = setRange(columns, day, anchor.slot, slot, value);
      if (next !== columns) onChange(next);
      return;
    }

    // A drag INVERTS whatever the first cell was, so dragging across a painted
    // run erases it. That is the LettuceMeet behaviour people already have in
    // their fingers.
    paintRef.current = !(columns[day]?.[slot] ?? false);
    anchorRef.current = { day, slot };
    lastRef.current = null;
    workingRef.current = columns;
    setDragging(true);
    try {
      containerRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimisation; elementFromPoint still resolves cells */
    }
    paint({ day, slot });
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging || locked) return;
    const at = cellFromPoint(event.clientX, event.clientY);
    if (!at) return;
    if (at.day === lastRef.current?.day && at.slot === lastRef.current?.slot) return;
    paint(at);
  }

  function endDrag(event?: React.PointerEvent<HTMLDivElement>) {
    setDragging(false);
    lastRef.current = null;
    workingRef.current = null;
    if (event) {
      try {
        containerRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    }
  }

  // A pointer lifted outside the window never fires our handlers, and a grid
  // left in drag mode paints on the next hover. Release on any global up.
  useEffect(() => {
    if (!dragging) return;
    const stop = () => {
      setDragging(false);
      lastRef.current = null;
      workingRef.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  function focusCell(next: Cursor) {
    setCursor(next);
    setActiveDay(next.day);
    // The focus has to follow the roving tabindex, or the next Tab leaves the
    // grid from wherever the browser last was.
    window.requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-day="${next.day}"][data-slot="${next.slot}"]`,
      );
      el?.focus();
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const { day, slot } = cursor;
    let next: Cursor | null = null;
    if (event.key === "ArrowUp") next = { day, slot: Math.max(0, slot - 1) };
    else if (event.key === "ArrowDown") next = { day, slot: Math.min(slots - 1, slot + 1) };
    else if (event.key === "ArrowLeft") next = { day: Math.max(0, day - 1), slot };
    else if (event.key === "ArrowRight") {
      next = { day: Math.min(AVAILABILITY_DAYS - 1, day + 1), slot };
    } else if (event.key === "Home") next = { day, slot: 0 };
    else if (event.key === "End") next = { day, slot: slots - 1 };
    else if (event.key === " " || event.key === "Enter") {
      if (locked) return;
      event.preventDefault();
      const value = !(columns[day]?.[slot] ?? false);
      anchorRef.current = { day, slot };
      const updated = setCell(columns, day, slot, value);
      if (updated !== columns) onChange(updated);
      return;
    } else {
      return;
    }

    event.preventDefault();
    // Shift with an arrow paints as it goes: the keyboard's answer to a drag.
    if (event.shiftKey && !locked) {
      const value = !(columns[next.day]?.[next.slot] ?? false);
      const updated = setCell(columns, next.day, next.slot, value);
      if (updated !== columns) onChange(updated);
    }
    focusCell(next);
  }

  const total = markedCount(columns);

  return (
    <div className={styles.wrap}>
      <div className={styles.strip} role="tablist" aria-label="Day">
        {WEEKDAY_SHORT.map((label, day) => {
          const count = columns[day]?.filter(Boolean).length ?? 0;
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={day === activeDay}
              className={styles.stripButton}
              data-selected={day === activeDay ? "true" : "false"}
              onClick={() => {
                setActiveDay(day);
                setCursor((c) => ({ day, slot: c.slot }));
              }}
            >
              <span className={styles.stripDay}>{label}</span>
              <span className={styles.stripCount} aria-hidden="true">
                {count > 0 ? count : ""}
              </span>
              <span className="visually-hidden">
                {count > 0 ? `${count} slots selected` : "nothing selected"}
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.board}>
        <div className={styles.rail} aria-hidden="true">
          <div className={styles.railHead} />
          {rows.map((label) => (
            <div key={label} className={styles.railCell}>
              {/* Hourly labels only: a label on every quarter hour is noise at
                  any width, and unreadable at phone width. */}
              {label.endsWith(":00") ? label : ""}
            </div>
          ))}
        </div>

        <div
          ref={containerRef}
          className={styles.cells}
          role="grid"
          aria-label="When you could be in a room in Nottingham"
          aria-readonly={locked || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          {columns.map((column, day) => (
            <div
              key={WEEKDAY_LONG[day]}
              className={styles.column}
              data-active={day === activeDay ? "true" : "false"}
              role="row"
            >
              <div className={styles.columnHead} role="columnheader">
                <span aria-hidden="true">{WEEKDAY_SHORT[day]}</span>
                <span className="visually-hidden">{WEEKDAY_LONG[day]}</span>
              </div>
              {column.map((on, slot) => (
                <div
                  key={`${day}-${slot}`}
                  role="gridcell"
                  aria-label={`${WEEKDAY_LONG[day]} ${rows[slot]}`}
                  aria-selected={on}
                  data-day={day}
                  data-slot={slot}
                  data-on={on ? "true" : "false"}
                  className={styles.cell}
                  tabIndex={cursor.day === day && cursor.slot === slot ? 0 : -1}
                  onFocus={() => setCursor({ day, slot })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <p className={styles.hint}>
          {locked
            ? total === 0
              ? "You did not mark any availability."
              : `${total} quarter-hour slot${total === 1 ? "" : "s"} marked.`
            : "Drag across the times you could be there in person. Drag over a marked run to clear it. On a phone, scroll the grid using the times down the left."}
        </p>
        {!locked ? (
          <button
            type="button"
            className={styles.clear}
            onClick={() => onChange(clearDay(columns, activeDay))}
          >
            Clear {WEEKDAY_LONG[activeDay]}
          </button>
        ) : null}
      </div>
      {!locked ? (
        <p className={styles.count} aria-live="polite">
          {total === 0
            ? "Nothing marked yet."
            : `${total} quarter-hour slot${total === 1 ? "" : "s"} marked.`}
        </p>
      ) : null}
    </div>
  );
}
