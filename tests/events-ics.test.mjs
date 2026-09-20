/**
 * The calendar builders: `src/lib/events/ics.ts`.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * ## Why these three things and not the whole file
 *
 * A calendar entry leaves the site and is read by software nobody here
 * controls, so the parts worth executing are the ones a reader cannot check by
 * looking at the page.
 *
 *  1. THE TWO OUTLOOK HOSTS. They are new, they are the only calendar target
 *     the site had no link for, and every one of their five required
 *     parameters is a literal that a typo turns into a compose window with no
 *     event in it. The assertions read the built URL back with `new URL` so
 *     they check what a phone receives rather than the string that was
 *     concatenated.
 *  2. SEQUENCE. A printed poster is a promise made once and edited afterwards,
 *     and SEQUENCE is the whole of how a corrected file REPLACES the entry
 *     somebody already added instead of sitting beside it. It has to be a
 *     non-negative 31-bit integer that only ever grows for a UID, which is a
 *     contract arithmetic can break silently: epoch milliseconds overflow it
 *     now, epoch seconds overflow it in 2038.
 *  3. THE SHARED END. Both link builders and the file builder default a
 *     missing end to two hours after the start, and they now do it through one
 *     helper. That is one place to get wrong for three outputs.
 *
 * Nothing here reaches Firestore, a transport or the network: the module has
 * no imports at all, and the loader compiles it in process.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./lib/tsLoader.mjs";

const { loadTs } = createLoader();
const {
  buildEventIcs,
  googleCalendarUrl,
  icsSequenceFor,
  outlookLiveUrl,
  outlookOfficeUrl,
} = await loadTs("lib/events/ics.ts");

/** A Monday-evening event in British Summer Time: 18:00 to 20:00 London. */
const START = new Date("2026-09-21T17:00:00Z");
const END = new Date("2026-09-21T19:00:00Z");
const UPDATED = new Date("2026-09-10T09:30:00Z");

const SAMPLE = {
  title: "NAISI intro to AI safety",
  description: "Food: pizza\nhttps://naisi.uk/events/abc123",
  location: "Portland Building, room A40",
  startAt: START,
  endAt: END,
};

