/**
 * Unit tests for V3 W1 PR5: STREAM SCOPE, OPEN MODE, and the normalisers
 * that decide what those fields look like on the wire.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Four properties here are load-bearing, cheap to break, and invisible to the
 * type checker:
 *
 *  1. **`streamIds` PERSISTS AT ALL.** `sanitizeMaterials`, `sanitizeExercises`
 *     and `sanitizeChecklist` REBUILD each row key by key and drop anything
 *     they do not name, which is deliberate (it is the defence that keeps a
 *     facilitator's fork PATCH from accumulating junk in a document whose only
 *     ceiling is Firestore's 1 MB). The consequence is that a field added only
 *     to the type, or only to `isValidMaterial`, validates cleanly and then
 *     silently never persists. `tsc` cannot see that. §1 can.
 *  2. **ABSENT, NEVER EMPTY, NEVER NULL.** Absent and empty both mean CORE
 *     (see `ItemStreamIds`), so the sanitisers emit no key rather than an
 *     empty array on every row of every week. And `submissionExerciseRef` is
 *     stored ABSENT rather than null because firestore.rules pins it with a
 *     `.get(field, {})` default that a stored null compares unequal to. §2
 *     and §3.
 *  3. **A TEMPLATE COPY CARRIES THE SCOPE.** `templateWeekFields` is the one
 *     function both directions of a snapshot copy go through. A stream-scoped
 *     curriculum that lost its scoping on the way into next year's run would
 *     silently show every learner every stream's material. §4.
 *  4. **DEFAULTS THAT KEEP LAST TERM WORKING.** `enrolMode` absent means
 *     admissions; `held` absent means the session happened. Defaulting either
 *     the other way would retroactively rewrite every run and register
 *     already in the database. §5.
 *
 * ## The loader dance
 *
 * Lifted verbatim from `course-templates.test.mjs`, which already solved
 * importing TypeScript (and `@/…` aliases) from `.mjs` on this repo's Node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** See `course-nudge.test.mjs`; nothing here is reachable from an assertion. */
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
        "the `typescript` devDependency is not installed, run `npm install`.",
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
  COURSE_FIELD_LIMITS,
  normalizeCourseRun,
  normalizeCourseWeek,
  sanitizeChecklist,
  sanitizeExercises,
  sanitizeMaterials,
  sanitizeStreams,
} = await loadTs("lib/firestore/courses.ts");

const { templateWeekFields } = await loadTs("lib/firestore/courseTemplates.ts");

const {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABEL,
  normalizeCourseAttendance,
} = await loadTs("lib/firestore/courseAttendance.ts");

const { normalizeCourseEnrolment } = await loadTs("lib/firestore/courseEnrolments.ts");

const {
  MAX_OPEN_MODE_CAPACITY,
  groupCapacityError,
  normalizeCourseGroup,
} = await loadTs("lib/firestore/courseGroups.ts");

const { DEFAULT_COURSES_CONFIG, readCoursesConfig } = await loadTs(
  "lib/firestore/config.ts",
);

const {
  COURSE_AUDIT_KIND_LABEL,
  UNKNOWN_COURSE_AUDIT_LABEL,
  courseAuditKindLabel,
  normalizeCourseAudit,
} = await loadTs("lib/firestore/courseAudit.ts");

/**
 * Read as TEXT, not imported: the enrol-mode route is an Admin SDK module and
 * pulling it in here would drag `firebase-admin` and `next/server` into a unit
 * suite that has no business booting either. The property being pinned is a
 * structural one (a guard runs BEFORE a write), and source order is exactly
 * what expresses it.
 */
