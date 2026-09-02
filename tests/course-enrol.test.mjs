/**
 * Unit tests for OPEN ENROLMENT: the enrolment window, the public group
 * picker's field projection, and the seat that two people click at once.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## The three properties, and why each earns a test
 *
 *  1. **The window.** A pre-course keeps taking sign-ups in
 *     `applications-closed` and in `running`, which is exactly where
 *     `applicationWindow()` says no. That widening is the whole behavioural
 *     difference between the two predicates, and it is the kind of difference
 *     a later tidy-up would collapse "because they read the same two fields".
 *     The full status matrix is asserted so a new `CourseRunStatus` cannot
 *     silently join the admitting set.
 *
 *  2. **The projection.** `courseGroups` is read-restricted in
 *     `firestore.rules` precisely so that a joinable meeting link is not
 *     enumerable by anybody who can guess a doc id. `fetchGroupPicker` reads
 *     it on the Admin SDK, where rules provide no defence at all, and hands
 *     the result to an anonymous visitor. So the key set is pinned EXACTLY,
 *     not merely checked for the fields we currently remember to worry about:
 *     the leak this prevents is the field somebody adds to `CourseGroupDoc`
 *     next year.
 *
 *  3. **The last seat.** Capacity is enforced against the counter read INSIDE
 *     the enrol transaction. The route's gate is `groupFullError`, exported
 *     for this reason: modelling the transaction against the real predicate
 *     tests the code, while modelling it against a re-implementation would
 *     only test the model.
 *
 * ## Why the loader dance
 *
 * Same root cause as `course-window.test.mjs`: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module graph is transpiled in
 * memory with the `typescript` devDependency `npx tsc --noEmit` already uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const ENROL_WINDOW_MODULE = join(SRC, "lib", "courses", "enrolWindow.ts");
const GROUPS_MODULE = join(SRC, "lib", "firestore", "courseGroups.ts");
const PICKER_MODULE = join(SRC, "features", "courses", "fetchGroupPicker.ts");
const ENROL_ROUTE = readFileSync(
  join(SRC, "app", "api", "courses", "runs", "[runId]", "enrol", "route.ts"),
  "utf8",
);
const ACCOUNT_DELETION = readFileSync(
  join(SRC, "lib", "firestore", "accountDeletion.ts"),
  "utf8",
);
const REINSTATE_ROUTE = readFileSync(
  join(
    SRC, "app", "api", "courses", "runs", "[runId]", "enrolments", "[uid]",
    "reinstate", "route.ts",
  ),
  "utf8",
);
const ENROL_MODE_ROUTE = readFileSync(
  join(SRC, "app", "api", "courses", "runs", "[runId]", "enrol-mode", "route.ts"),
  "utf8",
);
const APPLY_ROUTE = readFileSync(
  join(SRC, "app", "api", "courses", "runs", "[runId]", "apply", "route.ts"),
  "utf8",
);
const APPLY_PAGE = readFileSync(
  join(SRC, "app", "(public)", "courses", "[courseId]", "apply", "page.tsx"),
  "utf8",
);
const FETCH_COURSES = readFileSync(
  join(SRC, "features", "courses", "fetchCourses.ts"),
  "utf8",
);
const GROUP_PICKER = readFileSync(
  join(SRC, "features", "courses", "GroupPicker.tsx"),
  "utf8",
);
const DROP_OUT_CARD = readFileSync(
  join(SRC, "features", "courses", "DropOutCard.tsx"),
  "utf8",
);

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module.
 *
 * `server-only` is the usual one. `@/lib/firebase/admin` is stubbed because
 * `fetchGroupPicker` imports it for its async half; the PURE half
 * (`projectGroupForPicker`) is what these tests exercise, and dragging the
 * Admin SDK into a unit test to reach it would make the test need
 * credentials to assert a field list.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  ["@/lib/firebase/admin", "export function getAdminDb() { return null; }"],
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
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(file));
}

const { enrolWindow, isEnrolOpen, courseRunWindow, ENROLLING_RUN_STATUSES } =
  await loadTs(ENROL_WINDOW_MODULE);
const { groupFullError, groupCapacityError, normalizeCourseGroup, MAX_OPEN_MODE_CAPACITY } =
  await loadTs(GROUPS_MODULE);
const { projectGroupForPicker } = await loadTs(PICKER_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mon 21 Sep 2026, 09:00 London (BST): the real pre-course opening. */
const OPENS = new Date("2026-09-21T08:00:00Z");
/** Sun 18 Oct 2026, 23:59 London (BST): the real autumn deadline. */
const CLOSES = new Date("2026-10-18T22:59:00Z");

