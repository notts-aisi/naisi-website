/**
 * The stage release: the boundary that decides whether a question is served,
 * and the job that announces it once it has been.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing here
 *
 *  1. **The verify line of the PR, on the real serialiser.** A stage whose
 *     release date has passed goes out WITH its questions; one still ahead
 *     goes out as `{ id, label, order, releasesAt }` and has never had a
 *     `questions` key at any point in its construction. That is the whole
 *     fairness promise of a weekly-questions round.
 *  2. **The announcement's audience.** Draft and submitted, never withdrawn
 *     and never decided. Getting this wrong in the other direction (leaving
 *     out the people who submitted stage one) is the unforgivable version.
 *  3. **Exactly once, per person.** One marker per RECIPIENT, claimed before
 *     that person's send and stamped after it. A second run sends nothing, a
 *     manual release followed by a tick sends nothing twice, an interrupted
 *     run reaches only the people it did not get to, and a round far bigger
 *     than one tick is fully mailed rather than being given up on when the
 *     three-attempt budget runs out.
 *  4. **The stale rule and the round gate**, because both are policies about
 *     what NOT to do, and a policy nobody executes is a comment.
 *  5. **The push leg**, settled by the owner on 6 September 2026 and sent
 *     through the shared mirror. Executed here rather than reasoned about,
 *     because the properties that matter are all about ORDER: one push per
 *     email and only after it, inside the same claim so a retried tick
 *     repeats neither, and a push service having a bad day costing the push
 *     and never the stamp (an unstamped marker is a re-claim, and a re-claim
 *     is a second email).
 *
 * ## The fake Firestore
 *
 * A double, not the emulator: `npm test` has no emulator and must not reach a
 * project. It implements what the handler uses (doc get / create / set with
 * merge, subcollections, an equality query with a limit and a cursor, and a
 * transaction) and nothing else. The email send, the suppression list and the
 * Admin SDK are stubbed at the module boundary, so no test in this file can
 * put mail on the wire.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SERVER_TIMESTAMP = "__serverTimestamp__";

/** The doors to the outside world, replaced. Same set as the reminders suite. */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      `  serverTimestamp: () => ({ __sentinel: "${SERVER_TIMESTAMP}" }),\n` +
      "};\n" +
      // Only `courseFacilitatorEmails.ts` reaches for this, and only on paths
      // no test here executes. It exists so the module loads at all.
      "export class Timestamp {\n" +
      "  constructor(date) { this._date = date; }\n" +
      "  static fromDate(date) { return new Timestamp(date); }\n" +
      "  toDate() { return this._date; }\n" +
      "}\n" +
      // The registry imports every registered job, and a job that keeps a
      // resume cursor addresses its own row on that document by field path.
      // Exported so this suite still loads once such a job is registered.
      "export class FieldPath {\n" +
      "  constructor(...segments) { this.segments = segments; }\n" +
      "}",
  ],
  ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
  [
    "@/lib/firestore/suppression",
    "export const isSuppressed = async (db, to) => {\n" +
      "  if (globalThis.__suppressionError) throw new Error(globalThis.__suppressionError);\n" +
      "  return (globalThis.__suppressed ?? new Set()).has(to);\n" +
      "};\n" +
      // Reached only by `courseFacilitatorEmails.ts`, which is loaded whole for
      // the opt-out predicate's own test. No test here calls it.
      "export const filterSuppressed = async (db, addresses) => addresses;",
  ],
  [
    "@/lib/email/courseFacilitatorEmails",
    "export const hasOptedOutOfCourseAnnouncements = (data) =>\n" +
      "  data?.profile?.notifications?.categories?.courses === false;\n" +
      "export const memberNameOf = (data) =>\n" +
      "  (typeof data?.profile?.preferredName === 'string' && data.profile.preferredName) ||\n" +
      "  (typeof data?.displayName === 'string' && data.displayName) || '';",
  ],
  // The transport. `lib/email/admissionEmails.ts` is loaded FOR REAL further
  // down (its token contract is imported rather than pattern-matched), and it
  // imports the Resend send path along with the six templates: a real `./send`
  // in this graph could put mail on the wire. The templates themselves are the
  // real ones, compiled by the shared loader; they were stubbed here only
  // because a hand-copied loader could not read JSX, and a stub that stands in
  // for a file nothing can read is a file nothing ever checks. The stub of
  // `admissionEmails` itself, below, is what the JOB imports.
  ["./send", "export async function sendEmail() {}"],
  ["@/lib/firebase/session", "export async function getCurrentUser() { return null; }"],
  [
    "@/lib/email/admissionEmails",
    // Both halves, because the job builds its email link from one and its
    // push destination from the other, and the point of the pair is that they
    // cannot drift: the real `admissionApplicationUrl` is
    // `${base}${admissionApplicationPath(...)}`, and the stub keeps that.
    "export const admissionApplicationPath = (roundId, surface) =>\n" +
      "  `/${surface === 'apply' ? 'apply' : 'applications'}/${roundId}`;\n" +
      "export const admissionApplicationUrl = (roundId, surface) =>\n" +
      "  `https://naisi.uk${admissionApplicationPath(roundId, surface)}`;\n" +
      "export const sendAdmissionEmail = async (opts) => {\n" +
      "  const sends = (globalThis.__sends ??= []);\n" +
      "  sends.push(opts);\n" +
      "  return globalThis.__sendHook ? globalThis.__sendHook(opts) : 'sent';\n" +
      "};",
  ],
  // The worksheet due-soon reminders job's two doors. Nothing here runs it,
  // but `registry.ts` imports every job by value, so its email door (which
  // reaches a `.tsx`) and its push mirror (whose graph imports `Timestamp` as
  // a value) are both in this suite's module graph.
  [
    "@/lib/email/worksheetReminderEmails",
    "export const worksheetRespondPath = () => '';\n" +
      "export const worksheetDueSoonSubject = () => '';\n" +
      "export const formatWorksheetDue = () => '';\n" +
      "export const sendWorksheetDueSoonEmail = async () => 'sent';",
  ],
  ["@/lib/push/taskNotifications", "export const mirrorTaskEmailToPush = async () => {};"],
  // The push door. Stubbed for the same reason the email transport is: this
  // suite must put nothing on the wire. What it records is the HANDOFF, which
  // is all this job is responsible for; the mirror's own gates (the VAPID
  // check, the `courses` push switch, the subscriptions query, the prune)
  // are executed for real against a fake push service in
  // `tests/push-preferences.test.mjs`, which also pins that this job reaches
  // for this exact door rather than building one.
  [
    "@/lib/push/courseNotifications",
    "export const mirrorCourseDecisionToPush = async (uid, note) => {\n" +
      "  if (globalThis.__pushThrows) throw new Error(globalThis.__pushThrows);\n" +
      // The deviceless case: the real mirror returns having sent nothing, and
      // is indistinguishable from a delivered push to its caller.
      "  if (globalThis.__pushSilent) return;\n" +
      "  (globalThis.__pushes ??= []).push({ uid, ...note });\n" +
      "};",
  ],
]);

const { loadTs } = createLoader({ stubs: STUBS });

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

/** For pins that must read the CODE: this file explains itself at length. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code.
// ---------------------------------------------------------------------------

const apply = await loadTs("lib/admissions/applyRoutes.ts");
const { isStageReleased } = await loadTs("lib/admissions/stageRelease.ts");
const {
  ADMISSIONS_STAGE_RELEASE_JOB_ID,
  NOTIFIED_STATUSES,
  admissionsStageReleaseJob,
  runAdmissionsStageRelease,
  stageAnnouncedAt,
} = await loadTs("lib/scheduler/jobs/admissionsStageRelease.ts");
const { policyFor } = await loadTs("lib/scheduler/registry.ts");
const emails = await loadTs("lib/firestore/courseEmails.ts");
const sendHelper = await loadTs("lib/email/admissionEmails.ts");
const samples = await loadTs("features/admin/emailDesigns/courseEmailSamples.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUND_ID = "autumn-2026-intake__k3f9a2b1";
const STAGE_ID = "s2";

/** Inside the round's window, and two hours after stage two's release. */
const AFTER_RELEASE = new Date("2026-10-05T10:00:00.000Z");

