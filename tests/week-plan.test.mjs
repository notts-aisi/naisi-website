/**
 * Unit tests for the course week maths (`src/lib/courses/weekPlan.ts`).
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why there is a loader dance at the top
 *
 * Node strips TypeScript types from an imported `.ts` file natively from
 * v22.18 / v23.6 onward, so on a modern runtime this file just imports the
 * module directly. **This repo's Node is older** (`node --version` → v20.19.4
 * at the time of writing; `--experimental-strip-types` does not exist on v20 —
 * it errors with "bad option"), and a bare `import("…/weekPlan.ts")` there
 * fails with `ERR_UNKNOWN_FILE_EXTENSION`.
 *
 * Rather than skip the suite on the repo's own Node — these are the DST
 * assertions that stop a cohort being paced to the wrong week, they have to
 * actually run — the loader falls back to transpiling the module in memory
 * with `typescript`, which is already a devDependency (it is what `npx tsc
 * --noEmit` uses). No new dependency, and the tests execute identically on
 * both paths. Delete the fallback once the repo's Node is >= 22.18.
 *
 * ## What is being pinned
 *
 * The UK clock changes in the 2026/27 academic year, from first principles:
 *   - BST -> GMT: Sun 25 Oct 2026, 02:00 BST -> 01:00 GMT
 *     (the instant is 2026-10-25T01:00:00Z; 01:00-01:59 London happens twice)
 *   - GMT -> BST: Sun 28 Mar 2027, 01:00 GMT -> 02:00 BST
 *     (the instant is 2027-03-28T01:00:00Z; 01:00-01:59 London never happens)
 *   - GMT -> BST: Sun 29 Mar 2026 (the previous spring, for completeness)
 * Every expected UTC instant below is written out by hand from those rules,
 * not read back out of the implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_URL = new URL("../src/lib/courses/weekPlan.ts", import.meta.url);

/** Node errors that mean "this runtime cannot load .ts on its own". */
const NO_TYPE_STRIPPING = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

