import {
  ALL_CATEGORIES,
  SUBSCRIPTION_CATEGORIES,
  type NotificationCategory,
  type SubscriptionCategory,
} from "@/lib/firestore/notifications";
import type { PushDeviceState } from "@/features/pwa/pushDevice";

/**
 * The state of the /profile notification grid, as plain functions.
 *
 * Everything here is pure and DOM-free on purpose: the column master
 * switches are the part of that page most likely to be got subtly wrong (a
 * master that reads "on" while one address is unticked is a lie the member
 * cannot see, and one that writes a third value instead of the cells is a
 * preference nothing reads), and `npm test` has no DOM. So the rules live in
 * this module and the component draws them.
 *
 * THE ROW ORDER AND THE COLUMNS live in `src/lib/firestore/notifications.ts`,
 * beside the resolver every sender reads. This file adds only what is true of
 * the GRID: what a master switch means over an email column whose two
 * subscription rows expand per address, and when the push column is dead
 * because of the browser rather than the account.
 */

/**
 * The rows, top to bottom, exactly as the contract orders them: Newsletter,
 * Event announcements, Course announcements, Tasks and worksheets. Derived
 * from `ALL_CATEGORIES` rather than restated, so a fifth row cannot appear in
 * the model and be missing from the page.
 *
 * The locked "Important notices" row is NOT one of these. It stores nothing,
 * writes nothing and is drawn after them; see `NOTICE_ROW`.
 */
export const GRID_ROWS: NotificationCategory[] = [...ALL_CATEGORIES];

/**
 * The row that is not a preference.
 *
 * It is drawn on, in both columns, and disabled. The copy is the whole point
 * of drawing it at all: a member who has switched everything else off should
 * find out here, while they are making that choice, that an organiser can
 * still reach them about a change to something they signed up for, rather
 * than the first time one does.
 */
export const NOTICE_ROW = {
  label: "Important notices",
  description:
    "An organiser of an event you signed up for, or the facilitator of your group, can send you a message about a change, and it reaches you by email and notification whichever switches you set.",
  /** Shown beside each locked cell, so the lock does not rely on colour. */
  cellText: "Always on",
} as const;

/**
 * The per-address subscription matrix: one cell per (verified address,
 * subscription channel). The two subscription rows of the email column
 * expand into this; the other two rows are single booleans.
 */
export type Matrix = Record<string, Record<SubscriptionCategory, boolean>>;

export function emptyCell(): Record<SubscriptionCategory, boolean> {
  return { newsletter: false, events: false };
}

/**
 * The editable half of the email column: the matrix for the two subscription
 * rows, plus one boolean each for the two account-level rows.
 *
 * `courses` and `tasks` are deliberately NOT in the matrix. Cohort mail and
 * task mail are addressed by uid, not by list membership, so a per-address
 * checkbox for either would mint a subscription row nothing ever sends to.
 */
export type EmailColumn = {
  matrix: Matrix;
  courses: boolean;
  tasks: boolean;
};

/**
 * Every writable cell of the email column, flattened, in row order: one
 * boolean per (subscription row, address), then courses, then tasks.
 *
 * Addresses are passed in rather than read off the matrix because the matrix
 * can hold a row for an address the member has since replaced, and a master
 * switch must answer for what is on screen.
 */
export function emailColumnCells(column: EmailColumn, addresses: string[]): boolean[] {
  const cells: boolean[] = [];
  for (const category of SUBSCRIPTION_CATEGORIES) {
    for (const address of addresses) {
      cells.push(Boolean(column.matrix[address]?.[category]));
    }
  }
  cells.push(column.courses, column.tasks);
  return cells;
}

/**
 * Set every cell of the email column at once.
 *
 * The master writes THE SAME per-row booleans the cells write, never a value
 * of its own: with two verified addresses, "on" is every address ticked on
 * both subscription rows and "off" is every one unticked, so the whole-map
 * save and the subscriptions sync see exactly what they would have seen had
 * the member pressed each box. Addresses not on screen are left alone.
 */
export function setEmailColumn(
  column: EmailColumn,
  addresses: string[],
  next: boolean,
): EmailColumn {
  const matrix: Matrix = { ...column.matrix };
  for (const address of addresses) {
    const cell = matrix[address] ?? emptyCell();
    matrix[address] = { ...cell };
    for (const category of SUBSCRIPTION_CATEGORIES) {
      matrix[address][category] = next;
    }
  }
  return { matrix, courses: next, tasks: next };
}

/** Every cell of the push column, flattened, in row order. */
export function pushColumnCells(push: Record<NotificationCategory, boolean>): boolean[] {
  return GRID_ROWS.map((row) => Boolean(push[row]));
}

/**
 * Set every row of the push column at once: four booleans, one leaf write.
 *
 * Same rule as the email master. There is no stored "all push" flag to drift
 * out of step with the rows, because there is no stored flag at all.
 */
export function setColumn(
  push: Record<NotificationCategory, boolean>,
  next: boolean,
): Record<NotificationCategory, boolean> {
  const out = { ...push };
  for (const row of GRID_ROWS) out[row] = next;
  return out;
}

/**
 * A master switch reads ON only when every cell under it is on.
 *
 * Not "some", and not a tri-state: a half-on master would need a third
 * rendering nobody asked for, and "on when any is on" would let a member
 * switch the master off, back on, and find rows enabled they had never
 * chosen. An empty column is off, because there is nothing on in it.
 */
export function columnIsOn(cells: boolean[]): boolean {
  return cells.length > 0 && cells.every(Boolean);
}

/**
 * The push column is dead on THIS browser whenever the device is not
 * subscribed, and `null` (the probe has not finished) counts as not
 * subscribed.
 *
 * The switches still show the STORED value in every one of those states,
 * because the answer belongs to the account and the member may well be
 * setting it here for the phone in their pocket. Only the writing is
 * disabled, and the hint below says which of the two is happening.
 */
export function pushColumnDisabled(state: PushDeviceState | null): boolean {
  return state !== "on";
}

/** Said once, under the Push column header, when that column is disabled. */
export const PUSH_DISABLED_HINT =
  "You have not turned notifications on in this browser, so nothing will arrive here. A setting here still applies to your other devices.";
