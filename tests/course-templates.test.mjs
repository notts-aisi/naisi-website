/**
 * Unit tests for V2-2 — CURRICULUM SNAPSHOTS + THE RETROSPECTIVE LOOP.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Three properties in this feature are load-bearing, expensive to discover
 * broken, and invisible to the type checker:
 *
 *  1. **ID PRESERVATION — the platform invariant.** A snapshot copies week doc
 *     ids and every `material.id` / `exercise.id` / `checklist.id` inside them,
 *     and so does applying one back into a run. Member progress is keyed on
 *     those ids (`courseProgress/{runId}__{uid}__{itemId}`), so a copy that
 *     re-minted one would orphan every check-off the next time that material
 *     was taught — silently, a year later, with no error anywhere. `tsc` sees
 *     two `string`s and is happy. §1 is the executable version of that
 *     paragraph.
 *  2. **THE ANONYMITY FLOOR.** Members rate materials believing nobody reads
 *     their score as theirs, and the audience for the retrospective is exactly
 *     the facilitators who could put a name to a number in a group of eight.
 *     `avgRating` is withheld below three ratings, and no row carries a uid.
 *     §4 asserts both, including the exact key set of a row — so a future
 *     field that leaks an identity fails a test rather than a review.
 *  3. **NEVER ORPHAN MEMBER WORK.** `apply-template`'s `replace` is refused the
 *     moment any progress or exercise-response row exists for the run. §7 pins
 *     that gate at the source.
 *
 * ## Three kinds of test, labelled (the course-deletion.test.mjs idiom)
 *
 * **GUARD** — a property the shipped code holds. Break it, this goes red.
 *
 * **MODEL** — the rule restated here and PINNED to the source, for code that
 * cannot be imported (`next/server`, `firebase-admin`) or that lives in
 * `firestore.rules`. If a pin fails the model has drifted from the code; do
 * not "fix" it by loosening the pin.
 *
 * **PROVEN GAP** — a disagreement that needs a decision, not a patch. Asserted
 * as STILL OPEN so it fails the day it is closed. When you close one, invert
 * the assertion in the same commit. §8 has one.
 *
 * ## The loader dance
 *
 * Lifted from `course-nudge.test.mjs` / `course-deletion.test.mjs`, which
 * already solved importing TypeScript from `.mjs` on this repo's Node (v20, no
 * native type stripping) including `@/…` aliases. Nothing under test here
 * imports `server-only`, `firebase-admin` or a mail transport — the two data
 * modules are deliberately isomorphic so the admin client and these tests can
 * both load them — but the stub map is kept for anything they may grow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** See `course-nudge.test.mjs` — nothing here is reachable from an assertion. */
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

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed — run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code, not a model.
// ---------------------------------------------------------------------------

const {
  RETRO_ANONYMITY_FLOOR,
  RETRO_PROGRESS_LIMIT,
  TEMPLATE_LIMITS,
  aggregateRetrospective,
  courseTemplateId,
  normalizeCourseTemplate,
  summarizeRetrospective,
  templateRowOrder,
  templateWeekFields,
  toTemplateRow,
} = await loadTs("lib/firestore/courseTemplates.ts");

const {
  MATERIAL_NOTE_LIMITS,
  buildMaterialNoteWrite,
  courseMaterialNoteId,
  normalizeCourseMaterialNote,
} = await loadTs("lib/firestore/courseMaterialNotes.ts");

const { normalizeCourseRun, normalizeCourseWeek } = await loadTs(
  "lib/firestore/courses.ts",
);

// ---------------------------------------------------------------------------
// Source handles for what cannot be imported.
// ---------------------------------------------------------------------------

const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");
const api = (...parts) => src("app", "api", "courses", ...parts);

const TEMPLATES_ROUTE = api("[courseId]", "templates", "route.ts");
const TEMPLATE_DELETE_ROUTE = api("templates", "[templateId]", "route.ts");
const APPLY_ROUTE = api("runs", "[runId]", "apply-template", "route.ts");
const RETRO_ROUTE = api("runs", "[runId]", "retrospective", "route.ts");
const NOTES_ROUTE = api("runs", "[runId]", "material-notes", "route.ts");
const TEMPLATES_MODULE = src("lib", "firestore", "courseTemplates.ts");
/** The client half — a `"use client"` hook module, so read, never imported. */
const TEMPLATES_HOOK = src("features", "courses", "useTemplates.ts");
const RUN_EDITOR = src("features", "courses", "RunEditor.tsx");
const RETRO_VIEW = src("features", "courses", "RetrospectiveView.tsx");
const CLONE_WEEKS_ROUTE = api("runs", "[runId]", "clone-weeks", "route.ts");
const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

