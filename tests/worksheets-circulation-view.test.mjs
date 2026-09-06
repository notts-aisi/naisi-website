/**
 * Unit tests for the circulation page's DISPLAY LOGIC: the pure helpers in
 * `src/features/worksheets/circulation/circulationView.ts` and
 * `notificationCopy.ts`.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Every function under test turns a response document into something a sender
 * ACTS on. That is a narrow claim and worth stating precisely, because it is
 * what separates these from the components around them:
 *
 *  1. **The tally decides who gets chased.** A reviewed response is a
 *     submitted one, so working through the review pile must never make "3 of
 *     8 submitted" fall back to 2. Nothing else in the feature would notice if
 *     it did; the number would simply be wrong on somebody's screen.
 *
 *  2. **The sorts are chase orders, not field orders.** Progress and state
 *     both run least-done-first on purpose. A sort that buries the people who
 *     have not started, under the people who have finished, answers the
 *     opposite of the question the sender opened the page with.
 *
 *  3. **The relative day is counted in calendar days, from local midnight.**
 *     Eleven at night and one in the morning are different days to the person
 *     reading the line, even though they are two hours apart, and "1 day ago"
 *     for something that happened last night reads as wrong. `now` is a
 *     parameter throughout so this is testable rather than true-on-Tuesdays.
 *
 *  4. **The percentage has a zero-total case.** A worksheet with no questions
 *     is a real state (it is what a draft looks like before the first question
 *     is added), and dividing by its zero total would put "NaN%" beside
 *     somebody's name.
 *
 * ## Why the loader dance
 *
 * Identical to `tests/worksheets-model.test.mjs`, and for the same reason:
 * this repo's Node predates the v22.18 that strips TypeScript natively, so the
 * module graph is transpiled in memory with the `typescript` devDependency
 * that `npx tsc --noEmit` already uses. The transpile path is taken
 * unconditionally rather than as a fallback, so behaviour is identical on
 * every Node the team runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const VIEW_MODULE = join(SRC, "features", "worksheets", "circulation", "circulationView.ts");
const COPY_MODULE = join(SRC, "features", "worksheets", "circulation", "notificationCopy.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module.
 *
 * `circulations.ts` pulls in `worksheets.ts` for the item sanitiser, which
 * pulls in `newsletterBlocks.ts`, which pulls in `marked` to render legacy
 * markdown. Nothing under test reaches that, and stubbing it keeps this file
 * honest about what it is exercising.
 *
 * `ChipTone` comes in through `import type`, which TypeScript erases outright,
 * so `@/components/ui/Chip` and its CSS module never appear in this graph and
 * need no stub. That is worth noticing rather than assuming: turning it into a
 * value import would drag a CSS module into a Node process, and the failure
 * will say so.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  ["marked", "export const marked = { parse: (s) => s };"],
]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** file path (or stub key) -> data: URL of its module source. Memoised. */
const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(file) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error("the `typescript` devDependency is not installed. Run `npm install`.", {
        cause: err,
      });
    }
  }
  return import(await transpileToDataUrl(file));
}

const {
  CIRCULATION_SORT_OPTIONS,
  REVIEW_TOGGLES,
  activityLineOf,
  formatActiveTime,
  formatRelativeDay,
  percentOf,
  progressTone,
  responseStateLabel,
  responseStateTone,
  reviewConfigSummary,
  sortResponses,
  submittedTally,
} = await loadTs(VIEW_MODULE);