function round(overrides = {}) {
  return {
    kind: "enrolment",
    label: "Autumn 2026 intake",
    status: "open",
    archived: false,
    opensAt: new Date("2026-09-21T08:00:00.000Z"),
    closesAt: new Date("2026-10-18T22:59:00.000Z"),
    stageIds: ["s1", "s2"],
    ...overrides,
  };
}

function stage(overrides = {}) {
  return {
    roundId: ROUND_ID,
    label: "Stage 2",
    intro: "The technical exercise.",
    questions: [
      { id: "q1", type: "longText", label: "Recreate a paper", required: true },
    ],
    // 5 October 2026, 09:00 London (BST) is 08:00 UTC.
    releaseAt: "2026-10-05",
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: true,
    order: 1,
    ...overrides,
  };
}

function application(uid, overrides = {}) {
  return {
    roundId: ROUND_ID,
    uid,
    email: `${uid}@example.com`,
    displayName: `Applicant ${uid}`,
    status: "draft",
    ...overrides,
  };
}

/** Applications keyed the way `admissionApplicationId` keys them. */
function applications(count, overrides = () => ({})) {
  const rows = {};
  for (let i = 1; i <= count; i += 1) {
    const uid = `uid${String(i).padStart(3, "0")}`;
    rows[`${ROUND_ID}__${uid}`] = application(uid, overrides(uid, i));
  }
  return rows;
}

function users(count, overrides = () => ({})) {
  const rows = {};
  for (let i = 1; i <= count; i += 1) {
    const uid = `uid${String(i).padStart(3, "0")}`;
    rows[uid] = {
      email: `${uid}@example.com`,
      displayName: `Applicant ${uid}`,
      ...overrides(uid, i),
    };
  }
  return rows;
}

const STAGES_PATH = `admissionRounds/${ROUND_ID}/stages`;
/** The STAGE-level marker, which now records one thing only: a stale verdict. */
const STALE_MARKER_ID = `stagerel__${ROUND_ID}__${STAGE_ID}`;
/** One person's copy of the notice. */
const markerFor = (uid) => `stagerel__${ROUND_ID}__${STAGE_ID}__${uid}`;

/** The world the job runs against: one open round, one released stage, N rows. */
function world({ stages = { [STAGE_ID]: stage() }, apps = 3, roundOverrides = {} } = {}) {
  const rows = typeof apps === "number" ? applications(apps) : apps;
  const count = typeof apps === "number" ? apps : Object.keys(rows).length;
  return {
    admissionRounds: { [ROUND_ID]: round(roundOverrides) },
    [STAGES_PATH]: stages,
    admissionApplications: rows,
    users: users(Math.max(count, 3)),
  };
}

// ---------------------------------------------------------------------------
// 1. The release boundary, on the real serialiser (the PR's verify line)
// ---------------------------------------------------------------------------