/**
 * Source with its comments removed.
 *
 * Every "this string must NOT appear" assertion runs against this. These
 * routes explain their own boundaries in prose — the retrospective's module
 * comment names `publicComment` in the sentence forbidding it — so a naive
 * scan of the raw file finds the paragraph and calls it a leak. The `[^:]`
 * guard on the line-comment pass keeps `https://` intact.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TEMPLATES_CODE = code(TEMPLATES_ROUTE);
const TEMPLATE_DELETE_CODE = code(TEMPLATE_DELETE_ROUTE);
const APPLY_CODE = code(APPLY_ROUTE);
const RETRO_CODE = code(RETRO_ROUTE);
const NOTES_CODE = code(NOTES_ROUTE);
const TEMPLATES_MODULE_CODE = code(TEMPLATES_MODULE);

/** Every `route.ts` under `src/app/api` — for the collection-reach sweeps. */
function allApiRoutes(dir = join(SRC, "app", "api"), out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allApiRoutes(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A week as the editor stores it, carrying one material of every kind plus an
 * exercise and a checklist item — so §1 proves ids survive across ALL the
 * shapes `normalizeCourseWeek` treats differently, not just the easy one.
 */
function rawWeek(overrides = {}) {
  return {
    weekNumber: 3,
    title: "Goal misgeneralisation",
    summary: "Read the paper, then answer the prompt.",
    guideBlocks: [],
    materials: [
      { id: "m_read_1", type: "reading", title: "Ngo et al.", url: "https://example.com/p" },
      {
        id: "m_video_1",
        type: "video",
        title: "Lecture",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        estimatedMinutes: 25,
      },
      { id: "m_link_1", type: "link", title: "Blog", url: "https://example.com/b" },
      { id: "m_note_1", type: "note", title: "Aside", body: "Skim section 2." },
    ],
    exercises: [
      {
        id: "x_prompt_1",
        prompt: "Where does the model's goal come apart from ours?",
        responseType: "text",
        required: true,
        maxLength: 2000,
        peerVisible: false,
      },
    ],
    checklist: [{ id: "c_todo_1", title: "Post in the channel", mirrorToMyWork: true }],
    estimatedMinutes: 90,
    published: true,
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    updatedByUid: "drafter",
    ...overrides,
  };
}

/** Every id in a week, in one flat sorted list — the thing that must not move. */
function idsOf(week) {
  return [
    week.id,
    ...week.materials.map((m) => m.id),
    ...week.exercises.map((x) => x.id),
    ...week.checklist.map((c) => c.id),
  ].sort();
}

function progressRow(itemId, { rating = null, completed = false } = {}) {
  return { itemId, rating, completed };
}

function noteDoc(itemId, byName, note, at) {
  return normalizeCourseMaterialNote(`run1__${itemId}__u`, {
    runId: "run1",
    itemId,
    weekNumber: 3,
    uid: "u",
    byName,
    note,
    at,
  });
}

// ===========================================================================
// §1 — ID PRESERVATION. The platform invariant.
// ===========================================================================

test("GUARD §1.1 templateWeekFields preserves every material, exercise and checklist id", () => {
  const week = normalizeCourseWeek("w03", rawWeek());
  const copied = normalizeCourseWeek("w03", templateWeekFields(week));

  assert.deepEqual(idsOf(copied), idsOf(week));
  // Named explicitly so a failure says WHICH id class moved.
  assert.deepEqual(
    copied.materials.map((m) => m.id),
    ["m_read_1", "m_video_1", "m_link_1", "m_note_1"],
  );
  assert.deepEqual(copied.exercises.map((x) => x.id), ["x_prompt_1"]);
  assert.deepEqual(copied.checklist.map((c) => c.id), ["c_todo_1"]);
});

test("GUARD §1.2 the copy is a fixpoint — run -> template -> run is byte-identical", () => {
  // Snapshot, then apply back: the two directions share `templateWeekFields`,
  // so a second trip must add and remove nothing. A copy that drifted would
  // mean a template applied twice produced two different curricula.
  const once = templateWeekFields(normalizeCourseWeek("w03", rawWeek()));
  const twice = templateWeekFields(normalizeCourseWeek("w03", once));
  assert.deepEqual(twice, once);
});

test("GUARD §1.3 templateWeekFields carries content but not the audit stamp", () => {
  const fields = templateWeekFields(normalizeCourseWeek("w03", rawWeek()));
  // The doc id is the CALLER's to place (from `snap.id`), and the stamp
  // belongs to whoever is writing — see the function's doc comment.
  assert.equal("id" in fields, false);
  assert.equal("updatedAt" in fields, false);
  assert.equal("updatedByUid" in fields, false);
  assert.deepEqual(Object.keys(fields).sort(), [
    "checklist",
    "estimatedMinutes",
    "exercises",
    "guideBlocks",
    "materials",
    "published",
    "summary",
    "title",
    "weekNumber",
  ]);
});

test("MODEL §1.4 neither copy route mints an id or re-derives a week doc id", () => {
  for (const [name, source] of [
    ["templates POST", TEMPLATES_CODE],
    ["apply-template", APPLY_CODE],
  ]) {
    // `weekDocId(n)` would rebuild the id from the week NUMBER — which is
    // exactly the bug: the same `w03` is week 3 in one plan and something
    // else in another, so a re-derived id can silently rename a week and
    // detach its progress rows.
    assert.equal(
      /\bweekDocId\s*\(/.test(source),
      false,
      `${name} must take the week doc id from the source snapshot, never rebuild it`,
    );
    assert.equal(
      /newMaterialId|newExerciseId|newChecklistItemId/.test(source),
      false,
      `${name} must not generate item ids`,
    );
    assert.match(
      source,
      /templateWeekFields\(/,
      `${name} must copy through the shared id-preserving helper`,
    );
  }
  // The snapshot route names its week docs from the source doc; the apply
  // route from the snapshot's. Both read `.doc(<something>.id)`.
  assert.match(TEMPLATES_CODE, /collection\("weeks"\)\.doc\(week\.id\)/);
  assert.match(APPLY_CODE, /targetWeeks\.doc\(docSnap\.id\)/);
});

test("GUARD §1.5 the data module mints exactly one id, and it names the snapshot", () => {
  const minted = [...TEMPLATES_MODULE_CODE.matchAll(/slugId\(/g)];
  assert.equal(minted.length, 1, "only courseTemplateId may mint");
  assert.match(
    TEMPLATES_MODULE_CODE,
    /export function courseTemplateId[\s\S]{0,200}slugId\(/,
  );
  assert.equal(/Math\.random/.test(TEMPLATES_MODULE_CODE), false);
});

// ===========================================================================
// §2 — APPEND-ONLY. Snapshots are never overwritten and never edited.
// ===========================================================================

test("GUARD §2.1 saving twice under one label mints two ids", () => {
  const a = courseTemplateId("AI Safety Fundamentals", "Autumn 2026 final");
  const b = courseTemplateId("AI Safety Fundamentals", "Autumn 2026 final");
  assert.notEqual(a, b, "a re-save must never clobber the snapshot it came from");
  for (const id of [a, b]) {
    assert.match(id, /^ai-safety-fundamentals-autumn-2026-final__[a-z0-9]{8}$/);
  }
});

test("MODEL §2.2 only four routes touch courseTemplates, and none updates a week", () => {
  // The COLLECTION, not the module: the retrospective route imports the
  // aggregation from `courseTemplates.ts` and must not be counted as reaching
  // the collection.
  const touching = allApiRoutes()
    .filter((f) =>
      /\.collection\((COURSE_TEMPLATES_COLLECTION|"courseTemplates")\)/.test(
        code(readFileSync(f, "utf8")),
      ),
    )
    .map((f) => f.slice(SRC.length + 1))
    .sort();
  assert.deepEqual(touching, [
    // V3 W1 PR7: READ ONLY. The public page's theme generator reads a
    // snapshot's weeks to write copy onto `coursePages`; it never writes back,
    // which the assertion below pins.
    join("app", "api", "courses", "[courseId]", "page", "generate-themes", "route.ts"),
    join("app", "api", "courses", "[courseId]", "templates", "route.ts"),
    join("app", "api", "courses", "runs", "[runId]", "apply-template", "route.ts"),
    join("app", "api", "courses", "templates", "[templateId]", "route.ts"),
  ]);

  // The theme generator's only writes are to `coursePages`. A `.set` / `.update`
  // / `.delete` reached from its template ref would mean the page editor could
  // mutate a frozen snapshot, which is the property this whole file defends.
  const GENERATE_CODE = code(
    readFileSync(
      join(SRC, "app", "api", "courses", "[courseId]", "page", "generate-themes", "route.ts"),
      "utf8",
    ),
  );
  assert.equal(
    /templateRef[\s\S]{0,160}\.(set|create|update|delete)\(/.test(GENERATE_CODE),
    false,
  );

  // The snapshot route writes weeks with `create` (a collision is a bug, not
  // an overwrite) and the delete route only deletes them. Nowhere is there an
  // update path — that is what "frozen" means.
  assert.match(TEMPLATES_CODE, /\.create\(write\.ref, write\.data\)/);
  assert.equal(/\.update\(/.test(TEMPLATES_CODE), false);
  assert.equal(/\.set\(/.test(TEMPLATE_DELETE_CODE), false);
  // apply-template reads template weeks and writes RUN weeks — never back.
  assert.equal(
    /templateRef\.collection\("weeks"\)[\s\S]{0,120}\.(set|create|update|delete)\(/.test(
      APPLY_CODE,
    ),
    false,
  );
});

test("MODEL §2.3 firestore.rules denies every client write to templates and their weeks", () => {
  const block = RULES.slice(
    RULES.indexOf("match /courseTemplates/{templateId}"),
    RULES.indexOf("// === courseMaterialNotes ==="),
  );
  assert.ok(block.length > 0, "the courseTemplates block must exist");
  // Two `allow write: if false` — the doc and the weeks subcollection.
  assert.equal((block.match(/allow write: if false;/g) ?? []).length, 2);
  assert.match(block, /match \/weeks\/\{weekId\}/);
  // Read tier, both levels.
  assert.equal(
    (block.match(/allow read: if isAdmin\(\) \|\| canDraftCourse\(\) \|\| canApproveCourse\(\)/g) ?? [])
      .length,
    2,
  );
});

test("MODEL §2.4 firestore.rules locks courseMaterialNotes to route writes", () => {
  const block = RULES.slice(
    RULES.indexOf("match /courseMaterialNotes/{noteId}"),
    RULES.indexOf("// === courseDeletions ==="),
  );
  assert.ok(block.length > 0);
  assert.match(block, /allow write: if false;/);
  assert.match(block, /isNotedRunTrackLead\(\)/);
  // Members are excluded outright — no own-row branch anywhere in the block.
  assert.equal(/resource\.data\.uid == request\.auth\.uid/.test(block), false);
});

// ===========================================================================
// §3 — The snapshot document
// ===========================================================================

test("GUARD §3.1 normalizeCourseTemplate defaults a partial row safely", () => {
  const doc = normalizeCourseTemplate("t1", {});
  assert.deepEqual(doc, {
    id: "t1",
    courseId: "",
    courseTitle: "",
    label: "",
    sourceRunId: "",
    sourceGroupId: null,
    savedAt: null,
    savedByUid: "",
    savedByName: "",
    weekCount: 0,
    retrospective: null,
  });

  // Absent and empty-string both mean "run canonical" (see the field comment).
  assert.equal(normalizeCourseTemplate("t", { sourceGroupId: "" }).sourceGroupId, null);
  assert.equal(normalizeCourseTemplate("t", { sourceGroupId: "g1" }).sourceGroupId, "g1");
  // Counts are floored non-negative; the label is capped on the way out too.
  assert.equal(normalizeCourseTemplate("t", { weekCount: -4 }).weekCount, 0);
  assert.equal(normalizeCourseTemplate("t", { weekCount: 8.7 }).weekCount, 8);
  assert.equal(
    normalizeCourseTemplate("t", { label: "x".repeat(500) }).label.length,
    TEMPLATE_LIMITS.label,
  );
  // A garbled retrospective degrades to zeroes, never to NaN on a card.
  assert.deepEqual(normalizeCourseTemplate("t", { retrospective: [] }).retrospective, null);
  assert.deepEqual(
    normalizeCourseTemplate("t", { retrospective: { memberCount: "eight" } }).retrospective,
    { runLabel: "", memberCount: 0, ratedMaterialCount: 0 },
  );
});

test("GUARD §3.2 toTemplateRow is ISO on the wire and templateRowOrder is newest-first", () => {
  const row = toTemplateRow(
    normalizeCourseTemplate("t1", { savedAt: new Date("2026-08-01T10:00:00Z") }),
  );
  assert.equal(row.savedAt, "2026-08-01T10:00:00.000Z");
  // No field is dropped — nothing in a snapshot is PII.
  assert.deepEqual(Object.keys(row).sort(), [
    "courseId",
    "courseTitle",
    "id",
    "label",
    "retrospective",
    "savedAt",
    "savedByName",
    "savedByUid",
    "sourceGroupId",
    "sourceRunId",
    "weekCount",
  ]);

  const rows = [
    { label: "old", savedAt: "2025-01-01T00:00:00.000Z" },
    { label: "undated", savedAt: null },
    { label: "new", savedAt: "2026-01-01T00:00:00.000Z" },
  ].sort(templateRowOrder);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["new", "old", "undated"],
    "undated rows sort LAST — a legacy row is not the freshest thing to reach for",
  );
});

// ===========================================================================
// §4 — THE RETROSPECTIVE. The anonymity boundary, in code.
// ===========================================================================

const RETRO_WEEKS = [
  normalizeCourseWeek("w01", rawWeek({ weekNumber: 1 })),
  normalizeCourseWeek(
    "w02",
    rawWeek({
      weekNumber: 2,
      materials: [
        { id: "m_w2_a", type: "link", title: "Second week reading", url: "https://e.com/a" },
      ],
      exercises: [],
      checklist: [],
    }),
  ),
];

test("GUARD §4.1 avgRating is WITHHELD below the anonymity floor, the count never is", () => {
  assert.equal(RETRO_ANONYMITY_FLOOR, 3);
  for (const n of [1, 2]) {
    const [row] = aggregateRetrospective({
      weeks: [RETRO_WEEKS[1]],
      progress: Array.from({ length: n }, () => progressRow("m_w2_a", { rating: 1 })),
      notes: [],
      enrolledCount: 6,
    });
    assert.equal(
      row.avgRating,
      null,
      `${n} rating(s) must not yield an average — it is invertible in a small group`,
    );
    assert.equal(row.ratingCount, n, "the count is the honest reason the average is missing");
  }

  const [three] = aggregateRetrospective({
    weeks: [RETRO_WEEKS[1]],
    progress: [
      progressRow("m_w2_a", { rating: 5 }),
      progressRow("m_w2_a", { rating: 4 }),
      progressRow("m_w2_a", { rating: 4 }),
    ],
    notes: [],
    enrolledCount: 6,
  });
  assert.equal(three.ratingCount, 3);
  assert.equal(three.avgRating, 4.33, "two decimals, released only at the floor");
});

test("GUARD §4.2 no row can carry a member identity", () => {
  const [row] = aggregateRetrospective({
    weeks: [RETRO_WEEKS[1]],
    progress: [progressRow("m_w2_a", { rating: 5, completed: true })],
    notes: [noteDoc("m_w2_a", "Ada", "Landed well", new Date("2026-03-01T00:00:00Z"))],
    enrolledCount: 6,
  });
  // The exact key set. A future column that leaks an identity fails HERE,
  // rather than in a review that might not happen.
  assert.deepEqual(Object.keys(row).sort(), [
    "avgRating",
    "completedCount",
    "enrolledCount",
    "facilitatorNotes",
    "itemId",
    "ratingCount",
    "title",
    "weekNumber",
  ]);
  assert.deepEqual(Object.keys(row.facilitatorNotes[0]).sort(), ["at", "byName", "note"]);
  assert.equal(JSON.stringify(row).includes("uid"), false);
});

test("GUARD §4.3 rows come from the CURRENT week definitions, not from the rows", () => {
  const rows = aggregateRetrospective({
    weeks: RETRO_WEEKS,
    progress: [
      // An orphan: the material was deleted from the curriculum, the progress
      // row survived. Decision 6 tolerates orphans; it must not resurrect one.
      progressRow("m_deleted_last_year", { rating: 5, completed: true }),
      // A checklist item's row. Same collection, different kind — checklist is
      // the member's own to-do projection, not curriculum under review.
      progressRow("c_todo_1", { completed: true }),
      progressRow("m_read_1", { completed: true }),
    ],
    notes: [noteDoc("m_deleted_last_year", "Ada", "orphan note", new Date())],
    enrolledCount: 10,
  });

  const ids = rows.map((r) => r.itemId);
  assert.equal(ids.includes("m_deleted_last_year"), false, "orphan progress is ignored");
  assert.equal(ids.includes("c_todo_1"), false, "checklist items are not materials");
  assert.equal(
    rows.every((r) => r.facilitatorNotes.every((n) => n.note !== "orphan note")),
    true,
    "a note on a deleted material has nowhere to render, and is dropped",
  );

  // Every material of every week appears — including untouched ones, whose
  // zeroes are themselves the finding.
  assert.deepEqual(ids, [
    "m_read_1",
    "m_video_1",
    "m_link_1",
    "m_note_1",
    "m_w2_a",
  ]);
  const untouched = rows.find((r) => r.itemId === "m_note_1");
  assert.deepEqual(
    { ...untouched, facilitatorNotes: untouched.facilitatorNotes.length },
    {
      itemId: "m_note_1",
      weekNumber: 1,
      title: "Aside",
      avgRating: null,
      ratingCount: 0,
      completedCount: 0,
      enrolledCount: 10,
      facilitatorNotes: 0,
    },
  );
});

test("GUARD §4.4 counts, ordering and note threading", () => {
  const rows = aggregateRetrospective({
    weeks: RETRO_WEEKS,
    progress: [
      progressRow("m_read_1", { completed: true, rating: 5 }),
      progressRow("m_read_1", { completed: true }),
      progressRow("m_read_1", { completed: false, rating: 2 }),
      // A rating outside 1..5 is not a rating (a corrupt row, a bad migration).
      progressRow("m_read_1", { rating: 9 }),
      progressRow("m_read_1", { rating: 0 }),
    ],
    notes: [
      noteDoc("m_read_1", "Bea", "second", new Date("2026-03-02T00:00:00Z")),
      noteDoc("m_read_1", "Ada", "first", new Date("2026-03-01T00:00:00Z")),
      noteDoc("m_read_1", "", "", new Date("2026-03-03T00:00:00Z")),
    ],
    enrolledCount: 12,
  });

  const row = rows[0];
  assert.equal(row.itemId, "m_read_1");
  assert.equal(row.completedCount, 2);
  assert.equal(row.ratingCount, 2, "out-of-range values are discarded, not clamped");
  assert.equal(row.avgRating, null, "…which leaves it below the floor");
  assert.equal(row.enrolledCount, 12);
  assert.deepEqual(
    row.facilitatorNotes.map((n) => n.note),
    ["first", "second"],
    "oldest first — a material's notes read as a thread across terms",
  );
  assert.equal(row.facilitatorNotes.length, 2, "an empty note is not a note");

  // Curriculum order: week number, then the authored order inside the week.
  assert.deepEqual(
    rows.map((r) => r.weekNumber),
    [1, 1, 1, 1, 2],
  );
});

test("GUARD §4.5 summarizeRetrospective attests a cohort, or says nothing", () => {
  const rows = aggregateRetrospective({
    weeks: RETRO_WEEKS,
    progress: [progressRow("m_read_1", { rating: 4 })],
    notes: [],
    enrolledCount: 9,
  });
  assert.deepEqual(summarizeRetrospective(rows, "Autumn 2026", 9), {
    runLabel: "Autumn 2026",
    memberCount: 9,
    ratedMaterialCount: 1,
  });

  // A snapshot of a curriculum that was never delivered carries no evidence,
  // and a row of zeroes reads as evidence of failure rather than absence.
  const empty = aggregateRetrospective({
    weeks: RETRO_WEEKS,
    progress: [],
    notes: [],
    enrolledCount: 0,
  });
  assert.equal(summarizeRetrospective(empty, "Draft run", 0), null);
});

test("MODEL §4.6 the retrospective read is one query per collection, field-masked", () => {
  // ONE progress query for the whole run, grouped in memory — not one per
  // material (12 weeks x 10 items = 120 round trips per page view).
  assert.equal((RETRO_CODE.match(/collection\("courseProgress"\)/g) ?? []).length, 1);
  // The projection IS the anonymity boundary: `publicComment`, `privateNote`,
  // `uid` and the moderation stamps all live on a progress row.
  assert.match(RETRO_CODE, /\.select\("itemId", "rating", "completed"\)/);
  for (const leak of ["publicComment", "privateNote", "moderatedByUid"]) {
    assert.equal(RETRO_CODE.includes(leak), false, `${leak} must not reach this route`);
  }
  // The rater's uid is the sharpest one, and it cannot be scanned for by name
  // (`actor.uid` and `trackLeadUids` are legitimate). It is covered instead by
  // §4.2's exact-key-set assertion on the row the route returns.
  // Capped, and honest about it rather than averaging a prefix.
  assert.match(RETRO_CODE, /\.limit\(RETRO_PROGRESS_LIMIT\)/);
  assert.match(RETRO_CODE, /truncated: progressSnap\.size >= RETRO_PROGRESS_LIMIT/);
  assert.equal(RETRO_PROGRESS_LIMIT, 5000);
  // The denominator is an aggregation, never a fetch of the enrolment rows.
  assert.match(RETRO_CODE, /courseEnrolments[\s\S]{0,200}\.count\(\)/);
});

test("MODEL §4.7 the retrospective refuses before it 404s", () => {
  // A caller with no standing gets the SAME 403 whether the run is missing or
  // simply isn't theirs; the 404 is reachable only once authority is settled.
  const forbidden = RETRO_CODE.indexOf('{ error: "Forbidden" }');
  const notFound = RETRO_CODE.indexOf('{ error: "Run not found" }');
  assert.ok(forbidden > 0 && notFound > forbidden);
  assert.match(RETRO_CODE, /if \(!isLead\) return NextResponse\.json\(\{ error: "Forbidden" \}/);
  assert.match(
    RETRO_CODE,
    /actor\.permissions\.approveCourse[\s\S]{0,80}actor\.permissions\.draftCourse/,
  );
  assert.match(RETRO_CODE, /trackLeadUids/);
});

// ===========================================================================
// §5 — Facilitator notes
// ===========================================================================

test("GUARD §5.1 the note doc id binds (run, material, author)", () => {
  assert.equal(
    courseMaterialNoteId("aisf-autumn__ab12cd34", "m_read_1", "uid9"),
    "aisf-autumn__ab12cd34__m_read_1__uid9",
  );
});

test("GUARD §5.2 buildMaterialNoteWrite trims, caps and floors", () => {
  const doc = buildMaterialNoteWrite({
    runId: "run1",
    itemId: "m1",
    weekNumber: 3.9,
    uid: "u1",
    byName: "Ada",
    note: `  ${"x".repeat(2000)}  `,
    at: "SENTINEL",
  });
  assert.equal(doc.weekNumber, 3);
  assert.equal(doc.note.length, MATERIAL_NOTE_LIMITS.note);
  assert.equal(doc.at, "SENTINEL");
  // Blank in, blank out — the route reads that as "clear my note" and deletes
  // the row, so an empty note never reaches Firestore.
  assert.equal(buildMaterialNoteWrite({ ...doc, note: "   " }).note, "");
  // No `at` key at all when the caller passes none: absent, never undefined
  // (Firestore refuses undefined).
  assert.equal("at" in buildMaterialNoteWrite({ ...doc, at: undefined }), false);
});

test("GUARD §5.3 normalizeCourseMaterialNote caps on the way out too", () => {
  const doc = normalizeCourseMaterialNote("n1", { note: "y".repeat(9000) });
  assert.equal(doc.note.length, MATERIAL_NOTE_LIMITS.note);
  assert.equal(doc.at, null);
  assert.equal(doc.weekNumber, 0);
});

test("MODEL §5.4 the note route derives weekNumber and byName server-side", () => {
  // The client's weekNumber is validated for shape and then DISCARDED: a note
  // filed against a week the material is not in would never render.
  assert.match(NOTES_CODE, /const claimedWeek = body\.weekNumber;/);
  assert.match(NOTES_CODE, /week\.materials\.some\(\(m\) => m\.id === itemId\)/);
  assert.match(NOTES_CODE, /weekNumber = week\.weekNumber;/);
  // The refusal for an id that is in NO week the caller can note on. Widened
  // in V2-3 when the scan gained the group forks (see the group-first scan
  // GUARD in `course-schedule-changes.test.mjs`): the old sentence said "isn't
  // in this run's curriculum" while refusing a facilitator's own swapped-in
  // reading, which was untrue from their side.
  assert.match(
    NOTES_CODE,
    /"That material isn't in this run's curriculum, or in any week you can note on\."/,
  );
  // …and the name comes off the user doc, never the body.
  assert.match(NOTES_CODE, /byName: displayNameOf\(actorSnap\.data\(\) \?\? \{\}\)/);
  assert.equal(/body\.byName/.test(NOTES_CODE), false);
  // One indistinguishable 403 covering both "no such run" and "not yours".
  assert.match(NOTES_CODE, /runSnap\.exists &&\s*\(actor\.role === "admin"/);
  assert.equal((NOTES_CODE.match(/error: "Forbidden"/g) ?? []).length, 1);
  assert.equal(/error: "Run not found"/.test(NOTES_CODE), false);
  // The group lookup is a bounded field-masked scan, not an array-contains
  // pair that would demand a composite index.
  assert.match(NOTES_CODE, /\.select\("facilitatorUids"\)/);
  assert.equal(/array-contains/.test(NOTES_CODE), false);
});

// ===========================================================================
// §6 — Provenance on the run
// ===========================================================================

test("GUARD §6.1 normalizeCourseRun reads provenance as absent-or-string", () => {
  const bare = normalizeCourseRun("run1", {});
  assert.equal(bare.templateId, null);
  assert.equal(bare.templateLabel, null);

  const stamped = normalizeCourseRun("run1", {
    templateId: "t1",
    templateLabel: "Autumn 2026 final",
  });
  assert.equal(stamped.templateId, "t1");
  assert.equal(stamped.templateLabel, "Autumn 2026 final");

  // "" is the rules' default for an absent field, so it must read as absent.
  assert.equal(normalizeCourseRun("r", { templateId: "" }).templateId, null);
  assert.equal(normalizeCourseRun("r", { templateId: 7 }).templateId, null);
});

test("MODEL §6.2 firestore.rules pins provenance on update and on create", () => {
  const runsBlock = RULES.slice(
    RULES.indexOf("match /courseRuns/{runId}"),
    RULES.indexOf("// === courseGroups ==="),
  );
  const pinFn = runsBlock.slice(
    runsBlock.indexOf("function runPinnedFieldsUnchanged()"),
    runsBlock.indexOf("function runContentOk()"),
  );
  for (const field of ["templateId", "templateLabel"]) {
    assert.match(
      pinFn,
      new RegExp(
        `request\\.resource\\.data\\.get\\('${field}', ''\\)\\s*\\n?\\s*== resource\\.data\\.get\\('${field}', ''\\)`,
      ),
      `${field} must be pinned against non-admin run writers`,
    );
    // Clean start: update only PINS, so a run must not be BORN claiming a
    // provenance it never had.
    assert.match(
      runsBlock,
      new RegExp(`request\\.resource\\.data\\.get\\('${field}', ''\\) == ''`),
      `${field} must start empty at create`,
    );
  }
});

// ===========================================================================
// §7 — Route gates. NEVER ORPHAN MEMBER WORK.
// ===========================================================================

test("MODEL §7.1 apply-template refuses replace while ANY member work exists", () => {
  // Both collections, counted live. A member who ticked one box counts as
  // much as a cohort that finished: the failure mode is identical.
  assert.match(APPLY_CODE, /collection\("courseProgress"\)[\s\S]{0,120}\.count\(\)/);
  assert.match(
    APPLY_CODE,
    /collection\("courseExerciseResponses"\)[\s\S]{0,140}\.count\(\)/,
  );
  assert.match(APPLY_CODE, /if \(progressCount > 0 \|\| responseCount > 0\)/);
  assert.match(APPLY_CODE, /would orphan that work/);
  // The gate lives INSIDE the replace branch and BEFORE the first week write.
  const gate = APPLY_CODE.indexOf("if (progressCount > 0 || responseCount > 0)");
  const branch = APPLY_CODE.indexOf("if (!existing.empty && replace)");
  const firstWrite = APPLY_CODE.indexOf("tx.set(write.ref, write.data)");
  assert.ok(branch > 0 && branch < gate && gate < firstWrite);
  // Without `replace`, an occupied run is refused outright.
  assert.match(APPLY_CODE, /if \(!existing\.empty && !replace\)[\s\S]{0,400}409,/);
});

test("MODEL §7.1b the gate and the copy are ONE transaction, not a check then a write", () => {
  // The gate used to be two count() aggregations followed, hundreds of
  // milliseconds later, by an unrelated batch — a TOCTOU with a member on the
  // other side of it, because `courseProgress` is a DIRECT CLIENT WRITE. A
  // member ticking a checklist item inside that window was orphaned the
  // instant after the gate said nothing existed.
  //
  // Now every read and every write is one `runTransaction`. Firestore's
  // server-side transactions are serialisable and `tx.get(aggregateQuery)`
  // takes a pessimistic lock on what the query matches, so a racing create
  // either serialises before the count (and refuses the apply) or after the
  // commit (where it is keyed on the new curriculum and orphans nothing).
  assert.match(APPLY_CODE, /await db\.runTransaction\(async \(tx\) => \{/);
  // The counts are TRANSACTION reads. A bare `.count().get()` anywhere in
  // this route would be the old hole reopened next to the fix.
  assert.match(APPLY_CODE, /tx\.get\(db\.collection\("courseProgress"\)/);
  assert.equal(
    /\.count\(\)\s*\n?\s*\.get\(\)/.test(APPLY_CODE),
    false,
    "a count aggregation is being read outside the transaction again",
  );
  // No batch survives: a batch and a transaction are not two ways of writing
  // the same thing, and a second write path would sidestep the lock.
  assert.equal(/db\.batch\(\)|batch\.commit\(\)/.test(APPLY_CODE), false);
  // Reads before writes — the transaction's own rule, and the ordering the
  // gate depends on.
  const firstRead = APPLY_CODE.indexOf("await tx.get(targetWeeks.select())");
  const firstWrite = APPLY_CODE.indexOf("tx.set(write.ref, write.data)");
  assert.ok(firstRead > 0 && firstRead < firstWrite);
  // One transaction has no chunking to fall back on, so an oversized apply is
  // refused with a sentence rather than failing raw at Firestore's 500-write
  // limit.
  assert.match(APPLY_CODE, /MAX_APPLY_WRITES/);
  // And the refusal travels as a typed sentinel: a Response returned from
  // inside the callback would abort nothing (the SubmitError precedent).
  assert.match(APPLY_CODE, /class ApplyRefusedError extends Error/);
  assert.match(APPLY_CODE, /err instanceof ApplyRefusedError/);
});

test("MODEL §7.1c the guarantee comment claims only what the gate actually holds", () => {
  // The gate is bypassable in two presses — delete the run's weeks in the week
  // editor (no submission warning exists there until V2-3), then apply onto
  // the now-empty run. The fix for that is a warning at the surface where the
  // deletion happens, not here; what this route owes meanwhile is a comment
  // that does not overclaim.
  assert.match(APPLY_ROUTE, /The gate protects THIS PRESS/);
  assert.match(APPLY_ROUTE, /WEEK EDITOR/);
  assert.match(APPLY_ROUTE, /V2-3 decision 6/);
});

test("MODEL §7.2 apply-template stamps provenance atomically with the weeks", () => {
  // The stamp used to be a separate `runRef.update()` after the batches, so a
  // crash between them left a run holding a curriculum it did not claim. In
  // one transaction the two are the same write: the stamp is true the instant
  // it is visible. It is still LEXICALLY last, so the ordering reads the way
  // the old sequence did.
  const weekWrite = APPLY_CODE.indexOf("tx.set(write.ref, write.data)");
  const stamp = APPLY_CODE.indexOf("templateId: template.id");
  assert.ok(weekWrite > 0 && stamp > weekWrite, "the stamp no longer follows the weeks");
  assert.match(APPLY_CODE, /tx\.update\(runRef, \{/);
  assert.equal(
    /await runRef\.update\(/.test(APPLY_CODE),
    false,
    "provenance is written outside the transaction again",
  );
  assert.match(APPLY_CODE, /templateLabel: template\.label/);
  // Never null — rules pin these with a '' default (see CourseRunDoc).
  assert.equal(/templateId: null/.test(APPLY_CODE), false);
  assert.equal(/templateLabel: null/.test(APPLY_CODE), false);
});

test("MODEL §7.2b the apply receipt names the weeks it REMOVED", () => {
  // `removed` was returned and never rendered: `applyMessage()` read only
  // `created` and `replaced`, so a replace that deleted two weeks the snapshot
  // has no counterpart for reported "Copied 6 weeks · replaced 6." and said
  // nothing about the two that went. Those are the one figure an admin cannot
  // reconstruct from the screen in front of them — the weeks are gone by the
  // time they read it — so the ids travel with the count.
  assert.match(APPLY_CODE, /removedIds: outcome\.removedIds/);
  assert.match(APPLY_CODE, /removedIds: stale\.map\(\(ref\) => ref\.id\)/);
  assert.match(TEMPLATES_HOOK, /removed/);
  assert.match(TEMPLATES_HOOK, /the template doesn't have/);
  // The list is capped: 60 week ids in one sentence is not a receipt.
  assert.match(TEMPLATES_HOOK, /MAX_NAMED_REMOVALS/);
});

test("MODEL §7.3 every route gates before it reads", () => {
  for (const [name, source, gate] of [
    ["templates POST/GET", TEMPLATES_CODE, /if \(actor\.role !== "admin"\)/],
    ["template DELETE", TEMPLATE_DELETE_CODE, /if \(actor\.role !== "admin"\)/],
    [
      "apply-template",
      APPLY_CODE,
      /if \(!\(actor\.role === "admin" \|\| actor\.permissions\.approveCourse\)\)/,
    ],
  ]) {
    assert.match(source, gate, `${name} must carry its gate`);
    const forbidden = source.search(gate);
    const firstRead = source.indexOf(".get()");
    assert.ok(
      forbidden > 0 && forbidden < firstRead,
      `${name} must refuse before it touches the database`,
    );
  }
  // Save/delete are ADMIN, above the approveCourse content lane — a snapshot
  // is the record of what a cohort was taught and the seed of the next run.
  assert.equal(/permissions\.draftCourse/.test(TEMPLATE_DELETE_CODE), false);
  assert.equal(/permissions\.approveCourse/.test(TEMPLATE_DELETE_CODE), false);
});

test("MODEL §7.4 the template delete is bounded, weeks-first, and not the cascade", () => {
  const weeks = TEMPLATE_DELETE_CODE.indexOf("batch.delete(d.ref)");
  const parent = TEMPLATE_DELETE_CODE.indexOf("await ref.delete()");
  assert.ok(weeks > 0 && parent > weeks, "the parent goes last so a retry can resume");
  assert.match(TEMPLATE_DELETE_CODE, /if \(firstId === prevFirstId\)/);
  assert.match(TEMPLATE_DELETE_CODE, /page >= MAX_PAGES/);
  // Explicitly NOT the audited, resumable, budgeted machinery: nothing here
  // takes member work with it.
  assert.equal(
    /courseDeletion|recursiveDelete|courseDeletions/.test(TEMPLATE_DELETE_CODE),
    false,
  );
});

test("MODEL §7.5 the save route freezes evidence from the same aggregation", () => {
  assert.match(TEMPLATES_CODE, /summarizeRetrospective\(/);
  assert.match(TEMPLATES_CODE, /aggregateRetrospective\(/);
  assert.match(TEMPLATES_CODE, /\.select\("itemId", "rating", "completed"\)/);
  // A caller naming a group is refused rather than quietly given the canonical
  // copy under a `sourceGroupId: null` that says it asked for no such thing.
  assert.match(
    TEMPLATES_CODE,
    /body\.sourceGroupId !== undefined && body\.sourceGroupId !== null/,
  );
  assert.match(TEMPLATES_CODE, /sourceGroupId: null,/);
});

// ===========================================================================
// §8 — PROVEN GAPS. Assert the gap is STILL OPEN; invert when it closes.
// ===========================================================================

test("PROVEN GAP §8.1 facilitators cannot read back their own notes from a client", () => {
  // The pinned contract gives `courseMaterialNotes` the RETROSPECTIVE's read
  // tier (admin / draftCourse / approveCourse / track lead). Group
  // facilitators — the people who WRITE these notes — are in none of those,
  // and the retrospective route that renders notes carries the same tier. So
  // today a facilitator can write a note through the route and has no
  // supported way to read it back until V2-3 gives them a surface.
  //
  // That is a deliberate scoping decision, not an oversight: the alternative
  // (an own-row client read) widens the collection's surface for a view that
  // does not exist yet. When V2-3 lands a facilitator view, it gets a ROUTE
  // with its own tier — and this test inverts in the same commit.
  const notesBlock = RULES.slice(
    RULES.indexOf("match /courseMaterialNotes/{noteId}"),
    RULES.indexOf("// === courseDeletions ==="),
  );
  assert.equal(
    /facilitatorUids/.test(notesBlock),
    false,
    "no facilitator read branch exists yet — if you added one, invert this test",
  );
  assert.equal(
    /facilitatorUids/.test(RETRO_CODE),
    false,
    "the retrospective route does not admit facilitators either — same decision",
  );
});

// ===========================================================================
// §9 — THE REVIEW FINDINGS. Each test pins one fix from the pass that
// followed the V2-2 build.
// ===========================================================================

test("GUARD §9.1 the template listing scopes track leads to THIS course", () => {
  // The route admitted `trackLeadUids array-contains actor` with no courseId
  // filter, so leading ONE run of one course listed every other course's
  // snapshots — while firestore.rules deliberately resolves a client's
  // template read against the SOURCE RUN's leads. A route and its rules
  // disagreeing about who may read something is a bug even when the wider
  // answer is defensible.
  // Sliced to the BRANCH, not to the rest of the file: the listing query below
  // it also filters on courseId, and a scan that ran off the end would pass on
  // the wrong query's filter.
  const leadCheck = TEMPLATES_CODE.slice(
    TEMPLATES_CODE.indexOf("if (!staff)"),
    TEMPLATES_CODE.lastIndexOf("MAX_TEMPLATES_LISTED"),
  );
  assert.ok(leadCheck.length > 0, "the track-lead branch is gone");
  assert.match(leadCheck, /\.where\("courseId", "==", courseId\)/);
  // The equality is in the QUERY; the array membership is answered in memory
  // over a field-masked page. Pairing `array-contains` with an equality is the
  // combination this codebase has already decided not to depend on (the
  // material-notes route says so), and a permission check must not be the
  // place a missing composite index turns into a 500 for a legitimate lead.
  assert.match(leadCheck, /\.select\("trackLeadUids"\)/);
  assert.match(leadCheck, /MAX_RUNS_SCANNED/);
  assert.equal(
    /array-contains/.test(TEMPLATES_CODE),
    false,
    "the unscoped array-contains lead query is back",
  );
  // And the bounded scan fails CLOSED: past the bound a lead reads as not a
  // lead, which is the safe direction.
  assert.match(TEMPLATES_ROUTE, /safe direction/);
});

test("GUARD §9.2 the retrospective claims AGGREGATE, never anonymity", () => {
  // The floor defeats a single read of the table. It does NOT survive
  // differencing across reloads: 3 ratings averaging 4.0, refreshed into 4
  // averaging 4.25, gives up the newcomer's 5 exactly. The maths is right for
  // what it does; the CLAIM was wrong, so the claim is what changed.
  assert.match(TEMPLATES_MODULE, /SMALL-COHORT SUPPRESSION FLOOR/);
  assert.match(TEMPLATES_MODULE, /DIFFERENCING ACROSS READS/);
  assert.match(TEMPLATES_MODULE, /not an anonymity guarantee/);
  // The member-facing surface says "in aggregate" and names the limitation
  // rather than promising something the maths does not deliver.
  assert.match(RETRO_VIEW, /shown only in aggregate/);
  assert.match(RETRO_VIEW, /Aggregate is not the same as anonymous/);
  assert.equal(
    /anonymous aggregates/.test(RETRO_VIEW),
    false,
    "the retrospective is promising anonymity again",
  );
  // The floor itself is unchanged — this was a copy fix, not a maths fix.
  assert.equal(RETRO_ANONYMITY_FLOOR, 3);
});

test("GUARD §9.3 the clone-weeks doctrine comment describes the CURRENT design", () => {
  // It still argued "There is deliberately no curriculum template collection…
  // the most recent run IS the master copy" — a rule V2-2 abandoned. Left
  // standing, the next reader takes an abandoned decision as guidance.
  const clone = CLONE_WEEKS_ROUTE;
  assert.equal(
    /There is deliberately no curriculum template collection/.test(clone),
    false,
    "the abandoned no-templates rule is back in the clone-weeks comment",
  );
  assert.equal(
    /most recent run IS the master/.test(clone),
    false,
    "the abandoned master-copy rule is back in the clone-weeks comment",
  );
  // And it says what IS true: templates exist as append-only snapshots, and
  // copy-forward survives alongside them for a different question.
  assert.match(clone, /courseTemplates` exists/);
  assert.match(clone, /append-only/);
  assert.match(clone, /apply-template/);
});

test("GUARD §9.4 the Replace warning names the DELETION before the press", () => {
  // The receipt reports removals afterwards; a warning that only fires after
  // the press cannot change the decision. Both numbers are already on the
  // client — the run's authored weeks and the snapshot's `weekCount` — so the
  // editor states the possibility up front, as a LOWER bound (the two id sets
  // need not overlap, so the real figure can be higher, never lower).
  assert.match(RUN_EDITOR, /const minWeeksRemoved =/);
  assert.match(RUN_EDITOR, /Math\.max\(0, weeks\.length - templateWeekCount\)/);
  assert.match(RUN_EDITOR, /removed rather than overwritten/);
  assert.match(RUN_EDITOR, /at least \{minWeeksRemoved\}/);
  // Template sources only: clone-weeks skips or overwrites and never deletes,
  // so the sentence would be false on that lane.
  assert.match(RUN_EDITOR, /selectedTemplate\s*\n?\s*\? Math\.max\(0/);
});
