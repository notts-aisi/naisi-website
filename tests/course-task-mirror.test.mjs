/**
 * Unit tests for the course-week → My Work task mirror
 * (`src/lib/firestore/courseTasks.ts`).
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why there is a loader dance at the top
 *
 * Same reason as `week-plan.test.mjs`: this repo's Node is older than the
 * v22.18 that strips TypeScript types natively (`node --version` → v20.19.4 at
 * the time of writing), so a bare `import("…/courseTasks.ts")` fails with
 * `ERR_UNKNOWN_FILE_EXTENSION` and the fallback transpiles in memory with the
 * `typescript` devDependency that `npx tsc --noEmit` already uses. No new
 * dependency, no build step, no emitted artefacts.
 *
 * This file's dance is a little larger than week-plan's, because `weekPlan.ts`
 * has no imports and these modules do. `courseTasks.ts` value-imports
 * `weekDocId` from `courses.ts`, which imports `newsletterBlocks.ts` (and that
 * imports `marked`), which means the in-memory module has to be able to reach
 * its own dependencies. A `data:` URL cannot resolve either a relative path or
 * a bare package name, so `loadTsGraph` rewrites every specifier in the
 * transpiled output before handing it to `import()`:
 *   - a relative `./x` that resolves to a real `.ts` file → transpiled the same
 *     way, recursively, and replaced with ITS data URL (memoised, so a module
 *     imported twice is still one instance);
 *   - anything else (a package) → `import.meta.resolve`, which is the runtime's
 *     own resolver, so `marked` is the same `marked` the app would load.
 * The modules under test are therefore the real ones, not stubs. Delete the
 * whole thing once the repo's Node is >= 22.18 and imports carry extensions.
 *
 * ## What is being pinned
 *
 * The mirror is a ONE-WAY projection at a deterministic id, and three of its
 * properties are load-bearing enough that the source carries paragraphs about
 * them but nothing executed them until now:
 *
 *  1. `courseTaskId` is deterministic and separates its three inputs — it IS
 *     the idempotency guarantee (`.create()` at a fixed id), so a collision
 *     between two members or two weeks is a silently-swallowed lost card.
 *  2. `mirrorable()` — the round-trip guard. `sanitizeChecklist` keeps a
 *     checklist row with `id: ""` or `title: ""`; `normalizeSubtask` DROPS the
 *     subtask such a row would produce. Mirroring one makes `subtaskStats.total`
 *     count rows the board cannot render, permanently. The test feeds author
 *     input through the REAL `sanitizeChecklist` and reads the payload back
 *     through the REAL `normalizeTask`, so it fails if either side moves.
 *  3. The mirror contract: sole completer, no reviewers, `assignees-only`,
 *     `source`/`kind`/`sourceRef` exactly as the tasks rules and the sync
 *     route's short-circuit expect.
 *
 * The due date is the caller's to compute (that is what keeps `buildMirroredTask`
 * pure), so it is pinned in two halves: the builder passes the instant through
 * untouched, and the route's own formula — end of the cohort's CURRENT slot at
 * 23:59 Europe/London — is evaluated against the real `weekPlan` helpers, with a
 * source check that the route still spells that formula with those constants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** Node errors that mean "this runtime cannot load .ts on its own". */
const NO_TYPE_STRIPPING = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

/**
 * Every module specifier in transpiled output: `from "x"`, `import "x"` and
 * `import("x")`, in either quote style. Deliberately a regex over the OUTPUT
 * rather than a TypeScript AST walk — by that point the type-only imports are
 * already gone and what is left is plain ES module syntax.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

function resolveLocalTs(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** file path → data: URL of its transpiled form. Memoised for module identity. */
const graph = new Map();
let tsc = null;

