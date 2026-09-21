/**
 * "No sign-up needed": an event people just turn up to.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * Every public event page rendered the RSVP form, because every event took
 * sign-ups. A freshers' social, a screening and a stall do not, and asking
 * somebody to fill in a form for one of those costs attendance. The switch is
 * one boolean on the event, and the ways it could go wrong are all about it
 * being respected in one place and forgotten in another:
 *
 *  1. OLD EVENTS ARE UNAFFECTED. Absent reads as off, and only a strict `true`
 *     is on, in the normaliser and in both routes. A client that predates the
 *     switch and sends nothing must not turn sign-ups off on a published event.
 *  2. THE ROUTE REFUSES, not only the page. That half is run against a fake
 *     database in `tests/event-rsvp-identity.test.mjs`.
 *  3. NOTHING ASKS FOR A SIGN-UP THE EVENT DOES NOT TAKE: the public page shows
 *     no form, the announcement email's button does not say "sign up", and the
 *     events list never calls a drop-in "Full", because its capacity is ignored.
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
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const { loadTs } = createLoader();
const { normalizeEvent } = await loadTs("lib/firestore/events.ts");

describe("reading the switch", () => {
  test("an event made before the switch existed takes sign-ups, as it always did", () => {
    assert.equal(normalizeEvent("e1", { title: "Reading group" }).noSignup, false);
  });

  test("only a strict true is on", () => {
    assert.equal(normalizeEvent("e1", { noSignup: true }).noSignup, true);
    for (const value of [false, null, undefined, "true", 1, "yes", {}]) {
      assert.equal(normalizeEvent("e1", { noSignup: value }).noSignup, false, JSON.stringify(value));
    }
  });

  test("switching it on keeps the sign-up settings, so switching back loses nothing", () => {
    const event = normalizeEvent("e1", { noSignup: true, capacity: 30, waitlistEnabled: true });
    assert.equal(event.capacity, 30);
    assert.equal(event.waitlistEnabled, true);
  });
});

describe("writing the switch", () => {
  test("the post-publish route takes only a strict true, so an older client cannot switch sign-ups off by omission", () => {
    const code = codeOf("src/app/api/events/[id]/update/route.ts");
    assert.match(code, /const noSignup = body\.noSignup === true;/);
    assert.match(code, /\bnoSignup,/);
  });

  test("the pre-publish save writes a boolean and nothing else", () => {
    assert.match(codeOf("src/features/events/eventMutations.ts"), /patch\.noSignup = fields\.noSignup === true;/);
  });

  test("the editor sends it with every save", () => {
    const code = codeOf("src/features/events/EventEditor.tsx");
    const fields = code.slice(code.indexOf("const fields = {"), code.indexOf("};", code.indexOf("const fields = {")));
    assert.match(fields, /\bnoSignup,/);
  });

  test("the RSVP route refuses before it reads the sign-up form or writes anything", () => {
    const code = codeOf("src/app/api/events/[id]/rsvp/route.ts");
    const refusal = code.indexOf("event.noSignup === true");
    assert.ok(refusal > -1);
    assert.ok(refusal < code.indexOf("tx.set("), "the refusal comes after the write");
    assert.ok(refusal < code.indexOf("const signupSnapshot"), "the refusal comes after the snapshot is built");
  });
});

describe("nothing asks for a sign-up a drop-in does not take", () => {
  test("the public event page shows a card in place of the form", () => {
    const code = codeOf("src/features/events/EventDetailView.tsx");
    const aside = code.slice(code.indexOf("isCancelled ? ("));
    const dropIn = aside.indexOf("event.noSignup ? (");
    const form = aside.indexOf("<RsvpForm");
    assert.ok(dropIn > -1 && form > -1);
    assert.ok(dropIn < form, "the form is rendered before the drop-in branch is decided");
    const branch = aside.slice(dropIn, form);
    assert.match(branch, /No sign-up needed/);
  });

  test("and does not count places for an event that is not counting them", () => {
    // A drop-in keeps its capacity setting and ignores it. "40 places, 0
    // confirmed, waitlist opens once full" beside "no sign-up needed" is the
    // page contradicting itself.
    const code = codeOf("src/features/events/EventDetailView.tsx");
    assert.match(code, /event\.capacity !== null && !event\.noSignup &&/);
  });

  test("the switch itself is never handed to the form, which is a client component", () => {
    // Every prop a Server Component gives a client component is serialised
    // into the public HTML. The form has no use for this one.
    const code = codeOf("src/features/events/EventDetailView.tsx");
    const tag = code.slice(code.indexOf("<RsvpForm"), code.indexOf("/>", code.indexOf("<RsvpForm")));
    assert.doesNotMatch(tag, /noSignup|event=\{event\}/);
  });

  test("the announcement email's button does not say sign up", () => {
    const code = codeOf("src/emails/EventAnnouncementEmail.tsx");
    assert.match(code, /noSignup \? "See the event" : "See the event and sign up"/);
    for (const builder of ["src/app/api/events/[id]/publish/route.ts", "src/lib/scheduler/jobs/eventAnnouncements.ts"]) {
      assert.match(codeOf(builder), /noSignup:/, `${builder} does not tell the email`);
    }
  });

  test("the events list never calls a drop-in full, and says what it is", () => {
    const code = codeOf("src/app/(public)/events/page.tsx");
    assert.match(code, /const full =\s*!event\.noSignup &&/);
    assert.match(code, /event\.noSignup && <Badge[^>]*>No sign-up needed<\/Badge>/);
  });
});