describe("what a stage is served as", () => {
  const r = round();

  test("a release date in the PAST is served with its questions", () => {
    const wire = apply.serialiseStageForApplicant(stage(), r, AFTER_RELEASE);
    assert.equal(wire.released, true);
    assert.equal(wire.questions.length, 1);
    assert.equal(wire.questions[0].label, "Recreate a paper");
  });

  test("a release date in the FUTURE is served with no questions key", () => {
    // Two days before the stage opens, and inside the round's window: the
    // applicant can see that a second part exists and when it lands, and
    // nothing else.
    const before = new Date("2026-10-03T10:00:00.000Z");
    const wire = apply.serialiseStageForApplicant(stage(), r, before);

    assert.equal(wire.released, false);
    assert.deepEqual(Object.keys(wire).sort(), [
      "id",
      "label",
      "order",
      "released",
      "releasesAt",
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(wire, "questions"),
      false,
      "an unreleased stage carried a questions key",
    );
    assert.equal(wire.releasesAt, "2026-10-05T08:00:00.000Z");
    assert.equal(
      JSON.stringify(wire).includes("Recreate a paper"),
      false,
      "the question text rode out on an unreleased stage",
    );
  });

  test("a manual release brings the questions forward, and only forward", () => {
    const early = new Date("2026-10-01T10:00:00.000Z");
    const released = stage({ manualReleasedAt: new Date("2026-10-01T09:00:00.000Z") });
    assert.equal(isStageReleased(released, r, early), true);
    // The schedule alone would still be refusing it.
    assert.equal(isStageReleased(stage(), r, early), false);
  });
});

// ---------------------------------------------------------------------------
// 2. The fake Firestore
// ---------------------------------------------------------------------------

function alreadyExists(id) {
  const err = new Error(`already exists: ${id}`);
  err.code = 6;
  return err;
}

function makeDb(seed = {}) {
  /** collection path -> id -> { data, version } */
  const store = new Map();
  const stats = { queries: 0, creates: 0, sets: 0 };

  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };

  for (const [name, rows] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(rows)) {
      col(name).set(id, { data: { ...data }, version: 1 });
    }
  }

  const resolveValue = (value) =>
    value !== null && typeof value === "object" && value.__sentinel === SERVER_TIMESTAMP
      ? new Date()
      : value;

  function applyWrite(name, id, data, merge) {
    const resolved = {};
    for (const [key, value] of Object.entries(data)) resolved[key] = resolveValue(value);
    const current = col(name).get(id);
    col(name).set(id, {
      data: merge && current ? { ...current.data, ...resolved } : resolved,
      version: (current?.version ?? 0) + 1,
    });
  }

  const snapshotOf = (name, id) => {
    const row = col(name).get(id);
    return {
      id,
      exists: row !== undefined,
      data: () => (row === undefined ? undefined : { ...row.data }),
    };
  };

  function docRef(name, id) {
    return {
      id,
      // Subcollections are flat paths here: `admissionRounds/{id}/stages`.
      collection: (sub) => collectionRef(`${name}/${id}/${sub}`),
      async create(data) {
        stats.creates += 1;
        await Promise.resolve();
        globalThis.__createHook?.(name, id, data);
        if (col(name).has(id)) throw alreadyExists(id);
        applyWrite(name, id, data, false);
      },
      async set(data, options) {
        stats.sets += 1;
        await Promise.resolve();
        globalThis.__setHook?.(name, id, data);
        applyWrite(name, id, data, options?.merge === true);
      },
      async get() {
        await Promise.resolve();
        globalThis.__getHook?.(name, id);
        return snapshotOf(name, id);
      },
    };
  }

  function query(name, filters, limit, after) {
    return {
      where: (field, op, value) => {
        assert.equal(op, "==", "the fake only serves equality filters, as the job does");
        return query(name, [...filters, [field, value]], limit, after);
      },
      limit: (n) => query(name, filters, n, after),
      startAfter: (snap) => query(name, filters, limit, snap.id),
      async get() {
        stats.queries += 1;
        await Promise.resolve();
        globalThis.__queryHook?.(name, filters);
        // Sorted by id: Firestore's own default order for a query with no
        // `orderBy`, which is what the job's resume cursor is expressed in.
        let ids = [...col(name).keys()].sort();
        if (after !== null && after !== undefined) ids = ids.filter((id) => id > after);
        const docs = ids
          .filter((id) =>
            filters.every(([field, value]) => col(name).get(id).data[field] === value),
          )
          .slice(0, limit ?? Infinity)
          .map((id) => snapshotOf(name, id));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  function collectionRef(name) {
    return {
      doc: (id) => docRef(name, id),
      where: (field, op, value) => query(name, [], null, null).where(field, op, value),
      limit: (n) => query(name, [], n, null),
      // A bare `.get()` on a collection: what the stage loader does.
      async get() {
        stats.queries += 1;
        await Promise.resolve();
        globalThis.__queryHook?.(name, []);
        const docs = [...col(name).keys()].sort().map((id) => snapshotOf(name, id));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  return {
    collection: collectionRef,
    async runTransaction(body) {
      const writes = [];
      const result = await body({
        async get(ref) {
          await Promise.resolve();
          return ref.get();
        },
        set(ref, data, options) {
          writes.push([ref, data, options?.merge === true]);
        },
      });
      for (const [ref, data, merge] of writes) await ref.set(data, { merge });
      return result;
    },
    stats,
    read: (name, id) => {
      const row = col(name).get(id);
      return row === undefined ? null : { ...row.data };
    },
    /** Reach in and edit a stored row, to age a marker's claim. */
    patch: (name, id, data) => applyWrite(name, id, data, true),
    ids: (name) => [...col(name).keys()].sort(),
  };
}

function context({
  now = AFTER_RELEASE,
  maxPerTick = admissionsStageReleaseJob.maxPerTick,
  remainingMs = 60_000,
} = {}) {
  const logged = [];
  return {
    ctx: {
      now,
      budget: { remainingMs: () => remainingMs, expired: () => remainingMs <= 0 },
      log: (message, extra) => logged.push([message, extra]),
      policy: policyFor(admissionsStageReleaseJob),
      maxPerTick,
      maxLateHours: admissionsStageReleaseJob.maxLateHours,
    },
    logged,
  };
}

function reset(db) {
  globalThis.__db = db;
  globalThis.__sends = [];
  globalThis.__pushes = [];
  globalThis.__pushThrows = null;
  globalThis.__pushSilent = false;
  globalThis.__suppressed = new Set();
  globalThis.__sendHook = null;
  globalThis.__suppressionError = null;
  globalThis.__createHook = null;
  globalThis.__setHook = null;
  globalThis.__getHook = null;
  globalThis.__queryHook = null;
}

const uidsSent = () => globalThis.__sends.map((send) => send.uid).sort();
const uidsPushed = () => globalThis.__pushes.map((push) => push.uid).sort();

// ---------------------------------------------------------------------------
// 3. The job
// ---------------------------------------------------------------------------

describe("the stage release job", () => {
  test("mails everybody live on the round once, and stamps the marker", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);

    const { result, summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 3);
    assert.equal(summary.stages, 1);
    assert.equal(summary.rounds, 1);
    assert.equal(summary.failures.length, 0);
    assert.equal(result.hasMore, false);

    const first = globalThis.__sends[0];
    assert.equal(first.kind, "stage-released");
    assert.equal(first.roundLabel, "Autumn 2026 intake");
    assert.equal(first.stageLabel, "Stage 2");
    // The FORM, because the new questions are answered there.
    assert.match(first.applicationUrl, /\/apply\//);
    assert.ok(first.deadline, "the deadline token was not supplied");

    // ONE MARKER PER PERSON, each claimed and stamped. No stage-level marker:
    // the stage-wide id now records a stale verdict and nothing else.
    assert.deepEqual(
      db.ids("schedulerMarkers"),
      ["uid001", "uid002", "uid003"].map(markerFor),
    );
    const marker = db.read("schedulerMarkers", markerFor("uid001"));
    assert.ok(marker, "the announcement left no marker");
    assert.equal(marker.job, ADMISSIONS_STAGE_RELEASE_JOB_ID);
    assert.ok(marker.sentAt instanceof Date, "the marker was never stamped");
    assert.ok(marker.expiresAt instanceof Date, "a settled marker has no TTL horizon");
    // Every id component is a field, so a sweep never parses ids.
    assert.equal(marker.roundId, ROUND_ID);
    assert.equal(marker.stageId, STAGE_ID);
    assert.equal(marker.uid, "uid001");
  });

  test("submitted applications are in the audience; withdrawn and decided are not", async () => {
    // The people who sent stage one weeks ago are exactly who this is for.
    const rows = {
      [`${ROUND_ID}__uid001`]: application("uid001", { status: "draft" }),
      [`${ROUND_ID}__uid002`]: application("uid002", { status: "submitted" }),
      [`${ROUND_ID}__uid003`]: application("uid003", { status: "withdrawn" }),
      [`${ROUND_ID}__uid004`]: application("uid004", { status: "rejected" }),
      [`${ROUND_ID}__uid005`]: application("uid005", { status: "accepted" }),
    };
    const db = makeDb(world({ apps: rows }));
    reset(db);

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(uidsSent(), ["uid001", "uid002"]);
    assert.equal(summary.sent, 2);
    assert.deepEqual([...NOTIFIED_STATUSES].sort(), ["draft", "submitted"]);
  });

  test("a second run sends nothing, however many times it is asked", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);

    await runAdmissionsStageRelease(context().ctx);
    globalThis.__sends = [];
    const { summary } = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T14:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "the second run re-announced the stage");
    assert.equal(summary.sent, 0);
  });

  test("the marker is claimed BEFORE the first send, not after it", async () => {
    // Checked from inside the send: the order has to be a fact about the run,
    // not about where two lines sit in a file.
    const db = makeDb(world({ apps: 1 }));
    reset(db);
    let markerDuringSend = null;
    globalThis.__sendHook = () => {
      markerDuringSend = db.read("schedulerMarkers", markerFor("uid001"));
      return "sent";
    };

    await runAdmissionsStageRelease(context().ctx);

    assert.ok(markerDuringSend, "the send ran with no marker claimed");
    assert.ok(markerDuringSend.claimedAt instanceof Date);
    assert.equal(markerDuringSend.sentAt, null, "the marker was stamped before the send");
  });

  test("a release four days old is stamped stale and mails nobody", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);

    const { summary } = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-09T10:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "a stale announcement went out anyway");
    assert.equal(summary.stale, 1);
    assert.equal(summary.sent, 0);
    assert.deepEqual(db.ids("schedulerMarkers"), [STALE_MARKER_ID]);
    const marker = db.read("schedulerMarkers", STALE_MARKER_ID);
    assert.equal(marker.skippedReason, "stale");
    assert.equal(marker.sentAt, null);
    // Recorded, never claimed: a verdict must not spend one of the unit's
    // three attempts, which is the bug the per-recipient markers exist to fix.
    assert.equal(marker.attempts, 0, "the stale verdict consumed a claim attempt");
    assert.ok(marker.expiresAt instanceof Date, "a settled marker has no TTL horizon");

    // A second tick re-derives the same verdict and writes nothing new.
    const before = db.stats.creates;
    await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-09T12:00:00.000Z") }).ctx,
    );
    assert.equal(db.read("schedulerMarkers", STALE_MARKER_ID).attempts, 0);
    assert.ok(db.stats.creates > before, "the second run did not try the create");
  });

  test("the boundary is 72 hours, so a stage two days old is still announced", async () => {
    const db = makeDb(world({ apps: 1 }));
    reset(db);

    const { summary } = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-07T08:00:00.000Z") }).ctx,
    );

    assert.equal(summary.sent, 1, "an announcement well inside the window was dropped");
    assert.equal(admissionsStageReleaseJob.maxLateHours, 72);
  });

  test("a stage still ahead of its release is not announced at all", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);

    const { summary } = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-03T10:00:00.000Z") }).ctx,
    );

    assert.equal(summary.sent, 0);
    assert.deepEqual(db.ids("schedulerMarkers"), [], "an unreleased stage was claimed");
  });

  test("a stage that opens with the round announces nothing and claims nothing", async () => {
    // `releaseAt: null` means "this stage is the form". The round's own
    // opening was the news; a "stage one is open" email to somebody halfway
    // through writing it is noise.
    const db = makeDb(
      world({ stages: { s1: stage({ id: "s1", label: "Stage 1", releaseAt: null, order: 0 }) } }),
    );
    reset(db);

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 0);
    assert.deepEqual(db.ids("schedulerMarkers"), []);
    assert.equal(stageAnnouncedAt(stage({ releaseAt: null }), round()), null);
  });

  test("a manual release followed by a tick sends exactly one email each", async () => {
    // The two lanes share a marker precisely so this cannot double up.
    const db = makeDb(
      world({
        apps: 2,
        stages: {
          [STAGE_ID]: stage({ manualReleasedAt: new Date("2026-10-05T09:30:00.000Z") }),
        },
      }),
    );
    reset(db);

    // The release button: the same handler, scoped to one stage.
    const manual = await runAdmissionsStageRelease(context().ctx, {
      roundId: ROUND_ID,
      stageId: STAGE_ID,
    });
    assert.equal(manual.summary.sent, 2);

    globalThis.__sends = [];
    const tick = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T10:15:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "the tick mailed the round a second time");
    assert.equal(tick.summary.sent, 0);
  });

  test("a scoped run reaches only the stage it was given", async () => {
    const db = makeDb(
      world({
        apps: 2,
        stages: {
          s1: stage({ label: "Stage 1", order: 0, releaseAt: "2026-10-04" }),
          [STAGE_ID]: stage(),
        },
      }),
    );
    reset(db);

    await runAdmissionsStageRelease(context().ctx, {
      roundId: ROUND_ID,
      stageId: STAGE_ID,
    });

    assert.deepEqual(
      db.ids("schedulerMarkers"),
      ["uid001", "uid002"].map(markerFor),
    );
    assert.equal(globalThis.__sends.every((send) => send.stageLabel === "Stage 2"), true);
  });

  test("the ceiling stops the run, and the next one reaches only the rest", async () => {
    const db = makeDb(world({ apps: 5 }));
    reset(db);

    const { result, summary } = await runAdmissionsStageRelease(
      context({ maxPerTick: 2 }).ctx,
    );

    assert.equal(summary.sent, 2);
    assert.equal(result.hasMore, true, "a capped run must ask the tick to come back");
    // Only the people actually mailed carry a marker. There is nothing
    // stage-level left claimed, so nothing has to be aged or recovered.
    assert.deepEqual(db.ids("schedulerMarkers"), ["uid001", "uid002"].map(markerFor));

    globalThis.__sends = [];
    const second = await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(uidsSent(), ["uid003", "uid004", "uid005"]);
    assert.equal(second.summary.sent, 3);
    assert.equal(second.reason, null, "a full tick reports no single verdict");
    for (const uid of ["uid001", "uid002", "uid003", "uid004", "uid005"]) {
      assert.ok(
        db.read("schedulerMarkers", markerFor(uid)).sentAt instanceof Date,
        `${uid} was left unstamped`,
      );
    }
  });

  test("a round far bigger than one tick is fully mailed, not given up on", async () => {
    // THE REGRESSION. A stage-wide marker gave the whole round ONE
    // three-attempt budget, so a round needing more than three partial runs
    // was stamped failedAt with a "no send" error it had not had and the last
    // applicants were never told. Per-recipient markers make the budget
    // per person, so the number of partial runs stops mattering.
    const db = makeDb(world({ apps: 12 }));
    reset(db);

    for (let run = 0; run < 6; run += 1) {
      await runAdmissionsStageRelease(context({ maxPerTick: 2 }).ctx);
    }

    assert.equal(globalThis.__sends.length, 12, "somebody was mailed twice or not at all");
    assert.equal(new Set(uidsSent()).size, 12);
    const failed = db
      .ids("schedulerMarkers")
      .filter((id) => db.read("schedulerMarkers", id).failedAt !== null);
    assert.deepEqual(failed, [], "a marker was given up on");
  });

  test("nothing writes a resume cursor onto a shared document any more", async () => {
    // The second half of the same bug: one document written once per
    // recipient, against Firestore's per-document write ceiling, with the
    // write swallowed on failure. A cursor that silently stopped moving
    // re-mailed everybody behind it on the next claim.
    const db = makeDb(world({ apps: 4 }));
    reset(db);
    const writesPerDoc = new Map();
    globalThis.__setHook = (name, id) => {
      const key = `${name}/${id}`;
      writesPerDoc.set(key, (writesPerDoc.get(key) ?? 0) + 1);
    };

    await runAdmissionsStageRelease(context().ctx);

    for (const [key, count] of writesPerDoc) {
      assert.ok(count <= 2, `${key} was written ${count} times in one run`);
    }
    assert.ok(!/cursorId/.test(source(JOB_FILE)), "the resume cursor is still there");
  });

  test("the audience pages, so a round bigger than one page is fully reached", async () => {
    const count = 150;
    const db = makeDb(world({ apps: applications(count) }));
    reset(db);

    const { result, summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, count);
    assert.equal(result.hasMore, false);
    assert.ok(db.stats.queries >= 2, "one page was read, so the cursor did nothing");
  });

  test("a suppressed address is skipped and never mailed", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(uidsSent(), ["uid002"]);
    assert.equal(summary.skipped, 1);
  });

  test("an explicit courses opt-out is honoured; an unanswered one is not a refusal", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    db.patch("users", "uid001", {
      profile: { notifications: { categories: { courses: false } } },
    });

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(uidsSent(), ["uid002"]);
    assert.equal(summary.skipped, 1);
  });

  test("one bad recipient does not cost the people behind them", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);
    globalThis.__sendHook = (opts) => {
      if (opts.uid === "uid002") throw new Error("resend said no");
      return "sent";
    };

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 2);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].uid, "uid002");
    // Left RECLAIMABLE, which is the whole gain of a per-recipient marker: the
    // one person whose send failed is retried on a later tick, and the two who
    // got theirs are stamped and safe from a second copy.
    const failedMarker = db.read("schedulerMarkers", markerFor("uid002"));
    assert.equal(failedMarker.sentAt, null);
    assert.equal(failedMarker.skippedReason, null);
    assert.match(failedMarker.lastError, /resend said no/);
    for (const uid of ["uid001", "uid003"]) {
      assert.ok(db.read("schedulerMarkers", markerFor(uid)).sentAt instanceof Date);
    }

    // The proof: age that one claim and run again. Only they are re-sent.
    db.patch("schedulerMarkers", markerFor("uid002"), {
      claimedAt: new Date(Date.now() - 60 * 60_000),
    });
    globalThis.__sendHook = null;
    globalThis.__sends = [];
    await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T12:00:00.000Z") }).ctx,
    );
    assert.deepEqual(uidsSent(), ["uid002"]);
  });

  test("a round that is not open is left alone", async () => {
    for (const overrides of [
      { status: "closed" },
      { status: "draft" },
      { status: "cancelled" },
      { archived: true },
      { closesAt: new Date("2026-10-01T22:59:00.000Z") },
    ]) {
      const db = makeDb(world({ apps: 2, roundOverrides: overrides }));
      reset(db);
      await runAdmissionsStageRelease(context().ctx);
      assert.equal(
        globalThis.__sends.length,
        0,
        `a round with ${JSON.stringify(overrides)} was mailed`,
      );
      assert.deepEqual(db.ids("schedulerMarkers"), []);
    }
  });

  test("a stamp that will not stick still cannot become a second announcement", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    let stampAttempts = 0;
    globalThis.__setHook = (name, id, data) => {
      if (name !== "schedulerMarkers" || !("sentAt" in data) || data.sentAt === null) return;
      stampAttempts += 1;
      throw new Error("firestore refused the stamp");
    };

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 2);
    // Two recipients, two attempts each: the stamp is retried exactly once.
    assert.equal(stampAttempts, 4, "the stamp was not retried exactly once per person");
    for (const uid of ["uid001", "uid002"]) {
      assert.equal(
        db.read("schedulerMarkers", markerFor(uid)).skippedReason,
        "sent-unstamped",
      );
    }

    // The proof: a later run, with the writes working again, sends nothing.
    globalThis.__setHook = null;
    globalThis.__sends = [];
    await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-06T09:00:00.000Z") }).ctx,
    );
    assert.equal(globalThis.__sends.length, 0, "the round was announced twice");
  });

  test("a page of applicants that will not read leaves the stage outstanding", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    globalThis.__queryHook = (name) => {
      if (name === "admissionApplications") throw new Error("the read failed");
    };

    const { result, summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(result.hasMore, true, "the unread stage was not reported as outstanding");
    assert.equal(summary.sent, 0);
    assert.equal(summary.failures.length, 1);
    // Nothing was claimed at all: the page failed before the first recipient,
    // so the next tick simply derives the same stage again.
    assert.deepEqual(db.ids("schedulerMarkers"), []);
  });

  test("the registration is the one the contract names", () => {
    assert.equal(admissionsStageReleaseJob.id, "admissions-stage-release");
    assert.equal(admissionsStageReleaseJob.maxLateHours, 72);
    assert.ok(admissionsStageReleaseJob.maxPerTick > 0);
    // It emails applicants, so a missing config row must not arm it.
    assert.equal(admissionsStageReleaseJob.enabledByDefault, false);
    // The unit of work is ONE person's email, so the window only has to
    // exceed a single send comfortably. It is floored at five minutes by
    // `policyFor`, and a window at the floor would race a slow Resend call.
    assert.ok(
      admissionsStageReleaseJob.reclaimAfterMinutes >= 15,
      "the re-claim window is short enough to race a single send",
    );
  });
});

