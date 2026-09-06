/**
 * The shared reminder schedule: `src/lib/reminders/slots.ts` (the list and
 * what may be in it) and `src/lib/reminders/schedule.ts` (when each entry
 * comes due).
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this suite exists at all
 *
 * Both halves are pure functions with no Firestore behind them, which is
 * exactly why they are worth executing rather than reasoning about: they are
 * the code that decides whether a person is emailed, and they are shared by
 * two features, so a change made for one is a change made for the other.
 *
 * Three things are pinned that a reader of the source alone would have to
 * take on trust:
 *
 *  1. **What survives a read.** `sanitizeSlots` is the only thing between a
 *     stored document and a send, so what it drops, what it repairs and what
 *     it falls back to are assertions rather than comments.
 *  2. **The label cannot lie.** It is derived from the numbers on every
 *     render, which is the whole reason the three fixed admissions ids went.
 *  3. **The clock change.** A slot resolves through London CIVIL days, so a
 *     reminder set for 10:00 is 10:00 on both sides of the October change.
 *     The expected instants below are written out by hand from the change
 *     dates, never read back out of the implementation.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./lib/tsLoader.mjs";

const { loadTs } = createLoader({ stubs: new Map() });

const {
  DEFAULT_ROUND_SLOTS,
  DEFAULT_WORKSHEET_SLOTS,
  REMINDER_SLOT_LIMITS,
  newSlotId,
  sanitizeSlots,
  slotLabel,
  slotsSignature,
  validateSlots,
} = await loadTs("lib/reminders/slots.ts");

const {
  DEFAULT_REMINDER_TIME_LOCAL,
  reminderDateKey,
  reminderSlotInstant,
  resolveReminderSlots,
} = await loadTs("lib/reminders/schedule.ts");

/** A slot, with the boring fields filled in. */
function slot(daysBefore, atLocalTime, id = `s${daysBefore}-${atLocalTime}`) {
  return { id, daysBefore, atLocalTime };
}

/** The pairs of a list, ids dropped, for comparing shape without identity. */
function pairs(slots) {
  return slots.map((s) => [s.daysBefore, s.atLocalTime]);
}

// ---------------------------------------------------------------------------
// 1. The limits and the defaults
// ---------------------------------------------------------------------------

describe("the limits and the defaults", () => {
  it("caps a list at six slots and sixty days", () => {
    // Six because a list is a list: three presets plus room for the one
    // somebody actually wanted, twice over. Sixty because the worksheet job's
    // scan horizon IS this number, so raising it widens that scan.
    assert.equal(REMINDER_SLOT_LIMITS.maxSlots, 6);
    assert.equal(REMINDER_SLOT_LIMITS.maxDaysBefore, 60);
  });

  it("ships a worksheet with three days out and the day before, at 10:00", () => {
    assert.deepEqual(pairs(DEFAULT_WORKSHEET_SLOTS), [
      [3, "10:00"],
      [1, "10:00"],
    ]);
  });

  it("ships a round with the three presets the fixed ids used to carry", () => {
    // A round created after the free list landed must be scheduled exactly as
    // one created before it, or the change moved somebody's deadline mail.
    assert.deepEqual(pairs(DEFAULT_ROUND_SLOTS), [
      [7, "10:00"],
      [3, "10:00"],
      [0, "12:00"],
    ]);
  });

  it("has nothing to complain about in either default", () => {
    assert.deepEqual(validateSlots(DEFAULT_WORKSHEET_SLOTS), []);
    assert.deepEqual(validateSlots(DEFAULT_ROUND_SLOTS), []);
  });

  it("passes both defaults through the sanitiser unchanged", () => {
    // The round trip a stored circulation takes on every read. A default that
    // did not survive it would be a default nobody ever actually got.
    assert.deepEqual(
      sanitizeSlots(DEFAULT_WORKSHEET_SLOTS, []),
      DEFAULT_WORKSHEET_SLOTS,
    );
    assert.deepEqual(sanitizeSlots(DEFAULT_ROUND_SLOTS, []), DEFAULT_ROUND_SLOTS);
  });
});

