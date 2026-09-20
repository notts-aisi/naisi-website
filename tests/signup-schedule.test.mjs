/**
 * "This changed since you signed up", on the email that confirms an RSVP.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * The approve route tells a confirmed attendee if the organiser moved the
 * event between their signing up and their place being confirmed. It used to
 * decide that by comparing two FORMATTED lines, and two strings differ
 * whenever the formatter changes. On 20 September 2026 it did: every emailed
 * time moved from the server's zone to London time. Anybody who had signed up
 * before that and was approved after it would have been told the event had
 * changed, with the old wrong time shown against the right one, for an event
 * nobody had touched.
 *
 * So the comparison is on INSTANTS now, and this file holds that, including
 * for the sign-ups already in the database whose snapshots hold only words.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const codeOf = (path) =>
  readFileSync(join(REPO_ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const { loadTs } = createLoader();
const { scheduleChangeSinceSignup, scheduleInstants } = await loadTs("lib/events/signupSchedule.ts");
const { formatEventWhen } = await loadTs("lib/events/changeSummary.ts");
const { asSignupSnapshot } = await loadTs("lib/firestore/events.ts");

// The freshers' screening: 18:00 to 21:30 London time, which is 17:00 to 20:30 UTC in September.
const START = new Date("2026-09-24T17:00:00Z");
const END = new Date("2026-09-24T20:30:00Z");
const SIGNED_UP = new Date("2026-09-19T12:00:00Z");

/** What the old formatter stored for that event: the server's zone, an hour early. */
const LABEL_FROM_THE_OLD_FORMATTER = "Thu, Sep 24, 2026, 05:00 PM → 08:30 PM";

describe("a snapshot that recorded the instants", () => {
  const snapshot = { scheduleLabel: LABEL_FROM_THE_OLD_FORMATTER, locationLabel: "", ...scheduleInstants(START, END) };

  test("an untouched event has not changed, however its stored line reads", () => {
    assert.equal(
      scheduleChangeSinceSignup({ snapshot, liveStartAt: START, liveEndAt: END, eventUpdatedAt: null, signedUpAt: null }),
      null,
    );
  });

  test("a moved start is a change, and both lines come through today's formatter", () => {
    const moved = new Date("2026-09-24T18:00:00Z");
    const change = scheduleChangeSinceSignup({ snapshot, liveStartAt: moved, liveEndAt: END, eventUpdatedAt: null, signedUpAt: null });
    assert.deepEqual(change, { label: "When", from: formatEventWhen(START, END), to: formatEventWhen(moved, END) });
    assert.notEqual(change.from, LABEL_FROM_THE_OLD_FORMATTER, "the old formatter's words were shown to the attendee");
    assert.match(change.from, /18:00/);
    assert.match(change.to, /19:00/);
  });

  test("a moved end is a change on its own", () => {
    const change = scheduleChangeSinceSignup({
      snapshot,
      liveStartAt: START,
      liveEndAt: new Date("2026-09-24T21:00:00Z"),
      eventUpdatedAt: null,
      signedUpAt: null,
    });
    assert.equal(change.label, "When");
  });

  test("an end time added or removed is a change", () => {
    const open = { scheduleLabel: "x", locationLabel: "", ...scheduleInstants(START, null) };
    assert.ok(scheduleChangeSinceSignup({ snapshot: open, liveStartAt: START, liveEndAt: END, eventUpdatedAt: null, signedUpAt: null }));
    assert.ok(scheduleChangeSinceSignup({ snapshot, liveStartAt: START, liveEndAt: null, eventUpdatedAt: null, signedUpAt: null }));
  });

  test("an undated event that is still undated has not changed", () => {
    const undated = { scheduleLabel: "Date to be confirmed", locationLabel: "", ...scheduleInstants(null, null) };
    assert.equal(
      scheduleChangeSinceSignup({ snapshot: undated, liveStartAt: null, liveEndAt: null, eventUpdatedAt: null, signedUpAt: null }),
      null,
    );
    assert.ok(scheduleChangeSinceSignup({ snapshot: undated, liveStartAt: START, liveEndAt: END, eventUpdatedAt: null, signedUpAt: null }));
  });

  test("the same instant is the same instant whatever zone the process runs in", () => {
    assert.deepEqual(scheduleInstants(START, END), { startAtIso: "2026-09-24T17:00:00.000Z", endAtIso: "2026-09-24T20:30:00.000Z" });
    assert.deepEqual(scheduleInstants(null, null), { startAtIso: null, endAtIso: null });
  });
});