// ---------------------------------------------------------------------------
// 3b. The push leg
// ---------------------------------------------------------------------------

describe("the announcement also pushes", () => {
  test("one push per email, naming the round and the stage, landing on the form", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 2);
    assert.equal(summary.pushed, 2);
    assert.equal(summary.pushFailed, 0);
    assert.deepEqual(uidsPushed(), uidsSent());

    const first = globalThis.__pushes[0];
    assert.match(first.title, /Stage 2/, "the push does not name the stage");
    assert.match(first.body, /Autumn 2026 intake/, "the push does not name the round");
    // A PATH, and the same one the email's button carries: the service worker
    // hands this to clients.openWindow, so an absolute url would let a
    // notification wearing this site's name open somebody else's page.
    assert.equal(first.url, `/apply/${ROUND_ID}`);
    assert.equal(
      globalThis.__sends[0].applicationUrl.endsWith(first.url),
      true,
      "the push and the email point at different places",
    );
  });

  test("the push carries nothing the lock screen should not have", async () => {
    // The round's name and the stage's title are the whole payload. A
    // question, an intro or a deadline belongs behind the account, on a
    // surface the applicant chose to open.
    const db = makeDb(world({ apps: 1 }));
    reset(db);

    await runAdmissionsStageRelease(context().ctx);

    const payload = JSON.stringify(globalThis.__pushes);
    assert.equal(payload.includes("Recreate a paper"), false);
    assert.equal(payload.includes("The technical exercise"), false);
    assert.equal(/\d{2}:\d{2}/.test(payload), false, "a deadline rode out on a push");
  });

  test("the push happens BEFORE the stamp, inside the same claim", async () => {
    // Order is the whole safety argument: one marker settles both channels,
    // so a retried tick that finds it stamped repeats neither.
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    const pushesAtStamp = [];
    globalThis.__setHook = (name, id, data) => {
      if (name === "schedulerMarkers" && data.sentAt instanceof Date) {
        pushesAtStamp.push(globalThis.__pushes.length);
      }
    };

    await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(
      pushesAtStamp,
      [1, 2],
      "somebody was stamped before their push was handed off",
    );
  });

  test("a second tick pushes nothing: the stamp covers both channels", async () => {
    const db = makeDb(world({ apps: 3 }));
    reset(db);

    await runAdmissionsStageRelease(context().ctx);
    assert.equal(globalThis.__pushes.length, 3);

    const second = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T11:00:00.000Z") }).ctx,
    );

    assert.equal(second.summary.pushed, 0);
    assert.equal(globalThis.__pushes.length, 3, "a retried tick pushed a second time");
    assert.equal(globalThis.__sends.length, 3);
  });

  test("a push that throws costs the push and nothing else", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    globalThis.__pushThrows = "the push service refused";

    const { summary, result } = await runAdmissionsStageRelease(context().ctx);

    // The email accounting is untouched: a push failure is not a failed send,
    // and it must never reach the receipt's `failed` count.
    assert.equal(summary.sent, 2);
    assert.deepEqual(summary.failures, []);
    assert.equal(result.hasMore, false);
    assert.equal(summary.pushed, 0);
    assert.equal(summary.pushFailed, 2);
    // And above all it did not cost anybody their stamp, because an unstamped
    // marker is a re-claim and a re-claim is a second email.
    for (const uid of ["uid001", "uid002"]) {
      assert.ok(
        db.read("schedulerMarkers", markerFor(uid)).sentAt instanceof Date,
        `${uid} was left unstamped by a push failure`,
      );
    }

    globalThis.__pushThrows = null;
    globalThis.__sends = [];
    await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T11:00:00.000Z") }).ctx,
    );
    assert.equal(globalThis.__sends.length, 0, "a push failure re-mailed the round");
  });

  test("a recipient with no device does not block or duplicate the email", async () => {
    // What the real mirror does for somebody with nothing enabled, with push
    // unprovisioned, or with the category switched off: returns having sent
    // nothing, and says so to nobody. The job must treat that as an ordinary
    // announcement, so `pushed` counts HANDOFFS and never claims a buzz.
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    globalThis.__pushSilent = true;

    const { summary, result } = await runAdmissionsStageRelease(context().ctx);

    assert.deepEqual(globalThis.__pushes, [], "the silent mirror recorded a send");
    assert.equal(summary.sent, 2);
    assert.equal(summary.pushed, 2);
    assert.equal(summary.pushFailed, 0);
    assert.equal(result.hasMore, false);

    globalThis.__pushSilent = false;
    globalThis.__sends = [];
    await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T11:00:00.000Z") }).ctx,
    );
    assert.equal(globalThis.__sends.length, 0, "a deviceless recipient was re-mailed");
  });

  test("nobody the email skipped is pushed", async () => {
    // Suppressed, opted out, or a send that failed: the push rides a send this
    // job counted, so a person with no email has no push either.
    const rows = applications(3);
    const db = makeDb(world({ apps: rows }));
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);
    db.patch("users", "uid002", {
      profile: { notifications: { categories: { courses: false } } },
    });
    globalThis.__sendHook = (opts) => (opts.uid === "uid003" ? "failed" : "sent");

    const { summary } = await runAdmissionsStageRelease(context().ctx);

    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 2);
    assert.deepEqual(globalThis.__pushes, []);
  });
});

