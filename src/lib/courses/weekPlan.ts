/**
 * Course week maths — civil-date pacing for cohort runs.
 *
 * A course run is paced by two pieces of data and nothing else:
 *   - `startDate`: a **civil date** string `"YYYY-MM-DD"` in Europe/London
 *     (no time, no zone — the day the cohort's week 1 begins)
 *   - `weekPlan`: an ordered list of 7-day slots, each either a taught week or
 *     a break (reading week, Christmas, exam period)
 *
 * Everything else — which week the cohort is on, when the current slot began,
 * when a session actually happens — is *computed* from those two. There is no
 * cron on App Hosting, so nothing is ever "advanced"; the current week is a
 * pure function of `(run, now)` evaluated at read time. Servers must always
 * recompute it and never trust a week number sent by a client.
 *
 * ## Week-roll semantics
 *
 * A slot rolls at **local midnight (Europe/London) on the run's start
 * weekday**. If `startDate` is a Monday, slot N begins 00:00 London on the Nth
 * Monday after (and including) the start. The roll is *civil*, not elapsed-
 * milliseconds: the week containing a clock change is still exactly seven
 * calendar days long, even though it is 167 or 169 hours of wall time. That
 * falls out for free here because `daysBetween()` compares two civil dates —
 * both sides are parsed at `T00:00:00Z`, so the DST offset cancels and never
 * enters the arithmetic. (A naive `(now - start) / 86400000` would drift by an
 * hour across the 25 Oct 2026 change and could roll a week a day early.)
 *
 * ## Zero imports, on purpose
 *
 * This module is shared verbatim by client components, server components, and
 * Admin-SDK route handlers, so it depends on nothing but `Intl`. Keep it that
 * way — no Firestore types, no `server-only`, no React.
 *
 * ## Malformed input
 *
 * `daysBetween`, `addDaysToKey`, `currentWeekFor`, and
 * `londonWallClockToInstant` **throw `RangeError`** on a date key that is not
 * a real `YYYY-MM-DD` civil date (and on a time that is not `HH:MM`). That is
 * deliberate: a run's `startDate` is validated at write time by the
 * `courseRuns` normaliser, so a malformed value here means corrupt data, and
 * silently pacing a cohort to a garbage week is far worse than a loud failure.
 * Render paths that may legitimately see a half-authored draft run (no start
 * date chosen yet) should guard with `isValidDateKey()` first.
 */

export const COURSE_TZ = "Europe/London";

/** Every slot in a week plan is exactly this many days long. */
const DAYS_PER_WEEK = 7;

const MS_PER_DAY = 86_400_000;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * One 7-day slot in a run's plan.
 *
 * `weekId` is the stable `weeks/{wNN}` sub-doc id, which survives copy-forward
 * to a new run — so renumbering a plan (inserting a break at week 3) never
 * orphans authored curriculum. Breaks carry no week doc at all; they are pure
 * calendar padding with a label ("Reading week", "Christmas break").
 *
 * Declared here rather than in `src/lib/firestore/courses.ts` because the week
 * maths is the thing that gives the shape meaning; the Firestore module
 * re-exports it so callsites can import either.
 */
export type WeekPlanEntry =
  | { kind: "week"; weekNumber: number; weekId: string }
  | { kind: "break"; label: string };

/**
 * `en-CA` formats as `YYYY-MM-DD`, which is exactly our civil-date key — no
 * manual part assembly, no locale surprises. Module-scoped because
 * constructing an `Intl.DateTimeFormat` is expensive relative to using one,
 * and these two are hot (every week page, every roster row).
 */
const DATE_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: COURSE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Reads an instant's full London wall clock. `hourCycle: "h23"` (rather than
 * `hour12: false`, which some locales render as hour "24") guarantees midnight
 * comes back as `00`.
 */