async function transpileToDataUrl(file) {
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
    if (specifier.startsWith(".")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) {
        throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      }
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      // A package. `import.meta.resolve` is the runtime's own resolver, so this
      // is exactly the file the app would have loaded.
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
  const url = `data:text/javascript;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`;
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  const file = join(SRC, relativePath);
  try {
    return await import(new URL(`file://${file}`).href);
  } catch (err) {
    if (!NO_TYPE_STRIPPING.has(err?.code)) throw err;
    if (!tsc) {
      try {
        tsc = (await import("typescript")).default;
      } catch {
        throw new Error(
          `Node ${process.version} cannot import .ts (needs >= 22.18) and the ` +
            "`typescript` devDependency is not installed — run `npm install`, " +
            "or run this suite on a newer Node.",
          { cause: err },
        );
      }
      console.error(
        `[course-task-mirror] Node ${process.version} has no native TypeScript ` +
          `support — transpiling in memory with typescript@${tsc.version}.`,
      );
    }
    return import(await transpileToDataUrl(file));
  }
}

const { buildMirroredTask, courseTaskId } = await loadTs("lib/firestore/courseTasks.ts");
const { sanitizeChecklist, weekDocId } = await loadTs("lib/firestore/courses.ts");
const { normalizeTask } = await loadTs("lib/firestore/tasks.ts");
const { addDaysToKey, currentWeekFor, londonWallClockToInstant } = await loadTs(
  "lib/courses/weekPlan.ts",
);

const NOW = new Date("2026-10-05T09:00:00Z");

/** The arguments the sync route passes, with only what a test cares about set. */
function args(overrides = {}) {
  return {
    runId: "run1",
    weekNumber: 3,
    uid: "learner1",
    title: "AI Safety Fundamentals — Week 3",
    description: "Read the two papers.",
    checklist: [],
    dueDate: null,
    now: NOW,
    ...overrides,
  };
}

/** Shorthand for the exact-instant assertions. */
const iso = (d) => d.toISOString();

// ---------------------------------------------------------------------------
// courseTaskId
// ---------------------------------------------------------------------------

test("courseTaskId is deterministic for the same (run, week, member)", () => {
  assert.equal(
    courseTaskId("run1", 3, "learner1"),
    courseTaskId("run1", 3, "learner1"),
  );
  // The whole idempotency story is "two racing mounts aim at one document".
  assert.equal(courseTaskId("run1", 3, "learner1"), "course-w03__run1__learner1");
});

test("courseTaskId separates member, week and run", () => {
  const ids = new Set([
    courseTaskId("run1", 3, "learner1"),
    courseTaskId("run1", 3, "learner2"), // different member
    courseTaskId("run1", 4, "learner1"), // different week
    courseTaskId("run2", 3, "learner1"), // different run
  ]);
  // A collision here is a member silently never receiving a week's card, since
  // the loser of a `.create()` race is counted as "already present".
  assert.equal(ids.size, 4);
});

test("courseTaskId embeds the same week id the week page resolves", () => {
  // The route addresses `weeks/{weekDocId(n)}` and builds the task id from the
  // same number; if these two ever disagree the mirror carries subtask ids from
  // a week the member is not looking at.
  for (const week of [1, 3, 9, 10, 42]) {
    assert.ok(
      courseTaskId("run1", week, "learner1").startsWith(`course-${weekDocId(week)}__`),
      `week ${week} id does not lead with ${weekDocId(week)}`,
    );
  }
  assert.equal(courseTaskId("run1", 9, "u").split("__")[0], "course-w09"); // zero-padded
});

test("courseTaskId keeps its three parts separable by construction", () => {
  // CONSTRUCT-ONLY, never parsed — but the separator still has to survive ids
  // that contain single underscores, or a future reader will parse it wrongly.
  assert.equal(
    courseTaskId("autumn_2026", 3, "uid_with_underscore"),
    "course-w03__autumn_2026__uid_with_underscore",
  );
});

// ---------------------------------------------------------------------------
// buildMirroredTask — the mirror contract
// ---------------------------------------------------------------------------

test("the mirror is a personal-lane task: sole completer, no reviewers", () => {
  const payload = buildMirroredTask(args());
  assert.equal(payload.creatorUid, "learner1");
  assert.deepEqual(payload.completerUids, ["learner1"]);
  assert.deepEqual(payload.reviewerUids, []);
  // `assignees-only` + creator === completer is what keeps a mirror off the
  // committee board and inside the rules' personal branches.
  assert.equal(payload.visibility, "assignees-only");
});