// ---------------------------------------------------------------------------
// 3c. The verdict a scoped run reports, and how lateness is measured
// ---------------------------------------------------------------------------

describe("what a scoped run says it did", () => {
  const scope = { roundId: ROUND_ID, stageId: STAGE_ID };

  test("a first press announces; a second says everybody already had it", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);

    const first = await runAdmissionsStageRelease(context().ctx, scope);
    assert.equal(first.reason, "announced");

    const second = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-05T11:00:00.000Z") }).ctx,
      scope,
    );
    assert.equal(second.reason, "already-announced");
    assert.equal(second.summary.sent, 0);
  });

  test("an empty round is 'nobody to tell', not 'already told'", async () => {
    const db = makeDb(world({ apps: {} }));
    reset(db);
    const { reason } = await runAdmissionsStageRelease(context().ctx, scope);
    assert.equal(reason, "no-live-applications");
  });

  test("a round outside its window says so, rather than claiming an announcement", async () => {
    // The whole point of the discriminator. This case used to render as
    // "this stage had already been announced", which is simply untrue.
    for (const [overrides, expected] of [
      [{ closesAt: new Date("2026-10-01T22:59:00.000Z") }, "round-not-in-window"],
      [{ opensAt: new Date("2026-10-20T08:00:00.000Z") }, "round-not-in-window"],
      [{ status: "closed" }, "round-not-in-window"],
    ]) {
      const db = makeDb(world({ apps: 2, roundOverrides: overrides }));
      reset(db);
      const { reason } = await runAdmissionsStageRelease(context().ctx, scope);
      assert.equal(reason, expected, `a round with ${JSON.stringify(overrides)}`);
      assert.equal(globalThis.__sends.length, 0);
    }
  });

  test("a stale stage and a stage that opens with the round are distinct verdicts", async () => {
    const stale = makeDb(world({ apps: 2 }));
    reset(stale);
    const late = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-09T10:00:00.000Z") }).ctx,
      scope,
    );
    assert.equal(late.reason, "too-late");

    const withRound = makeDb(
      world({ stages: { [STAGE_ID]: stage({ releaseAt: null }) } }),
    );
    reset(withRound);
    const rides = await runAdmissionsStageRelease(context().ctx, scope);
    assert.equal(rides.reason, "stage-not-released");
  });

  test("a full tick reports no verdict, because it has no single subject", async () => {
    const db = makeDb(world({ apps: 2 }));
    reset(db);
    const { reason } = await runAdmissionsStageRelease(context().ctx);
    assert.equal(reason, null);
  });
});