const { NOTIFICATION_ROWS, notificationSummaryOf } = await loadTs(COPY_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A response document, only as far as these helpers read one. */
function response(overrides = {}) {
  return {
    uid: "u1",
    state: "started",
    progress: { answered: 0, total: 10, requiredAnswered: 0, required: 0 },
    activity: { firstOpenedAt: null, pageOpens: 0, activeMs: 0, lastActiveAt: null },
    addedAt: new Date("2026-09-01T09:00:00Z"),
    ...overrides,
  };
}

function progress(answered, total) {
  return { answered, total, requiredAnswered: 0, required: 0 };
}

// ---------------------------------------------------------------------------
// Active time
// ---------------------------------------------------------------------------

describe("formatActiveTime", () => {
  it("reports anything under a minute as such rather than as zero", () => {
    // "0 min active" reads as "they did nothing", which is a different claim
    // from "they were here briefly".
    assert.equal(formatActiveTime(0), "under a minute");
    assert.equal(formatActiveTime(59_000), "under a minute");
  });

  it("rounds to whole minutes under an hour", () => {
    assert.equal(formatActiveTime(12 * MINUTE), "12 min");
    assert.equal(formatActiveTime(12 * MINUTE + 40_000), "13 min");
  });

  it("splits into hours and minutes above an hour", () => {
    assert.equal(formatActiveTime(HOUR + 5 * MINUTE), "1 h 5 min");
    assert.equal(formatActiveTime(2 * HOUR + 30 * MINUTE), "2 h 30 min");
  });

  it("never prints sixty minutes past an hour", () => {
    // 1h59.7m rounds the remainder to 60, which would read "1 h 60 min".
    assert.equal(formatActiveTime(HOUR + 59 * MINUTE + 45_000), "2 h");
    assert.equal(formatActiveTime(3 * HOUR), "3 h");
  });

  it("survives a stored NaN rather than printing one", () => {
    assert.equal(formatActiveTime(Number.NaN), "under a minute");
  });
});

// ---------------------------------------------------------------------------
// Relative day
// ---------------------------------------------------------------------------

describe("formatRelativeDay", () => {
  it("counts calendar days, not twenty-four-hour blocks", () => {
    // Late last night and early this morning are two hours apart and a day
    // apart, and the second reading is the one a person recognises.
    const now = new Date(2026, 8, 6, 1, 0);
    assert.equal(formatRelativeDay(new Date(2026, 8, 5, 23, 0), now), "yesterday");
    assert.equal(formatRelativeDay(new Date(2026, 8, 6, 0, 30), now), "today");
  });

  it("names the days inside a week and dates anything older", () => {
    const now = new Date(2026, 8, 10, 12, 0);
    assert.equal(formatRelativeDay(new Date(2026, 8, 7, 9, 0), now), "3 days ago");

    // Compared against the same formatting call rather than a literal: the
    // short month name comes from ICU ("Sept" on a full build, "Sep" on a
    // small one), and pinning the literal would make this fail on somebody
    // else's Node for a reason that has nothing to do with the branch.
    const older = new Date(2026, 8, 1, 9, 0);
    assert.equal(
      formatRelativeDay(older, now),
      older.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    );
  });

  it("adds the year once the date is not in the current one", () => {
    const now = new Date(2026, 0, 20, 12, 0);
    const lastYear = new Date(2025, 11, 18, 9, 0);
    assert.equal(
      formatRelativeDay(lastYear, now),
      lastYear.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    );
  });

  it("treats a future stamp as today rather than as a negative count", () => {
    const now = new Date(2026, 8, 10, 12, 0);
    assert.equal(formatRelativeDay(new Date(2026, 8, 11, 9, 0), now), "today");
  });
});

// ---------------------------------------------------------------------------
// Activity line
// ---------------------------------------------------------------------------

describe("activityLineOf", () => {
  it("says nothing was opened when nothing was", () => {
    assert.equal(activityLineOf(response().activity, new Date()), "Not opened yet");
  });

  it("reads as one sentence, and counts one page open in the singular", () => {
    const now = new Date(2026, 8, 6, 12, 0);
    const activity = {
      firstOpenedAt: new Date(2026, 8, 5, 10, 0),
      pageOpens: 1,
      activeMs: 12 * MINUTE,
      lastActiveAt: new Date(2026, 8, 5, 10, 20),
    };
    assert.equal(
      activityLineOf(activity, now),
      "First opened yesterday, 1 page open, 12 min active",
    );
  });

  it("pluralises page opens above one", () => {
    const now = new Date(2026, 8, 6, 12, 0);
    const activity = {
      firstOpenedAt: new Date(2026, 8, 6, 9, 0),
      pageOpens: 4,
      activeMs: 90 * MINUTE,
      lastActiveAt: new Date(2026, 8, 6, 11, 0),
    };
    assert.equal(
      activityLineOf(activity, now),
      "First opened today, 4 page opens, 1 h 30 min active",
    );
  });
});

// ---------------------------------------------------------------------------
// Progress and state
// ---------------------------------------------------------------------------

describe("percentOf", () => {
  it("is zero for a worksheet with nothing to answer", () => {
    // A worksheet with no questions is a real state; NaN% is not.
    assert.equal(percentOf(progress(0, 0)), 0);
  });

  it("rounds to whole percent", () => {
    assert.equal(percentOf(progress(2, 5)), 40);
    assert.equal(percentOf(progress(1, 3)), 33);
  });
});

describe("responseStateLabel", () => {
  it("appends the percentage only while somebody is part-way", () => {
    assert.equal(
      responseStateLabel(response({ state: "started", progress: progress(2, 5) })),
      "In progress, 40%",
    );
  });

  it("leaves the other three states as their plain label", () => {
    assert.equal(
      responseStateLabel(response({ state: "not-opened", progress: progress(0, 5) })),
      "Not opened",
    );
    assert.equal(
      responseStateLabel(response({ state: "submitted", progress: progress(5, 5) })),
      "Submitted",
    );
    assert.equal(
      responseStateLabel(response({ state: "reviewed", progress: progress(5, 5) })),
      "Reviewed",
    );
  });
});

describe("tones", () => {
  it("colours the two terminal states alike on the bar and on the chip", () => {
    // A submitted bar and a reviewed bar are both full. Colouring them apart
    // would make "reviewed" look like a different amount of work done.
    assert.equal(progressTone("submitted"), "success");
    assert.equal(progressTone("reviewed"), "success");
    assert.equal(responseStateTone("submitted"), "success");
    assert.equal(responseStateTone("reviewed"), "success");
  });

  it("separates untouched from in-progress", () => {
    assert.equal(progressTone("not-opened"), "neutral");
    assert.equal(progressTone("started"), "accent");
    assert.equal(responseStateTone("not-opened"), "neutral");
    assert.equal(responseStateTone("started"), "accent");
  });
});

describe("submittedTally", () => {
  it("counts a reviewed response as submitted", () => {
    // Reviewing must never make the number the sender is watching fall.
    const rows = [
      response({ uid: "a", state: "reviewed" }),
      response({ uid: "b", state: "submitted" }),
      response({ uid: "c", state: "started" }),
      response({ uid: "d", state: "not-opened" }),
    ];
    assert.deepEqual(submittedTally(rows), { submitted: 2, total: 4 });
  });

  it("is zero of zero on an empty circulation", () => {
    assert.deepEqual(submittedTally([]), { submitted: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sortResponses", () => {
  const names = { a: "Ada", b: "Bela", c: "Cai" };
  const nameOf = (uid) => names[uid] ?? uid;

  const rows = [
    response({ uid: "c", state: "submitted", progress: progress(5, 5) }),
    response({ uid: "a", state: "not-opened", progress: progress(0, 5) }),
    response({ uid: "b", state: "started", progress: progress(2, 5) }),
  ];

  it("leaves the added order alone when that is what was asked for", () => {
    assert.deepEqual(
      sortResponses(rows, "added", nameOf).map((r) => r.uid),
      ["c", "a", "b"],
    );
  });

  it("does not mutate the array it was given", () => {
    const before = rows.map((r) => r.uid);
    sortResponses(rows, "name", nameOf);
    assert.deepEqual(
      rows.map((r) => r.uid),
      before,
    );
  });

  it("sorts by name through the resolver, not by uid", () => {
    assert.deepEqual(
      sortResponses(rows, "name", nameOf).map((r) => r.uid),
      ["a", "b", "c"],
    );
  });

  it("puts the least finished first, because that is who gets chased", () => {
    assert.deepEqual(
      sortResponses(rows, "progress", nameOf).map((r) => r.uid),
      ["a", "b", "c"],
    );
  });

  it("orders states from not-opened towards reviewed", () => {
    assert.deepEqual(
      sortResponses(rows, "state", nameOf).map((r) => r.uid),
      ["a", "b", "c"],
    );
  });

  it("keeps ties in the order they were added", () => {
    // Two people on the same percentage must not swap places on every
    // snapshot, which is what an unstable tie-break would look like.
    const tied = [
      response({ uid: "x", state: "started", progress: progress(2, 5) }),
      response({ uid: "y", state: "started", progress: progress(2, 5) }),
      response({ uid: "z", state: "started", progress: progress(1, 5) }),
    ];
    assert.deepEqual(
      sortResponses(tied, "progress", nameOf).map((r) => r.uid),
      ["z", "x", "y"],
    );
  });

  it("offers a sort option for every key it handles", () => {
    // The select and the switch are two lists that have to agree; an option
    // with no branch falls through to "added" silently.
    const handled = ["added", "name", "progress", "state"];
    assert.deepEqual(
      CIRCULATION_SORT_OPTIONS.map((o) => o.value),
      handled,
    );
  });
});

// ---------------------------------------------------------------------------
// Review configuration
// ---------------------------------------------------------------------------

describe("reviewConfigSummary", () => {
  it("lists only what is on, in the order the switches are shown", () => {
    const summary = reviewConfigSummary({
      perQuestionFeedback: true,
      perQuestionScoring: false,
      overallFeedback: true,
      returnToRecipient: false,
    });
    assert.deepEqual(summary, ["Per-question feedback", "Overall feedback"]);
  });

  it("is empty when nothing is on", () => {
    assert.deepEqual(
      reviewConfigSummary({
        perQuestionFeedback: false,
        perQuestionScoring: false,
        overallFeedback: false,
        returnToRecipient: false,
      }),
      [],
    );
  });

  it("says out loud that a score is never shown to the recipient", () => {
    // The whole difference between a score and feedback is who sees it. A
    // switch that does not say so is one somebody turns on believing they are
    // grading in the open.
    const scoring = REVIEW_TOGGLES.find((t) => t.key === "perQuestionScoring");
    assert.ok(scoring.label.includes("never shown to the recipient"));
  });
});

// ---------------------------------------------------------------------------
// Notification summary
// ---------------------------------------------------------------------------

describe("notificationSummaryOf", () => {
  const allOff = Object.fromEntries(
    NOTIFICATION_ROWS.map((row) => [row.event, { email: false, push: false }]),
  );

  it("drops an event with both channels off rather than listing it as off", () => {
    const summary = notificationSummaryOf({
      ...allOff,
      assigned: { email: true, push: true },
    });
    assert.deepEqual(
      summary.map((row) => row.event),
      ["assigned"],
    );
  });

  it("names the channels that are on", () => {
    const summary = notificationSummaryOf({
      ...allOff,
      assigned: { email: true, push: true },
      submitted: { email: true, push: false },
      feedbackReturned: { email: false, push: true },
    });
    assert.deepEqual(
      summary.map((row) => row.channels),
      ["Email and Push", "Email", "Push"],
    );
  });

  it("is empty when the sender turned everything off", () => {
    assert.deepEqual(notificationSummaryOf(allOff), []);
  });

  it("keeps the event order the model declares", () => {
    const allOn = Object.fromEntries(
      NOTIFICATION_ROWS.map((row) => [row.event, { email: true, push: false }]),
    );
    assert.deepEqual(
      notificationSummaryOf(allOn).map((row) => row.event),
      NOTIFICATION_ROWS.map((row) => row.event),
    );
  });
});