describe("a snapshot from before the instants were recorded: words only", () => {
  const legacy = { scheduleLabel: LABEL_FROM_THE_OLD_FORMATTER, locationLabel: "" };

  test("THE INCIDENT: the formatter changed, nobody touched the event, and nothing is reported", () => {
    const change = scheduleChangeSinceSignup({
      snapshot: legacy,
      liveStartAt: START,
      liveEndAt: END,
      eventUpdatedAt: new Date("2026-09-18T09:00:00Z"),
      signedUpAt: SIGNED_UP,
    });
    assert.equal(change, null);
    assert.notEqual(formatEventWhen(START, END), LABEL_FROM_THE_OLD_FORMATTER, "the fixture no longer differs, so this test proves nothing");
  });

  test("an event edited since the sign-up falls back to the words, which is all there is", () => {
    const change = scheduleChangeSinceSignup({
      snapshot: legacy,
      liveStartAt: START,
      liveEndAt: END,
      eventUpdatedAt: new Date("2026-09-20T09:00:00Z"),
      signedUpAt: SIGNED_UP,
    });
    assert.deepEqual(change, { label: "When", from: LABEL_FROM_THE_OLD_FORMATTER, to: formatEventWhen(START, END) });
  });

  test("with no way to tell whether it was edited, the words are compared, as before", () => {
    assert.ok(scheduleChangeSinceSignup({ snapshot: legacy, liveStartAt: START, liveEndAt: END, eventUpdatedAt: null, signedUpAt: SIGNED_UP }));
    assert.ok(scheduleChangeSinceSignup({ snapshot: legacy, liveStartAt: START, liveEndAt: END, eventUpdatedAt: new Date(), signedUpAt: null }));
  });

  test("matching words are never a change", () => {
    const same = { scheduleLabel: formatEventWhen(START, END), locationLabel: "" };
    assert.equal(
      scheduleChangeSinceSignup({ snapshot: same, liveStartAt: START, liveEndAt: END, eventUpdatedAt: new Date(), signedUpAt: SIGNED_UP }),
      null,
    );
  });
});

describe("reading a stored snapshot", () => {
  test("an old row stays recognisable as an old row", () => {
    const got = asSignupSnapshot({ scheduleLabel: "x", locationLabel: "y" });
    assert.deepEqual(got, { scheduleLabel: "x", locationLabel: "y" });
    assert.equal("startAtIso" in got, false);
  });

  test("a new row carries its instants, null included", () => {
    assert.deepEqual(asSignupSnapshot({ scheduleLabel: "x", locationLabel: "y", startAtIso: "2026-09-24T17:00:00.000Z", endAtIso: null }), {
      scheduleLabel: "x",
      locationLabel: "y",
      startAtIso: "2026-09-24T17:00:00.000Z",
      endAtIso: null,
    });
    assert.deepEqual(asSignupSnapshot({ scheduleLabel: "x", locationLabel: "y", startAtIso: null, endAtIso: null }), {
      scheduleLabel: "x",
      locationLabel: "y",
      startAtIso: null,
      endAtIso: null,
    });
  });

  test("an instant that is not a string or null is treated as not recorded", () => {
    const got = asSignupSnapshot({ scheduleLabel: "x", locationLabel: "y", startAtIso: 12345 });
    assert.equal("startAtIso" in got, false);
  });

  test("something that is not a snapshot is not one", () => {
    assert.equal(asSignupSnapshot(null), null);
    assert.equal(asSignupSnapshot({ scheduleLabel: "x" }), null);
  });
});

describe("the wiring", () => {
  test("a sign-up stores the instants beside the label", () => {
    const code = codeOf("src/app/api/events/[id]/rsvp/route.ts");
    assert.match(code, /\.\.\.scheduleInstants\(/);
  });

  test("the approve route compares through the helper and never two formatted lines", () => {
    const code = codeOf("src/app/api/events/[id]/rsvp/[rsvpId]/approve/route.ts");
    assert.match(code, /scheduleChangeSinceSignup\(/);
    assert.doesNotMatch(code, /scheduleLabel\s*!==|formatEventWhen\(/);
  });
});
