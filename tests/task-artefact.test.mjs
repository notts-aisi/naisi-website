/**
 * The task `artefact` pointer, and the worksheet source and kind that go with
 * it.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * `artefact` is how a task says WHAT IT IS ABOUT: a discriminated union with
 * one member today (`worksheet-response`) and two the owner has in mind next
 * (an event, a newsletter section). Three properties have to hold at once,
 * and each is a decision rather than an obvious consequence.
 *
 *  1. **An unknown `kind` normalises to null.** Every reader branches on
 *     `kind`, so a build that predates the next member of the union cannot
 *     render one, and "there is no artefact" is the only honest answer it can
 *     give. Carrying the raw map through would put a shape nothing can read
 *     in front of a reader that has already decided it is safe to open.
 *  2. **The field is written, not omitted.** `normalizeTask` fills it in for
 *     every task, but the CREATE write is a raw object literal that TypeScript
 *     never compares against `TaskDoc`, so nothing but a source pin can hold
 *     the two together. Same class of hole as
 *     `tests/admin-permissions-keys.test.mjs`: a whole-object write the type
 *     system does not check.
 *  3. **`worksheet` is a kind, and is not pickable.** It has a label so a
 *     board can show one, and it is deliberately absent from `TASK_KINDS`,
 *     which is what `TaskForm` builds its picker from. A hand-made task
 *     carrying the kind but no pointer would render a worksheet panel with
 *     nothing behind it. For the same reason it is not offered as a SOURCE on
 *     the committee board's filters: that board queries committee-visibility
 *     tasks and every worksheet task is assignees-only, so the option could
 *     only ever empty the board without saying why.
 *
 * The source and the kind prove nothing on their own, and that is pinned in
 * the module comment on `TaskSource` rather than here: the create rule
 * constrains neither, so an SU-committee member can mint a task that calls
 * itself a worksheet. What the respond page trusts is the pointer plus the
 * circulation's own response document, which only the worksheet routes write.
 *
 * ## Why the loader dance
 *
 * Same as tests/form-question-limits.test.mjs: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module is transpiled in
 * memory with the `typescript` devDependency `npx tsc --noEmit` already uses.
 * `tasks.ts` imports nothing at all, so the graph walk below has no work to
 * do on it today; it is kept in the shape the other suites use so that the
 * day the module grows an import, this file does not have to be rewritten.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const TASKS_MODULE = join(SRC, "lib", "firestore", "tasks.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** Specifiers replaced with a no-op module. */
const STUBS = new Map([["server-only", "export {};"]]);

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
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(file));
}

const { TASK_KINDS, TASK_KIND_LABELS, TASK_SOURCE_LABELS, normalizeTask } =
  await loadTs(TASKS_MODULE);

const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const MUTATIONS = read("src/features/tasks/taskMutations.ts");
const TASK_FORM = read("src/features/tasks/components/TaskForm.tsx");
const TASK_FILTERS = read("src/features/tasks/components/TaskFilters.tsx");
const COMMITTEE_BOARD = read("src/app/(app)/committee/tasks/page.tsx");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CIRCULATION_ID = "committee-onboarding__aa11bb22";

/** A stored worksheet task, as the circulation route writes one. */
function worksheetTask(overrides = {}) {
  return {
    title: "Committee onboarding worksheet",
    description: "",
    source: "worksheet",
    kind: "worksheet",
    completerUids: ["member1"],
    reviewerUids: ["sender1"],
    status: "todo",
    visibility: "assignees-only",
    subtasks: [],
    blocks: [],
    sourceRef: null,
    artefact: { kind: "worksheet-response", circulationId: CIRCULATION_ID },
    ...overrides,
  };
}

/** A stored subtask, the minimum `normalizeSubtask` accepts. */
function subtask(overrides = {}) {
  return { id: "s1", title: "Answer the questions", ...overrides };
}

// ---------------------------------------------------------------------------
// §1 The worksheet source and kind
// ---------------------------------------------------------------------------

