/**
 * The numbers on the /admin/links dashboard.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * A dashboard is only worth having if its numbers can be trusted, and the
 * ways these ones could quietly be wrong are all small:
 *
 *  1. PEOPLE, NOT ROWS. A subscription is one row per address per channel, so
 *     somebody who ticks two boxes on one form makes two rows. Counting rows
 *     would count them twice and flatter every poster.
 *  2. STARTED IS NOT CONFIRMED. A public sign-up is double opt-in. One number
 *     would overstate the print run by everyone who never opened the email.
 *  3. THE DAY IS A CALENDAR DAY. Moving a date by whole days must survive the
 *     clocks changing, and a chart must show the days nobody scanned, or two
 *     busy days a week apart end up side by side.
 *  4. NO ADDRESS LEAVES THE ARITHMETIC. What comes out is counts, so the
 *     exports are not files of named people.
 *  5. NEITHER READ NEEDS A DECLARED INDEX. Each is a range on one field. The
 *     emulator does not enforce indexes, so a query that needs one passes
 *     every local check and fails in production.
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
const { buildLinkStats, slugFromSource, shiftDateKey, sumLinkStats, dayColumns, hourColumns, MAX_DAY_COLUMNS } =
  await loadTs("lib/campaign/linkStats.ts");

const day = (slug, date, count, hours = {}) => ({ slug, date, count, hours });
const signup = (email, source, confirmed, createdOn = "2026-09-21") => ({ email, source, confirmed, createdOn });

describe("which link a sign-up came from", () => {
  test("the slug is read out of the source, with or without an interest", () => {
    assert.equal(slugFromSource("qr:poster"), "poster");
    assert.equal(slugFromSource("qr:poster:fellowship"), "poster");
  });

  test("a source that names no link is not attributed to one", () => {
    for (const source of ["links", "homepage", "links:fellowship", "qr:", "qr", "", "qr:a_b", "qr:way-too-long-to-be-a-slug", "QR:poster"]) {
      assert.equal(slugFromSource(source), null, source);
    }
  });
});

describe("sign-ups count people, and started is not confirmed", () => {
  test("one person ticking two channels is one sign-up", () => {
    const stats = buildLinkStats({
      days: [],
      fromDate: null,
      signups: [signup("a@example.com", "qr:poster", false), signup("a@example.com", "qr:poster", false)],
    });
    assert.equal(stats.get("poster").signupsStarted, 1);
    assert.equal(stats.get("poster").signupsConfirmed, 0);
  });

  test("an address is the same address however it was typed", () => {
    const stats = buildLinkStats({
      days: [],
      fromDate: null,
      signups: [signup("A@Example.com ", "qr:poster", true), signup("a@example.com", "qr:poster:fellowship", true)],
    });
    assert.equal(stats.get("poster").signupsStarted, 1);
    assert.equal(stats.get("poster").signupsConfirmed, 1);
  });

  test("confirmed on either channel counts the person as confirmed, once", () => {
    const stats = buildLinkStats({
      days: [],
      fromDate: null,
      signups: [
        signup("a@example.com", "qr:poster", true),
        signup("a@example.com", "qr:poster", false),
        signup("b@example.com", "qr:poster", false),
        signup("c@example.com", "qr:movie", true),
      ],
    });
    assert.deepEqual(
      [stats.get("poster").signupsStarted, stats.get("poster").signupsConfirmed],
      [2, 1],
    );
    assert.deepEqual([stats.get("movie").signupsStarted, stats.get("movie").signupsConfirmed], [1, 1]);
  });

  test("a sign-up outside the range is left out, and one with no date only counts for all time", () => {
    const signups = [
      signup("old@example.com", "qr:poster", true, "2026-09-01"),
      signup("new@example.com", "qr:poster", true, "2026-09-21"),
      signup("undated@example.com", "qr:poster", true, null),
    ];
    assert.equal(buildLinkStats({ days: [], signups, fromDate: "2026-09-15" }).get("poster").signupsStarted, 1);
    assert.equal(buildLinkStats({ days: [], signups, fromDate: null }).get("poster").signupsStarted, 3);
  });

  test("no address comes out of the arithmetic", () => {
    const stats = buildLinkStats({
      days: [day("poster", "2026-09-21", 3, { 11: 3 })],
      fromDate: null,
      signups: [signup("someone@example.com", "qr:poster", true)],
    });
    assert.doesNotMatch(JSON.stringify([...stats]), /@|example\.com/);
  });
});

describe("scans", () => {
  const days = [
    day("poster", "2026-09-22", 5, { 10: 2, 11: 3 }),
    day("poster", "2026-09-21", 7, { 11: 4, 14: 3 }),
    day("poster", "2026-09-10", 100, { 9: 100 }),
    day("movie", "2026-09-21", 2, { 18: 2 }),
    day("movie", "2026-09-22", 0, {}),
  ];

  test("are summed per link over the range, days oldest first, hours added up", () => {
    const poster = buildLinkStats({ days, signups: [], fromDate: "2026-09-15" }).get("poster");
    assert.equal(poster.scans, 12);
    assert.deepEqual(poster.byDay, [
      { date: "2026-09-21", count: 7 },
      { date: "2026-09-22", count: 5 },
    ]);
    assert.deepEqual(poster.byHour, { 10: 2, 11: 7, 14: 3 });
  });

  test("all time takes everything", () => {
    assert.equal(buildLinkStats({ days, signups: [], fromDate: null }).get("poster").scans, 112);
  });

  test("a day with nothing on it is not a day with a scan", () => {
    assert.deepEqual(buildLinkStats({ days, signups: [], fromDate: null }).get("movie").byDay, [
      { date: "2026-09-21", count: 2 },
    ]);
  });

  test("a link that was scanned but has no record any more is still in the numbers", () => {
    const stats = buildLinkStats({ days: [day("retired", "2026-09-21", 4)], signups: [], fromDate: null });
    assert.equal(stats.get("retired").scans, 4);
  });

  test("totals add links together", () => {
    const stats = buildLinkStats({
      days,
      fromDate: null,
      signups: [signup("a@example.com", "qr:poster", true), signup("b@example.com", "qr:movie", false)],
    });
    assert.deepEqual(sumLinkStats([...stats.values()]), { scans: 114, signupsStarted: 2, signupsConfirmed: 1 });
    assert.deepEqual(sumLinkStats([]), { scans: 0, signupsStarted: 0, signupsConfirmed: 0 });
  });
});

describe("the calendar", () => {
  test("a date moves by whole days across a month end and a leap day", () => {
    assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDateKey("2028-03-01", -1), "2028-02-29");
    assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
    assert.equal(shiftDateKey("2026-09-21", -6), "2026-09-15");
  });

  test("and across both clock changes, where a day is 23 or 25 hours long", () => {
    // UK clocks: forward on 29 March 2026, back on 25 October 2026.
    assert.equal(shiftDateKey("2026-03-28", 1), "2026-03-29");
    assert.equal(shiftDateKey("2026-03-29", 1), "2026-03-30");
    assert.equal(shiftDateKey("2026-10-25", -1), "2026-10-24");
    assert.equal(shiftDateKey("2026-10-25", 1), "2026-10-26");
  });

  test("the by-day chart shows the days nobody scanned", () => {
    const columns = dayColumns(
      [
        { date: "2026-09-18", count: 3 },
        { date: "2026-09-21", count: 9 },
      ],
      "2026-09-17",
      "2026-09-22",
    );
    assert.deepEqual(
      columns.map((c) => [c.key, c.value]),
      [
        ["2026-09-17", 0],
        ["2026-09-18", 3],
        ["2026-09-19", 0],
        ["2026-09-20", 0],
        ["2026-09-21", 9],
        ["2026-09-22", 0],
      ],
    );
    assert.equal(columns[4].tick, "21");
    assert.equal(columns[4].name, "Monday 21 September");
  });

  test("for all time it starts at the first scan, and never draws more than it can fit", () => {
    assert.equal(dayColumns([{ date: "2026-09-20", count: 1 }], null, "2026-09-22")[0].key, "2026-09-20");
    const long = dayColumns([{ date: "2026-01-01", count: 1 }], null, "2026-09-22");
    assert.equal(long.length, MAX_DAY_COLUMNS);
    assert.equal(long.at(-1).key, "2026-09-22");
    assert.deepEqual(dayColumns([], "2026-09-17", "2026-09-22"), []);
  });

  test("the by-hour chart runs from the first busy hour to the last, quiet hours included", () => {
    const columns = hourColumns({ 10: 2, 13: 5, "09": 0 });
    assert.deepEqual(
      columns.map((c) => [c.tick, c.value]),
      [
        ["10", 2],
        ["11", 0],
        ["12", 0],
        ["13", 5],
      ],
    );
    assert.equal(columns[0].name, "10:00 to 11:00");
    assert.equal(hourColumns({ 23: 1 })[0].name, "23:00 to 00:00");
    assert.deepEqual(hourColumns({}), []);
  });
});

describe("the two reads", () => {
  const code = codeOf("src/features/admin/links/linkStatsData.ts");
  const queries = [...code.matchAll(/query\(([\s\S]*?)\),?\s*\)/g)].map((m) => m[1]);

  test("both are found", () => {
    assert.equal(queries.length, 2);
  });

  test("each is a range on one field, with no orderBy, so neither needs a declared index", () => {
    // Add an equality beside the range, or order by another field, and
    // Firestore wants a composite index. The emulator does not enforce them.
    for (const q of queries) {
      const fields = new Set([...q.matchAll(/where\("(\w+)"/g)].map((m) => m[1]));
      assert.equal(fields.size, 1, `this query filters on more than one field:\n${q}`);
    }
    assert.doesNotMatch(code, /orderBy\(/);
  });

  test("the exports carry counts and never an address", () => {
    const page = codeOf("src/app/(app)/admin/(admin-only)/links/page.tsx");
    const headers = [...page.matchAll(/toCSV\(\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    assert.equal(headers.length, 2);
    for (const header of headers) assert.doesNotMatch(header, /email|address|name|uid/i);
    assert.doesNotMatch(page, /\.email\b/);
  });
});