const WALL_CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: COURSE_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** True when `key` is a real `YYYY-MM-DD` civil date (rejects `2026-02-31`). */
export function isValidDateKey(key: string): boolean {
  if (typeof key !== "string" || !DATE_KEY_PATTERN.test(key)) return false;
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  // Round-trip guard: belt-and-braces against an engine that accepts an
  // out-of-range day and rolls it over instead of returning NaN.
  return new Date(ms).toISOString().slice(0, 10) === key;
}

function parseDateKey(key: string, label: string): number {
  if (!isValidDateKey(key)) {
    throw new RangeError(
      `${label} must be a YYYY-MM-DD civil date, got ${JSON.stringify(key)}`,
    );
  }
  return Date.parse(`${key}T00:00:00Z`);
}

/**
 * The civil date (`"YYYY-MM-DD"`) that `d` falls on in Europe/London.
 *
 * This is the only place an instant becomes a date. 23:30 UTC on 15 June is
 * already 16 June in London — pacing off UTC dates would roll the cohort's
 * week half a day early for anyone browsing late in the evening during BST.
 */
export function londonDateKey(d: Date): string {
  return DATE_KEY_FORMAT.format(d);
}

/**
 * Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier).
 *
 * DST-proof by construction: both keys are parsed as `T00:00:00Z`, so the pair
 * differs by an exact multiple of 24h and no offset ever enters the sum. The
 * `Math.round` is defensive only (a leap second or a future non-integral zone
 * rule can't survive it).
 */
