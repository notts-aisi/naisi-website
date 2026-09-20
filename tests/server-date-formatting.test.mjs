/**
 * A date formatted on the server names its zone.
 *
 * ## The failure
 *
 * `date.toLocaleString(undefined, …)` formats in the zone and locale of the
 * process that runs it. In a browser that is the reader, which is usually what
 * was meant. In a Server Component, a route or a scheduler job it is the
 * container, and a Cloud Run container is UTC and en-US. So for the whole of
 * British Summer Time every event time the server rendered was one hour early,
 * in American date order with AM/PM: the public events list printed
 * "Thu, May 28 at 04:30 PM". The same formatter sat in the event page, the
 * home page strip, the RSVP emails, the change notices and the announcement,
 * and naming the locale alone (`"en-GB"`, as the home page did) fixed the
 * order and left the hour wrong.
 *
 * Nothing caught it, and nothing could: TypeScript has no opinion, the page
 * looks right on a laptop in Nottingham because the laptop's defaults are the
 * correct answer, and an emulator run has the same defaults. It shows only on
 * the deployed container, in summer.
 *
 * ## The guard
 *
 * Every `.ts` and `.tsx` under `src` that is not a `"use client"` module is
 * read, and every `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`
 * and `Intl.DateTimeFormat` call in it must carry a `timeZone` in its own
 * argument list. The ordinary way to satisfy it is `formatSiteDate` from
 * `src/lib/datetime/siteTime.ts`, which is the one place the site's zone and
 * locale are written down.
 *
 * It walks the tree rather than the files that were broken, which is the
 * point: the next formatter is written by somebody who has not read this.
 *
 * ## What it cannot see
 *
 * A file with no directive of its own still runs in the browser when only
 * client components import it, and there the reader's zone is the intent.
 * `BROWSER_ONLY` lists those, each with a reason and a pinned call count, and
 * is checked in both directions so an entry cannot outlive the call it excuses.
 * Options passed by reference (`new Intl.DateTimeFormat(locale, OPTIONS)`) are
 * reported as unzoned, because the guard cannot follow the name: write the
 * options inline, or go through `formatSiteDate`.
 */

// Before anything reads the clock. `node --test` runs each file in its own
// process, so this reaches no other suite. A zone far from London is the point:
// the behavioural tests below would pass on a London laptop with the bug intact.
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadable, stripSource } from "./lib/stripSource.mjs";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/**
 * Modules with no `"use client"` of their own whose every importer is a client
 * component, so the call runs in the reader's browser and the reader's zone is
 * what was meant. `calls` pins how many unzoned calls the file may hold.
 */
const BROWSER_ONLY = new Map([
  [
    "src/features/tasks/components/DueDateBadge.tsx",
    {
      calls: 1,
      reason:
        "Rendered only by TaskCard and MyWorkSummary, both client components on the authed task board, where a due date is shown in the reader's own zone like every other time on the board.",
    },
  ],
  [
    "src/features/worksheets/circulation/circulationView.ts",
    {
      calls: 1,
      reason:
        "formatRelativeDay counts calendar days from the reader's local midnight on purpose, and every importer is a client component of the circulation page.",
    },
  ],
]);

