/**
 * A browser spec drives the page through Playwright's actionable locator
 * methods and never through coordinates it measured itself.
 *
 * WHY. `click`, `fill`, `press`, `hover`, `dragTo`, `selectOption` and
 * `scrollIntoViewIfNeeded` scroll the target in, wait for it to hold still,
 * check that it is what the pointer will hit, and retry until it is, all in
 * one loop immediately before the act. A spec that reads a bounding box,
 * scrolls by the shortfall and moves the mouse to the result is measuring in
 * one round trip and acting in the next, and the page can move in between: a
 * late font, a save bar sliding in, a row painted taller. The availability
 * grid step of the applicant funnel did exactly that, grew four stacked waits
 * for it between 6 and 8 September 2026, and still failed one deployed run in
 * four. The fix was to hand the drag to `dragTo`. This guard is what stops the
 * next spec starting down the same road, so that class of failure is caught
 * in `npm test` rather than in a nightly.
 *
 * WHAT IT FORBIDS, with comments stripped first so a spec may still explain:
 *  - `page.mouse.*`: the raw pointer, no actionability check.
 *  - `elementFromPoint`, `getBoundingClientRect`: measuring where things are.
 *  - `scrollIntoView(`, `scrollBy(`, `scrollTo(`: moving the page by hand.
 *    `scrollIntoViewIfNeeded` is a locator action and is fine.
 *  - `dispatchEvent(`: a synthetic event bypasses the browser's own hit test.
 *  - `waitForTimeout(`: a fixed sleep is a guess about how long the page
 *    takes, and it is wrong on the machine it was not tuned on.
 *
 * MEASUREMENT THAT ASSERTS IS ALLOWED, per entry, with a reason. The events
 * mobile baseline reads a box and what is painted over its centre in order to
 * assert nothing is, which is a claim about layout rather than an input to an
 * action. An entry names the file, the pattern and the reason, and it is
 * checked in both directions: an entry that no longer matches anything fails,
 * because the reason has gone stale with it.
 *
 * WHERE THE MEASURING GOES INSTEAD. `scripts/e2e/lib/browser.mjs`. A helper
 * there owns its robustness and its diagnostics once (`waitForHydration`,
 * `installPointerProbe`), and this guard does not read that directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPECS_DIR = join(REPO_ROOT, "tests", "e2e");

const FORBIDDEN = [
  { name: "page.mouse", pattern: /\bpage\.mouse\b/g },
  { name: "mouse.move/down/up/wheel", pattern: /\bmouse\.(?:move|down|up|wheel)\s*\(/g },
  { name: "elementFromPoint", pattern: /\belementFromPoint\b/g },
  { name: "getBoundingClientRect", pattern: /\bgetBoundingClientRect\b/g },
  { name: "scrollIntoView(", pattern: /\bscrollIntoView\s*\(/g },
  { name: "scrollBy/scrollTo(", pattern: /\bscroll(?:By|To)\s*\(/g },
  { name: "dispatchEvent(", pattern: /\bdispatchEvent\s*\(/g },
  { name: "waitForTimeout(", pattern: /\bwaitForTimeout\s*\(/g },
];

/**
 * Measurement a spec may keep. `file` is repo-relative, `name` is an entry of
 * FORBIDDEN, `count` is how many matches the reason covers, so a second use
 * added under an old reason fails here.
 */
const ALLOWED = [
  {
    file: "tests/e2e/events-rsvp.spec.mjs",
    name: "getBoundingClientRect",
    count: 1,
    reason:
      "The mobile baseline's `measure` reads where the submit button sits after a " +
      "scroll in order to ASSERT it is inside the viewport. Nothing acts on the box.",
  },
  {
    file: "tests/e2e/events-rsvp.spec.mjs",
    name: "elementFromPoint",
    count: 1,
    reason:
      "The same `measure` asks what is painted over the button's centre in order to " +
      "ASSERT it is the button: a sticky bar over it leaves the box where it was and " +
      "the tap going elsewhere. Nothing acts on the answer.",
  },
];

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/(^|[^:\\])\/\/[^\n]*$/gm, "$1");
}

const specs = readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".spec.mjs"))
  .map((f) => join(SPECS_DIR, f));

test("there is a browser spec directory to guard", () => {
  assert.ok(specs.length > 0, `${relative(REPO_ROOT, SPECS_DIR)} holds no *.spec.mjs`);
});

test("browser specs act through Playwright's actionable methods, never measured coordinates", () => {
  const seen = new Map(); // `${file}::${name}` -> count
  const offences = [];
  for (const file of specs) {
    const rel = relative(REPO_ROOT, file);
    const source = codeOf(file);
    for (const { name, pattern } of FORBIDDEN) {
      const count = (source.match(pattern) ?? []).length;
      if (count === 0) continue;
      seen.set(`${rel}::${name}`, count);
      const allowed = ALLOWED.find((a) => a.file === rel && a.name === name);
      if (!allowed) {
        offences.push(`${rel} uses ${name} (${count}x) and no ALLOWED entry names it.`);
      } else if (allowed.count !== count) {
        offences.push(
          `${rel} uses ${name} ${count}x but its ALLOWED entry covers ${allowed.count}. ` +
            "A new use needs its own reason, or belongs in scripts/e2e/lib/browser.mjs.",
        );
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    "A spec is measuring the page and acting on the measurement. Use the locator " +
      "action that does the same thing with a hit-target check and retry (click, " +
      "hover, dragTo, scrollIntoViewIfNeeded), or put a helper with its own " +
      "diagnostics in scripts/e2e/lib/browser.mjs. Measurement that only ASSERTS " +
      "goes in ALLOWED with a reason.",
  );
  for (const entry of ALLOWED) {
    assert.ok(
      seen.has(`${entry.file}::${entry.name}`),
      `ALLOWED names ${entry.name} in ${entry.file}, which no longer uses it. Delete the entry.`,
    );
  }
});

test("every ALLOWED entry names a real spec, a real pattern, and a reason", () => {
  const files = new Set(specs.map((f) => relative(REPO_ROOT, f)));
  const names = new Set(FORBIDDEN.map((f) => f.name));
  for (const entry of ALLOWED) {
    assert.ok(files.has(entry.file), `ALLOWED names ${entry.file}, which is not a spec.`);
    assert.ok(names.has(entry.name), `ALLOWED names pattern ${entry.name}, which FORBIDDEN does not define.`);
    assert.ok(Number.isInteger(entry.count) && entry.count > 0, `ALLOWED entry for ${entry.file} has no count.`);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 40,
      `ALLOWED entry for ${entry.file} / ${entry.name} needs a reason a reader can check.`,
    );
  }
});