export function daysBetween(fromKey: string, toKey: string): number {
  const from = parseDateKey(fromKey, "fromKey");
  const to = parseDateKey(toKey, "toKey");
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * `key` shifted by `days` calendar days, still as a civil-date key.
 *
 * Used for slot boundaries (`slotStartKey + 6` is the slot's last day, which
 * the task mirror turns into a 23:59 London due date).
 */
export function addDaysToKey(key: string, days: number): string {
  const ms = parseDateKey(key, "key") + Math.round(days) * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Where a run is right now.
 *
 * - `phase` — `"before"` the run has started, `"running"` inside the plan,
 *   `"after"` once every slot has elapsed.
 * - `planIndex` — index into `weekPlan` while running, else `null`.
 * - `weekNumber` — the taught week number, or `null` during a break (and
 *   outside the run).
 * - `breakLabel` — the break's label while inside one, else `null`.
 * - `anchorWeekNumber` — the last taught week that has *started*, which is
 *   what every "you should be up to here" surface uses: the pacing banner, the
 *   run-home Continue CTA, and the My Work task mirror. Breaks anchor to the
 *   week before them, so a cohort on reading week is still anchored to week 4
 *   rather than falling back to zero. `0` means no taught week has begun.
 * - `slotStartKey` — the civil date the current slot began. Clamped to the
 *   run's first slot before the run and to its last slot after it, so
 *   "next session" style maths always has a real date to work from.
 */
export type CurrentWeek = {
  phase: "before" | "running" | "after";
  planIndex: number | null;
  weekNumber: number | null;
  breakLabel: string | null;
  anchorWeekNumber: number;
  slotStartKey: string;
};

/** Last taught week number at or before `index` (`0` when none has started). */
function anchorAt(weekPlan: WeekPlanEntry[], index: number): number {
  for (let i = Math.min(index, weekPlan.length - 1); i >= 0; i -= 1) {
    const entry = weekPlan[i];
    if (entry.kind === "week") return entry.weekNumber;
  }
  return 0;
}

/**
 * Compute a run's current position. Pure: same `(run, now)` in, same out.
 *
 * `now` defaults to the real clock; every test and every "preview this run's
 * schedule" admin surface passes it explicitly.
 *
 * Throws `RangeError` if `run.startDate` is not a valid civil date — see the
 * module header.
 */
export function currentWeekFor(
  run: { startDate: string; weekPlan: WeekPlanEntry[] },
  now: Date = new Date(),
): CurrentWeek {
  const { startDate, weekPlan } = run;
  const elapsed = daysBetween(startDate, londonDateKey(now));
  const index = Math.floor(elapsed / DAYS_PER_WEEK);

  if (elapsed < 0) {
    return {
      phase: "before",
      planIndex: null,
      weekNumber: null,
      breakLabel: null,
      anchorWeekNumber: 0,
      slotStartKey: startDate,
    };
  }

  // An empty plan lands here too (index 0 >= length 0): a run with no slots
  // authored yet is "after" from day one, anchored to nothing.
  if (index >= weekPlan.length) {
    const lastIndex = Math.max(weekPlan.length - 1, 0);
    return {
      phase: "after",
      planIndex: null,
      weekNumber: null,
      breakLabel: null,
      anchorWeekNumber: anchorAt(weekPlan, lastIndex),
      slotStartKey: addDaysToKey(startDate, lastIndex * DAYS_PER_WEEK),
    };
  }

  const entry = weekPlan[index];
  return {
    phase: "running",
    planIndex: index,
    weekNumber: entry.kind === "week" ? entry.weekNumber : null,
    breakLabel: entry.kind === "break" ? entry.label : null,
    anchorWeekNumber: anchorAt(weekPlan, index),
    slotStartKey: addDaysToKey(startDate, index * DAYS_PER_WEEK),
  };
}

/** An instant's London wall clock, re-encoded as if it were UTC. */
function londonWallAsUtcMs(instant: Date): number {
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of WALL_CLOCK_FORMAT.formatToParts(instant)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * The UTC instant at which the London wall clock reads `hhmm` on `dateKey`.
 *
 * This is the fiddly one, and it is fiddly for a real reason: JS has no
 * "construct a Date in timezone X" primitive, only "read a Date in timezone
 * X". So we invert the readable direction by probing.
 *
 * **Two-probe offset resolution.** Encode the target wall clock as if it were
 * UTC (`target`). Read that instant back through `Intl` in London and measure
 * the drift — that is London's offset *at the guessed instant*. Subtract it to
 * get a candidate. Verify the candidate by reading it back: if its wall clock
 * is the one we asked for, we are done. One probe is not enough because the
 * offset we measured was sampled at the wrong instant whenever the guess lands
 * on the far side of a clock change; the second probe re-measures at the
 * candidate and re-solves.
 *
 * Behaviour at the two pathological wall clocks (both exercised by the tests):
 *
 * - **Fold** — 01:00–01:59 on 25 Oct 2026 happens twice (BST then GMT). This
 *   resolves to the **second, GMT** occurrence. Deterministic, and the later
 *   reading is the safer one for a deadline.
 * - **Gap** — 01:00–01:59 on 28 Mar 2027 never happens (clocks jump 01:00 GMT
 *   → 02:00 BST). This shifts **forward** by the gap, so 01:30 resolves to the
 *   same instant as 02:30 BST. It never throws: a facilitator who picks an
 *   impossible slot time gets the next real minute, not an error page.
 *
 * Throws `RangeError` on a malformed `dateKey` or an `hhmm` that is not
 * 24-hour `HH:MM`.
 */
export function londonWallClockToInstant(dateKey: string, hhmm: string): Date {
  const dayMs = parseDateKey(dateKey, "dateKey");
  const time = WALL_CLOCK_PATTERN.exec(hhmm);
  if (!time) {
    throw new RangeError(
      `hhmm must be a 24-hour HH:MM wall clock, got ${JSON.stringify(hhmm)}`,
    );
  }
  const target = dayMs + Number(time[1]) * 3_600_000 + Number(time[2]) * 60_000;

  // Probe 1: measure the offset at the naive guess and undo it.
  const candidate = target - (londonWallAsUtcMs(new Date(target)) - target);

  // Probe 2: verify. A mismatch means the first probe sampled the offset on
  // the wrong side of a clock change — re-measure at the candidate and re-solve.
  const wallAtCandidate = londonWallAsUtcMs(new Date(candidate));
  if (wallAtCandidate === target) return new Date(candidate);
  return new Date(target - (wallAtCandidate - candidate));
}
