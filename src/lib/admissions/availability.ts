/**
 * The availability grid: ONE codec, ONE shape.
 *
 * ## What this is
 *
 * An admission round asks "when could you actually be in a room in
 * Nottingham?" as a LettuceMeet-style grid: seven day columns (Sunday through
 * Saturday, so Saturday and Sunday are first-class rather than an
 * afterthought) cut into fixed slots between two wall-clock bounds. The
 * default grid is 09:00 to 18:00 in 15-minute slots, which is 36 slots a day
 * and 252 cells in total.
 *
 * A drawn grid is stored as SEVEN HEX STRINGS, one per weekday, four slots to
 * a character. At the default geometry that is nine characters a day and 63
 * characters for the whole answer, against 252 booleans or 252 array entries.
 * It fits in a document field nobody has to think about, and it survives a
 * JSON round trip unchanged.
 *
 * ## Why the geometry travels with the answer
 *
 * `AvailabilityMask` carries `startMinute`, `endMinute`, `slotMinutes` and
 * `version` alongside its `days`, duplicating what the round's
 * `availabilityGrid` already says. That duplication is the point. Widening a
 * round's window from 09:00-18:00 to 08:00-20:00 is meant to be a config
 * edit, not a schema migration; but the bit at index 0 of an answer drawn on
 * the old grid means 09:00, and the same bit read against the new grid means
 * 08:00. Without the stored geometry, one config edit silently shifts every
 * already-submitted answer an hour earlier, on the screen whose entire job is
 * putting people into session slots.
 *
 * So every read decodes against the geometry the answer was DRAWN on, and the
 * round's current grid is only ever the fallback for a row written before the
 * geometry was stored.
 *
 * ## Why there is no date arithmetic in this file
 *
 * Every number here is a WALL CLOCK: minutes past midnight in Europe/London
 * on an unspecified day, and a weekday index. No instant is ever constructed,
 * so no DST transition can move a slot, and the same drawn grid means the
 * same thing in October (BST) and in February (GMT). A session at 17:45 for
 * 30 minutes overruns an 18:00 grid whatever the date is. That is deliberate:
 * the applicant is answering "most Tuesdays", not "Tuesday 27 October".
 *
 * The conversion from a wall clock to a real instant belongs to
 * `londonWallClockToInstant` in `src/lib/courses/weekPlan.ts`, and it is the
 * caller's job, not this module's.
 */

/** Bumped only when the ENCODING changes, never when a round widens its window. */
export const AVAILABILITY_VERSION = 1;

/** Sunday through Saturday. Matches `Date.getDay()` and `GroupSession.weekday`. */
export const AVAILABILITY_DAYS = 7;

/**
 * The shape of one round's grid.
 *
 * `startMinute` is INCLUSIVE and `endMinute` is EXCLUSIVE, both measured in
 * minutes past London midnight, so 09:00-18:00 is `{ startMinute: 540,
 * endMinute: 1080 }` and the last slot of the day starts at 17:45 and ends at
 * the bound itself.
 */
export type AvailabilityGrid = {
  version: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
};

/** 09:00 to 18:00 in quarter hours: 36 slots a day, 252 cells, 63 hex chars. */
export const DEFAULT_AVAILABILITY_GRID: AvailabilityGrid = {
  version: AVAILABILITY_VERSION,
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  slotMinutes: 15,
};

/**
 * One applicant's drawn answer: the geometry it was drawn on, plus seven hex
 * strings indexed by `Date.getDay()` (0 = Sunday).
 */
export type AvailabilityMask = AvailabilityGrid & {
  days: string[];
};

/**
 * The three fields of a session this module needs, structurally rather than
 * as `GroupSession`, so the predicate stays testable without building a whole
 * group document and cannot quietly start reading a fourth field.
 *
 * `weekday` is the `Date.getDay()` convention (0 = Sunday .. 6 = Saturday),
 * byte-identical to `GroupSession.weekday` in `courseGroups.ts`. If those two
 * ever disagree, every availability chip on the allocation board is off by
 * some number of days and nothing in the UI would say so.
 */
export type SessionSlot = {
  weekday: number;
  /** Wall-clock start in Europe/London, 24-hour "HH:MM". */
  startTimeLocal: string;
  durationMinutes: number;
};

const HEX_ONLY = /^[0-9a-f]*$/;
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isMinuteOfDay(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 24 * 60;
}

/**
 * True when a grid can be drawn on at all. A grid that fails this yields zero
 * slots everywhere below, which makes every predicate answer "no" rather than
 * throwing at whichever caller happened to reach it first.
 */
export function isUsableGrid(grid: AvailabilityGrid | null | undefined): grid is AvailabilityGrid {
  if (!grid) return false;
  if (!isMinuteOfDay(grid.startMinute) || !isMinuteOfDay(grid.endMinute)) return false;
  if (!isPositiveInt(grid.slotMinutes)) return false;
  return grid.endMinute > grid.startMinute;
}