describe("how late an announcement is", () => {
  test("lateness runs from the round's opening, not from a schedule nobody could see", async () => {
    // An author dates every stage up front, then moves the round's opening
    // back. Stage two's own date is now BEFORE the round opens, so nobody
    // could read it then, and measuring from it would stamp the stage stale
    // on the day it first became visible.
    const opensAt = new Date("2026-10-08T08:00:00.000Z");
    const db = makeDb(
      world({
        apps: 2,
        roundOverrides: { opensAt, closesAt: new Date("2026-10-30T22:59:00.000Z") },
      }),
    );
    reset(db);

    // Four hours after the round opened, and three days after the stage's own
    // scheduled instant (5 October).
    const { summary, reason } = await runAdmissionsStageRelease(
      context({ now: new Date("2026-10-08T12:00:00.000Z") }).ctx,
      { roundId: ROUND_ID, stageId: STAGE_ID },
    );

    assert.equal(reason, "announced");
    assert.equal(summary.sent, 2, "the stage was stamped stale on the day it appeared");
    assert.equal(summary.stale, 0);
    assert.equal(
      stageAnnouncedAt(stage(), round({ opensAt })).toISOString(),
      opensAt.toISOString(),
    );
  });

  test("a manual release still wins, and is measured from itself", () => {
    const manual = new Date("2026-10-06T09:00:00.000Z");
    assert.equal(
      stageAnnouncedAt(stage({ manualReleasedAt: manual }), round()).toISOString(),
      manual.toISOString(),
    );
  });

  test("a release instant a fraction ahead of the clock is not a negative lateness", async () => {
    // `manualReleasedAt` is the server's timestamp and `ctx.now` is this
    // tick's; a few milliseconds of skew between them is not a stage that
    // opens in the future, and the old code returned silently on it.
    const now = new Date("2026-10-05T10:00:00.000Z");
    const db = makeDb(
      world({
        apps: 1,
        stages: {
          [STAGE_ID]: stage({ manualReleasedAt: new Date(now.getTime() + 500) }),
        },
      }),
    );
    reset(db);

    const { summary, reason } = await runAdmissionsStageRelease(context({ now }).ctx, {
      roundId: ROUND_ID,
      stageId: STAGE_ID,
    });

    assert.equal(reason, "announced");
    assert.equal(summary.sent, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Source pins: the ordering, and the release route
// ---------------------------------------------------------------------------

const JOB_FILE = "src/lib/scheduler/jobs/admissionsStageRelease.ts";
const RELEASE_ROUTE =
  "src/app/api/admissions/rounds/[roundId]/stages/[stageId]/release/route.ts";

describe("the handler's own ordering", () => {
  const src = source(JOB_FILE);

  test("claims before it sends, and stamps after", () => {
    // Read inside `mailCandidate`, which is where the whole order now lives:
    // one person's claim, one person's send, one person's stamp. (The RUNTIME
    // proof that the claim precedes the send is the "claimed BEFORE the first
    // send" test above, which inspects the marker from inside the send.)
    const body = src.slice(
      src.indexOf("async function mailCandidate("),
      src.indexOf("async function stampSentOrSettle("),
    );
    assert.ok(body.length > 500, "could not slice mailCandidate out of the source");
    const claimAt = body.indexOf("const claimed = await claim(db, marker, {");
    const sendAt = body.indexOf("await sendAdmissionEmail(");
    const stampAt = body.indexOf("await stampSentOrSettle(");
    assert.ok(claimAt !== -1, "the handler no longer claims a marker");
    assert.ok(sendAt !== -1, "the handler no longer mails the audience");
    assert.ok(stampAt !== -1, "the handler no longer stamps the marker after the send");
    assert.ok(claimAt < sendAt, "the send runs before the claim");
    assert.ok(sendAt < stampAt, "the marker is stamped before the send");
    assert.match(src, /stageRecipientMarker\(round\.id, stage\.id, candidate\.uid\)/);
  });

  test("the stale verdict is recorded, never claimed", () => {
    // `claim()` counts attempts. A verdict with no side effect behind it must
    // not spend one, which is what turned a big round into a give-up.
    const body = src.slice(
      src.indexOf("async function stampStale("),
      src.indexOf("async function announceStage("),
    );
    assert.ok(body.length > 200, "could not slice stampStale out of the source");
    assert.match(body, /createSettled\(/);
    assert.ok(!/claim\(/.test(body), "the stale verdict goes through claim()");
  });

  test("gates the round on the shared window predicate and the release predicate", () => {
    assert.match(src, /isRoundOpen\(round, ctx\.now\)/);
    assert.match(src, /isStageReleased\(stage, round, ctx\.now\)/);
  });

  test("never orders the audience by a field a draft does not have", () => {
    // `submittedAt` is null until submission, and Firestore drops documents
    // missing an ordered field: an orderBy here would empty the audience.
    assert.ok(!/\.orderBy\(/.test(src), "the audience query has an orderBy on it");
  });

  test("pushes through the SHARED mirror, never a sender of its own", () => {
    // Settled by the owner on 6 September 2026: this job announces by email
    // and push. The mirror is where the VAPID gate, the `courses` push
    // switch, the subscriptions query and the dead-endpoint prune live, so a
    // job reaching past it would be a second copy of all four.
    assert.match(
      src,
      /import \{ mirrorCourseDecisionToPush \} from "@\/lib\/push\/courseNotifications";/,
    );
    // Comment-stripped: the module header names the senders it does NOT use.
    const code = stripComments(src);
    for (const bespoke of ["sendPushToUid", "web-push", "webpush", "subscriptionsForUid"]) {
      assert.ok(
        !code.includes(bespoke),
        `the job reaches ${bespoke} directly instead of the shared mirror`,
      );
    }
  });

  test("the push sits between the send and the stamp", () => {
    // Inside the same claim as the email, so ONE marker settles both
    // channels. (The runtime proof is in "the push happens BEFORE the stamp".)
    const body = src.slice(
      src.indexOf("async function mailCandidate("),
      src.indexOf("async function pushCandidate("),
    );
    assert.ok(body.length > 500, "could not slice mailCandidate out of the source");
    const sendAt = body.indexOf("await sendAdmissionEmail(");
    const pushAt = body.indexOf("await pushCandidate(");
    const stampAt = body.indexOf("await stampSentOrSettle(");
    assert.ok(pushAt !== -1, "the handler no longer pushes");
    assert.ok(sendAt < pushAt, "the push runs before the email it mirrors");
    assert.ok(pushAt < stampAt, "the marker is stamped before the push");
  });

  test("a push failure is counted and logged, never thrown and never a send failure", () => {
    const body = src.slice(
      src.indexOf("async function pushCandidate("),
      src.indexOf("async function stampSentOrSettle("),
    );
    assert.ok(body.length > 200, "could not slice pushCandidate out of the source");
    assert.match(body, /catch \(err\) \{/, "the push handoff is not wrapped");
    assert.match(body, /summary\.pushFailed \+= 1;/);
    assert.match(body, /ctx\.log\(/);
    assert.ok(
      !/throw/.test(body),
      "a push failure must not throw into the per-recipient loop",
    );
    assert.ok(
      !/summary\.failures/.test(body),
      "a push failure must not land in the email accounting the receipt renders",
    );
  });
});

describe("the manual release route", () => {
  const src = source(RELEASE_ROUTE);

  test("refuses a view-as session before it reads anything", () => {
    const guard = src.indexOf("assertNotImpersonating()");
    assert.ok(guard !== -1, "the route does not call the impersonation guard at all");
    for (const later of [
      "getCurrentUser(",
      "getAdminDb(",
      "stageRef.update(",
      "runAdmissionsStageRelease(",
    ]) {
      const at = src.indexOf(later);
      assert.ok(at !== -1, `${later} is not in the route at all`);
      assert.ok(guard < at, `${later} runs before the view-as guard`);
    }
  });

  test("is a POST and nothing else: a GET must not release a stage", () => {
    assert.match(src, /export async function POST\(/);
    assert.ok(!/export async function GET\(/.test(src));
  });

  test("checks the caller may author rounds", () => {
    assert.match(src, /canAuthorRounds\(user\)/);
  });

  test("an already-released stage returns before the write and before the send", () => {
    const already = src.indexOf("alreadyReleased: true");
    const update = src.indexOf("await stageRef.update(");
    const announce = src.indexOf("await announce(");
    assert.ok(already !== -1 && update !== -1 && announce !== -1);
    assert.ok(
      already < update && already < announce,
      "a second press moves the timestamp or re-sends the announcement",
    );
  });

  test("refuses a cancelled round", () => {
    assert.match(src, /round\.status === "cancelled"/);
  });

  test("announces through the job rather than a copy of it", () => {
    assert.match(src, /runAdmissionsStageRelease\(/);
    assert.match(src, /policyFor\(admissionsStageReleaseJob\)/);
    assert.match(src, /maxLateHours: admissionsStageReleaseJob\.maxLateHours/);
    assert.ok(
      !/sendAdmissionEmail/.test(src),
      "the route sends mail itself instead of going through the job",
    );
  });

  test("honours both scheduler switches", () => {
    assert.match(src, /jobStateFor\(\s*config,\s*ADMISSIONS_STAGE_RELEASE_JOB_ID/);
    assert.match(src, /jobDefaultEnabled\(admissionsStageReleaseJob\)/);
    assert.match(src, /if \(!config\.enabled\)/);
  });

  test("the receipt names WHICH kind of nothing happened", () => {
    // "Nobody was emailed" has six causes, and an admin who cannot tell them
    // apart presses the button again looking for a reason. Reporting them all
    // as "already announced" (which an earlier version did) is worse than
    // vague: it is false about a round whose window is shut.
    for (const key of ["announced:", "reason:", "sent:", "skipped:", "failed:", "stale:"]) {
      assert.ok(src.includes(key), `the notice has no ${key}`);
    }
    for (const reason of ["scheduler-off", "job-off", "failed"]) {
      assert.ok(src.includes(`"${reason}"`), `the route never reports ${reason}`);
    }

    const console_ = source("src/features/admissions/StagesSection.tsx");
    for (const reason of [
      "too-late",
      "already-announced",
      "round-not-in-window",
      "stage-not-released",
      "no-live-applications",
      "announced",
    ]) {
      assert.match(
        console_,
        new RegExp(`case "${reason}":`),
        `the console has no sentence for ${reason}`,
      );
    }
    // A transport outage during a hand release must not be reported as an
    // empty audience, so the failure count is read BEFORE the reason switch.
    const failedAt = console_.indexOf("if (notice.failed > 0 && notice.sent === 0)");
    const switchAt = console_.indexOf("switch (notice.reason)");
    assert.ok(failedAt !== -1, "the console no longer reads the failure count first");
    assert.ok(failedAt < switchAt, "an outage is reported as one of the quiet reasons");
    assert.match(console_, /courses-ops\.md/, "the failure line names no remedy");
  });

  test("it refuses a round whose application window is not open", () => {
    // The job gates every send on `isRoundOpen`, so a button that released a
    // stage outside the window would either do nothing today or publish the
    // questions the moment the window opened, and the receipt would have to
    // explain a send nobody could have made.
    assert.match(src, /roundWindowState\(round, new Date\(\)\)/);
    assert.match(src, /window\.state !== "open"/);
    assert.match(src, /round\.status === "cancelled"/);
    const guard = src.indexOf("window.state !== \"open\"");
    assert.ok(guard < src.indexOf("await stageRef.update("), "it releases first");
  });

  test("a send that fails does not turn a released stage into an error", () => {
    // The release is committed first and the notice is a courtesy: the
    // announcement helper swallows its own failures and reports them.
    const announce = src.slice(src.indexOf("async function announce("));
    assert.match(announce, /catch \(err\)/);
    assert.ok(
      !/status: 500/.test(announce),
      "a failed announcement answers with an error the release did not have",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The template
// ---------------------------------------------------------------------------

const TEMPLATE_ID = "admissions-stage-released";
const KIND = "stage-released";
const TOKEN = /\{([a-zA-Z]+)\}/g;

describe("the stage-released template", () => {
  test("is registered with a trigger, a label and seed copy", () => {
    assert.ok(emails.COURSE_TEMPLATE_IDS.includes(TEMPLATE_ID));
    assert.equal(emails.isCourseTemplateId(TEMPLATE_ID), true);
    assert.equal(emails.COURSE_TEMPLATE_TRIGGER[TEMPLATE_ID], TEMPLATE_ID);
    assert.ok(emails.COURSE_DEFAULT_LABELS[TEMPLATE_ID]);
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    assert.ok(seed.subject.length > 0);
    assert.ok(seed.blocks.length > 0);
  });

  test("the send kind resolves to it", () => {
    assert.equal(sendHelper.TEMPLATE_FOR_KIND[KIND], TEMPLATE_ID);
    assert.ok(Array.isArray(sendHelper.TOKENS_BY_KIND[KIND]));
  });

  test("every token the seed copy uses is one THIS trigger supplies", () => {
    const supplied = new Set(sendHelper.TOKENS_BY_KIND[KIND]);
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    const text = seed.subject + JSON.stringify(seed.blocks);
    for (const [, token] of text.matchAll(TOKEN)) {
      assert.ok(
        supplied.has(token),
        `the seed copy uses {${token}}, which this trigger never supplies, so it ` +
          "would arrive as literal text in somebody's inbox",
      );
    }
  });

  test("the tokens are the ones the contract names", () => {
    assert.deepEqual([...sendHelper.TOKENS_BY_KIND[KIND]].sort(), [
      "applicationUrl",
      "deadline",
      "firstName",
      "preferredName",
      "roundLabel",
      "stageLabel",
    ]);
  });

  test("the seed copy does not put the link in a sentence", () => {
    // `personaliseBlocks` leaves an unresolved token literal, so a tokenised
    // link is a broken link the day a send path forgets to pass it. The
    // component renders it.
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    const text = seed.subject + JSON.stringify(seed.blocks);
    assert.equal(text.includes("{applicationUrl}"), false);
  });

  test("the client mirror agrees with the send path", () => {
    assert.deepEqual(
      [...samples.admissionsTokensFor(TEMPLATE_ID)].sort(),
      [...sendHelper.TOKENS_BY_KIND[KIND]].sort(),
      "the editor previews a different token set than the send resolves",
    );
    assert.equal(samples.courseTemplateUsesAdmissionsTokens(TEMPLATE_ID), true);
  });

  test("the send-test route renders it through its own component", () => {
    const src = source("src/app/api/admin/course-emails/[templateId]/send-test/route.ts");
    assert.match(src, /case "admissions-stage-released":/);
    assert.match(src, /AdmissionsStageReleasedEmail\(/);
  });

  test("the job passes the stage label and the form link", () => {
    const src = source(JOB_FILE);
    assert.match(src, /kind: "stage-released"/);
    assert.match(src, /stageLabel: stage\.label/);
    assert.match(src, /admissionApplicationUrl\(round\.id, "apply"\)/);
    // The earlier of the stage's own deadline and the round's.
    assert.match(src, /effectiveStageClose\(stage, round\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. The deadline sentence, when there is no deadline
// ---------------------------------------------------------------------------

/**
 * A round's `closesAt` is genuinely optional (null means "no automatic
 * deadline"), and `buildCourseTokens` OMITS an absent admissions token rather
 * than blanking it, so `personaliseString` leaves `{deadline}` literal. That
 * is the right house rule for a token an admin typed and this trigger never
 * supplies, and the wrong one for a token the trigger supplies conditionally:
 * it puts eleven literal characters in an applicant's inbox.
 */
describe("a stage announcement with no deadline behind it", () => {
  const TOKENS_WITHOUT_DEADLINE = {
    preferredName: "Ada",
    firstName: "Ada",
    roundLabel: "Autumn 2026 intake",
    stageLabel: "Stage 2",
    applicationUrl: "https://naisi.uk/apply/x",
  };

  test("the deadline sentence is a block of its own", () => {
    // The copy rule the drop depends on: a conditional token folded into a
    // paragraph takes the rest of that paragraph with it when it goes.
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    const owning = seed.blocks.filter((b) =>
      JSON.stringify(b).includes("{deadline}"),
    );
    assert.equal(owning.length, 1, "the deadline is spread across blocks");
    const other = [...JSON.stringify(owning[0]).matchAll(TOKEN)]
      .map(([, token]) => token)
      .filter((token) => token !== "deadline");
    assert.deepEqual(other, [], "the deadline shares its block with another token");
  });

  test("that block is dropped whole rather than shipped as a literal token", () => {
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    const kept = sendHelper.dropDataAbsentBlocks(
      seed.blocks,
      KIND,
      TOKENS_WITHOUT_DEADLINE,
    );

    assert.equal(
      JSON.stringify(kept).includes("{deadline}"),
      false,
      "an applicant was told their questions are due by {deadline}",
    );
    assert.equal(kept.length, seed.blocks.length - 1, "more than the one block went");
    // The rest of the email is untouched: the stage is still announced, and
    // the "you can leave it" line still lands.
    const text = JSON.stringify(kept);
    assert.ok(text.includes("{stageLabel}"));
    assert.ok(text.includes("nobody chases you"));
  });

  test("a deadline that IS supplied keeps every block", () => {
    const seed = emails.courseTemplateDefaults[TEMPLATE_ID];
    const kept = sendHelper.dropDataAbsentBlocks(seed.blocks, KIND, {
      ...TOKENS_WITHOUT_DEADLINE,
      deadline: "Sun 18 Oct, 23:59",
    });
    assert.equal(kept.length, seed.blocks.length);
  });

  test("a token this trigger never supplies still stays literal", () => {
    // The house convention, and the drop must not quietly take it over: an
    // admin who pastes {courseTitle} into an admissions template needs to SEE
    // it, because nothing will ever fill it in.
    const blocks = [
      { id: "b1", type: "richText", html: "<p>You are on {courseTitle}.</p>" },
    ];
    assert.deepEqual(
      sendHelper.dropDataAbsentBlocks(blocks, KIND, TOKENS_WITHOUT_DEADLINE),
      blocks,
    );
  });

  test("the rounds route refuses to clear a published deadline", () => {
    // The other half: the deadline can go missing on an OPEN round only if a
    // PATCH is allowed to clear it, and by then applicants have already been
    // sent sentences written against a date.
    const src = source("src/app/api/admissions/rounds/[roundId]/route.ts");
    assert.match(
      src,
      /parsed\.value === null\s*\n\s*&& current\.closesAt !== null\s*\n\s*&& current\.status === "open"/,
      "an open round's deadline can still be cleared out from under it",
    );
    assert.match(src, /cannot be cleared while people are applying/);
  });
});

// ---------------------------------------------------------------------------
// 7. The opt-out predicate, for real
// ---------------------------------------------------------------------------

/**
 * The job tests above run against a STUB of
 * `hasOptedOutOfCourseAnnouncements`, because loading the real
 * `courseFacilitatorEmails.ts` drags in React email components, the session
 * reader and the transport. A stub is a re-implementation, and a
 * re-implementation that drifts is a test that passes while the shipping
 * predicate refuses everybody or nobody. So the real one is loaded here, with
 * those three doors stubbed by specifier, and asked the questions that matter.
 */
const prefs = await loadTs("lib/email/courseFacilitatorEmails.ts");

describe("the courses opt-out, on the real predicate", () => {
  const optOut = prefs.hasOptedOutOfCourseAnnouncements;

  test("only an EXPLICIT false is a refusal", () => {
    assert.equal(
      optOut({ profile: { notifications: { categories: { courses: false } } } }),
      true,
    );
    assert.equal(
      optOut({ profile: { notifications: { categories: { courses: true } } } }),
      false,
    );
  });

  test("an unanswered preference is not a refusal, at any depth", () => {
    for (const data of [
      {},
      { profile: {} },
      { profile: { notifications: {} } },
      { profile: { notifications: { categories: {} } } },
      { profile: { notifications: { categories: { newsletter: false } } } },
      { profile: { notifications: null } },
      { profile: { notifications: { categories: { courses: undefined } } } },
      // The legacy shape predates the category entirely and never means "no".
      { profile: { newsletter: false } },
    ]) {
      assert.equal(
        optOut(data),
        false,
        `${JSON.stringify(data)} was read as an opt-out`,
      );
    }
  });

  test("a truthy-but-not-true value is not a refusal either", () => {
    // The comparison is `=== false`, so a string "false" out of a bad import
    // must not silently mute somebody's application mail.
    assert.equal(
      optOut({ profile: { notifications: { categories: { courses: "false" } } } }),
      false,
    );
  });

  test("the stub the job tests use agrees with it", () => {
    // The stub is a convenience, not a second implementation: if it ever
    // disagrees, the job tests above are measuring the wrong thing.
    const stub = (data) =>
      data?.profile?.notifications?.categories?.courses === false;
    for (const data of [
      { profile: { notifications: { categories: { courses: false } } } },
      { profile: { notifications: { categories: { courses: true } } } },
      { profile: {} },
      {},
    ]) {
      assert.equal(optOut(data), stub(data), JSON.stringify(data));
    }
  });
});