/** The VEVENT's properties, keyed by name, from a built file. */
function propertiesOf(ics) {
  const out = new Map();
  for (const line of ics.split("\r\n")) {
    const at = line.indexOf(":");
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outlook
// ---------------------------------------------------------------------------

describe("the two Outlook deep links", () => {
  test("each one addresses its own host, with no account index", () => {
    const live = new URL(outlookLiveUrl(SAMPLE));
    const office = new URL(outlookOfficeUrl(SAMPLE));

    assert.equal(live.host, "outlook.live.com");
    assert.equal(office.host, "outlook.office.com");
    // The index selects the first signed-in account, which means nothing in a
    // stranger's browser, so neither path may carry one.
    assert.equal(live.pathname, "/calendar/deeplink/compose");
    assert.equal(office.pathname, "/calendar/deeplink/compose");
  });

  test("the five required parameters are all there, and read back as written", () => {
    for (const url of [outlookLiveUrl(SAMPLE), outlookOfficeUrl(SAMPLE)]) {
      const params = new URL(url).searchParams;
      assert.equal(params.get("path"), "/calendar/action/compose");
      assert.equal(params.get("rru"), "addevent");
      assert.equal(params.get("subject"), SAMPLE.title);
      assert.equal(params.get("startdt"), "2026-09-21T17:00:00Z");
      assert.equal(params.get("enddt"), "2026-09-21T19:00:00Z");
    }
  });

  test("the instants are UTC with no milliseconds", () => {
    // `toISOString()` carries `.000`, which is not the form the deep link
    // documents, and a rejected date silently opens an empty compose window.
    const params = new URL(outlookLiveUrl(SAMPLE)).searchParams;
    assert.doesNotMatch(params.get("startdt"), /\.\d/);
    assert.doesNotMatch(params.get("enddt"), /\.\d/);
  });

  test("the optional pair travels as location and body", () => {
    const params = new URL(outlookOfficeUrl(SAMPLE)).searchParams;
    assert.equal(params.get("location"), SAMPLE.location);
    assert.equal(params.get("body"), SAMPLE.description);
  });

  test("an event with no place and no notes sends neither key", () => {
    const params = new URL(
      outlookLiveUrl({ title: SAMPLE.title, startAt: START, endAt: END }),
    ).searchParams;
    assert.equal(params.has("location"), false);
    assert.equal(params.has("body"), false);
    assert.equal(params.get("subject"), SAMPLE.title);
  });

  test("a missing end is two hours after the start", () => {
    for (const build of [outlookLiveUrl, outlookOfficeUrl]) {
      const params = new URL(build({ ...SAMPLE, endAt: null })).searchParams;
      assert.equal(params.get("enddt"), "2026-09-21T19:00:00Z");
    }
    // An end BEFORE the start is the same case: it cannot be honoured, so the
    // default stands rather than emitting a negative-length event.
    const backwards = new URL(
      outlookLiveUrl({ ...SAMPLE, endAt: new Date("2026-09-21T16:00:00Z") }),
    ).searchParams;
    assert.equal(backwards.get("enddt"), "2026-09-21T19:00:00Z");
  });

  test("a space in the title survives this end of the trip", () => {
    // Microsoft's signed-out login redirect turns these back into plus signs,
    // which is theirs and not ours. What is ours is that the link leaves here
    // correctly escaped.
    const raw = outlookLiveUrl(SAMPLE);
    assert.match(raw, /subject=NAISI\+intro\+to\+AI\+safety/);
    assert.equal(new URL(raw).searchParams.get("subject"), SAMPLE.title);
  });
});

// ---------------------------------------------------------------------------
// Google, which the shared end helper now runs through
// ---------------------------------------------------------------------------

describe("the Google TEMPLATE link", () => {
  test("it is the render form, with a UTC range", () => {
    const url = new URL(googleCalendarUrl(SAMPLE));
    assert.equal(url.host, "calendar.google.com");
    assert.equal(url.pathname, "/calendar/render");
    assert.equal(url.searchParams.get("action"), "TEMPLATE");
    assert.equal(url.searchParams.get("text"), SAMPLE.title);
    // Both halves end in Z, which is what makes Google read the range as UTC
    // rather than as the reader's local time.
    assert.equal(
      url.searchParams.get("dates"),
      "20260921T170000Z/20260921T190000Z",
    );
    assert.equal(url.searchParams.get("details"), SAMPLE.description);
    assert.equal(url.searchParams.get("location"), SAMPLE.location);
  });

  test("a missing end is two hours after the start here too", () => {
    const url = new URL(googleCalendarUrl({ ...SAMPLE, endAt: null }));
    assert.equal(
      url.searchParams.get("dates"),
      "20260921T170000Z/20260921T190000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// SEQUENCE and LAST-MODIFIED
// ---------------------------------------------------------------------------

describe("the sequence number", () => {
  test("it is a non-negative integer inside 31 bits", () => {
    for (const updatedAt of [
      new Date("2020-01-01T00:00:00Z"),
      new Date("2026-09-10T09:30:00Z"),
      new Date("2088-01-01T00:00:00Z"),
      new Date("2200-01-01T00:00:00Z"),
    ]) {
      const value = icsSequenceFor(updatedAt);
      assert.ok(Number.isInteger(value), `${updatedAt.toISOString()} is not an integer`);
      assert.ok(value >= 0, `${updatedAt.toISOString()} went negative`);
      assert.ok(value <= 2 ** 31 - 1, `${updatedAt.toISOString()} overflowed 31 bits`);
    }
  });

  test("it only grows, and one second apart is two different numbers", () => {
    const first = icsSequenceFor(new Date("2026-09-10T09:30:00Z"));
    const second = icsSequenceFor(new Date("2026-09-10T09:30:01Z"));
    const later = icsSequenceFor(new Date("2026-09-11T09:30:00Z"));
    assert.equal(second, first + 1);
    assert.equal(later, first + 86400);
  });

  test("an unknown or pre-anchor edit scores zero rather than going negative", () => {
    // Zero is what a file with no SEQUENCE line means anyway, so the fallback
    // loses nothing; a negative value would be refused outright.
    assert.equal(icsSequenceFor(null), 0);
    assert.equal(icsSequenceFor(undefined), 0);
    assert.equal(icsSequenceFor(new Date("2019-06-01T00:00:00Z")), 0);
    assert.equal(icsSequenceFor(new Date("not a date")), 0);
  });

  test("an edit twenty years out still fits, which epoch seconds would not", () => {
    // Epoch seconds pass 2 ** 31 in January 2038, so this is the assertion
    // that fails if the anchor is ever dropped.
    const value = icsSequenceFor(new Date("2045-01-01T00:00:00Z"));
    assert.ok(value > 0 && value <= 2 ** 31 - 1);
  });
});

describe("the built file", () => {
  test("it carries SEQUENCE and LAST-MODIFIED from the event's last edit", () => {
    const properties = propertiesOf(
      buildEventIcs({ uid: "abc123", ...SAMPLE, updatedAt: UPDATED }),
    );
    assert.equal(properties.get("SEQUENCE"), String(icsSequenceFor(UPDATED)));
    assert.equal(properties.get("LAST-MODIFIED"), "20260910T093000Z");
    assert.equal(properties.get("UID"), "abc123@naisi.uk");
    assert.equal(properties.get("DTSTART"), "20260921T170000Z");
    assert.equal(properties.get("DTEND"), "20260921T190000Z");
  });

  test("a later edit of the same event produces a higher SEQUENCE", () => {
    // The point of the whole property: same UID, higher number, so the second
    // download replaces the entry the first one created.
    const before = propertiesOf(
      buildEventIcs({ uid: "abc123", ...SAMPLE, updatedAt: UPDATED }),
    );
    const after = propertiesOf(
      buildEventIcs({
        uid: "abc123",
        ...SAMPLE,
        updatedAt: new Date("2026-09-12T11:00:00Z"),
      }),
    );
    assert.equal(before.get("UID"), after.get("UID"));
    assert.ok(Number(after.get("SEQUENCE")) > Number(before.get("SEQUENCE")));
  });

  test("an event with no recorded edit still declares SEQUENCE, at zero", () => {
    const properties = propertiesOf(buildEventIcs({ uid: "abc123", ...SAMPLE }));
    assert.equal(properties.get("SEQUENCE"), "0");
    assert.equal(properties.has("LAST-MODIFIED"), false);
  });

  test("it is still CRLF-delimited and still escapes its text fields", () => {
    const ics = buildEventIcs({
      uid: "abc123",
      title: "Pizza, films; and AI",
      location: "Portland Building, room A40",
      startAt: START,
      endAt: END,
    });
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.ok(!/[^\r]\n/.test(ics), "a bare LF would break strict parsers");
    assert.match(ics, /SUMMARY:Pizza\\, films\\; and AI/);
  });
});
