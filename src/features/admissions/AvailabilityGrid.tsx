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
 * application is started on a phone in a queue. A 336-cell grid laid out for a
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
 * `pointerdown` is caught on the cell container, not on 336 listeners. The
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
 * TOUCH drag is in flight the document is pinned with `useBodyScrollLock`, so
 * a drag that runs off the bottom edge does not take the page with it, and the
 * pin is released the moment the pointer comes up. A mouse drag does not pin
 * anything: it has no such problem, and pinning the document on a browser with
 * classic scrollbars shifts the whole layout sideways as the drag starts.
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
   * Which kind of pointer is drawing, captured on `pointerdown`. State rather
   * than a ref because the scroll lock below is computed during render.
   */
  const [dragPointer, setDragPointer] = useState("");

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

  /**
   * Pinned only while a TOUCH drag is in flight.
   *
   * The lock exists for one gesture: a finger dragging off the bottom of the
   * grid, where the browser would otherwise scroll the page out from under it.
   * A mouse drag has no such problem, and arming the lock for one has a cost
   * of its own: on a browser with classic scrollbars, pinning the document
   * takes the scrollbar's width out of the layout and every column jumps
   * sideways the instant a paint starts. So the pointer type is captured on
   * `pointerdown` and only touch locks. Pen behaves like a mouse here, which
   * is right: a stylus on a tablet is precise and does not need the page
   * frozen to stay on the cell it is over.
   */
  useBodyScrollLock(dragging && dragPointer === "touch");

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
    setDragPointer(event.pointerType);
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
    setDragPointer("");
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
      setDragPointer("");
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
      {/*
        A group of toggle buttons, NOT a tablist. A tablist promises tabpanels
        with ids to point `aria-controls` at, and there are none: the grid
        below is one element whose visible column changes. `aria-pressed` says
        exactly what is true, which is better than a richer pattern half kept.
        Hidden entirely from 48rem, where all seven columns are on screen.
      */}
      <div className={styles.strip} role="group" aria-label="Which day to show">
        {WEEKDAY_SHORT.map((label, day) => {
          const count = columns[day]?.filter(Boolean).length ?? 0;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={day === activeDay}
              className={styles.stripButton}
              data-selected={day === activeDay ? "true" : "false"}
              onClick={() => {
                setActiveDay(day);
                setCursor((c) => ({ day, slot: c.slot }));
              }}
            >
              <span className={styles.stripDay} aria-hidden="true">
                {label}
              </span>
              <span className={styles.stripCount} aria-hidden="true">
                {count > 0 ? count : ""}
              </span>
              <span className="visually-hidden">
                {WEEKDAY_LONG[day]},{" "}
                {count > 0 ? `${count} slots marked` : "nothing marked"}
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
          /*
            The label states the AXES, because this grid is transposed against
            the reading of it a screen reader will assume. Each `row` here is a
            DAY and each cell in it is a time, so the arrow keys do the
            opposite of what "grid" implies: up and down move through the day,
            left and right change the day. Without saying so, somebody
            navigating by keyboard has to press an arrow and infer the model
            from where they land, on a form that decides who gets a place.
          */
          aria-label="When you could be in a room in Nottingham. Each row is one day: up and down move through that day's times, left and right change the day."
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
              {/* A ROW header, not a column one. The element it names is a
                  `role="row"` and everything after it in that row belongs to
                  the same day, which is exactly what `rowheader` means;
                  `columnheader` would tell a screen reader this cell heads a
                  column of the cells BELOW it in other rows, which is the
                  opposite of the DOM it is sitting in. */}
              <div className={styles.columnHead} role="rowheader">
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
