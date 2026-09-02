import {
  AVAILABILITY_DAYS,
  decodeMask,
  encodeMask,
  slotCountFor,
  slotLabels,
  type AvailabilityGrid,
  type AvailabilityMask,
} from "@/lib/admissions/availability";

/**
 * The AvailabilityGrid component's state model, kept OUT of the component file
 * on purpose.
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *  1. A grid of 252 cells with pointer painting, a roving tabindex and a
 *     shift-range is enough behaviour that the state transitions want to be
 *     readable on their own, without a JSX file around them.
 *  2. The round trip THROUGH THE WIRE FORMAT is the thing that must not
 *     break. A drawn grid is stored as seven hex strings and read back by the
 *     decide route to build a seat row's availability labels, so a bug here
 *     does not show up as a broken screen: it shows up as somebody being put
 *     in a session they said they could not make. These functions are
 *     therefore unit tested by `tests/admissions-apply-flow.test.mjs`, which
 *     transpiles plain TypeScript and cannot import a `.tsx` file.
 *
 * The component holds `boolean[][]` (seven day columns of `slotCountFor(grid)`
 * booleans) and converts at the edges only. Nothing in the UI ever touches
 * hex.
 */

export type DayColumns = boolean[][];

/** Seven empty columns on this grid's geometry. */
export function emptyColumns(grid: AvailabilityGrid): DayColumns {
  const count = slotCountFor(grid);
  const out: DayColumns = [];
  for (let day = 0; day < AVAILABILITY_DAYS; day += 1) {
    out.push(new Array<boolean>(count).fill(false));
  }
  return out;
}

/**
 * A stored mask to editable columns.
 *
 * Decoded against the geometry the answer was DRAWN on (which travels inside
 * the mask), with the round's current grid only as the fallback for a row
 * written before the geometry was stored. `decodeMask` handles that; this
 * wrapper exists so the component never has to think about which grid it is
 * holding.
 */
export function maskToColumns(
  mask: AvailabilityMask | null | undefined,
  grid: AvailabilityGrid,
): DayColumns {
  if (!mask) return emptyColumns(grid);
  const own: AvailabilityGrid = {
    version: mask.version,
    startMinute: mask.startMinute,
    endMinute: mask.endMinute,
    slotMinutes: mask.slotMinutes,
  };
  const columns = decodeMask(mask.days, own);
  // A mask drawn on a WIDER grid than the round now offers decodes to columns
  // longer than the editor draws. Trimming here rather than in the renderer
  // keeps every consumer of these columns the same length as `slotCountFor`.
  const count = slotCountFor(grid);
  return columns.map((column) => {
    const next = column.slice(0, count);
    while (next.length < count) next.push(false);
    return next;
  });
}

/** Editable columns back to a stored mask on the ROUND's geometry. */
export function columnsToMask(columns: DayColumns, grid: AvailabilityGrid): AvailabilityMask {
  return {
    version: grid.version,
    startMinute: grid.startMinute,
    endMinute: grid.endMinute,
    slotMinutes: grid.slotMinutes,
    days: encodeMask(columns, grid),
  };
}

/** The row headers, one per slot. `["09:00", "09:15", ...]`. */
export function rowLabels(grid: AvailabilityGrid): string[] {
  return slotLabels(grid);
}

/**
 * Set one cell. Returns a NEW columns array (React state, so no mutation) and
 * returns the input unchanged when nothing would move, which keeps a drag
 * across an already-painted run from re-rendering on every pointer event.
 */
export function setCell(
  columns: DayColumns,
  day: number,
  slot: number,
  value: boolean,
): DayColumns {
  const column = columns[day];
  if (!column || slot < 0 || slot >= column.length) return columns;
  if (column[slot] === value) return columns;
  const next = columns.slice();
  const copy = column.slice();
  copy[slot] = value;
  next[day] = copy;
  return next;
}

/**
 * Set an inclusive run of slots in one day column: the shift-click gesture,
 * and the drag paint's catch-up when a fast pointer skips cells.
 *
 * The ends are given in either order, because "shift-click above the anchor"
 * is a thing people do and a range that silently did nothing would read as a
 * broken grid.
 */
export function setRange(
  columns: DayColumns,
  day: number,
  from: number,
  to: number,
  value: boolean,
): DayColumns {
  const column = columns[day];
  if (!column) return columns;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(column.length - 1, Math.max(from, to));
  if (hi < lo) return columns;
  let changed = false;
  const copy = column.slice();
  for (let i = lo; i <= hi; i += 1) {
    if (copy[i] !== value) {
      copy[i] = value;
      changed = true;
    }
  }
  if (!changed) return columns;
  const next = columns.slice();
  next[day] = copy;
  return next;
}

/** How many slots are marked in total. Powers the "nothing selected" note. */
export function markedCount(columns: DayColumns): number {
  let total = 0;
  for (const column of columns) {
    for (const slot of column) if (slot) total += 1;
  }
  return total;
}

/** Clear one day column. The per-day "Clear" action on the mobile view. */
export function clearDay(columns: DayColumns, day: number): DayColumns {
  const column = columns[day];
  if (!column || !column.some(Boolean)) return columns;
  const next = columns.slice();
  next[day] = new Array<boolean>(column.length).fill(false);
  return next;
}

/** Sunday first, matching `Date.getDay()` and `GroupSession.weekday`. */
export const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