test("the mirror carries the hooks the rules and the route key off", () => {
  const payload = buildMirroredTask(args({ runId: "run7", weekNumber: 12 }));
  // firestore.rules keys the dismissal-delete branch and the archive scope off
  // this exact source string; the tasks UI keys the card off the kind.
  assert.equal(payload.source, "fellowship-reminder");
  assert.equal(payload.kind, "fellowship-weekly");
  assert.deepEqual(payload.sourceRef, { cohortId: "run7", weekNumber: 12 });
  assert.equal(payload.sourceTemplateId, null);
  assert.equal(payload.projectId, null);
});

test("the mirror is born already-notified, so no email is ever sent about it", () => {
  const payload = buildMirroredTask(args());
  // The course's own week nudge owns that moment; the task-email machinery
  // must find this task already stamped.
  assert.equal(payload.initialNotifyAt, NOW);
  assert.deepEqual(payload.pendingNotifyUids, []);
  assert.equal(payload.createdAt, NOW);
  assert.equal(payload.updatedAt, NOW);
});

test("the mirror starts open and un-archived, with empty block machinery", () => {
  const payload = buildMirroredTask(args());
  assert.equal(payload.status, "todo");
  assert.equal(payload.priority, "normal");
  assert.equal(payload.archived, false);
  assert.equal(payload.completedAt, null);
  assert.deepEqual(payload.blocks, []);
  assert.deepEqual(payload.blockConsents, {});
  assert.deepEqual(payload.tags, []);
  assert.equal(payload.attachmentCount, 0);
  assert.equal(payload.commentCount, 0);
});

test("buildMirroredTask never emits an `id` — the caller addresses the doc", () => {
  // `.create()` at `courseTaskId(...)` is the idempotency guarantee; an `id`
  // field in the payload would be a second, drifting copy of it.
  assert.equal("id" in buildMirroredTask(args()), false);
});

// ---------------------------------------------------------------------------
// buildMirroredTask — the checklist projection (mirrorable)
// ---------------------------------------------------------------------------

test("only `mirrorToMyWork` checklist items become subtasks", () => {
  const payload = buildMirroredTask(
    args({
      checklist: [
        { id: "c1", title: "Read the paper", mirrorToMyWork: true },
        { id: "c2", title: "Optional extra reading", mirrorToMyWork: false },
        { id: "c3", title: "Write your reflection", mirrorToMyWork: true },
      ],
    }),
  );
  assert.deepEqual(
    payload.subtasks.map((s) => s.id),
    ["c1", "c3"],
  );
  // Subtask ids REUSE the checklist ids so a re-created task lines up with the
  // same curriculum rows.
  assert.deepEqual(
    payload.subtasks.map((s) => s.title),
    ["Read the paper", "Write your reflection"],
  );
});

test("mirrorable drops blank-id and blank-title rows the author left behind", () => {
  // `sanitizeChecklist` is the REAL one: this is the input an author actually
  // produces by adding an empty row and ticking the mirror box.
  const checklist = sanitizeChecklist([
    { id: "c1", title: "Read the paper", mirrorToMyWork: true },
    { id: "", title: "Has no id", mirrorToMyWork: true },
    { id: "c3", title: "", mirrorToMyWork: true },
    { id: "c4", title: "   ", mirrorToMyWork: true },
    { id: "c5", title: "Write your reflection", mirrorToMyWork: true },
  ]);
  // The premise of the guard: sanitizeChecklist keeps all five.
  assert.equal(checklist.length, 5);

  const payload = buildMirroredTask(args({ checklist }));
  assert.deepEqual(
    payload.subtasks.map((s) => s.id),
    ["c1", "c5"],
  );
});