const ENROL_MODE_ROUTE = readFileSync(
  join(SRC, "app/api/courses/runs/[runId]/enrol-mode/route.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rawRun(overrides = {}) {
  return {
    courseId: "course1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "draft",
    startDate: "2026-10-26",
    weekPlan: [],
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: {},
    groupCount: 0,
    channel: "cohort:run1",
    archived: false,
    ...overrides,
  };
}

function rawWeek(overrides = {}) {
  return {
    weekNumber: 3,
    title: "Goal misgeneralisation",
    summary: "Read the two papers.",
    guideBlocks: [],
    materials: [
      {
        id: "m_core",
        type: "reading",
        title: "The core paper",
        url: "https://example.org/core",
      },
      {
        id: "m_tech",
        type: "reading",
        title: "The technical extension",
        url: "https://example.org/tech",
        streamIds: ["technical"],
      },
    ],
    exercises: [
      {
        id: "x_core",
        prompt: "Where do the goals come apart?",
        responseType: "text",
        required: true,
        maxLength: 2000,
        peerVisible: false,
      },
      {
        id: "x_gov",
        prompt: "Which regulator would act first?",
        responseType: "text",
        required: false,
        maxLength: 2000,
        peerVisible: false,
        streamIds: ["governance"],
        estimatedMinutes: 25,
      },
    ],
    checklist: [
      { id: "c_core", title: "Post in the channel", mirrorToMyWork: true },
      {
        id: "c_tech",
        title: "Reproduce figure 3",
        mirrorToMyWork: false,
        streamIds: ["technical", "generalist"],
      },
    ],
    estimatedMinutes: 90,
    published: true,
    ...overrides,
  };
}

// ===========================================================================
// §1. streamIds SURVIVES the key-by-key rebuild. The whole point.
// ===========================================================================

test("GUARD §1.1 sanitizeMaterials carries streamIds through the rebuild", () => {
  const [core, tech] = sanitizeMaterials(rawWeek().materials);
  assert.equal("streamIds" in core, false, "a core material must carry no key");
  assert.deepEqual(tech.streamIds, ["technical"]);
  // The rest of the row is untouched, which is what keeps every existing
  // caller working.
  assert.equal(tech.type, "reading");
  assert.equal(tech.url, "https://example.org/tech");
});

test("GUARD §1.2 sanitizeExercises carries streamIds AND estimatedMinutes", () => {
  const [core, gov] = sanitizeExercises(rawWeek().exercises);
  assert.equal("streamIds" in core, false);
  assert.equal("estimatedMinutes" in core, false);
  assert.deepEqual(gov.streamIds, ["governance"]);
  assert.equal(gov.estimatedMinutes, 25);
  assert.equal(gov.prompt, "Which regulator would act first?");
});

test("GUARD §1.3 sanitizeChecklist carries streamIds through the rebuild", () => {
  const [core, tech] = sanitizeChecklist(rawWeek().checklist);
  assert.equal("streamIds" in core, false);
  assert.deepEqual(tech.streamIds, ["technical", "generalist"]);
  assert.equal(tech.mirrorToMyWork, false);
});

test("GUARD §1.4 a full week normalises with every scope intact", () => {
  // The read path an actual page takes. If any one of the three sanitisers
  // regressed, exactly one of these three would go quiet.
  const week = normalizeCourseWeek("w03", rawWeek());
  assert.deepEqual(
    week.materials.map((m) => m.streamIds ?? null),
    [null, ["technical"]],
  );
  assert.deepEqual(
    week.exercises.map((x) => x.streamIds ?? null),
    [null, ["governance"]],
  );
  assert.deepEqual(
    week.checklist.map((c) => c.streamIds ?? null),
    [null, ["technical", "generalist"]],
  );
});

// ===========================================================================
// §2. ABSENT, NEVER EMPTY. Firestore refuses undefined, and empty is noise.
// ===========================================================================

test("GUARD §2.1 an empty or junk streamIds writes NO key at all", () => {
  // Absent and empty already mean the same thing, so an empty array on every
  // row of every week is bytes with no meaning. And a key set to `undefined`
  // is a write Firestore refuses outright.
  for (const value of [[], null, undefined, "technical", 7, [null, 3, ""]]) {
    const [row] = sanitizeMaterials([
      { id: "m1", type: "link", title: "T", url: "https://example.org", streamIds: value },
    ]);
    assert.equal("streamIds" in row, false, `streamIds: ${JSON.stringify(value)}`);
  }
});

test("GUARD §2.2 streamIds are de-duplicated, order-preserved and capped", () => {
  const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const [row] = sanitizeMaterials([
    {
      id: "m1",
      type: "link",
      title: "T",
      url: "https://example.org",
      streamIds: ["b", "a", "b", ...many],
    },
  ]);
  assert.equal(row.streamIds.length, COURSE_FIELD_LIMITS.maxItemStreamIds);
  assert.deepEqual(row.streamIds.slice(0, 2), ["b", "a"]);
  assert.equal(new Set(row.streamIds).size, row.streamIds.length);
});

test("GUARD §2.3 sanitizeStreams drops id-less streams and caps the run's list", () => {
  // A stream with no id is unaddressable: item `streamIds` and enrolment
  // `streamId` both point at the id, so keeping one would render an empty
  // chip nobody can be placed on.
  const streams = sanitizeStreams([
    { id: "technical", label: "Technical" },
    { label: "No id at all" },
    { id: "technical", label: "A duplicate" },
    { id: "governance" },
    "not an object",
    ...Array.from({ length: 10 }, (_, i) => ({ id: `extra${i}`, label: `X${i}` })),
  ]);
  assert.equal(streams.length, COURSE_FIELD_LIMITS.maxStreams);
  assert.deepEqual(streams.slice(0, 3), [
    { id: "technical", label: "Technical" },
    { id: "governance", label: "" },
    { id: "extra0", label: "X0" },
  ]);
});

// ===========================================================================
// §3. submissionExerciseRef is ABSENT, never null. The rules pin depends on it.
// ===========================================================================

test("GUARD §3.1 a null submissionExerciseRef normalises to an ABSENT key", () => {
  // firestore.rules pins the field with `.get('submissionExerciseRef', {})` on
  // BOTH sides. A stored null compares unequal to that default, so a
  // whole-document save then refuses every later non-admin edit of the run.
  // The normaliser is the last line of defence: whatever is on the wire, a
  // doc round-tripped through here can never REINTRODUCE a null.
  for (const stored of [null, undefined, {}, { weekId: "w06" }, { exerciseId: "x1" }, 7]) {
    const run = normalizeCourseRun("run1", rawRun({ submissionExerciseRef: stored }));
    assert.equal(
      "submissionExerciseRef" in run,
      false,
      `stored ${JSON.stringify(stored)} must normalise to an absent key`,
    );
  }
});

test("GUARD §3.2 a complete pointer survives verbatim", () => {
  const run = normalizeCourseRun(
    "run1",
    rawRun({ submissionExerciseRef: { weekId: "w06", exerciseId: "x1", junk: 1 } }),
  );
  assert.deepEqual(run.submissionExerciseRef, { weekId: "w06", exerciseId: "x1" });
});

// ===========================================================================
// §4. A template copy carries the stream scope
// ===========================================================================

test("GUARD §4.1 templateWeekFields carries streamIds in both directions", () => {
  // `templateWeekFields` is the ONE function both directions of the copy go
  // through (run -> snapshot and snapshot -> run). A stream-scoped curriculum
  // that lost its scoping on the way into next year's run would show every
  // learner every stream's material, silently, a year later.
  const week = normalizeCourseWeek("w03", rawWeek());
  const fields = templateWeekFields(week);
  const copied = normalizeCourseWeek("w03", fields);

  assert.deepEqual(copied.materials, week.materials);
  assert.deepEqual(copied.exercises, week.exercises);
  assert.deepEqual(copied.checklist, week.checklist);
  assert.deepEqual(copied.materials[1].streamIds, ["technical"]);
  assert.deepEqual(copied.exercises[1].streamIds, ["governance"]);
  assert.equal(copied.exercises[1].estimatedMinutes, 25);
  assert.deepEqual(copied.checklist[1].streamIds, ["technical", "generalist"]);
});

test("GUARD §4.2 the copy is still a fixpoint with scoped items", () => {
  // §1.2 of course-templates.test.mjs, re-run over a scoped week: a template
  // applied twice must produce the same curriculum both times.
  const once = templateWeekFields(normalizeCourseWeek("w03", rawWeek()));
  const twice = templateWeekFields(normalizeCourseWeek("w03", once));
  assert.deepEqual(twice, once);
});

test("MODEL §4.3 the template field list is the week's content, unabridged", () => {
  // `templateWeekFields` carries the material / exercise / checklist ARRAYS
  // wholesale, which is exactly why `streamIds` rides along for free and why
  // this list is the thing to check when a week gains a field. A field added
  // to a week and not to this list would be dropped by every snapshot.
  const fields = templateWeekFields(normalizeCourseWeek("w03", rawWeek()));
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

// ===========================================================================
// §5. Defaults that keep last term working
// ===========================================================================

test("GUARD §5.1 a run with no enrolMode is an ADMISSIONS run", () => {
  // Every run written before V3 is absent this field, and admissions is the
  // behaviour it already has. Open mode is never reached by accident, and an
  // unrecognised value degrades the safe way rather than the open way.
  for (const stored of [undefined, null, "", "OPEN", "self-serve", 1]) {
    assert.equal(normalizeCourseRun("run1", rawRun({ enrolMode: stored })).enrolMode, "admissions");
  }
  assert.equal(normalizeCourseRun("run1", rawRun({ enrolMode: "open" })).enrolMode, "open");
});

test("GUARD §5.2 a register with no `held` flag records a session that HAPPENED", () => {
  // Defaulting the other way would retroactively cancel the whole of last
  // term, and every ratio built on the registers with it.
  const base = { runId: "run1", groupId: "grp1", weekNumber: 3, records: {} };
  assert.equal(normalizeCourseAttendance("a", base).held, true);
  assert.equal(normalizeCourseAttendance("a", { ...base, held: false }).held, false);
  // Only an explicit `false` cancels. A garbled value is a session that ran.
  assert.equal(normalizeCourseAttendance("a", { ...base, held: "no" }).held, true);
});

test("GUARD §5.3 left-early is a first-class status, and the labels are total", () => {
  // The completion bar is "attend N sessions IN FULL", so somebody who came
  // for ten minutes must not be recorded identically to somebody who stayed.
  assert.ok(ATTENDANCE_STATUSES.includes("left-early"));
  for (const status of ATTENDANCE_STATUSES) {
    assert.ok(ATTENDANCE_STATUS_LABEL[status], `${status} has no label`);
  }
  const doc = normalizeCourseAttendance("a", {
    runId: "run1",
    groupId: "grp1",
    weekNumber: 3,
    records: { u1: "left-early", u2: "present", u3: "not-a-status" },
  });
  assert.deepEqual(doc.records, { u1: "left-early", u2: "present" });
});

test("GUARD §5.4 participant notes are capped in count and in length", () => {
  // Personal data about a named student, written by another student. The cap
  // is what keeps a hand-edited register degrading to a smaller register
  // rather than to an unbounded payload on a staff surface.
  const notes = {};
  for (let i = 0; i < 60; i += 1) notes[`u${String(i).padStart(3, "0")}`] = "x".repeat(2000);
  const doc = normalizeCourseAttendance("a", {
    runId: "run1",
    groupId: "grp1",
    weekNumber: 3,
    records: {},
    participantNotes: { ...notes, empty: "", bad: 7 },
  });
  assert.equal(Object.keys(doc.participantNotes).length, 40);
  assert.equal(doc.participantNotes.u000.length, 1000);
  assert.equal("empty" in doc.participantNotes, false);
  assert.equal("bad" in doc.participantNotes, false);
});

test("GUARD §5.5 an enrolment with no rollup reads as a zeroed one, not as undefined", () => {
  // Every consumer of the rollup (the learner's own progress page, the
  // reviewer evidence snapshot, certificates) reads the numbers directly. A
  // pre-V3 row must give them zeroes rather than a crash.
  const row = normalizeCourseEnrolment("run1__u1", {
    runId: "run1",
    courseId: "course1",
    uid: "u1",
    status: "active",
  });
  assert.deepEqual(row.attendance, {
    sessionsHeld: 0,
    attendedInFull: 0,
    late: 0,
    leftEarly: 0,
    absent: 0,
    excused: 0,
    lastPushedSessionKey: null,
    lastComputedAt: null,
  });
  assert.equal(row.submissionDone, false);
  assert.equal(row.selfEnrolled, false);
  assert.equal(row.streamId, null);
  assert.equal(row.droppedOutAt, null);
  assert.equal(row.dropOutReason, null);
});

// ===========================================================================
// §6. The group capacity rule, in the layer that can see both documents
// ===========================================================================

test("GUARD §6.1 an open-mode group MUST carry a capacity; an admissions one need not", () => {
  // The rules express as much of this as a rule can reach; this is the half
  // that knows the parent run's mode and produces the sentence a human reads.
  assert.equal(groupCapacityError(12, "open"), null);
  assert.equal(groupCapacityError(null, "admissions"), null);
  assert.match(groupCapacityError(null, "open"), /open-enrolment run/);
});

test("GUARD §6.2 the ceiling is the register's ceiling, on both modes", () => {
  // 40 is ATTENDANCE_LIMITS.maxRecords, and it is load-bearing: the marking
  // route fails the WHOLE post once the merged map passes it, so a 41st
  // member breaks bulk marking for everybody in the group.
  assert.equal(MAX_OPEN_MODE_CAPACITY, 40);
  assert.equal(groupCapacityError(MAX_OPEN_MODE_CAPACITY, "open"), null);
  assert.match(groupCapacityError(41, "open"), /at most 40/);
  assert.match(groupCapacityError(41, "admissions"), /at most 40/);
  assert.match(groupCapacityError(0, "admissions"), /whole number/);
  assert.match(groupCapacityError(4.5, "open"), /whole number/);
});

test("GUARD §6.3 a group's stream tag and appointments normalise safely", () => {
  const group = normalizeCourseGroup("grp1", {
    runId: "run1",
    courseId: "course1",
    name: "Group A",
    facilitatorUids: ["f1"],
    capacity: 12,
    memberCount: 3,
    session: {},
    streamId: "",
    facilitatorAppointments: {
      f1: { at: new Date("2026-10-05T00:00:00Z"), byUid: "admin1", byName: "An Admin" },
      f2: "not an object",
    },
  });
  // Empty means "open to every stream", the widest safe state.
  assert.equal(group.streamId, null);
  assert.deepEqual(Object.keys(group.facilitatorAppointments), ["f1"]);
  assert.equal(group.facilitatorAppointments.f1.byUid, "admin1");
  // Not yet agreed is a real state during the training window, not an error.
  assert.equal(group.facilitatorAppointments.f1.agreedAt, null);
});

test("GUARD §6.4 the enrol-mode route checks the run's GROUPS before it opens it", () => {
  // `groupCapacityOk()` requires a capacity when the parent run is open, and
  // it is evaluated against the merged document on EVERY group write. So the
  // one write that can wedge a document it does not touch is the flip to open
  // mode: every uncapped group on that run becomes unwritable, and the
  // facilitator who tries to move the room gets a raw permission-denied with
  // nothing anywhere to explain it. The rules test
  // "THE TRAP: flipping the run to open wedges an already-uncapped group"
  // in scripts/rules-tests/tests/courses.test.mjs proves that failure is real.
  //
  // This pins the guard against it: the route reads courseGroups for the run,
  // and it does so BEFORE the ref.update that stores the new mode.
  assert.match(ENROL_MODE_ROUTE, /groupCapacityError/);
  assert.match(ENROL_MODE_ROUTE, /collection\("courseGroups"\)/);

  const guardAt = ENROL_MODE_ROUTE.indexOf('collection("courseGroups")');
  const writeAt = ENROL_MODE_ROUTE.indexOf("ref.update(");
  assert.ok(guardAt > 0 && writeAt > 0, "both the group read and the run write exist");
  assert.ok(
    guardAt < writeAt,
    "the group capacity check must run BEFORE the run's enrolMode is written",
  );

  // And the refusal is a 409, the same class as the other two populated-run
  // refusals, not a 400 that reads like a malformed request.
  const guardBlock = ENROL_MODE_ROUTE.slice(guardAt, writeAt);
  assert.match(guardBlock, /status: 409/);
});

// ===========================================================================
// §7. An audit row never claims to be an action it was not
// ===========================================================================

test("GUARD §7.1 an unrecognised audit kind is kept verbatim, not degraded", () => {
  // The first cut mapped an unknown kind onto `attendance-edit`, which turns
  // a rollback (or a newer route writing a kind this bundle predates) into a
  // log full of rows asserting the wrong action. An audit that lies is worse
  // than one that admits it does not know.
  const known = normalizeCourseAudit("a1", { kind: "enrol-mode-change", runId: "run1" });
  assert.equal(known.kind, "enrol-mode-change");
  assert.equal(known.kindKnown, true);
  assert.equal(courseAuditKindLabel(known.kind), COURSE_AUDIT_KIND_LABEL["enrol-mode-change"]);

  const future = normalizeCourseAudit("a2", { kind: "certificate-revoked", runId: "run1" });
  assert.equal(future.kind, "certificate-revoked");
  assert.equal(future.kindKnown, false);
  assert.equal(courseAuditKindLabel(future.kind), UNKNOWN_COURSE_AUDIT_LABEL);
  assert.notEqual(courseAuditKindLabel(future.kind), COURSE_AUDIT_KIND_LABEL["attendance-edit"]);

  // A missing kind is the same case, not a crash and not a wrong label.
  const missing = normalizeCourseAudit("a3", { runId: "run1" });
  assert.equal(missing.kind, "");
  assert.equal(missing.kindKnown, false);
  assert.equal(courseAuditKindLabel(missing.kind), UNKNOWN_COURSE_AUDIT_LABEL);
});

// ===========================================================================
// §8. config/courses: the one field that becomes an href
// ===========================================================================

/** The smallest thing that answers `db.collection(c).doc(d).get()`. */
function fakeConfigDb(stored) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: stored !== null, data: () => stored }),
      }),
    }),
  };
}

test("GUARD §8.1 dropOutFeedbackUrl is http(s) or empty, never a script url", async () => {
  // The value is rendered as an href on a page the member is looking at, so
  // a `javascript:` or `data:` url here is script execution in their session.
  // A config doc being Admin-SDK-only today is not a reason to render it raw
  // tomorrow.
  const good = await readCoursesConfig(
    fakeConfigDb({ dropOutFeedbackUrl: "https://forms.example/leaving " }),
  );
  assert.equal(good.dropOutFeedbackUrl, "https://forms.example/leaving");

  for (const hostile of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "  javascript:alert(1)",
    "/relative/path",
    "forms.example/leaving",
    42,
  ]) {
    const cfg = await readCoursesConfig(fakeConfigDb({ dropOutFeedbackUrl: hostile }));
    assert.equal(cfg.dropOutFeedbackUrl, "", `refused: ${String(hostile)}`);
  }

  // Missing doc still means documented defaults, never "feature off".
  const absent = await readCoursesConfig(fakeConfigDb(null));
  assert.deepEqual(absent, DEFAULT_COURSES_CONFIG);
});