const BEFORE = new Date("2026-09-01T12:00:00Z");
const INSIDE = new Date("2026-10-01T12:00:00Z");
const AFTER = new Date("2026-11-01T12:00:00Z");

/** Every run status, so the matrix below cannot silently miss a new one. */
const STATUSES = [
  "draft",
  "applications-open",
  "applications-closed",
  "running",
  "completed",
  "cancelled",
];

function run(over = {}) {
  return {
    status: "applications-open",
    enrolMode: "open",
    archived: false,
    applicationsOpenAt: OPENS,
    applicationsCloseAt: CLOSES,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test("open enrolment admits the three live statuses, and only those", () => {
  const admitting = [];
  for (const status of STATUSES) {
    if (isEnrolOpen(run({ status }), INSIDE)) admitting.push(status);
  }
  assert.deepEqual(admitting, [
    "applications-open",
    "applications-closed",
    "running",
  ]);
  // The exported list and the behaviour are the same list.
  assert.deepEqual([...ENROLLING_RUN_STATUSES].sort(), [...admitting].sort());
});

test("applications-closed and running are the point of the widened set", () => {
  // THE CASE THAT MOTIVATES THE WHOLE MODULE. The pre-course runs alongside
  // an intake whose applications shut on 18 October; the bootcamp's own
  // sessions keep going, and somebody who finds it in week two is exactly the
  // person open enrolment exists for. `applicationWindow()` would say no to
  // both of these.
  assert.equal(isEnrolOpen(run({ status: "applications-closed" }), INSIDE), true);
  assert.equal(isEnrolOpen(run({ status: "running" }), INSIDE), true);
});

test("draft and archived are inactive; completed and cancelled are closed", () => {
  assert.equal(enrolWindow(run({ status: "draft" }), INSIDE).state, "inactive");
  assert.equal(enrolWindow(run({ archived: true }), INSIDE).state, "inactive");
  // Archived beats an otherwise-live status, which is what keeps a run
  // mid-destroy off every enrol surface before its first row dies.
  assert.equal(
    enrolWindow(run({ status: "running", archived: true }), INSIDE).state,
    "inactive",
  );
  assert.equal(enrolWindow(run({ status: "completed" }), INSIDE).state, "closed");
  assert.equal(enrolWindow(run({ status: "cancelled" }), INSIDE).state, "closed");
});

test("an admissions run has no enrolment window at all", () => {
  for (const status of STATUSES) {
    const w = enrolWindow(run({ status, enrolMode: "admissions" }), INSIDE);
    assert.equal(w.state, "inactive", `${status} leaked an enrolment window`);
    assert.equal(isEnrolOpen(run({ status, enrolMode: "admissions" }), INSIDE), false);
  }
});

test("both bounds are INCLUSIVE, to the millisecond", () => {
  // Exactly at the opening instant you are in.
  assert.equal(isEnrolOpen(run(), OPENS), true);
  assert.equal(isEnrolOpen(run(), new Date(OPENS.getTime() - 1)), false);
  assert.equal(enrolWindow(run(), new Date(OPENS.getTime() - 1)).state, "not-yet");
  // Exactly at the deadline you are still in. "Closes at 23:59" has to mean
  // 23:59:00.000 is accepted, which is what it reads as to a person.
  assert.equal(isEnrolOpen(run(), CLOSES), true);
  assert.equal(isEnrolOpen(run(), new Date(CLOSES.getTime() + 1)), false);
  assert.equal(enrolWindow(run(), new Date(CLOSES.getTime() + 1)).state, "closed");
});

test("a null bound is unbounded, never closed", () => {
  // Reading null as "no window, therefore shut" would close every rolling
  // pre-course on the site.
  assert.equal(isEnrolOpen(run({ applicationsOpenAt: null }), BEFORE), true);
  assert.equal(isEnrolOpen(run({ applicationsCloseAt: null }), AFTER), true);
  assert.equal(
    isEnrolOpen(run({ applicationsOpenAt: null, applicationsCloseAt: null }), AFTER),
    true,
  );
});

test("the window echoes its own bounds back, whatever the state", () => {
  for (const status of STATUSES) {
    const w = enrolWindow(run({ status }), INSIDE);
    assert.equal(w.opensAt, OPENS);
    assert.equal(w.closesAt, CLOSES);
  }
});

test("courseRunWindow dispatches on enrolMode, which is the whole point", () => {
  // The same document, read by the same public surface, two answers. Calling
  // `applicationWindow()` directly on an open run is what would put
  // "applications closed" on a bootcamp taking sign-ups that evening.
  const closedish = { status: "running" };
  assert.equal(courseRunWindow(run(closedish), INSIDE).state, "open");
  assert.equal(
    courseRunWindow(run({ ...closedish, enrolMode: "admissions" }), INSIDE).state,
    "closed",
  );
});

// ---------------------------------------------------------------------------
// The public projection
// ---------------------------------------------------------------------------

/** A group document with every restricted field populated. */
function fullGroup(over = {}) {
  return normalizeCourseGroup("grp1", {
    runId: "run1",
    courseId: "c1",
    name: "Tuesday 6pm",
    facilitatorUids: ["fac-uid-1", "fac-uid-2"],
    streamId: "technical",
    capacity: 12,
    memberCount: 9,
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Hallward Library, B12",
      meetingUrl: "https://meet.example.com/secret-room",
      notes: "Priya has the key; Sam is away in week 4.",
    },
    ...over,
  });
}

test("the picker projection carries NO restricted field, ever", () => {
  const projected = projectGroupForPicker(fullGroup());
  const serialised = JSON.stringify(projected);
  for (const secret of [
    "meet.example.com",
    "secret-room",
    "Hallward",
    "fac-uid-1",
    "Priya",
  ]) {
    assert.ok(
      !serialised.includes(secret),
      `the public group projection leaked ${secret}`,
    );
  }
  assert.equal("meetingUrl" in projected, false);
  assert.equal("notes" in projected, false);
  assert.equal("location" in projected, false);
  assert.equal("facilitatorUids" in projected, false);
  assert.equal("facilitatorAppointments" in projected, false);
  assert.equal("sessionOverrides" in projected, false);
});

test("the projection's key set is pinned EXACTLY, not merely screened", () => {
  // The leak this prevents is the field somebody adds to `CourseGroupDoc`
  // next year. A screen for the fields we happen to worry about today would
  // pass on the day that field lands; an exact key set fails, which is what
  // makes adding one a reviewed decision.
  assert.deepEqual(Object.keys(projectGroupForPicker(fullGroup())).sort(), [
    "capacity",
    "durationMinutes",
    "full",
    "id",
    "name",
    "seatsLeft",
    "startTimeLocal",
    "streamId",
    "weekday",
  ]);
});

test("the projection carries the timetable facts a visitor picks between", () => {
  const projected = projectGroupForPicker(fullGroup());
  assert.equal(projected.id, "grp1");
  assert.equal(projected.name, "Tuesday 6pm");
  assert.equal(projected.weekday, 2);
  assert.equal(projected.startTimeLocal, "18:00");
  assert.equal(projected.durationMinutes, 90);
  assert.equal(projected.streamId, "technical");
});

test("seatsLeft is derived, floored at zero, and null when uncapped", () => {
  assert.equal(projectGroupForPicker(fullGroup()).seatsLeft, 3);
  assert.equal(projectGroupForPicker(fullGroup()).full, false);
  assert.equal(projectGroupForPicker(fullGroup({ memberCount: 12 })).seatsLeft, 0);
  assert.equal(projectGroupForPicker(fullGroup({ memberCount: 12 })).full, true);
  // An over-full group (a capacity lowered under a live cohort) reports zero
  // rather than a negative number a card would render as "-2 places left".
  assert.equal(projectGroupForPicker(fullGroup({ memberCount: 20 })).seatsLeft, 0);
  assert.equal(projectGroupForPicker(fullGroup({ memberCount: 20 })).full, true);
  const uncapped = projectGroupForPicker(fullGroup({ capacity: null }));
  assert.equal(uncapped.capacity, null);
  assert.equal(uncapped.seatsLeft, null);
  assert.equal(uncapped.full, false);
});

test("the projection's `full` and the route's refusal are one predicate", () => {
  // A card greyed out by one rule and a 409 raised by another is how a
  // visitor ends up clicking something that was never going to work, or being
  // refused something that looked available.
  for (const memberCount of [0, 11, 12, 13]) {
    const group = fullGroup({ memberCount });
    assert.equal(
      projectGroupForPicker(group).full,
      groupFullError(group) !== null,
      `disagreement at memberCount ${memberCount}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The last seat
// ---------------------------------------------------------------------------

/**
 * A model of Firestore's transaction semantics, small enough to read:
 * each attempt reads a snapshot of the counter, decides, and commits only if
 * the counter has not moved since the read. A losing attempt RETRIES against
 * the committed value, which is precisely what makes the second caller see a
 * full group rather than overwriting the first.
 *
 * `tx.create` is modelled too, because the doc id is the other half of the
 * invariant: a second enrolment at the same (run, uid) cannot exist.
 */
function enrolTransaction(store, { uid, capacity }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const readCount = store.memberCount;
    const readVersion = store.version;

    if (store.enrolments.has(uid)) {
      return { ok: false, reason: "already-enrolled" };
    }
    const full = groupFullError({
      name: "Tuesday 6pm",
      capacity,
      memberCount: readCount,
    });
    if (full) return { ok: false, reason: "full", message: full };

    // Commit, unless somebody else moved the counter since the read.
    if (store.version !== readVersion) continue; // contended: retry
    store.enrolments.add(uid);
    store.memberCount = readCount + 1;
    store.enrolledCount += 1;
    store.version += 1;
    return { ok: true };
  }
  return { ok: false, reason: "contention" };
}

function freshStore(memberCount = 0) {
  return { memberCount, enrolledCount: 0, version: 0, enrolments: new Set() };
}

test("two people take the last seat: one gets it, memberCount ends at capacity", () => {
  const store = freshStore(11); // capacity 12, one place left
  // Both callers read the same counter before either commits — the interleave
  // that a check-then-write outside a transaction gets wrong.
  const first = enrolTransaction(store, { uid: "a", capacity: 12 });
  const second = enrolTransaction(store, { uid: "b", capacity: 12 });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "full");
  // The refusal is a sentence a person can act on, not a status code.
  assert.match(second.message, /is full\./);
  assert.match(second.message, /Pick another session/);

  assert.equal(store.memberCount, 12, "the counter overshot capacity");
  assert.equal(store.enrolledCount, 1);
  assert.equal(store.enrolments.size, 1);
});

test("a crowd on one seat leaves the counter exactly at capacity", () => {
  const store = freshStore(11);
  const results = [];
  for (const uid of ["a", "b", "c", "d", "e", "f"]) {
    results.push(enrolTransaction(store, { uid, capacity: 12 }));
  }
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(store.memberCount, 12);
  assert.equal(store.enrolments.size, 1);
});

test("the deterministic doc id refuses a second enrolment for the same person", () => {
  const store = freshStore(0);
  assert.equal(enrolTransaction(store, { uid: "a", capacity: 12 }).ok, true);
  const again = enrolTransaction(store, { uid: "a", capacity: 12 });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already-enrolled");
  // A double-tapped button must not spend two seats.
  assert.equal(store.memberCount, 1);
  assert.equal(store.enrolledCount, 1);
});

test("an uncapped group is never full, because an open run cannot have one", () => {
  // `capacity === null` here means an ADMISSIONS group, where seats are
  // decided by allocation rather than by whoever clicks first. An open-mode
  // run refuses to exist with an uncapped group at all, and that refusal is
  // `groupCapacityError`'s job, not this one's.
  assert.equal(groupFullError({ name: "g", capacity: null, memberCount: 999 }), null);
  assert.equal(groupCapacityError(null, "open") !== null, true);
  assert.equal(groupCapacityError(null, "admissions"), null);
  assert.equal(groupCapacityError(MAX_OPEN_MODE_CAPACITY + 1, "open") !== null, true);
});

// ---------------------------------------------------------------------------
// Route shape
// ---------------------------------------------------------------------------

test("SOURCE — the enrol route rate limits before it reads anything", () => {
  // Throttling exists to cap COST, so it has to come before the work it is
  // protecting. The per-IP limit needs no identity, so it sits in front of the
  // session lookup's Auth RPC too.
  const post = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function POST"),
    ENROL_ROUTE.indexOf("async function subscribeToCohort"),
  );
  assert.ok(post.length > 0, "the POST handler is gone");
  const ipLimit = post.indexOf("courses:enrol:ip:");
  const session = post.indexOf("requireEnroller()");
  const runRead = post.indexOf("loadRun(");
  assert.ok(ipLimit > 0 && session > 0 && runRead > 0);
  assert.ok(ipLimit < session, "the IP limit no longer precedes the session lookup");
  assert.ok(session < runRead, "the session lookup no longer precedes the reads");
  assert.ok(
    post.indexOf("courses:enrol:uid:") < runRead,
    "the per-uid limit no longer precedes the reads",
  );
});

test("SOURCE — every mutating handler calls the view-as guard first", () => {
  // Also pinned repo-wide by tests/impersonation-guard.test.mjs; asserted here
  // too because this route writes in a MEMBER's own name, which is the case
  // that guard exists for.
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const at = ENROL_ROUTE.indexOf(`export async function ${method}(`);
    assert.ok(at > 0, `${method} is gone`);
    const head = ENROL_ROUTE.slice(at, at + 400);
    assert.match(head, /const blocked = await assertNotImpersonating\(\);/);
  }
  // The GET is a read and deliberately does NOT call it: view-as is a debug
  // tool for seeing what a member sees.
  const getAt = ENROL_ROUTE.indexOf("export async function GET(");
  const getBody = ENROL_ROUTE.slice(getAt, ENROL_ROUTE.indexOf("export async function POST"));
  assert.doesNotMatch(getBody, /assertNotImpersonating/);
});

test("SOURCE — the pause flag stops new sign-ups and nothing else", () => {
  // The admin panel's copy promises exactly this: "People already enrolled
  // keep their place and their access." A pause that also blocked a session
  // change or a drop-out would make that sentence false.
  const post = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function POST"),
    ENROL_ROUTE.indexOf("async function subscribeToCohort"),
  );
  assert.match(post, /isSurfacePaused\(notice, "courseEnrolments"\)/);
  const patch = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function PATCH"),
    ENROL_ROUTE.indexOf("export async function DELETE"),
  );
  const del = ENROL_ROUTE.slice(ENROL_ROUTE.indexOf("export async function DELETE"));
  assert.doesNotMatch(patch, /isSurfacePaused/);
  assert.doesNotMatch(del, /isSurfacePaused/);
});

test("SOURCE — the drop-out is behind a byte-exact typed confirmation", () => {
  const del = ENROL_ROUTE.slice(ENROL_ROUTE.indexOf("export async function DELETE"));
  // Nothing normalised away, the destroy routes' rule.
  assert.match(del, /body\.confirmName !== run\.courseTitle/);
  // An unnamed course cannot be confirmed by name: "" === "" would pass the
  // ritual on an empty body.
  assert.match(del, /run\.courseTitle\.length === 0/);
  // And it writes the audit row the enum actually has a member for.
  assert.match(del, /kind: "enrolment-dropout"/);
});

test("SOURCE — joining writes no audit row, because the enum has no kind for it", () => {
  const post = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function POST"),
    ENROL_ROUTE.indexOf("async function subscribeToCohort"),
  );
  // Inventing one would put a string in the log that `courseAuditKindLabel`
  // renders as "Unrecognised action"; the enrolment document is the record of
  // joining. Leaving destroys state, so leaving gets a row.
  assert.doesNotMatch(post, /COURSE_AUDIT_COLLECTION/);
});

test("SOURCE — deleting an account gives back the seats it was holding", () => {
  // Every writer of `enrolledCount` agrees on what it counts, or the counter
  // goes negative and the enrol-mode route refuses to reopen a run nobody is
  // on. The sweep's condition is the NARROW one, active AND selfEnrolled,
  // because decrementing for an allocated admissions learner, whose row
  // nothing ever counted, drives the counter negative.
  assert.match(ACCOUNT_DELETION, /if \(e\.selfEnrolled && e\.runId\)/);
  assert.match(ACCOUNT_DELETION, /enrolledCount: FieldValue\.increment\(-count\)/);
  // In the SAME batch as the enrolment deletes and the memberCount deltas, so
  // a counter can never survive the rows it summarises.
  // Anchored on the enrolment teardown specifically: `db.batch()` appears
  // several times in this file, and a slice from the first one would be
  // asserting about somebody else's step.
  const teardownAt = ACCOUNT_DELETION.indexOf("const seats = new Map<string, number>();");
  const block = ACCOUNT_DELETION.slice(
    teardownAt,
    ACCOUNT_DELETION.indexOf("await batch.commit();", teardownAt),
  );
  assert.ok(block.length > 0, "the enrolment teardown batch is gone");
  assert.match(block, /memberCount: FieldValue\.increment\(-count\)/);
  assert.match(block, /enrolledCount: FieldValue\.increment\(-count\)/);
  // A run deleted since the enrolment was written must not make the whole
  // batch reject and strand every row in it — the groups rule, applied to
  // runs.
  assert.match(ACCOUNT_DELETION, /if \(!liveRunIds\.has\(runId\)\) continue;/);
});

test("SOURCE — the enrol route moves both counters in the seat transaction", () => {
  const post = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function POST"),
    ENROL_ROUTE.indexOf("async function subscribeToCohort"),
  );
  assert.match(post, /memberCount: FieldValue\.increment\(1\)/);
  assert.match(post, /enrolledCount: FieldValue\.increment\(1\)/);
  assert.match(post, /selfEnrolled: true/);

  const del = ENROL_ROUTE.slice(ENROL_ROUTE.indexOf("export async function DELETE"));
  assert.match(del, /memberCount: FieldValue\.increment\(-1\)/);
  assert.match(del, /enrolledCount: FieldValue\.increment\(-1\)/);
  // And the run's counter moves only for a row it actually counted. An
  // allocated learner on a run since flipped to open mode was never counted
  // by `enrolledCount`, so uncounting them would drive it negative and wedge
  // the enrol-mode route.
  const selfGate = del.indexOf("if (row.selfEnrolled) {");
  const runDecrement = del.indexOf("enrolledCount: FieldValue.increment(-1)");
  assert.ok(selfGate > 0, "the drop-out decrements the run counter unconditionally");
  assert.ok(selfGate < runDecrement, "the decrement escaped its selfEnrolled gate");

  // Changing session moves the two GROUP counters and leaves the run's alone:
  // the member is still on the run.
  const patch = ENROL_ROUTE.slice(
    ENROL_ROUTE.indexOf("export async function PATCH"),
    ENROL_ROUTE.indexOf("export async function DELETE"),
  );
  assert.match(patch, /memberCount: FieldValue\.increment\(-1\)/);
  assert.match(patch, /memberCount: FieldValue\.increment\(1\)/);
  assert.doesNotMatch(patch, /enrolledCount/);
});

// ---------------------------------------------------------------------------
// The apply lane and the enrol lane do not overlap
// ---------------------------------------------------------------------------

test("SOURCE: the apply route refuses an open-enrolment run outright", () => {
  // The two date fields are the ENROLMENT window on an open run, so an open
  // run inside its dates passes `applicationWindow()` and would mint a
  // `courseApplications` row nothing in admissions ever reads: not the queue,
  // not the allocation board, not the decide route. The refusal comes BEFORE
  // the dates are consulted, because the dates are the thing that misleads.
  const at = APPLY_ROUTE.indexOf("function windowError(");
  assert.ok(at > 0, "the apply route's window predicate is gone");
  const fn = APPLY_ROUTE.slice(at, APPLY_ROUTE.indexOf("\n}", at));
  const modeCheck = fn.indexOf('run.enrolMode === "open"');
  const dateCheck = fn.indexOf("applicationWindow(");
  assert.ok(modeCheck > 0, "an open-mode run is no longer refused an application");
  assert.ok(
    modeCheck < dateCheck,
    "the mode check must precede the window read: the dates are what mislead",
  );
  // A sentence the applicant can act on, pointing at the surface that works.
  assert.match(fn, /doesn't take applications/);
});

test("SOURCE: the apply page sends an open-enrolment run to the picker", () => {
  // `getApplyContext` reads the window through `courseRunWindow()`, so an
  // open run in `applications-closed` or `running` reports `open` and used to
  // render a live application form whose submit the route refused.
  assert.match(FETCH_COURSES, /openEnrol: boolean;/);
  assert.match(FETCH_COURSES, /run\.enrolMode === "open"/);
  assert.match(
    FETCH_COURSES,
    /return \{ course, run, window, groups: \[\], openEnrol: true \};/,
  );
  assert.match(APPLY_PAGE, /if \(context\.openEnrol\) redirect\(/);
  // The redirect has to come before the form's own props are read, or the
  // page renders on the way past it.
  const redirectAt = APPLY_PAGE.indexOf("if (context.openEnrol) redirect(");
  const destructureAt = APPLY_PAGE.indexOf("const { course, run, groups, window } = context;");
  assert.ok(redirectAt > 0 && destructureAt > 0);
  assert.ok(redirectAt < destructureAt);
});

test("SOURCE: the enrol-mode gate counts rows, not the open-enrol counter", () => {
  // `enrolledCount` only ever tracked open-enrolment seats, so an ADMISSIONS
  // run holding a hundred allocated learners reads 0 through it. Trusting it
  // here is how the flip strands a whole cohort on a run whose admissions
  // surfaces stop reading applications.
  assert.match(ENROL_MODE_ROUTE, /\.collection\("courseEnrolments"\)/);
  assert.match(ENROL_MODE_ROUTE, /\.where\("runId", "==", runId\)/);
  assert.match(ENROL_MODE_ROUTE, /\.where\("status", "==", "active"\)/);
  assert.match(ENROL_MODE_ROUTE, /\.count\(\)\.get\(\)/);
  // Facilitator rows are active enrolments and are legitimate in either mode,
  // so a run whose staff were appointed before it opened stays flippable.
  assert.match(ENROL_MODE_ROUTE, /\.where\("role", "==", "facilitator"\)/);
  // And nothing reads the stale counter off the run document any more.
  assert.doesNotMatch(ENROL_MODE_ROUTE, /data\.enrolledCount/);
});

test("SOURCE: the picker read is gated on the run, and throttled", () => {
  // `fetchGroupPicker` runs on the Admin SDK, so this handler is the whole
  // access decision for a read-restricted collection: without the gate, any
  // signed-in account could name any run id and get its timetable and seat
  // counts back, including an admissions run whose groups are staff working
  // material until allocation publishes them.
  const getAt = ENROL_ROUTE.indexOf("export async function GET(");
  const get = ENROL_ROUTE.slice(getAt, ENROL_ROUTE.indexOf("export async function POST"));
  assert.ok(get.length > 0, "the GET handler is gone");
  const limitAt = get.indexOf("courses:enrol:read:uid:");
  const runAt = get.indexOf("loadRun(");
  const fetchAt = get.indexOf("fetchGroupPicker(");
  assert.ok(limitAt > 0, "the picker read takes no per-account budget");
  assert.ok(runAt > 0 && limitAt < runAt, "the throttle no longer precedes the reads");
  assert.ok(runAt < fetchAt, "the run is no longer read before the slots are handed out");
  assert.match(get, /run\.enrolMode === "open" && enrolWindow\(run, new Date\(\)\)\.state !== "inactive"/);
  assert.match(get, /offering \? fetchGroupPicker\(runId\) : Promise\.resolve/);
  // The caller's OWN row still comes back on a run that is not offering: this
  // call is also how a member learns where they stand.
  assert.match(get, /\.doc\(courseEnrolmentId\(runId, user\.uid\)\)\.get\(\)/);
});

test("SOURCE: the post-drop confirmation outlives the card that did the drop", () => {
  // The drop triggers a re-read; the row comes back `withdrawn`; the branch
  // that renders DropOutCard is gone, and with it any confirmation the card
  // held itself. So the card hands the feedback URL up and renders nothing
  // after the commit.
  assert.match(DROP_OUT_CARD, /onDropped: \(feedbackUrl: string\) => void;/);
  assert.match(DROP_OUT_CARD, /onDropped\(body\?\.feedbackUrl \?\? ""\);/);
  assert.doesNotMatch(DROP_OUT_CARD, /setFeedbackUrl/);
  assert.doesNotMatch(DROP_OUT_CARD, /You&apos;re off the course/);

  // And the picker's "you came off this course" branch is where it lands.
  assert.match(GROUP_PICKER, /const \[justLeft, setJustLeft\] = useState<string \| null>\(null\);/);
  assert.match(GROUP_PICKER, /setJustLeft\(url\);/);
  const leftAt = GROUP_PICKER.indexOf("  if (enrolment) {");
  assert.ok(leftAt > 0, "the picker's already-left branch is gone");
  const left = GROUP_PICKER.slice(leftAt);
  assert.match(left, /You&apos;re off the course/);
  assert.match(left, /href=\{justLeft\}/);
  assert.match(left, /tell us anonymously what got in the way/);
});

// ---------------------------------------------------------------------------
// The way back
// ---------------------------------------------------------------------------

test("SOURCE: reinstating exists, and is the repair the copy promises", () => {
  // The drop-out copy says the team can put somebody back. The allocation
  // board cannot: it refuses any uid whose application is not `accepted`, and
  // a self-enrolled member never had one. So the promise needed a route.
  assert.match(REINSTATE_ROUTE, /export async function POST\(/);
  // Guarded first, like every mutating course route (and pinned repo-wide by
  // tests/impersonation-guard.test.mjs).
  const head = REINSTATE_ROUTE.slice(
    REINSTATE_ROUTE.indexOf("export async function POST("),
    REINSTATE_ROUTE.indexOf("export async function POST(") + 400,
  );
  assert.match(head, /const blocked = await assertNotImpersonating\(\);/);
  // Admins and the run's track leads: the remove route's gate, because
  // reinstating is its exact inverse.
  assert.match(REINSTATE_ROUTE, /run\.trackLeadUids\.includes\(actor\.uid\)/);

  // Withdrawn AND self-enrolled only. A `removed` row was staff's own
  // decision and is undone on the board; an allocated learner was never
  // counted by `enrolledCount`, so re-incrementing it for one would inflate
  // the number the enrol-mode route reads.
  assert.match(REINSTATE_ROUTE, /row\.status !== "withdrawn"/);
  assert.match(REINSTATE_ROUTE, /!row\.selfEnrolled/);

  // One transaction, both counters, and a hard capacity check against the
  // count read inside it: somebody else may have taken the seat.
  assert.match(REINSTATE_ROUTE, /db\.runTransaction\(/);
  assert.match(REINSTATE_ROUTE, /groupFullError\(/);
  assert.match(REINSTATE_ROUTE, /memberCount: FieldValue\.increment\(1\)/);
  assert.match(REINSTATE_ROUTE, /enrolledCount: FieldValue\.increment\(1\)/);
  // Idempotent: a double-clicked button must not spend a second seat.
  assert.match(REINSTATE_ROUTE, /if \(row\.status === "active"\) return;/);
});

test("SOURCE: the drop-out no longer points at the allocation board", () => {
  // It did, and the board refuses these rows outright, so the comment sent a
  // reader to a repair that does not work.
  const del = ENROL_ROUTE.slice(ENROL_ROUTE.indexOf("// DELETE"));
  assert.doesNotMatch(ENROL_ROUTE, /Staff can still re-place someone/);
  assert.match(del, /reinstate/);
});