test("subtaskStats agrees with the rows normalizeTask reads back", () => {
  // THE round-trip assertion. `normalizeSubtask` drops falsy ids/titles, so
  // without `mirrorable` the payload's own stats would over-count and the
  // member's progress pill would read "0/5" over two visible rows, forever.
  const checklist = sanitizeChecklist([
    { id: "c1", title: "Read the paper", mirrorToMyWork: true },
    { id: "", title: "Has no id", mirrorToMyWork: true },
    { id: "c3", title: "", mirrorToMyWork: true },
    { id: "c4", title: "Not mirrored", mirrorToMyWork: false },
    { id: "c5", title: "Write your reflection", mirrorToMyWork: true },
  ]);
  const payload = buildMirroredTask(args({ checklist }));

  const readBack = normalizeTask("course-w03__run1__learner1", payload);
  assert.equal(payload.subtaskStats.total, payload.subtasks.length);
  assert.equal(payload.subtaskStats.total, readBack.subtasks.length);
  assert.equal(payload.subtaskStats.done, 0);
  assert.deepEqual(
    readBack.subtasks.map((s) => s.id),
    payload.subtasks.map((s) => s.id),
  );
});

test("an empty or fully-unmirrored checklist still yields a card, with no subtasks", () => {
  // The task IS the weekly nudge; the checklist is a bonus, not its reason to
  // exist. A `total: 0` here must stay 0 rather than becoming a falsy surprise.
  for (const checklist of [
    [],
    [{ id: "c1", title: "Optional extra reading", mirrorToMyWork: false }],
  ]) {
    const payload = buildMirroredTask(args({ checklist }));
    assert.deepEqual(payload.subtasks, []);
    assert.deepEqual(payload.subtaskStats, { done: 0, total: 0 });
    assert.equal(payload.title, "AI Safety Fundamentals — Week 3");
  }
});

test("every emitted subtask is assigned to the member and open, with no reviewers", () => {
  const payload = buildMirroredTask(
    args({
      checklist: [
        { id: "c1", title: "Read the paper", detail: "Both of them.", mirrorToMyWork: true },
        { id: "c2", title: "Write your reflection", mirrorToMyWork: true },
      ],
    }),
  );
  assert.equal(payload.subtasks.length, 2);
  for (const subtask of payload.subtasks) {
    assert.deepEqual(subtask.assigneeUids, ["learner1"]);
    assert.deepEqual(subtask.reviewerUids, []);
    assert.deepEqual(subtask.blockedBy, []);
    assert.deepEqual(subtask.approvedByReviewerUids, []);
    assert.deepEqual(subtask.questionedByReviewerUids, []);
    assert.deepEqual(subtask.rejectedByReviewerUids, []);
    assert.equal(subtask.done, false);
    assert.equal(subtask.doneAt, null);
    assert.equal(subtask.doneByUid, null);
    assert.equal(subtask.blockId, null);
    assert.equal(subtask.sealState, "open");
    assert.equal(subtask.sealedAt, null);
    assert.equal(subtask.roleHint, null);
    // Per-subtask dates would compete with the task's own slot-end due date.
    assert.equal(subtask.dueDate, null);
  }
  // `detail` becomes the subtask description; absent means empty, never
  // undefined (Firestore refuses undefined).
  assert.equal(payload.subtasks[0].description, "Both of them.");
  assert.equal(payload.subtasks[1].description, "");
});

test("buildMirroredTask is pure — it does not mutate the checklist it is given", () => {
  const checklist = [
    { id: "c1", title: "Read the paper", mirrorToMyWork: true },
    { id: "c2", title: "Optional extra reading", mirrorToMyWork: false },
  ];
  const before = JSON.parse(JSON.stringify(checklist));
  const payload = buildMirroredTask(args({ checklist }));
  payload.subtasks[0].title = "clobbered";
  assert.deepEqual(checklist, before);
});

// ---------------------------------------------------------------------------
// The due date — end of the cohort's slot, 23:59 Europe/London
// ---------------------------------------------------------------------------

/**
 * The route's formula, spelled once here. `sync-tasks/route.ts` keeps these as
 * module constants (`SLOT_LAST_DAY_OFFSET`, `DUE_WALL_CLOCK`) and the source
 * check below fails if either moves, which is what stops this from quietly
 * becoming a test of a formula nobody uses.
 */
const SLOT_LAST_DAY_OFFSET = 6;
const DUE_WALL_CLOCK = "23:59";

function slotEndFor(run, now) {
  const week = currentWeekFor(run, now);
  return londonWallClockToInstant(
    addDaysToKey(week.slotStartKey, SLOT_LAST_DAY_OFFSET),
    DUE_WALL_CLOCK,
  );
}