// ---------------------------------------------------------------------------
// 2. Ids
// ---------------------------------------------------------------------------

describe("newSlotId", () => {
  it("is prefixed, so a stray id says what it belongs to", () => {
    assert.match(newSlotId(), /^rs_/);
  });

  it("is unique across a burst, which is how somebody adds three rows", () => {
    // The clock alone collides inside one millisecond, and two rows sharing an
    // id would share a React key and edit each other.
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) ids.add(newSlotId());
    assert.equal(ids.size, 500);
  });

  it("carries no separator the marker ids reserve", () => {
    // Not because an id reaches a marker (nothing keys a send off one), but
    // because a slot id turns up in log lines beside ids that do.
    for (let i = 0; i < 50; i += 1) {
      assert.ok(!newSlotId().includes("__"));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The label
// ---------------------------------------------------------------------------

describe("slotLabel", () => {
  it("says 'on the day' for zero, and names the anchor when given one", () => {
    assert.equal(slotLabel(slot(0, "12:00")), "On the day at 12:00");
    assert.equal(
      slotLabel(slot(0, "12:00"), "the due date"),
      "On the due date at 12:00",
    );
  });

  it("keeps 'day' singular at one", () => {
    assert.equal(slotLabel(slot(1, "10:00")), "1 day before at 10:00");
    assert.equal(
      slotLabel(slot(1, "10:00"), "the closing date"),
      "1 day before the closing date at 10:00",
    );
  });

  it("reads as a sentence for anything else", () => {
    assert.equal(
      slotLabel(slot(3, "10:00"), "the due date"),
      "3 days before the due date at 10:00",
    );
    assert.equal(
      slotLabel(slot(14, "09:30"), "the closing date"),
      "14 days before the closing date at 09:30",
    );
  });

  it("says the day count is missing rather than reading 'NaN days before'", () => {
    // Unreachable from a stored document, since `sanitizeSlots` drops a slot
    // whose day count is not a finite number, and entirely reachable in the
    // editor: an emptied day box is held as typed rather than snapping back
    // to 0, and carries `NaN` until a number is there. The row still has to
    // read as a sentence while that is true.
    assert.equal(
      slotLabel({ id: "rs_x", daysBefore: Number.NaN, atLocalTime: "10:00" }),
      "Set how many days before at 10:00",
    );
    assert.equal(
      slotLabel(
        { id: "rs_x", daysBefore: Number.NaN, atLocalTime: "10:00" },
        "the due date",
      ),
      "Set how many days before the due date at 10:00",
    );
  });

  it("is derived from the numbers, so an edited slot cannot wear an old name", () => {
    // THE BUG THIS MODULE EXISTS TO REMOVE. The admissions schedule had three
    // fixed ids wearing three fixed labels ("A week out"), so an admin who
    // edited that row to four days was left with a row that said one thing
    // and sent another.
    const edited = { id: "t7", daysBefore: 4, atLocalTime: "10:00" };
    assert.equal(
      slotLabel(edited, "the closing date"),
      "4 days before the closing date at 10:00",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Sanitising a stored list
// ---------------------------------------------------------------------------

describe("sanitizeSlots", () => {
  const FALLBACK = [slot(3, "10:00", "f3"), slot(1, "10:00", "f1")];

  it("keeps a good list as it stands, in the order it was written", () => {
    const stored = [slot(7, "09:00"), slot(0, "12:00")];
    assert.deepEqual(pairs(sanitizeSlots(stored, FALLBACK)), [
      [7, "09:00"],
      [0, "12:00"],
    ]);
  });

  it("drops an entry that is not an object", () => {
    const out = sanitizeSlots([null, "10:00", 3, slot(1, "10:00")], FALLBACK);
    assert.deepEqual(pairs(out), [[1, "10:00"]]);
  });

  it("drops an entry whose time is not a 24-hour clock", () => {
    // Dropped rather than defaulted: a time nobody can read is not a time to
    // guess at, and the editor shows the surviving list, so the row's absence
    // is visible rather than a schedule silently moved to some other hour.
    const out = sanitizeSlots(
      [slot(3, "10:00"), slot(2, "25:00"), slot(2, "9:00"), slot(2, ""), slot(1, "10:00")],
      FALLBACK,
    );
    assert.deepEqual(pairs(out), [
      [3, "10:00"],
      [1, "10:00"],
    ]);
  });

  it("drops an entry whose day count is not a finite number", () => {
    const out = sanitizeSlots(
      [
        { id: "a", daysBefore: "3", atLocalTime: "10:00" },
        { id: "b", daysBefore: Number.NaN, atLocalTime: "10:00" },
        { id: "c", daysBefore: Number.POSITIVE_INFINITY, atLocalTime: "10:00" },
        slot(1, "10:00"),
      ],
      FALLBACK,
    );
    assert.deepEqual(pairs(out), [[1, "10:00"]]);
  });

  it("clamps a day count into range rather than dropping it", () => {
    // A number that is merely too big says plainly what was meant, unlike a
    // time that cannot be parsed.
    const out = sanitizeSlots([slot(900, "10:00"), slot(-4, "09:00")], FALLBACK);
    assert.deepEqual(pairs(out), [
      [REMINDER_SLOT_LIMITS.maxDaysBefore, "10:00"],
      [0, "09:00"],
    ]);
  });

  it("rounds a fractional day count", () => {
    const out = sanitizeSlots([slot(2.6, "10:00")], FALLBACK);
    assert.deepEqual(pairs(out), [[3, "10:00"]]);
  });

  it("de-duplicates identical day and time pairs, keeping the first", () => {
    // Two slots that resolve to one instant are one reminder anyway, so the
    // second is a row that would never send and would sit in the editor
    // looking like it might.
    const out = sanitizeSlots(
      [slot(3, "10:00", "first"), slot(3, "10:00", "second"), slot(3, "16:00")],
      FALLBACK,
    );
    assert.deepEqual(pairs(out), [
      [3, "10:00"],
      [3, "16:00"],
    ]);
    assert.equal(out[0].id, "first");
  });

  it("re-mints a missing or repeated id, because no send keys off one", () => {
    const out = sanitizeSlots(
      [
        { daysBefore: 3, atLocalTime: "10:00" },
        { id: "dup", daysBefore: 2, atLocalTime: "10:00" },
        { id: "dup", daysBefore: 1, atLocalTime: "10:00" },
      ],
      FALLBACK,
    );
    assert.equal(out.length, 3);
    assert.equal(new Set(out.map((s) => s.id)).size, 3, "two rows share an id");
    assert.match(out[0].id, /^rs_/);
    assert.equal(out[1].id, "dup");
    assert.match(out[2].id, /^rs_/);
  });

  it("caps the list, keeping the first entries", () => {
    const stored = [];
    for (let days = 1; days <= 10; days += 1) stored.push(slot(days, "10:00"));
    const out = sanitizeSlots(stored, FALLBACK);
    assert.equal(out.length, REMINDER_SLOT_LIMITS.maxSlots);
    assert.deepEqual(
      out.map((s) => s.daysBefore),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it("falls back when the field is missing, wrong, or entirely unusable", () => {
    // The reason every circulation written before this feature existed keeps
    // working AND gains a schedule.
    for (const raw of [undefined, null, {}, "10:00", [], [null, { daysBefore: 1 }]]) {
      assert.deepEqual(pairs(sanitizeSlots(raw, FALLBACK)), pairs(FALLBACK), String(raw));
    }
  });

  it("keeps an explicitly emptied list empty when the caller asks it to", () => {
    // THE CONSENT RULE, and it lives here rather than in each normaliser
    // because it is one rule about one thing. A stored EMPTY array is not a
    // document missing a schedule: it is somebody who opened the editor and
    // deleted every row. Falling back there would restore the defaults under
    // them and send the mail they had just removed. Both the worksheet and
    // the round normalisers read documents, so both pass the flag; a caller
    // with no stored intent behind it leaves it off and gets the fallback.
    assert.deepEqual(sanitizeSlots([], FALLBACK, { allowEmpty: true }), []);
    assert.deepEqual(pairs(sanitizeSlots([], FALLBACK)), pairs(FALLBACK));
  });

  it("does not read a missing or malformed list as an emptied one", () => {
    // The flag is about an EMPTY ARRAY and nothing else. A document with no
    // field at all, or a field holding something that is not a list, has no
    // intent in it to respect, so it still gains the defaults even under
    // `allowEmpty`. Getting this wrong would silence every circulation
    // written before the schedule existed.
    for (const raw of [undefined, null, {}, "10:00", [null, { daysBefore: 1 }]]) {
      assert.deepEqual(
        pairs(sanitizeSlots(raw, FALLBACK, { allowEmpty: true })),
        pairs(FALLBACK),
        String(raw),
      );
    }
  });

  it("hands back COPIES, so an editor cannot rewrite the defaults", () => {
    // `DEFAULT_WORKSHEET_SLOTS` is a module constant read by every
    // circulation. An editor holding a row of it would be editing the default
    // for the whole process.
    const out = sanitizeSlots(undefined, DEFAULT_WORKSHEET_SLOTS);
    out[0].daysBefore = 99;
    assert.equal(DEFAULT_WORKSHEET_SLOTS[0].daysBefore, 3);
    assert.notEqual(out[0], DEFAULT_WORKSHEET_SLOTS[0]);
  });
});

// ---------------------------------------------------------------------------
// 5. Validating a list somebody is typing
// ---------------------------------------------------------------------------

describe("validateSlots", () => {
  it("says nothing about a list that is fine", () => {
    assert.deepEqual(validateSlots([slot(3, "10:00"), slot(0, "12:00")]), []);
    assert.deepEqual(validateSlots([]), []);
  });

  it("names a day count out of range, in a sentence", () => {
    const problems = validateSlots([slot(61, "10:00")]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /between 0 and 60/);
    assert.match(problems[0], /\.$/, "a message that is not a sentence");
  });

  it("names a fractional or negative day count too", () => {
    assert.equal(validateSlots([slot(1.5, "10:00")]).length, 1);
    assert.equal(validateSlots([slot(-1, "10:00")]).length, 1);
  });

  it("names a time that is not a 24-hour clock", () => {
    const problems = validateSlots([slot(3, "10:0")]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /24-hour clock time/);
  });

  it("names a duplicate, because it would never send", () => {
    const problems = validateSlots([slot(3, "10:00", "a"), slot(3, "10:00", "b")]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /same day and time/);
  });

  it("names a list longer than the cap", () => {
    const many = [];
    for (let days = 1; days <= 7; days += 1) many.push(slot(days, "10:00"));
    const problems = validateSlots(many);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /6 reminders or fewer/);
  });

  it("says each kind of problem once, however many rows carry it", () => {
    // Three bad times is one thing wrong with the list. Three copies of one
    // sentence is a wall rather than a message.
    const problems = validateSlots([slot(3, "9:00"), slot(2, "24:00"), slot(1, "")]);
    assert.equal(problems.length, 1);
  });

  it("reports every kind that is present, in a stable order", () => {
    const problems = validateSlots([slot(99, "9:00"), slot(99, "9:00")]);
    assert.deepEqual(problems.length, 3);
    assert.match(problems[0], /between 0 and 60/);
    assert.match(problems[1], /24-hour clock time/);
    assert.match(problems[2], /same day and time/);
  });
});

// ---------------------------------------------------------------------------
// 6. The signature
// ---------------------------------------------------------------------------

describe("slotsSignature", () => {
  it("ignores ids, because a re-minted id is not somebody's edit", () => {
    assert.equal(
      slotsSignature([slot(3, "10:00", "a")]),
      slotsSignature([slot(3, "10:00", "rs_whatever")]),
    );
  });

  it("changes when a day, a time, an order or a length changes", () => {
    const base = slotsSignature([slot(3, "10:00"), slot(1, "10:00")]);
    assert.notEqual(base, slotsSignature([slot(2, "10:00"), slot(1, "10:00")]));
    assert.notEqual(base, slotsSignature([slot(3, "16:00"), slot(1, "10:00")]));
    assert.notEqual(base, slotsSignature([slot(1, "10:00"), slot(3, "10:00")]));
    assert.notEqual(base, slotsSignature([slot(3, "10:00")]));
  });
});

// ---------------------------------------------------------------------------
// 7. Resolving a slot to a moment
// ---------------------------------------------------------------------------

/** 23:59 London on Sunday 4 October 2026, which is BST, so 22:59 UTC. */
const ANCHOR = new Date("2026-10-04T22:59:00.000Z");

describe("reminderDateKey and reminderSlotInstant", () => {
  it("counts back CIVIL days in London", () => {
    assert.equal(reminderDateKey(ANCHOR, 0), "2026-10-04");
    assert.equal(reminderDateKey(ANCHOR, 3), "2026-10-01");
    assert.equal(reminderDateKey(ANCHOR, 7), "2026-09-27");
  });

  it("resolves the wall clock on that day, both sides of the clock change", () => {
    // BST ends on Sunday 25 October 2026 (02:00 BST becomes 01:00 GMT). So
    // 10:00 on the 24th is 09:00 UTC and 10:00 on the 26th is 10:00 UTC, and
    // a reminder set for "10:00" is 10:00 to the person on both days.
    const late = new Date("2026-10-27T12:00:00.000Z");
    assert.equal(
      reminderSlotInstant(late, slot(3, "10:00")).dueAt.toISOString(),
      "2026-10-24T09:00:00.000Z",
    );
    assert.equal(
      reminderSlotInstant(late, slot(1, "10:00")).dueAt.toISOString(),
      "2026-10-26T10:00:00.000Z",
    );
  });

  it("falls back to a sane hour when a stored slot carries no time", () => {
    // Not reachable through either editor, both of which validate. Reachable
    // through a document written by hand in the console.
    const blank = reminderSlotInstant(ANCHOR, { id: "x", daysBefore: 1, atLocalTime: "" });
    assert.equal(blank.atLocalTime, DEFAULT_REMINDER_TIME_LOCAL);
    assert.equal(blank.dueAt.toISOString(), "2026-10-03T08:00:00.000Z");
  });
});

describe("resolveReminderSlots", () => {
  const NOW = new Date("2026-10-03T09:30:00.000Z");

  it("returns nothing without an anchor to count back from", () => {
    assert.deepEqual(
      resolveReminderSlots({
        anchor: null,
        slots: [slot(1, "10:00")],
        now: NOW,
        maxLateHours: 24,
      }),
      [],
    );
  });

  it("classifies each slot against its OWN moment", () => {
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(3, "10:00"), slot(1, "10:00"), slot(0, "09:00")],
      now: NOW,
      maxLateHours: 24,
      grouping: "instant",
    });
    // 1 Oct 10:00 BST is 48 hours before this tick: past the bound.
    // 3 Oct 10:00 BST is half an hour before it: due.
    // 4 Oct 09:00 BST is still ahead: pending.
    assert.deepEqual(
      due.map((entry) => [entry.dueAtKey, entry.state]),
      [
        ["2026-10-01T1000", "stale"],
        ["2026-10-03T1000", "due"],
        ["2026-10-04T0900", "pending"],
      ],
    );
  });

  it("sorts earliest first, whatever order the list is written in", () => {
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(0, "09:00"), slot(3, "10:00"), slot(1, "10:00")],
      now: NOW,
      maxLateHours: 24,
      grouping: "instant",
    });
    const instants = due.map((entry) => entry.dueAt.getTime());
    assert.deepEqual(instants, [...instants].sort((a, b) => a - b));
  });

  it("groups by DAY for admissions: two times on one day are one send", () => {
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(1, "09:00"), slot(1, "16:00")],
      now: new Date("2026-10-03T20:00:00.000Z"),
      maxLateHours: 24,
      grouping: "day",
    });
    assert.equal(due.length, 1);
    assert.equal(due[0].dueAtKey, "2026-10-03");
    assert.deepEqual(due[0].slotIds.length, 2);
    // The EARLIER of the two, so a same-day pair goes out at the first time
    // rather than waiting for the second.
    assert.equal(due[0].dueAt.toISOString(), "2026-10-03T08:00:00.000Z");
  });

  it("groups by INSTANT for worksheets: two times on one day are two sends", () => {
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(1, "09:00"), slot(1, "16:00")],
      now: new Date("2026-10-03T20:00:00.000Z"),
      maxLateHours: 24,
      grouping: "instant",
    });
    assert.deepEqual(
      due.map((entry) => entry.dueAtKey),
      ["2026-10-03T0900", "2026-10-03T1600"],
    );
  });

  it("makes one entry of two slots that resolve to the same moment", () => {
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(1, "10:00", "a"), slot(1, "10:00", "b")],
      now: NOW,
      maxLateHours: 24,
      grouping: "instant",
    });
    assert.equal(due.length, 1);
    assert.deepEqual(due[0].slotIds, ["a", "b"]);
  });

  it("drops a slot that resolves PAST the date it counts down to", () => {
    // A round closing at 09:00 with a day-of slot at 12:00 would otherwise
    // mail "closes today, 09:00" three hours after the form started refusing
    // people.
    const closesAt = new Date("2026-10-04T08:00:00.000Z"); // 09:00 London
    const due = resolveReminderSlots({
      anchor: closesAt,
      slots: [slot(0, "12:00"), slot(0, "07:00")],
      now: new Date("2026-10-04T09:00:00.000Z"),
      maxLateHours: 24,
      grouping: "instant",
    });
    assert.deepEqual(
      due.map((entry) => entry.dueAtKey),
      ["2026-10-04T0700"],
    );
  });

  it("builds keys a scheduler marker will accept", () => {
    // A marker id component may not contain `__`, `/` or `.`, and the whole
    // point of the instant key is that it still does not.
    const due = resolveReminderSlots({
      anchor: ANCHOR,
      slots: [slot(3, "10:00"), slot(0, "09:30")],
      now: NOW,
      maxLateHours: 24,
      grouping: "instant",
    });
    for (const entry of due) {
      assert.ok(!entry.dueAtKey.includes("__"), entry.dueAtKey);
      assert.ok(!entry.dueAtKey.includes("/"), entry.dueAtKey);
      assert.ok(!entry.dueAtKey.includes("."), entry.dueAtKey);
      assert.match(entry.dueAtKey, /^\d{4}-\d{2}-\d{2}T\d{4}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The two features share one resolver
// ---------------------------------------------------------------------------

test("the admissions module is a name over the shared resolver", async () => {
  // Behaviour, not wiring: the admissions names must answer exactly what the
  // shared resolver answers under `"day"` grouping, or lifting the arithmetic
  // moved somebody's deadline mail.
  const admissions = await loadTs("lib/admissions/reminderSchedule.ts");
  const offsets = [
    { id: "t7", daysBefore: 7, atLocalTime: "10:00" },
    { id: "t3", daysBefore: 3, atLocalTime: "10:00" },
    { id: "dday", daysBefore: 0, atLocalTime: "12:00" },
  ];
  const now = new Date("2026-10-01T09:30:00.000Z");
  const viaAdmissions = admissions.resolveReminderDueDates({
    closesAt: ANCHOR,
    offsets,
    now,
    maxLateHours: 24,
  });
  const viaShared = resolveReminderSlots({
    anchor: ANCHOR,
    slots: offsets,
    now,
    maxLateHours: 24,
    grouping: "day",
  });
  assert.deepEqual(
    viaAdmissions.map((entry) => [entry.dueAtKey, entry.offsetIds, entry.state]),
    viaShared.map((entry) => [entry.dueAtKey, entry.slotIds, entry.state]),
  );
  assert.equal(admissions.markerDateKey(ANCHOR, 3), reminderDateKey(ANCHOR, 3));
  assert.equal(
    admissions.reminderDueAt(ANCHOR, offsets[1]).dueAt.toISOString(),
    reminderSlotInstant(ANCHOR, offsets[1]).dueAt.toISOString(),
  );
});