const FORMATTER = /\.toLocale(?:Date|Time)?String\(|\bIntl\.DateTimeFormat\(/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The argument list of the call whose opening bracket ends at `start`. */
function argumentsFrom(code, start) {
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") depth--;
    i++;
  }
  return depth === 0 ? code.slice(start, i - 1) : null;
}

/**
 * Unzoned formatter calls per file, for every module that can run on the
 * server. Strings are KEPT: one of the broken calls sat inside a template
 * substitution, which the string-emptying reader would have dropped.
 */
function scan() {
  const unzoned = new Map();
  const unreadable = [];
  for (const file of walk(SRC)) {
    const rel = relative(REPO_ROOT, file).split("\\").join("/");
    const source = readFileSync(file, "utf8");
    if (!FORMATTER.test(source)) continue;
    FORMATTER.lastIndex = 0;
    const code = stripSource(source, { keepStrings: true });
    assertReadable(source, code, rel, assert);
    if (/^\s*["']use client["']/.test(code)) continue;
    const hits = [];
    for (const match of code.matchAll(FORMATTER)) {
      const args = argumentsFrom(code, match.index + match[0].length);
      if (args === null) {
        unreadable.push(rel);
        continue;
      }
      if (!/\btimeZone\b/.test(args)) {
        hits.push(`${match[0]}${args.replace(/\s+/g, " ").trim().slice(0, 70)})`);
      }
    }
    if (hits.length > 0) unzoned.set(rel, hits);
  }
  return { unzoned, unreadable };
}

const { unzoned, unreadable } = scan();

test("every formatter call the guard met could be read to its closing bracket", () => {
  assert.deepEqual(
    unreadable,
    [],
    "These files hold a date formatter whose argument list never closes as the guard reads it. " +
      "A guard that cannot read a call must say so rather than pass it.",
  );
});

test("a date formatted on the server names its time zone", () => {
  const offenders = [...unzoned.entries()]
    .filter(([file]) => !BROWSER_ONLY.has(file))
    .map(([file, hits]) => `${file}\n${hits.map((h) => `      ${h}`).join("\n")}`);
  assert.deepEqual(
    offenders,
    [],
    "These modules can run on the server and format a date without a timeZone, so the deployed " +
      "container (UTC, en-US) decides what the reader sees: an hour early all summer, month before day.\n" +
      "Use formatSiteDate from src/lib/datetime/siteTime.ts, or pass timeZone inline. If every importer " +
      "is a client component and the reader's own zone is what you mean, add the file to BROWSER_ONLY " +
      "with the reason.\n\n" +
      offenders.join("\n"),
  );
});

test("BROWSER_ONLY is exact: no stale entry, no extra call, a written reason", () => {
  for (const [file, entry] of BROWSER_ONLY) {
    assert.ok(
      entry.reason.trim().length >= 40,
      `${file}: say why the reader's zone is the intent, in a sentence.`,
    );
    const found = unzoned.get(file)?.length ?? 0;
    assert.equal(
      found,
      entry.calls,
      `${file} is listed with ${entry.calls} unzoned call(s) and has ${found}. Remove a stale entry; ` +
        "a new call gets the same scrutiny as the first.",
    );
  }
});

// ---------------------------------------------------------------------------
// The helper itself, run under a process zone that is not London
// ---------------------------------------------------------------------------

const { loadTs } = createLoader();
const { formatSiteDate, isSameSiteDay } = await loadTs("lib/datetime/siteTime.ts");
const { formatEventWhen } = await loadTs("lib/events/changeSummary.ts");

const TIME = { hour: "2-digit", minute: "2-digit" };

test("the suite really is running outside London", () => {
  // If this fails the zone override did not take, and every test below would
  // pass with the bug restored.
  assert.notEqual(new Date("2026-09-21T17:00:00Z").getHours(), 18);
});

test("a summer instant is stated in British Summer Time", () => {
  assert.equal(formatSiteDate(new Date("2026-09-21T17:00:00Z"), TIME), "18:00");
});

test("a winter instant is stated in Greenwich Mean Time", () => {
  assert.equal(formatSiteDate(new Date("2026-11-02T18:00:00Z"), TIME), "18:00");
});

test("UK order and a 24-hour clock, whatever the process locale", () => {
  const text = formatSiteDate(new Date("2026-09-21T17:00:00Z"), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...TIME,
  });
  assert.match(text, /Monday/);
  assert.match(text, /21 September 2026/);
  assert.match(text, /18:00/);
  assert.doesNotMatch(text, /AM|PM/i);
});

test("midnight is 00:00 on the London day, not the UTC one", () => {
  const justAfter = new Date("2026-09-21T23:00:00Z");
  assert.equal(formatSiteDate(justAfter, TIME), "00:00");
  assert.equal(formatSiteDate(justAfter, { day: "numeric" }), "22");
});

test("the same day is judged in London", () => {
  // 23:30 to 00:30 in London: one UTC day, two London days.
  assert.equal(
    isSameSiteDay(new Date("2026-09-21T22:30:00Z"), new Date("2026-09-21T23:30:00Z")),
    false,
  );
  // 00:10 to 01:30 in London: two UTC days, one London day.
  assert.equal(
    isSameSiteDay(new Date("2026-09-21T23:10:00Z"), new Date("2026-09-22T00:30:00Z")),
    true,
  );
});

test("the emailed event line carries London times and collapses a same-day end", () => {
  const line = formatEventWhen(
    new Date("2026-09-21T17:00:00Z"),
    new Date("2026-09-21T19:30:00Z"),
  );
  assert.match(line, /21 September 2026/);
  assert.match(line, /18:00 → 20:30$/);
});