describe("the worksheet source and kind", () => {
  test("both carry a board-facing label", () => {
    // A card whose source or kind has no label renders a bare enum string at
    // somebody, which is the one outcome worse than no badge at all.
    assert.equal(TASK_SOURCE_LABELS.worksheet, "Worksheet");
    assert.equal(TASK_KIND_LABELS.worksheet, "Worksheet");
  });

  test("worksheet is labelled but not pickable in the task form", () => {
    // The kind is minted by the circulation route alongside an `artefact`
    // that points at the response the task is about. A human picking the same
    // kind by hand would get the panel and none of the document behind it, so
    // the kind is deliberately absent from the list the picker is built from.
    assert.ok(
      !TASK_KINDS.includes("worksheet"),
      "worksheet is now pickable in TaskForm, so a hand-made task can claim " +
        "to be a worksheet with nothing behind it",
    );
    assert.match(
      TASK_FORM,
      /TASK_KINDS\.map/,
      "TaskForm no longer builds its kind picker from TASK_KINDS, so keeping " +
        "a kind out of that list no longer keeps it off the form",
    );
  });

  test("worksheet is not offered as a source on the committee board's filters", () => {
    // The one page that mounts TaskFilters is the committee board, and it
    // loads `useTasks({ visibility: "committee" })`. Every worksheet task is
    // `assignees-only` (docs/worksheets.md), so a "Worksheet" option there
    // could only ever empty every column, with nothing to tell the reader
    // apart from a board that genuinely has nothing on it. That is the
    // silent-empty-panel shape this repo has shipped before, so the absence
    // is pinned rather than left to the next person's judgement.
    //
    // BOTH halves are asserted, because the finding is a pair: the option
    // must be absent WHILE the only board that renders it is the
    // committee-visibility one. A board that can show assignees-only tasks
    // may add the option, and should fail this test on the way in so the
    // decision is made deliberately.
    assert.ok(
      !/\{\s*value:\s*"worksheet"/.test(TASK_FILTERS),
      "TaskFilters offers a Worksheet source option. The only page that " +
        "mounts it queries committee-visibility tasks, and every worksheet " +
        "task is assignees-only, so the option empties the board with no " +
        "explanation.",
    );
    assert.match(
      COMMITTEE_BOARD,
      /useTasks\(\{\s*visibility:\s*"committee"/,
      "the committee board no longer filters on committee visibility, so the " +
        "reason the Worksheet source option is withheld may no longer hold. " +
        "Re-decide it rather than deleting this test.",
    );
  });
});

// ---------------------------------------------------------------------------
// §2 normalizeTask reads the pointer defensively
// ---------------------------------------------------------------------------

describe("normalizeTask and the artefact pointer", () => {
  test("keeps a well-formed worksheet-response pointer", () => {
    const task = normalizeTask("task1", worksheetTask());
    assert.deepEqual(task.artefact, {
      kind: "worksheet-response",
      circulationId: CIRCULATION_ID,
    });
    assert.equal(task.source, "worksheet");
    assert.equal(task.kind, "worksheet");
    assert.equal(task.visibility, "assignees-only");
  });

  test("a task with no artefact field reads as null, not undefined", () => {
    // Every task stored before the field existed is in this shape, and the
    // readers branch on `task.artefact` being null rather than on the key
    // being present.
    const stored = worksheetTask();
    delete stored.artefact;
    assert.equal(normalizeTask("task1", stored).artefact, null);
  });

  test("an artefact kind this build does not know reads as null", () => {
    // The rolled-back-deploy case: a newer build mints `{ kind: "event", … }`
    // and an older one reads it. Carrying the map through would hand a shape
    // nothing can render to a reader that has already decided it is safe to
    // open.
    const task = normalizeTask(
      "task1",
      worksheetTask({ artefact: { kind: "event", eventId: "socials-week-3" } }),
    );
    assert.equal(task.artefact, null);
  });

  test("a pointer with no usable circulationId reads as null", () => {
    // A pointer to nothing is not a pointer. Both the missing and the empty
    // case, because a half-written document is the likelier of the two.
    for (const artefact of [
      { kind: "worksheet-response" },
      { kind: "worksheet-response", circulationId: "" },
      { kind: "worksheet-response", circulationId: 7 },
    ]) {
      assert.equal(
        normalizeTask("task1", worksheetTask({ artefact })).artefact,
        null,
        `${JSON.stringify(artefact)} should not survive normalisation`,
      );
    }
  });

  test("a non-object artefact reads as null", () => {
    for (const artefact of ["worksheet-response", 3, true, null, []]) {
      assert.equal(
        normalizeTask("task1", worksheetTask({ artefact })).artefact,
        null,
        `${JSON.stringify(artefact)} should not survive normalisation`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §3 The subtask field is reserved, and reserved carefully
// ---------------------------------------------------------------------------

describe("a subtask's reserved artefact", () => {
  test("carries a valid pointer through", () => {
    const task = normalizeTask(
      "task1",
      worksheetTask({
        subtasks: [
          subtask({
            artefact: { kind: "worksheet-response", circulationId: CIRCULATION_ID },
          }),
        ],
      }),
    );
    assert.deepEqual(task.subtasks[0].artefact, {
      kind: "worksheet-response",
      circulationId: CIRCULATION_ID,
    });
  });

  test("leaves the key ABSENT when there is nothing valid to carry", () => {
    // Absent rather than null, and absent rather than undefined: the field is
    // optional on `Subtask`, every writer funnels through `serializeSubtask`,
    // and Firestore refuses undefined outright. A subtask normalised with the
    // key set to undefined would be written as undefined by the next edit to
    // any other subtask in the same task.
    const task = normalizeTask(
      "task1",
      worksheetTask({
        subtasks: [subtask(), subtask({ id: "s2", artefact: { kind: "event" } })],
      }),
    );
    for (const s of task.subtasks) {
      assert.ok(
        !("artefact" in s),
        `subtask ${s.id} carries an artefact key it should not have`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §4 The create write, which no type checks
// ---------------------------------------------------------------------------

describe("createTask", () => {
  test("writes artefact beside sourceRef, so no task is stored without it", () => {
    // `setDoc` takes an untyped object literal, so `TaskDoc` gaining a
    // required field does NOT make a missing key a compile error here. The
    // update rules pin these fields by equality, and a field a document does
    // not carry is a field the first update has to invent, so the write has
    // to spell it out. This is a source pin for the same reason
    // tests/admin-permissions-keys.test.mjs is one.
    assert.match(
      MUTATIONS,
      /sourceRef: null,[\s\S]{0,800}?artefact: null,/,
      "createTask no longer writes `artefact: null` next to `sourceRef: " +
        "null`, so client-made tasks are stored without the field",
    );
  });

  test("serializeSubtask spreads the reserved pointer rather than assigning it", () => {
    // `artefact: s.artefact` would put an undefined into every serialised
    // subtask, and Firestore refuses undefined outright: the whole write
    // fails, not just the field.
    assert.match(
      MUTATIONS,
      /\.\.\.\(s\.artefact \? \{ artefact: s\.artefact \} : \{\}\),/,
      "serializeSubtask no longer spreads `artefact` conditionally, so an " +
        "unset pointer is written as undefined and the write is refused",
    );
  });
});