/**
 * How many slots one day column holds. A window that is not a whole number of
 * slots long is FLOORED — a trailing part-slot is not offerable, so offering
 * it would mean an applicant could mark availability for a quarter hour that
 * runs past the window the round advertised.
 */
export function slotCountFor(grid: AvailabilityGrid): number {
  if (!isUsableGrid(grid)) return 0;
  return Math.floor((grid.endMinute - grid.startMinute) / grid.slotMinutes);
}

/** Hex characters one day column encodes to: four slots per character. */
export function hexCharsPerDay(grid: AvailabilityGrid): number {
  return Math.ceil(slotCountFor(grid) / 4);
}

function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The START time of every slot, in order: `["09:00", "09:15", ...]`. London
 * wall clock, which is what the grid's row headers show and what the seat-row
 * labels are built from.
 */
export function slotLabels(grid: AvailabilityGrid): string[] {
  const count = slotCountFor(grid);
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    labels.push(minuteLabel(grid.startMinute + i * grid.slotMinutes));
  }
  return labels;
}

/** Minutes past midnight for a 24-hour "HH:MM", or null when it is not one. */
export function minutesFromTimeLocal(hhmm: string): number | null {
  const m = WALL_CLOCK.exec(typeof hhmm === "string" ? hhmm : "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Encode one day column.
 *
 * Slot `i` lives in hex character `i >> 2` at bit weight `8 >> (i & 3)`, so
 * the MOST significant bit of the first character is the earliest slot and
 * the string reads left to right in time order. That ordering is worth the
 * one line it costs: a hex mask is something a person will end up reading in
 * the Firebase console during an intake, and "starts at the left" is the only
 * convention that survives being read by eye.
 *
 * Slots past `slotCountFor(grid)` are padding and are always written as 0.
 */
function encodeDay(slots: readonly boolean[], grid: AvailabilityGrid): string {
  const count = slotCountFor(grid);
  const chars = hexCharsPerDay(grid);
  let out = "";
  for (let c = 0; c < chars; c += 1) {
    let nibble = 0;
    for (let b = 0; b < 4; b += 1) {
      const slot = c * 4 + b;
      if (slot < count && slots[slot] === true) nibble |= 8 >> b;
    }
    out += nibble.toString(16);
  }
  return out;
}

/**
 * Decode one day column back to booleans of length `slotCountFor(grid)`.
 *
 * A day string that is not lower-case hex, or that is longer than the grid
 * allows, decodes to an EMPTY column rather than to whatever its prefix
 * happens to say. The two failure directions are not symmetrical: reading
 * junk as "available" would put someone in a session they never offered,
 * while reading it as "not available" costs a conflict warning nobody wanted.
 * Padding bits past the last real slot are ignored either way.
 */
function decodeDay(raw: unknown, grid: AvailabilityGrid): boolean[] {
  const count = slotCountFor(grid);
  const empty = new Array<boolean>(count).fill(false);
  if (typeof raw !== "string" || !HEX_ONLY.test(raw)) return empty;
  if (raw.length > hexCharsPerDay(grid)) return empty;
  const out = empty.slice();
  for (let c = 0; c < raw.length; c += 1) {
    const nibble = Number.parseInt(raw[c], 16);
    for (let b = 0; b < 4; b += 1) {
      const slot = c * 4 + b;
      if (slot < count && (nibble & (8 >> b)) !== 0) out[slot] = true;
    }
  }
  return out;
}

/**
 * Encode a whole drawn grid: seven day columns of booleans to seven hex
 * strings. Short or missing columns encode as empty ones, so a partially
 * built client state cannot throw its way out of a save.
 */
export function encodeMask(days: ReadonlyArray<readonly boolean[]>, grid: AvailabilityGrid): string[] {
  const out: string[] = [];
  for (let d = 0; d < AVAILABILITY_DAYS; d += 1) {
    out.push(encodeDay(Array.isArray(days?.[d]) ? days[d] : [], grid));
  }
  return out;
}

/** Decode seven hex strings back to seven columns of `slotCountFor(grid)` booleans. */
export function decodeMask(days: unknown, grid: AvailabilityGrid): boolean[][] {
  const list = Array.isArray(days) ? days : [];
  const out: boolean[][] = [];
  for (let d = 0; d < AVAILABILITY_DAYS; d += 1) {
    out.push(decodeDay(list[d], grid));
  }
  return out;
}

/** An untouched answer on the given grid: seven all-zero columns. */
export function emptyMask(grid: AvailabilityGrid): AvailabilityMask {
  return {
    version: grid.version,
    startMinute: grid.startMinute,
    endMinute: grid.endMinute,
    slotMinutes: grid.slotMinutes,
    days: encodeMask([], grid),
  };
}

/** How many slots are marked across the whole answer. Powers "no availability given". */
export function markedSlotCount(mask: AvailabilityMask): number {
  const grid = gridOf(mask);
  if (!isUsableGrid(grid)) return 0;
  let total = 0;
  for (const column of decodeMask(mask.days, grid)) {
    for (const slot of column) if (slot) total += 1;
  }
  return total;
}

/**
 * The geometry an answer was drawn on. Falls back to the round's current grid
 * only when the stored answer carries none, which is the pre-geometry legacy
 * case and nothing else.
 */
function gridOf(mask: AvailabilityMask, fallback?: AvailabilityGrid): AvailabilityGrid {
  const own: AvailabilityGrid = {
    version: mask?.version ?? 0,
    startMinute: mask?.startMinute ?? -1,
    endMinute: mask?.endMinute ?? -1,
    slotMinutes: mask?.slotMinutes ?? 0,
  };
  if (isUsableGrid(own)) return own;
  return fallback && isUsableGrid(fallback) ? fallback : own;
}

/**
 * Does this answer cover EVERY minute of the session?
 *
 * This is what the decide route resolves seat-row availability labels with,
 * and what the allocation payload's `availabilityConflict` is ultimately
 * built on, so the bar is "all of it", not "some of it": a person who can
 * make the first half of a ninety-minute session cannot make the session.
 *
 * A session that starts before the grid opens or ends after it closes is NOT
 * covered, whatever the marked slots say. The applicant was never shown that
 * time, so treating unmarked-because-unaskable as available would invent
 * consent out of the grid's own bounds. The honest reading of a session
 * outside the window is "this round never asked", and the answer to "can they
 * make it" is then no.
 *
 * `grid` is the round's CURRENT geometry and is used only when the stored
 * mask carries none of its own (see the module comment).
 */
export function maskCoversSession(
  mask: AvailabilityMask,
  grid: AvailabilityGrid,
  session: SessionSlot,
): boolean {
  const effective = gridOf(mask, grid);
  const count = slotCountFor(effective);
  if (count === 0) return false;

  const weekday = session?.weekday;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday >= AVAILABILITY_DAYS) {
    return false;
  }

  const start = minutesFromTimeLocal(session.startTimeLocal);
  if (start === null) return false;
  const duration = session.durationMinutes;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  const end = start + duration;
  if (start < effective.startMinute || end > effective.endMinute) return false;

  const column = decodeDay(
    Array.isArray(mask?.days) ? mask.days[weekday] : undefined,
    effective,
  );
  const first = Math.floor((start - effective.startMinute) / effective.slotMinutes);
  // The last slot the session touches. `end` is exclusive, so a session
  // finishing exactly on a slot boundary does not require the slot after it.
  const last = Math.ceil((end - effective.startMinute) / effective.slotMinutes) - 1;
  for (let i = first; i <= last; i += 1) {
    if (i < 0 || i >= count) return false;
    if (!column[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * A round's stored `availabilityGrid`, normalised. Anything unusable falls
 * back to the default grid whole, never field by field: half of one grid and
 * half of another is a geometry nobody chose.
 */
export function normalizeAvailabilityGrid(raw: unknown): AvailabilityGrid {
  const data = (raw ?? {}) as Raw;
  const grid: AvailabilityGrid = {
    version: num(data.version, AVAILABILITY_VERSION),
    startMinute: num(data.startMinute, DEFAULT_AVAILABILITY_GRID.startMinute),
    endMinute: num(data.endMinute, DEFAULT_AVAILABILITY_GRID.endMinute),
    slotMinutes: num(data.slotMinutes, DEFAULT_AVAILABILITY_GRID.slotMinutes),
  };
  return isUsableGrid(grid) ? grid : { ...DEFAULT_AVAILABILITY_GRID };
}

/**
 * An application's stored `availability`, normalised against the round's
 * grid. `days` is always exactly seven strings afterwards, so every consumer
 * can index by weekday without a bounds check.
 */
export function normalizeAvailabilityMask(
  raw: unknown,
  fallback: AvailabilityGrid = DEFAULT_AVAILABILITY_GRID,
): AvailabilityMask {
  const data = (raw ?? {}) as Raw;
  const stored: AvailabilityGrid = {
    version: num(data.version, 0),
    startMinute: num(data.startMinute, -1),
    endMinute: num(data.endMinute, -1),
    slotMinutes: num(data.slotMinutes, 0),
  };
  const grid = isUsableGrid(stored) ? stored : normalizeAvailabilityGrid(fallback);
  return {
    ...grid,
    // Re-encode through the decoder so a malformed column lands as an empty
    // one here rather than at whichever reader touches it first.
    days: encodeMask(decodeMask(data.days, grid), grid),
  };
}