const PLAIN_RUN = {
  startDate: "2026-09-28",
  weekPlan: Array.from({ length: 8 }, (_, i) => ({
    kind: "week",
    weekNumber: i + 1,
    weekId: `w${String(i + 1).padStart(2, "0")}`,
  })),
};

test("the due date is 23:59 London on the last day of the cohort's current slot", () => {
  // Week 2 runs Mon 5 Oct – Sun 11 Oct 2026, still BST (UTC+1), so 23:59
  // London is 22:59Z on the Sunday.
  const due = slotEndFor(PLAIN_RUN, new Date("2026-10-05T09:00:00Z"));
  assert.equal(iso(due), "2026-10-11T22:59:00.000Z");

  // Week 5 runs Mon 26 Oct – Sun 1 Nov 2026, after the clocks go back, so
  // 23:59 London is 23:59Z. A naive fixed offset gets one of these two wrong.
  const gmtDue = slotEndFor(PLAIN_RUN, new Date("2026-10-26T09:00:00Z"));
  assert.equal(iso(gmtDue), "2026-11-01T23:59:00.000Z");
});

test("the due date is always in the future of the mount that mirrors the week", () => {
  // The reason the CURRENT slot is used rather than the anchor week's own slot:
  // a week mirrored late (or during a break that anchors back to it) must not
  // arrive already overdue.
  for (let day = 0; day < 56; day += 1) {
    const now = new Date(`${addDaysToKey("2026-09-28", day)}T12:00:00Z`);
    const week = currentWeekFor(PLAIN_RUN, now);
    if (week.phase !== "running") continue;
    assert.ok(
      slotEndFor(PLAIN_RUN, now).getTime() > now.getTime(),
      `due date was not in the future on day ${day}`,
    );
  }
});

test("a break slot still gets a deadline at the end of the BREAK", () => {
  const run = {
    startDate: "2026-09-28",
    weekPlan: [
      { kind: "week", weekNumber: 1, weekId: "w01" },
      { kind: "week", weekNumber: 2, weekId: "w02" },
      { kind: "break", label: "Reading week" },
    ],
  };
  // Slot 3 (Mon 12 Oct – Sun 18 Oct) is the break; the anchor holds at week 2
  // and the deadline is the break's end, not week 2's own Sunday.
  const now = new Date("2026-10-12T09:00:00Z");
  assert.equal(currentWeekFor(run, now).anchorWeekNumber, 2);
  assert.equal(iso(slotEndFor(run, now)), "2026-10-18T22:59:00.000Z");
});

test("buildMirroredTask passes the due instant through untouched", () => {
  // Timezone maths lives in weekPlan — the builder stays pure, and that is only
  // true while it does no arithmetic of its own.
  const due = slotEndFor(PLAIN_RUN, new Date("2026-10-05T09:00:00Z"));
  const payload = buildMirroredTask(args({ dueDate: due }));
  assert.equal(payload.dueDate, due);
  assert.equal(iso(payload.dueDate), "2026-10-11T22:59:00.000Z");
  // `null` is a legitimate due date (nothing above ever produces one today,
  // but the type allows it and Firestore must not receive `undefined`).
  assert.equal(buildMirroredTask(args({ dueDate: null })).dueDate, null);
});

test("the sync route still composes the due date from those two constants", () => {
  // A source check, deliberately: the constants are module-private and the
  // route is not importable from here (next/server, firebase-admin). Without
  // this, the four assertions above could keep passing against a formula the
  // route no longer uses.
  const source = readFileSync(
    join(SRC, "app", "api", "courses", "runs", "[runId]", "sync-tasks", "route.ts"),
    "utf8",
  );
  assert.match(source, /SLOT_LAST_DAY_OFFSET\s*=\s*6\b/);
  assert.match(source, /DUE_WALL_CLOCK\s*=\s*"23:59"/);
  assert.match(
    source,
    /londonWallClockToInstant\(\s*addDaysToKey\(\s*currentWeek\.slotStartKey,\s*SLOT_LAST_DAY_OFFSET,?\s*\),\s*DUE_WALL_CLOCK,?\s*\)/,
  );
});