async function loadWeekPlan() {
  try {
    return await import(MODULE_URL.href);
  } catch (err) {
    if (!NO_TYPE_STRIPPING.has(err?.code)) throw err;
    let ts;
    try {
      ts = (await import("typescript")).default;
    } catch {
      throw new Error(
        `Node ${process.version} cannot import .ts (needs >= 22.18) and the ` +
          "`typescript` devDependency is not installed — run `npm install`, " +
          "or run this suite on a newer Node.",
        { cause: err },
      );
    }
    console.error(
      `[week-plan] Node ${process.version} has no native TypeScript support — ` +
        `transpiling weekPlan.ts in memory with typescript@${ts.version}.`,
    );
    const source = readFileSync(fileURLToPath(MODULE_URL), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: "weekPlan.ts",
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`;
    return import(dataUrl);
  }
}

const {
  COURSE_TZ,
  isValidDateKey,
  londonDateKey,
  daysBetween,
  addDaysToKey,
  currentWeekFor,
  londonWallClockToInstant,
} = await loadWeekPlan();

/** Shorthand for the exact-instant assertions. */
const iso = (d) => d.toISOString();

/** A plain N-week plan with no breaks. */
function weeksPlan(count) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "week",
    weekNumber: i + 1,
    weekId: `w${String(i + 1).padStart(2, "0")}`,
  }));
}

// ---------------------------------------------------------------------------
// COURSE_TZ
// ---------------------------------------------------------------------------

test("COURSE_TZ is Europe/London", () => {
  assert.equal(COURSE_TZ, "Europe/London");
});

// ---------------------------------------------------------------------------
// isValidDateKey
// ---------------------------------------------------------------------------

test("isValidDateKey accepts real civil dates and rejects everything else", () => {
  assert.equal(isValidDateKey("2026-09-28"), true);
  assert.equal(isValidDateKey("2026-02-28"), true);
  assert.equal(isValidDateKey("2024-02-29"), true); // real leap day
  assert.equal(isValidDateKey("2026-02-29"), false); // 2026 is not a leap year
  assert.equal(isValidDateKey("2026-02-31"), false);
  assert.equal(isValidDateKey("2026-13-01"), false);
  assert.equal(isValidDateKey("2026-9-28"), false); // must be zero-padded
  assert.equal(isValidDateKey("2026-09-28T00:00:00Z"), false);
  assert.equal(isValidDateKey(""), false);
});

// ---------------------------------------------------------------------------
// londonDateKey
// ---------------------------------------------------------------------------

test("londonDateKey reads the London civil date, not the UTC one", () => {
  // During BST the London day rolls an hour before the UTC day does. This is
  // the case that pages a cohort into next week a day early if you use UTC.
  assert.equal(londonDateKey(new Date("2026-06-15T22:30:00Z")), "2026-06-15");
  assert.equal(londonDateKey(new Date("2026-06-15T23:30:00Z")), "2026-06-16");

  // During GMT the two agree.
  assert.equal(londonDateKey(new Date("2026-12-15T23:30:00Z")), "2026-12-15");
  assert.equal(londonDateKey(new Date("2026-12-16T00:30:00Z")), "2026-12-16");
});

test("londonDateKey is stable either side of both 2026/27 clock changes", () => {
  // 25 Oct 2026: 00:30Z is 01:30 BST, 01:30Z is 01:30 GMT — same civil date,
  // same wall clock, two different instants.
  assert.equal(londonDateKey(new Date("2026-10-25T00:30:00Z")), "2026-10-25");
  assert.equal(londonDateKey(new Date("2026-10-25T01:30:00Z")), "2026-10-25");
  // 24 Oct 23:30 BST is still 24 Oct in London but already 25 Oct in UTC-land
  // one hour later.
  assert.equal(londonDateKey(new Date("2026-10-24T22:30:00Z")), "2026-10-24");
  assert.equal(londonDateKey(new Date("2026-10-24T23:30:00Z")), "2026-10-25");

  // 28 Mar 2027: clocks jump 01:00 GMT -> 02:00 BST, date unaffected.
  assert.equal(londonDateKey(new Date("2027-03-28T00:59:00Z")), "2027-03-28");
  assert.equal(londonDateKey(new Date("2027-03-28T01:00:00Z")), "2027-03-28");
});

// ---------------------------------------------------------------------------
// daysBetween
// ---------------------------------------------------------------------------

test("daysBetween counts whole civil days across clock changes", () => {
  assert.equal(daysBetween("2026-09-28", "2026-09-28"), 0);

  // The 25-hour day (BST -> GMT) is still one day.
  assert.equal(daysBetween("2026-10-24", "2026-10-25"), 1);
  assert.equal(daysBetween("2026-10-24", "2026-10-26"), 2);

  // The 23-hour day (GMT -> BST) is still one day.
  assert.equal(daysBetween("2027-03-27", "2027-03-28"), 1);
  assert.equal(daysBetween("2026-03-28", "2026-03-29"), 1);

  // Spans that contain both 2026/27 changes.
  assert.equal(daysBetween("2026-09-28", "2027-03-29"), 182);
  assert.equal(daysBetween("2026-01-01", "2027-01-01"), 365); // 2026 not a leap year

  assert.equal(daysBetween("2026-10-25", "2026-10-24"), -1);
  assert.equal(daysBetween("2026-11-02", "2026-09-28"), -35);
});

test("daysBetween throws on a malformed civil date", () => {
  assert.throws(() => daysBetween("2026-9-28", "2026-09-29"), RangeError);
  assert.throws(() => daysBetween("2026-09-28", "not-a-date"), RangeError);
  assert.throws(() => daysBetween("", "2026-09-28"), RangeError);
});

// ---------------------------------------------------------------------------
// addDaysToKey
// ---------------------------------------------------------------------------

test("addDaysToKey walks calendar days, including over clock changes", () => {
  assert.equal(addDaysToKey("2026-10-25", 7), "2026-11-01");
  assert.equal(addDaysToKey("2026-10-24", 1), "2026-10-25");
  assert.equal(addDaysToKey("2027-03-27", 1), "2027-03-28");
  assert.equal(addDaysToKey("2026-02-27", 2), "2026-03-01"); // 2026 not a leap year
  assert.equal(addDaysToKey("2026-01-01", -1), "2025-12-31");
  assert.equal(addDaysToKey("2026-09-28", 0), "2026-09-28");
  assert.equal(addDaysToKey("2026-09-28", 42), "2026-11-09");
});

test("addDaysToKey and daysBetween are inverses across a whole academic year", () => {
  const start = "2026-09-28";
  for (let offset = 0; offset <= 400; offset += 1) {
    const key = addDaysToKey(start, offset);
    assert.equal(
      daysBetween(start, key),
      offset,
      `round trip broke at +${offset} (${key})`,
    );
  }
});

// ---------------------------------------------------------------------------
// currentWeekFor — phases
// ---------------------------------------------------------------------------

test("currentWeekFor reports 'before' ahead of the start date", () => {
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };
  assert.deepEqual(currentWeekFor(run, new Date("2026-09-27T12:00:00Z")), {
    phase: "before",
    planIndex: null,
    weekNumber: null,
    breakLabel: null,
    anchorWeekNumber: 0,
    slotStartKey: "2026-09-28",
  });
  // Weeks out, still 'before' — and slotStartKey clamps to the first slot.
  assert.equal(
    currentWeekFor(run, new Date("2026-08-01T12:00:00Z")).slotStartKey,
    "2026-09-28",
  );
});

test("currentWeekFor uses London midnight, not UTC midnight, to start the run", () => {
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };
  // 27 Sep 23:30Z is 28 Sep 00:30 BST — the run has already started in London.
  assert.equal(
    currentWeekFor(run, new Date("2026-09-27T23:30:00Z")).weekNumber,
    1,
  );
  // 27 Sep 22:30Z is still 23:30 BST on 27 Sep.
  assert.equal(
    currentWeekFor(run, new Date("2026-09-27T22:30:00Z")).phase,
    "before",
  );
});

test("currentWeekFor rolls on the exact 7-day boundary (day 6 vs day 7)", () => {
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };

  const day6 = currentWeekFor(run, new Date("2026-10-04T12:00:00Z"));
  assert.equal(day6.planIndex, 0);
  assert.equal(day6.weekNumber, 1);
  assert.equal(day6.slotStartKey, "2026-09-28");

  const day7 = currentWeekFor(run, new Date("2026-10-05T12:00:00Z"));
  assert.equal(day7.planIndex, 1);
  assert.equal(day7.weekNumber, 2);
  assert.equal(day7.slotStartKey, "2026-10-05");

  const day13 = currentWeekFor(run, new Date("2026-10-11T12:00:00Z"));
  assert.equal(day13.weekNumber, 2);
  const day14 = currentWeekFor(run, new Date("2026-10-12T12:00:00Z"));
  assert.equal(day14.weekNumber, 3);
});

test("currentWeekFor rolls on London's day-6/day-7 line during BST", () => {
  // The regression this exists for: a naive
  // `floor((now - Date.parse(start + "T00:00:00Z")) / 86400000 / 7)` reads
  // 2026-10-04T23:30Z as 6 days 23.5 hours elapsed -> still week 1. In London
  // it is already 00:30 on 5 Oct (BST), which is day 7 -> week 2.
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };
  assert.equal(
    currentWeekFor(run, new Date("2026-10-04T22:30:00Z")).weekNumber,
    1,
  );
  assert.equal(
    currentWeekFor(run, new Date("2026-10-04T23:30:00Z")).weekNumber,
    2,
  );
});

// ---------------------------------------------------------------------------
// currentWeekFor — DST boundaries
// ---------------------------------------------------------------------------

test("currentWeekFor is unmoved by the mid-term BST -> GMT change (Sun 25 Oct 2026)", () => {
  // Run starts Mon 28 Sep 2026. Slot 4 (week 4) covers Mon 19 - Sun 25 Oct,
  // and the clocks go back inside it, making that slot 169 hours long.
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };

  // 01:30 BST on the change day — the first of the two 01:30s.
  const beforeFold = currentWeekFor(run, new Date("2026-10-25T00:30:00Z"));
  assert.equal(beforeFold.planIndex, 3);
  assert.equal(beforeFold.weekNumber, 4);
  assert.equal(beforeFold.slotStartKey, "2026-10-19");

  // 01:30 GMT on the change day — the second 01:30, one hour later.
  const afterFold = currentWeekFor(run, new Date("2026-10-25T01:30:00Z"));
  assert.equal(afterFold.weekNumber, 4);
  assert.equal(afterFold.slotStartKey, "2026-10-19");

  // Last minutes of the change day, still week 4.
  assert.equal(
    currentWeekFor(run, new Date("2026-10-25T23:30:00Z")).weekNumber,
    4,
  );
  // Just past midnight GMT on Mon 26 Oct — week 5 begins.
  const week5 = currentWeekFor(run, new Date("2026-10-26T00:30:00Z"));
  assert.equal(week5.planIndex, 4);
  assert.equal(week5.weekNumber, 5);
  assert.equal(week5.slotStartKey, "2026-10-26");

  // The clock-change slot is still exactly seven days.
  assert.equal(daysBetween(beforeFold.slotStartKey, week5.slotStartKey), 7);
});

test("currentWeekFor is unmoved by the GMT -> BST change (Sun 28 Mar 2027)", () => {
  // Spring run starting Mon 25 Jan 2027; the clocks go forward inside slot 9
  // (Mon 22 - Sun 28 Mar 2027), making that slot 167 hours long.
  const run = { startDate: "2027-01-25", weekPlan: weeksPlan(12) };

  const inGap = currentWeekFor(run, new Date("2027-03-28T00:59:00Z")); // 00:59 GMT
  assert.equal(inGap.weekNumber, 9);
  assert.equal(inGap.slotStartKey, "2027-03-22");

  const afterJump = currentWeekFor(run, new Date("2027-03-28T01:00:00Z")); // 02:00 BST
  assert.equal(afterJump.weekNumber, 9);
  assert.equal(afterJump.slotStartKey, "2027-03-22");

  // 22:30 BST on Sun 28 Mar is still slot 9; 23:30Z is 00:30 BST on Mon 29 -> slot 10.
  assert.equal(
    currentWeekFor(run, new Date("2027-03-28T21:30:00Z")).weekNumber,
    9,
  );
  const week10 = currentWeekFor(run, new Date("2027-03-28T23:30:00Z"));
  assert.equal(week10.weekNumber, 10);
  assert.equal(week10.slotStartKey, "2027-03-29");
});

test("currentWeekFor handles a run that starts on a clock-change day", () => {
  // Sun 25 Oct 2026 is the BST -> GMT day; the run's very first slot is the
  // 169-hour one, and the roll weekday is Sunday.
  const autumn = { startDate: "2026-10-25", weekPlan: weeksPlan(4) };
  const first = currentWeekFor(autumn, new Date("2026-10-25T01:30:00Z"));
  assert.equal(first.phase, "running");
  assert.equal(first.weekNumber, 1);
  assert.equal(first.slotStartKey, "2026-10-25");
  // Day 6 (Sat 31 Oct) is still week 1...
  assert.equal(
    currentWeekFor(autumn, new Date("2026-10-31T12:00:00Z")).weekNumber,
    1,
  );
  // ...and day 7 (Sun 1 Nov) is week 2.
  const second = currentWeekFor(autumn, new Date("2026-11-01T12:00:00Z"));
  assert.equal(second.weekNumber, 2);
  assert.equal(second.slotStartKey, "2026-11-01");

  // Sun 28 Mar 2027 is the GMT -> BST day; the first slot is the 167-hour one.
  const spring = { startDate: "2027-03-28", weekPlan: weeksPlan(4) };
  assert.equal(
    currentWeekFor(spring, new Date("2027-03-28T02:00:00Z")).weekNumber,
    1,
  );
  assert.equal(
    currentWeekFor(spring, new Date("2027-04-03T12:00:00Z")).weekNumber,
    1,
  );
  const springSecond = currentWeekFor(spring, new Date("2027-04-04T12:00:00Z"));
  assert.equal(springSecond.weekNumber, 2);
  assert.equal(springSecond.slotStartKey, "2027-04-04");
});

// ---------------------------------------------------------------------------
// currentWeekFor — breaks
// ---------------------------------------------------------------------------

/**
 * Breaks at the start, in the middle, and at the end of one plan:
 *   idx 0  break "Induction"     (nothing taught yet)
 *   idx 1  week 1
 *   idx 2  week 2
 *   idx 3  break "Reading week"  (anchors back to week 2)
 *   idx 4  week 3
 *   idx 5  week 4
 *   idx 6  break "Christmas"     (anchors back to week 4)
 */
const BREAK_PLAN = [
  { kind: "break", label: "Induction" },
  { kind: "week", weekNumber: 1, weekId: "w01" },
  { kind: "week", weekNumber: 2, weekId: "w02" },
  { kind: "break", label: "Reading week" },
  { kind: "week", weekNumber: 3, weekId: "w03" },
  { kind: "week", weekNumber: 4, weekId: "w04" },
  { kind: "break", label: "Christmas" },
];

/** Noon London on the first day of slot `index` of a run starting `start`. */
function noonInSlot(start, index) {
  return new Date(`${addDaysToKey(start, index * 7)}T12:00:00Z`);
}

test("a break at the start of a plan has no week and anchors to nothing", () => {
  const run = { startDate: "2026-09-28", weekPlan: BREAK_PLAN };
  assert.deepEqual(currentWeekFor(run, noonInSlot("2026-09-28", 0)), {
    phase: "running",
    planIndex: 0,
    weekNumber: null,
    breakLabel: "Induction",
    anchorWeekNumber: 0,
    slotStartKey: "2026-09-28",
  });
});

test("a break in the middle of a plan anchors to the last taught week", () => {
  const run = { startDate: "2026-09-28", weekPlan: BREAK_PLAN };

  const week2 = currentWeekFor(run, noonInSlot("2026-09-28", 2));
  assert.equal(week2.weekNumber, 2);
  assert.equal(week2.anchorWeekNumber, 2);

  // Reading week: no week number, but the anchor holds at 2 so the pacing
  // banner and the My Work mirror don't fall back to zero.
  assert.deepEqual(currentWeekFor(run, noonInSlot("2026-09-28", 3)), {
    phase: "running",
    planIndex: 3,
    weekNumber: null,
    breakLabel: "Reading week",
    anchorWeekNumber: 2,
    slotStartKey: "2026-10-19",
  });

  // Teaching resumes at week 3 in the next slot.
  const week3 = currentWeekFor(run, noonInSlot("2026-09-28", 4));
  assert.equal(week3.weekNumber, 3);
  assert.equal(week3.anchorWeekNumber, 3);
  assert.equal(week3.breakLabel, null);
});

test("a break at the end of a plan anchors to the final taught week", () => {
  const run = { startDate: "2026-09-28", weekPlan: BREAK_PLAN };
  const christmas = currentWeekFor(run, noonInSlot("2026-09-28", 6));
  assert.equal(christmas.phase, "running");
  assert.equal(christmas.planIndex, 6);
  assert.equal(christmas.weekNumber, null);
  assert.equal(christmas.breakLabel, "Christmas");
  assert.equal(christmas.anchorWeekNumber, 4);
  assert.equal(christmas.slotStartKey, "2026-11-09");
});

// ---------------------------------------------------------------------------
// currentWeekFor — past the end
// ---------------------------------------------------------------------------

test("currentWeekFor reports 'after' once every slot has elapsed", () => {
  const run = { startDate: "2026-09-28", weekPlan: BREAK_PLAN };

  // Last day of the final slot (day 48) is still running...
  assert.equal(
    currentWeekFor(run, new Date(`${addDaysToKey("2026-09-28", 48)}T12:00:00Z`))
      .phase,
    "running",
  );
  // ...day 49 is past the end. The anchor keeps the last taught week (4, not
  // the trailing break) and slotStartKey clamps to the final slot's start.
  assert.deepEqual(
    currentWeekFor(
      run,
      new Date(`${addDaysToKey("2026-09-28", 49)}T12:00:00Z`),
    ),
    {
      phase: "after",
      planIndex: null,
      weekNumber: null,
      breakLabel: null,
      anchorWeekNumber: 4,
      slotStartKey: "2026-11-09",
    },
  );

  // Years later, same answer.
  assert.deepEqual(currentWeekFor(run, new Date("2030-01-01T12:00:00Z")), {
    phase: "after",
    planIndex: null,
    weekNumber: null,
    breakLabel: null,
    anchorWeekNumber: 4,
    slotStartKey: "2026-11-09",
  });
});

test("currentWeekFor on a plain 8-week run ends anchored to week 8", () => {
  const run = { startDate: "2026-09-28", weekPlan: weeksPlan(8) };
  const last = currentWeekFor(run, noonInSlot("2026-09-28", 7));
  assert.equal(last.weekNumber, 8);
  assert.equal(last.slotStartKey, "2026-11-16");

  const after = currentWeekFor(run, noonInSlot("2026-09-28", 8));
  assert.equal(after.phase, "after");
  assert.equal(after.anchorWeekNumber, 8);
  assert.equal(after.slotStartKey, "2026-11-16");
});

test("currentWeekFor tolerates an empty week plan", () => {
  const run = { startDate: "2026-09-28", weekPlan: [] };
  assert.deepEqual(currentWeekFor(run, new Date("2026-09-28T12:00:00Z")), {
    phase: "after",
    planIndex: null,
    weekNumber: null,
    breakLabel: null,
    anchorWeekNumber: 0,
    slotStartKey: "2026-09-28",
  });
  assert.equal(
    currentWeekFor(run, new Date("2026-09-01T12:00:00Z")).phase,
    "before",
  );
});

test("currentWeekFor throws on a malformed startDate", () => {
  assert.throws(
    () => currentWeekFor({ startDate: "", weekPlan: weeksPlan(4) }, new Date()),
    RangeError,
  );
});

// ---------------------------------------------------------------------------
// londonWallClockToInstant
// ---------------------------------------------------------------------------

test("londonWallClockToInstant resolves 18:00 on ordinary BST and GMT days", () => {
  // BST (UTC+1): 18:00 London is 17:00Z.
  assert.equal(
    iso(londonWallClockToInstant("2026-06-15", "18:00")),
    "2026-06-15T17:00:00.000Z",
  );
  assert.equal(
    iso(londonWallClockToInstant("2026-09-28", "18:00")),
    "2026-09-28T17:00:00.000Z",
  );
  // GMT (UTC+0): 18:00 London is 18:00Z.
  assert.equal(
    iso(londonWallClockToInstant("2026-12-15", "18:00")),
    "2026-12-15T18:00:00.000Z",
  );
  assert.equal(
    iso(londonWallClockToInstant("2027-01-25", "18:00")),
    "2027-01-25T18:00:00.000Z",
  );
});

test("londonWallClockToInstant handles the BST -> GMT day (Sun 25 Oct 2026)", () => {
  // Saturday before: still BST.
  assert.equal(
    iso(londonWallClockToInstant("2026-10-24", "18:00")),
    "2026-10-24T17:00:00.000Z",
  );
  // The change day itself, evening: GMT.
  assert.equal(
    iso(londonWallClockToInstant("2026-10-25", "18:00")),
    "2026-10-25T18:00:00.000Z",
  );
  // Monday after: GMT.
  assert.equal(
    iso(londonWallClockToInstant("2026-10-26", "18:00")),
    "2026-10-26T18:00:00.000Z",
  );

  // Around the fold. 00:30 is unambiguously BST...
  assert.equal(
    iso(londonWallClockToInstant("2026-10-25", "00:30")),
    "2026-10-24T23:30:00.000Z",
  );
  // ...01:30 happens twice; documented behaviour is the second (GMT) one...
  assert.equal(
    iso(londonWallClockToInstant("2026-10-25", "01:30")),
    "2026-10-25T01:30:00.000Z",
  );
  // ...and 02:30 is unambiguously GMT.
  assert.equal(
    iso(londonWallClockToInstant("2026-10-25", "02:30")),
    "2026-10-25T02:30:00.000Z",
  );
});

test("londonWallClockToInstant handles the GMT -> BST days (29 Mar 2026, 28 Mar 2027)", () => {
  // Saturday before the 2027 change: GMT.
  assert.equal(
    iso(londonWallClockToInstant("2027-03-27", "18:00")),
    "2027-03-27T18:00:00.000Z",
  );
  // The change day, evening: BST.
  assert.equal(
    iso(londonWallClockToInstant("2027-03-28", "18:00")),
    "2027-03-28T17:00:00.000Z",
  );
  // The previous spring change, for the same shape.
  assert.equal(
    iso(londonWallClockToInstant("2026-03-28", "18:00")),
    "2026-03-28T18:00:00.000Z",
  );
  assert.equal(
    iso(londonWallClockToInstant("2026-03-29", "18:00")),
    "2026-03-29T17:00:00.000Z",
  );

  // Around the gap on 28 Mar 2027. 00:30 is unambiguously GMT...
  assert.equal(
    iso(londonWallClockToInstant("2027-03-28", "00:30")),
    "2027-03-28T00:30:00.000Z",
  );
  // ...01:30 never happens, so it shifts forward onto 02:30 BST...
  assert.equal(
    iso(londonWallClockToInstant("2027-03-28", "01:30")),
    "2027-03-28T01:30:00.000Z",
  );
  // ...which is exactly where an explicit 02:30 lands.
  assert.equal(
    iso(londonWallClockToInstant("2027-03-28", "02:30")),
    "2027-03-28T01:30:00.000Z",
  );
  // 03:30 is a normal BST time again.
  assert.equal(
    iso(londonWallClockToInstant("2027-03-28", "03:30")),
    "2027-03-28T02:30:00.000Z",
  );
});

test("londonWallClockToInstant handles midnight and end-of-day", () => {
  // Midnight must come back as hour 00, never 24 — the hourCycle guard.
  assert.equal(
    iso(londonWallClockToInstant("2026-06-16", "00:00")),
    "2026-06-15T23:00:00.000Z",
  );
  assert.equal(
    iso(londonWallClockToInstant("2026-12-16", "00:00")),
    "2026-12-16T00:00:00.000Z",
  );
  // 23:59 is the slot-end due date the My Work task mirror stamps.
  assert.equal(
    iso(londonWallClockToInstant("2026-06-15", "23:59")),
    "2026-06-15T22:59:00.000Z",
  );
  assert.equal(
    iso(londonWallClockToInstant("2026-10-25", "23:59")),
    "2026-10-25T23:59:00.000Z",
  );
});

test("londonWallClockToInstant lands on the requested civil date all year", () => {
  // Property check over 400 consecutive days, spanning both 2026/27 changes:
  // an 18:00 session must always still be on the day it was scheduled for.
  for (let offset = 0; offset <= 400; offset += 1) {
    const key = addDaysToKey("2026-09-01", offset);
    assert.equal(
      londonDateKey(londonWallClockToInstant(key, "18:00")),
      key,
      `18:00 drifted off ${key}`,
    );
    assert.equal(
      londonDateKey(londonWallClockToInstant(key, "23:59")),
      key,
      `23:59 drifted off ${key}`,
    );
  }
});

test("londonWallClockToInstant throws on malformed input", () => {
  assert.throws(() => londonWallClockToInstant("2026-10-25", "24:00"), RangeError);
  assert.throws(() => londonWallClockToInstant("2026-10-25", "7:00"), RangeError);
  assert.throws(() => londonWallClockToInstant("2026-10-25", "18:60"), RangeError);
  assert.throws(() => londonWallClockToInstant("2026-10-25", "1800"), RangeError);
  assert.throws(() => londonWallClockToInstant("2026-02-31", "18:00"), RangeError);
});
