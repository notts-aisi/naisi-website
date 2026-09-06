/**
 * The worksheet due-soon reminders job.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing here
 *
 *  1. **It ships dark.** The job emails and pushes to people, and
 *     `config/scheduler` reads a missing row as the job's own default, so
 *     `enabledByDefault: false` is the difference between a job an admin arms
 *     and a job that arms itself on whatever data an environment holds the
 *     moment it deploys.
 *  2. **The order of operations.** Claim, then send, then stamp. The fake
 *     below inspects the marker FROM INSIDE the send, which is the only way to
 *     prove the claim really precedes the send rather than merely appearing
 *     earlier in the file.
 *  3. **The audience.** A submitted or reviewed response is out of it by
 *     construction. Reminding somebody to finish work they have already sent
 *     back is the one message this job could send that would make a person
 *     trust it less.
 *  4. **Both channels, independently.** The owner asked for an email switch
 *     and a push switch per event, so email-off-push-on is a real setting and
 *     is executed here rather than reasoned about.
 *  5. **The window and the ceiling.** The window is the schedule, so the
 *     tests that matter are the ones at its edges: the deadline hours away
 *     (which an earlier lateness rule silenced), the deadline still days
 *     away, and the deadline already gone.
 *
 * ## The fake Firestore
 *
 * A double, not the emulator: `npm test` has no emulator and must not reach a
 * project. It implements what the handler uses (doc get, doc create, doc set
 * with merge, a subcollection, a query with equality / range / `in` filters
 * plus a limit and a cursor, a transaction, and a resolving server timestamp)
 * and nothing else. The email send, the push mirror, the suppression list and
 * the Admin SDK are stubbed at the module boundary, so no test in this file
 * can put mail on the wire or a notification on a phone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;
const SERVER_TIMESTAMP = "__serverTimestamp__";

/**
 * The doors to the outside world, replaced.
 *
 * They talk to the tests through `globalThis` rather than through an injected
 * argument because the handler resolves them by import, exactly as it does in
 * production: a handler that took its database as a parameter would be a
 * handler this suite tested in a shape the tick never runs.
 *
 * The two admissions entries are here because this file loads `registry.ts`
 * for `policyFor`, and the registry imports every registered job by value.
 * Without them the loader tries to transpile the `.tsx` email components that
 * job reaches, with no JSX setting, and this suite fails on a syntax error
 * that has nothing to do with worksheets.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      `  serverTimestamp: () => ({ __sentinel: "${SERVER_TIMESTAMP}" }),\n` +
      "};\n" +
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
      "};",
  ],
  [
    "@/lib/email/worksheetReminderEmails",
    "export const worksheetRespondPath = (id) => `/worksheets/respond/${id}`;\n" +
      "export const worksheetDueSoonSubject = (title) => `Due soon: ${title}`;\n" +
      "export const formatWorksheetDue = (date) => date.toISOString();\n" +
      "export const sendWorksheetDueSoonEmail = async (opts) => {\n" +
      "  (globalThis.__sends ??= []).push(opts);\n" +
      "  return globalThis.__sendHook ? globalThis.__sendHook(opts) : 'sent';\n" +
      "};",
  ],
  [
    "@/lib/push/taskNotifications",
    "export const mirrorTaskEmailToPush = async (uid, payload) => {\n" +
      "  (globalThis.__pushes ??= []).push({ uid, ...payload });\n" +
      "};",
  ],
  [
    "@/lib/email/admissionEmails",
    "export const admissionApplicationUrl = () => '';\n" +
      "export const sendAdmissionEmail = async () => 'sent';",
  ],
  [
    "@/lib/email/courseFacilitatorEmails",
    "export const hasOptedOutOfCourseAnnouncements = () => false;\n" +
      "export const memberNameOf = () => '';",
  ],
]);

/** A FILE, never a directory: `@/lib/devBypass` is both. */
function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) continue;
    return candidate;
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
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code.
// ---------------------------------------------------------------------------

const {
  DUE_SOON_WINDOW_HOURS,
  RESPONSE_PAGE_SIZE,
  SENT_UNSTAMPED_REASON,
  SUPPRESSION_UNREADABLE_REASON,
  WORKSHEET_DUE_REMINDERS_JOB_ID,
  runWorksheetDueReminders,
  worksheetDueRemindersJob,
} = await loadTs("lib/scheduler/jobs/worksheetDueReminders.ts");

const { JOBS, jobDefaultEnabled, policyFor } = await loadTs("lib/scheduler/registry.ts");

// ---------------------------------------------------------------------------
// 1. The fake Firestore
// ---------------------------------------------------------------------------

function alreadyExists(id) {
  const err = new Error(`already exists: ${id}`);
  err.code = 6;
  return err;
}

/** Dates compare by instant; everything else compares as itself. */
function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matches(data, [field, op, value]) {
  const stored = data[field];
  // A document MISSING the field is outside every filter, which is what
  // Firestore does and the reason `orderBy` on a sparse field empties a query.
  if (stored === undefined) return false;
  switch (op) {
    case "==":
      return stored === value;
    case "in":
      return Array.isArray(value) && value.includes(stored);
    case ">=":
      return comparable(stored) >= comparable(value);
    case "<=":
      return comparable(stored) <= comparable(value);
    default:
      throw new Error(`the fake does not serve the "${op}" operator`);
  }
}

function makeDb(seed = {}) {
  /** collection PATH -> id -> { data, version } */
  const store = new Map();
  const stats = { queries: 0, creates: 0, sets: 0, gets: 0 };

  const col = (path) => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path);
  };

  for (const [path, rows] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(rows)) {
      col(path).set(id, { data: { ...data }, version: 1 });
    }
  }

  const resolveValue = (value) =>
    value !== null && typeof value === "object" && value.__sentinel === SERVER_TIMESTAMP
      ? new Date()
      : value;

  function applyWrite(path, id, data, merge) {
    const resolved = {};
    for (const [key, value] of Object.entries(data)) resolved[key] = resolveValue(value);
    const current = col(path).get(id);
    col(path).set(id, {
      data: merge && current ? { ...current.data, ...resolved } : resolved,
      version: (current?.version ?? 0) + 1,
    });
  }

  const snapshotOf = (path, id) => {
    const row = col(path).get(id);
    return {
      id,
      exists: row !== undefined,
      data: () => (row === undefined ? undefined : { ...row.data }),
    };
  };

  function docRef(path, id) {
    return {
      id,
      // The subcollection, which is how the responses under one circulation
      // are reached. Its path is the parent's, so nothing in the fake has to
      // know that `responses` is nested.
      collection: (name) => collectionRef(`${path}/${id}/${name}`),
      async create(data) {
        stats.creates += 1;
        await Promise.resolve();
        // The hooks are how a test makes ONE write fail. Firestore's own
        // failures are per-call and transient, and the handler's whole
        // resilience story is about surviving them one at a time.
        globalThis.__createHook?.(path, id, data);
        if (col(path).has(id)) throw alreadyExists(id);
        applyWrite(path, id, data, false);
      },
      async set(data, options) {
        stats.sets += 1;
        await Promise.resolve();
        globalThis.__setHook?.(path, id, data);
        applyWrite(path, id, data, options?.merge === true);
      },
      async get() {
        stats.gets += 1;
        await Promise.resolve();
        globalThis.__getHook?.(path, id);
        return snapshotOf(path, id);
      },
    };
  }

  function query(path, filters, limit, after) {
    return {
      where: (field, op, value) => query(path, [...filters, [field, op, value]], limit, after),
      limit: (n) => query(path, filters, n, after),
      startAfter: (snap) => query(path, filters, limit, snap.id),
      async get() {
        stats.queries += 1;
        await Promise.resolve();
        globalThis.__queryHook?.(path, filters);
        // Sorted by id, which is what the cursor below is walking.
        let ids = [...col(path).keys()].sort();
        if (after !== null) ids = ids.filter((id) => id > after);
        const docs = ids
          .filter((id) => filters.every((filter) => matches(col(path).get(id).data, filter)))
          .slice(0, limit ?? Infinity)
          .map((id) => snapshotOf(path, id));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  function collectionRef(path) {
    return {
      doc: (id) => docRef(path, id),
      where: (field, op, value) => query(path, [], null, null).where(field, op, value),
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
    read: (path, id) => {
      const row = col(path).get(id);
      return row === undefined ? null : { ...row.data };
    },
    ids: (path) => [...col(path).keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// 2. Fixtures
// ---------------------------------------------------------------------------

const CIRCULATION_ID = "week-3-check-in__k3f9a2b1";
const RESPONSES = `circulations/${CIRCULATION_ID}/responses`;

/** 23:59 London on Sunday 4 October 2026, which is BST, so 22:59 UTC. */
const DUE_AT = new Date("2026-10-04T22:59:00.000Z");
/** The London civil date of that deadline, and the marker's `dueKey`. */
const DUE_KEY = "2026-10-04";
/** Inside the 48-hour window (it opens at 22:59 on 2 Oct) and not yet stale. */
const IN_WINDOW = new Date("2026-10-03T09:00:00.000Z");

const markerId = (uid) => `wsremind__${CIRCULATION_ID}__${uid}__${DUE_KEY}`;

function circulation(overrides = {}) {
  return {
    worksheetId: "week-3-check-in__aa11bb22",
    title: "Week 3 check-in",
    description: "",
    items: [],
    senderUid: "sender01",
    authorUid: "sender01",
    reviewerUids: ["sender01"],
    staffUids: ["sender01"],
    dueDate: DUE_AT,
    status: "open",
    notifications: { dueSoon: { email: true, push: false } },
    recipientCount: 3,
    submittedCount: 0,
    reviewedCount: 0,
    ...overrides,
  };
}

function responses(count, stateOf = () => "started") {
  const rows = {};
  for (let i = 1; i <= count; i += 1) {
    const uid = `uid${String(i).padStart(3, "0")}`;
    rows[uid] = {
      uid,
      circulationId: CIRCULATION_ID,
      taskId: `task-${uid}`,
      state: stateOf(uid, i),
      addedByUid: "sender01",
    };
  }
  return rows;
}

function users(count, overrides = () => ({})) {
  const rows = {};
  for (let i = 1; i <= count; i += 1) {
    const uid = `uid${String(i).padStart(3, "0")}`;
    rows[uid] = {
      email: `${uid}@example.com`,
      displayName: `Member ${uid}`,
      ...overrides(uid, i),
    };
  }
  return rows;
}

/** A whole world: one circulation, its responses, and the people behind them. */
function world({ count = 3, circulationOverrides = {}, stateOf, userOverrides } = {}) {
  return makeDb({
    circulations: { [CIRCULATION_ID]: circulation(circulationOverrides) },
    [RESPONSES]: responses(count, stateOf),
    users: users(count, userOverrides),
  });
}

function context({
  now = IN_WINDOW,
  maxPerTick = worksheetDueRemindersJob.maxPerTick,
  remainingMs = 60_000,
} = {}) {
  const logged = [];
  return {
    ctx: {
      now,
      budget: { remainingMs: () => remainingMs, expired: () => remainingMs <= 0 },
      log: (message, extra) => logged.push([message, extra]),
      policy: policyFor(worksheetDueRemindersJob),
      maxPerTick,
      maxLateHours: worksheetDueRemindersJob.maxLateHours,
    },
    logged,
  };
}

function reset(db) {
  globalThis.__db = db;
  globalThis.__sends = [];
  globalThis.__pushes = [];
  globalThis.__suppressed = new Set();
  globalThis.__sendHook = null;
  globalThis.__suppressionError = null;
  globalThis.__createHook = null;
  globalThis.__setHook = null;
  globalThis.__getHook = null;
  globalThis.__queryHook = null;
}

// ---------------------------------------------------------------------------
// 3. The registration
// ---------------------------------------------------------------------------

describe("the registration", () => {
  test("ships dark, because it emails and pushes to people", () => {
    // `config/scheduler` treats a missing row as the job's own default, so a
    // job that mails a live audience must declare that default as OFF or it
    // arms itself the moment it deploys.
    assert.equal(worksheetDueRemindersJob.enabledByDefault, false);
    assert.equal(jobDefaultEnabled(worksheetDueRemindersJob), false);
  });

  test("carries the caps and windows the contract names", () => {
    assert.equal(worksheetDueRemindersJob.id, WORKSHEET_DUE_REMINDERS_JOB_ID);
    assert.equal(worksheetDueRemindersJob.id, "worksheet-due-reminders");
    assert.equal(worksheetDueRemindersJob.maxPerTick, 200);
    assert.equal(worksheetDueRemindersJob.maxLateHours, 24);
    assert.equal(worksheetDueRemindersJob.reclaimAfterMinutes, 10);
    assert.equal(DUE_SOON_WINDOW_HOURS, 48);
    // The audience is paged, so the ceiling is not the page size: 200 sends
    // has to be reachable across more than one page of recipients.
    assert.ok(RESPONSE_PAGE_SIZE <= worksheetDueRemindersJob.maxPerTick);
  });

  test("is registered, and the registration order is still alphabetical", () => {
    const ids = JOBS.map((job) => job.id);
    assert.ok(ids.includes("worksheet-due-reminders"), "the job is not registered at all");
    assert.deepEqual(ids, [...ids].sort(), `registration order is ${ids.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// 4. The run
// ---------------------------------------------------------------------------

describe("the reminders job", () => {
  test("reminds everybody who still owes an answer, and stamps each marker", async () => {
    const db = world();
    reset(db);

    const { result, summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.sent, 3);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.pushOnly, []);
    assert.equal(summary.circulations, 1);
    assert.equal(summary.failures.length, 0);
    assert.equal(result.hasMore, false);
    assert.equal(globalThis.__sends.length, 3);

    const first = globalThis.__sends[0];
    assert.equal(first.to, "uid001@example.com");
    assert.equal(first.worksheetTitle, "Week 3 check-in");
    assert.equal(first.circulationId, CIRCULATION_ID);
    assert.equal(first.dueDate.toISOString(), DUE_AT.toISOString());

    for (const uid of ["uid001", "uid002", "uid003"]) {
      const marker = db.read("schedulerMarkers", markerId(uid));
      assert.ok(marker, `no marker for ${uid}`);
      assert.equal(marker.job, WORKSHEET_DUE_REMINDERS_JOB_ID);
      assert.ok(marker.sentAt instanceof Date, `${uid}'s marker was never stamped`);
      assert.ok(marker.expiresAt instanceof Date, "a settled marker has no TTL horizon");
    }
  });

  test("the marker id is the family, the circulation, the person and the deadline", async () => {
    // Every component is ALSO stored as a field, so a sweep or the admin panel
    // never has to parse an id back into its parts.
    const db = world({ count: 1 });
    reset(db);

    await runWorksheetDueReminders(context().ctx);

    assert.deepEqual(db.ids("schedulerMarkers"), [
      `wsremind__${CIRCULATION_ID}__uid001__2026-10-04`,
    ]);
    const marker = db.read("schedulerMarkers", markerId("uid001"));
    assert.equal(marker.family, "wsremind");
    assert.equal(marker.circulationId, CIRCULATION_ID);
    assert.equal(marker.uid, "uid001");
    assert.equal(marker.dueKey, DUE_KEY);
  });

  test("a second run reminds nobody, however many times it is asked", async () => {
    const db = world();
    reset(db);

    await runWorksheetDueReminders(context().ctx);
    globalThis.__sends = [];
    const { summary } = await runWorksheetDueReminders(
      context({ now: new Date("2026-10-03T18:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "the second run re-sent");
    assert.equal(summary.sent, 0);
  });

  test("moving the deadline is a new reminder, not a silenced one", async () => {
    // The marker keys on the London civil date, so a sender who pushes a
    // deadline back reminds the people who have still not submitted about the
    // new date. Nudging the TIME on the same day is the same key and cannot
    // re-send, which is the failure people notice.
    const db = world({ count: 1 });
    reset(db);
    await runWorksheetDueReminders(context().ctx);
    assert.equal(globalThis.__sends.length, 1);

    const moved = new Date("2026-10-05T22:59:00.000Z");
    await db.collection("circulations").doc(CIRCULATION_ID).set({ dueDate: moved }, { merge: true });
    globalThis.__sends = [];

    await runWorksheetDueReminders(context({ now: new Date("2026-10-04T09:00:00.000Z") }).ctx);

    assert.equal(globalThis.__sends.length, 1, "the moved deadline sent nothing");
    assert.ok(
      db.read("schedulerMarkers", `wsremind__${CIRCULATION_ID}__uid001__2026-10-05`),
      "the new deadline left no marker of its own",
    );
  });

  test("the marker is claimed BEFORE the send, not after it", async () => {
    // Checked from inside the send: the order has to be a fact about the run,
    // not about where two lines sit in a file. A crash here must cost a missed
    // reminder, never a duplicate one.
    const db = world({ count: 1 });
    reset(db);
    let markerDuringSend = null;
    globalThis.__sendHook = (opts) => {
      markerDuringSend = db.read("schedulerMarkers", markerId(opts.uid));
      return "sent";
    };

    await runWorksheetDueReminders(context().ctx);

    assert.ok(markerDuringSend, "the send ran with no marker claimed");
    assert.ok(markerDuringSend.claimedAt instanceof Date);
    assert.equal(markerDuringSend.sentAt, null, "the marker was stamped before the send");
  });

  test("somebody who has already submitted is not in the audience", async () => {
    const db = world({
      count: 4,
      stateOf: (uid) =>
        uid === "uid002" ? "submitted" : uid === "uid003" ? "reviewed" : "started",
    });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.deepEqual(
      globalThis.__sends.map((send) => send.uid),
      ["uid001", "uid004"],
      "a reminder went to somebody who had already sent their answers",
    );
    assert.equal(summary.sent, 2);
    assert.equal(db.read("schedulerMarkers", markerId("uid002")), null);
  });

  test("a not-opened response is still in the audience", async () => {
    const db = world({ count: 1, stateOf: () => "not-opened" });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.sent, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. The two channels
// ---------------------------------------------------------------------------

describe("the email and push switches", () => {
  test("email on, push off: one email and no notification", async () => {
    const db = world({ count: 1 });
    reset(db);

    await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 1);
    assert.equal(globalThis.__pushes.length, 0);
  });

  test("email off, push on: a notification and no email", async () => {
    // The deliberate divergence from the notify module's mirror policy: the
    // owner asked for a switch per channel, so this one is a real setting.
    const db = world({
      count: 1,
      circulationOverrides: { notifications: { dueSoon: { email: false, push: true } } },
    });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 0, "an email went out with the switch off");
    assert.equal(globalThis.__pushes.length, 1);
    assert.equal(globalThis.__pushes[0].uid, "uid001");
    // The push opens the recipient's OWN copy, never the board and never the
    // staff view of the circulation.
    assert.equal(globalThis.__pushes[0].url, `/worksheets/respond/${CIRCULATION_ID}`);
    assert.equal(summary.sent, 1);
    // Nothing was SKIPPED here: the sender asked for push alone. The push-only
    // record is for the circulation that asked for both and got one.
    assert.deepEqual(summary.pushOnly, []);
    assert.ok(db.read("schedulerMarkers", markerId("uid001")).sentAt instanceof Date);
  });

  test("both on: one of each, and the push follows the email", async () => {
    const db = world({
      count: 1,
      circulationOverrides: { notifications: { dueSoon: { email: true, push: true } } },
    });
    reset(db);
    let pushesAtSendTime = 0;
    globalThis.__sendHook = () => {
      pushesAtSendTime = globalThis.__pushes.length;
      return "sent";
    };

    await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 1);
    assert.equal(globalThis.__pushes.length, 1);
    assert.equal(pushesAtSendTime, 0, "the push led the email");
  });

  test("both off: the circulation is not examined at all", async () => {
    const db = world({
      count: 3,
      circulationOverrides: { notifications: { dueSoon: { email: false, push: false } } },
    });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.circulations, 0);
    assert.equal(globalThis.__sends.length, 0);
    assert.equal(globalThis.__pushes.length, 0);
    assert.deepEqual(db.ids("schedulerMarkers"), [], "a silent circulation left markers");
  });

  test("a failed email sends no push, and leaves the marker reclaimable", async () => {
    // A notification about mail that never arrived tells somebody to go and
    // read something they have not been sent.
    const db = world({
      count: 1,
      circulationOverrides: { notifications: { dueSoon: { email: true, push: true } } },
    });
    reset(db);
    globalThis.__sendHook = () => "failed";

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__pushes.length, 0);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failures.length, 1);
    const marker = db.read("schedulerMarkers", markerId("uid001"));
    assert.equal(marker.sentAt, null, "a failed send was stamped as sent");
    assert.equal(marker.skippedReason, null, "a failed send was settled as skipped");
    assert.ok(marker.lastError, "the failure left no reason on the marker");
  });
});

// ---------------------------------------------------------------------------
// 6. Who is skipped, and why the marker still settles
// ---------------------------------------------------------------------------

describe("the skips", () => {
  test("a suppressed address is skipped, settled, and never mailed", async () => {
    const db = world({ count: 2 });
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(
      globalThis.__sends.map((send) => send.to),
      ["uid002@example.com"],
    );
    assert.equal(db.read("schedulerMarkers", markerId("uid001")).skippedReason, "suppressed");
  });

  test("a suppression list that will not read is a recorded skip, not a send", async () => {
    // Failing open here would mail addresses the platform has been told to stop
    // mailing, which outlives this send.
    const db = world({ count: 2 });
    reset(db);
    globalThis.__suppressionError = "suppression list unavailable";

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 0);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failures.length, 0, "a handled skip was reported as a failure");
    assert.equal(
      db.read("schedulerMarkers", markerId("uid001")).skippedReason,
      SUPPRESSION_UNREADABLE_REASON,
    );
  });

  test("a recipient with no account address is settled rather than left unmarked", async () => {
    const db = world({ count: 2, userOverrides: (uid) => (uid === "uid001" ? { email: "" } : {}) });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(db.read("schedulerMarkers", markerId("uid001")).skippedReason, "no-address");
  });

  test("a suppressed address on a circulation that also pushes is recorded as push-only", async () => {
    // The email did not go and the push did, so the person WAS reached and the
    // marker is stamped `sentAt`. The marker holds one instant and no channel,
    // so without the summary line the suppression is invisible: a mailbox the
    // platform has been told to stop mailing would read as a delivered email.
    const db = world({
      count: 1,
      circulationOverrides: { notifications: { dueSoon: { email: true, push: true } } },
    });
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 0, "a suppressed address was mailed");
    assert.equal(globalThis.__pushes.length, 1);
    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.pushOnly, [{ uid: "uid001", reason: "suppressed" }]);
    assert.ok(db.read("schedulerMarkers", markerId("uid001")).sentAt instanceof Date);
  });

  test("a suppressed address on a push-only circulation still gets its push", async () => {
    // Suppression is a fact about a MAILBOX. The push has its own preference
    // axis and its own transport, and refusing it here would be one channel
    // silencing another.
    const db = world({
      count: 1,
      circulationOverrides: { notifications: { dueSoon: { email: false, push: true } } },
    });
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__pushes.length, 1);
    assert.equal(summary.sent, 1);
  });

  test("the site-wide task-email switch stops the run before anything is claimed", async () => {
    const db = makeDb({
      circulations: { [CIRCULATION_ID]: circulation() },
      [RESPONSES]: responses(2),
      users: users(2),
      config: { taskEmails: { enabled: false } },
    });
    reset(db);

    const { result, summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 0);
    assert.equal(globalThis.__pushes.length, 0, "the kill switch did not cover push");
    assert.equal(summary.sent, 0);
    assert.equal(result.hasMore, false);
    assert.deepEqual(db.ids("schedulerMarkers"), [], "a silenced run claimed markers");
  });

  test("a switch that will not read stops the run and asks the tick to come back", async () => {
    const db = world({ count: 1 });
    reset(db);
    globalThis.__getHook = (path, id) => {
      if (path === "config" && id === "taskEmails") throw new Error("config read failed");
    };

    const { result, summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 0, "a run mailed people with the switch unread");
    assert.equal(result.hasMore, true);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].uid, "config:taskEmails");
  });
});

// ---------------------------------------------------------------------------
// 7. The clock, the ceiling and the failures
// ---------------------------------------------------------------------------

describe("the window", () => {
  test("a deadline hours away is the most urgent reminder there is, and it goes", async () => {
    // THE REGRESSION THIS SUITE EXISTS TO HOLD DOWN. An earlier version of the
    // handler derived staleness from the moment the 48-hour window OPENED, so
    // `maxLateHours` (24) silenced every circulation with under a day left: a
    // worksheet set at 09:00 to be in by the evening was dropped on sight by a
    // scheduler that had never missed a tick. This run is 14 hours before the
    // deadline and every recipient hears about it.
    const db = world({ count: 3 });
    reset(db);

    const { summary } = await runWorksheetDueReminders(
      context({ now: new Date("2026-10-04T09:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 3, "the reminders closest to the wire were dropped");
    assert.equal(summary.sent, 3);
    assert.equal(summary.circulations, 1);
    assert.equal(summary.failures.length, 0);
  });

  test("somebody added inside the last day is reminded like everybody else", async () => {
    // The second half of the same bug: the drop was per CIRCULATION, so once a
    // deadline was less than a day away, a recipient added after that point
    // could never be reminded at all, however many ticks ran.
    const db = world({ count: 1 });
    reset(db);
    await runWorksheetDueReminders(context().ctx);
    assert.equal(globalThis.__sends.length, 1);

    // A late addition, in the shape the add-recipients route writes.
    await db
      .collection("circulations")
      .doc(CIRCULATION_ID)
      .collection("responses")
      .doc("uid009")
      .set({
        uid: "uid009",
        circulationId: CIRCULATION_ID,
        taskId: "task-uid009",
        state: "not-opened",
        addedByUid: "sender01",
      });
    await db
      .collection("users")
      .doc("uid009")
      .set({ email: "uid009@example.com", displayName: "Member uid009" });
    globalThis.__sends = [];

    // Five hours to go: well past the point the old lateness rule gave up.
    const { summary } = await runWorksheetDueReminders(
      context({ now: new Date("2026-10-04T18:00:00.000Z") }).ctx,
    );

    assert.deepEqual(
      globalThis.__sends.map((send) => send.uid),
      ["uid009"],
      "the late addition was never reminded",
    );
    assert.equal(summary.sent, 1);
  });

  test("a deadline further out than the window is not looked at yet", async () => {
    const db = world({ count: 2 });
    reset(db);

    const { summary } = await runWorksheetDueReminders(
      context({ now: new Date("2026-09-28T09:00:00.000Z") }).ctx,
    );

    assert.equal(summary.circulations, 0, "a circulation outside the window was examined");
    assert.equal(globalThis.__sends.length, 0);
  });

  test("a deadline that has passed is out of the query, whatever the status says", async () => {
    const db = world({ count: 2 });
    reset(db);

    await runWorksheetDueReminders(
      context({ now: new Date("2026-10-05T09:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "a passed deadline was reminded about");
  });

  test("a closed circulation is left alone", async () => {
    const db = world({ count: 2, circulationOverrides: { status: "closed" } });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.circulations, 0);
    assert.equal(globalThis.__sends.length, 0);
  });

  test("a circulation with no due date is out of the query", async () => {
    const db = world({ count: 2, circulationOverrides: { dueDate: null } });
    reset(db);

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.circulations, 0);
    assert.equal(globalThis.__sends.length, 0);
  });
});

describe("the ceiling and the failures", () => {
  test("the per-tick ceiling stops the sends and reports what is left", async () => {
    const db = world({ count: 5 });
    reset(db);

    const { result, summary } = await runWorksheetDueReminders(
      context({ maxPerTick: 2 }).ctx,
    );

    assert.equal(summary.sent, 2);
    assert.equal(result.hasMore, true, "a capped run must ask the tick to come back");

    // The next run picks up exactly the people the first one did not reach.
    globalThis.__sends = [];
    await runWorksheetDueReminders(context({ maxPerTick: 200 }).ctx);
    assert.deepEqual(
      globalThis.__sends.map((send) => send.uid),
      ["uid003", "uid004", "uid005"],
    );
  });

  test("a spent wall clock ends the run rather than the circulation", async () => {
    const db = world({ count: 3 });
    reset(db);

    const { result, summary } = await runWorksheetDueReminders(
      context({ remainingMs: 0 }).ctx,
    );

    assert.equal(summary.sent, 0);
    assert.equal(result.hasMore, true);
    assert.deepEqual(db.ids("schedulerMarkers"), []);
  });

  test("one recipient throwing does not cost the people behind them", async () => {
    const db = world({ count: 3 });
    reset(db);
    globalThis.__createHook = (path, id) => {
      if (path === "schedulerMarkers" && id === markerId("uid002")) {
        throw new Error("firestore refused the claim");
      }
    };

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.deepEqual(
      globalThis.__sends.map((send) => send.uid),
      ["uid001", "uid003"],
      "a failed claim took the rest of the page with it",
    );
    assert.equal(summary.sent, 2);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].uid, "uid002");
    assert.match(summary.failures[0].error, /refused the claim/);
  });

  test("a page of recipients that will not read ends the circulation, not the run", async () => {
    const db = world({ count: 2 });
    reset(db);
    globalThis.__queryHook = (path) => {
      if (path === RESPONSES) throw new Error("the read failed");
    };

    const { result, summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(result.hasMore, true, "the unread circulation was not reported as outstanding");
    assert.equal(summary.sent, 0);
    assert.equal(summary.failures.length, 1);
    assert.equal(
      summary.failures[0].uid,
      `circulation:${CIRCULATION_ID}`,
      "a failure with no recipient behind it was filed under a uid",
    );
    assert.deepEqual(db.ids("schedulerMarkers"), [], "a claim was made on an unread page");
  });

  test("a stamp that will not stick still cannot become a second reminder", async () => {
    // The nastiest of the failure orders: the mail is on the wire and the
    // marker cannot record it. An unstamped marker is RECLAIMABLE, so a later
    // tick would derive this person again and send them a second reminder.
    const db = world({ count: 1 });
    reset(db);
    let stampAttempts = 0;
    globalThis.__setHook = (path, id, data) => {
      if (path !== "schedulerMarkers" || !("sentAt" in data) || data.sentAt === null) return;
      stampAttempts += 1;
      throw new Error("firestore refused the stamp");
    };

    const { summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(globalThis.__sends.length, 1, "the reminder did not go out at all");
    assert.equal(summary.sent, 1, "a send on the wire was not counted");
    assert.equal(stampAttempts, 2, "the stamp was not retried exactly once");

    const marker = db.read("schedulerMarkers", markerId("uid001"));
    assert.equal(marker.sentAt, null, "the stamp somehow landed");
    assert.equal(marker.skippedReason, SENT_UNSTAMPED_REASON);
    assert.match(marker.lastError, /WAS sent/, "the marker does not say the mail went out");

    // The proof: a later tick, with the writes working again, sends nothing.
    globalThis.__setHook = null;
    globalThis.__sends = [];
    await runWorksheetDueReminders(
      context({ now: new Date("2026-10-03T20:00:00.000Z") }).ctx,
    );
    assert.equal(globalThis.__sends.length, 0, "the recipient was reminded twice");
  });

  test("the audience pages, so a circulation bigger than one page is fully reached", async () => {
    // The cursor is the part that is easy to get wrong and invisible when it
    // is: without it the job re-reads page one forever.
    const count = RESPONSE_PAGE_SIZE + 20;
    const db = world({ count });
    reset(db);

    const { result, summary } = await runWorksheetDueReminders(context().ctx);

    assert.equal(summary.sent, count);
    assert.equal(result.hasMore, false);
    assert.ok(db.stats.queries >= 3, "one page was read, so the cursor did nothing");
  });
});

// ---------------------------------------------------------------------------
// 8. Source pins
// ---------------------------------------------------------------------------

const JOB_FILE = "src/lib/scheduler/jobs/worksheetDueReminders.ts";

describe("the handler's own shape", () => {
  const src = source(JOB_FILE);

  test("claims before it sends, and stamps after", () => {
    const claimAt = src.indexOf("await claim(db, marker");
    const sendAt = src.indexOf("await sendWorksheetDueSoonEmail(");
    const stampAt = src.indexOf("await stampSentOrSettle(");
    assert.ok(claimAt !== -1, "the handler no longer claims a marker");
    assert.ok(sendAt !== -1, "the handler no longer sends through the email door");
    assert.ok(stampAt !== -1, "the handler no longer stamps the marker after a send");
    assert.ok(claimAt < sendAt, "the send runs before the claim");
    assert.ok(sendAt < stampAt, "the marker is stamped before the send");
  });

  test("scans in the order the one composite index declares", () => {
    // `circulations (status ASC, dueDate ASC)` in firestore.indexes.json.
    // Equality first, then the range field: any other order is the same query
    // to Firestore and a different-looking one to the index guard.
    const statusAt = src.indexOf('.where("status", "==", "open")');
    const fromAt = src.indexOf('.where("dueDate", ">=", ctx.now)');
    const toAt = src.indexOf('.where("dueDate", "<=", horizon)');
    assert.ok(statusAt !== -1 && fromAt !== -1 && toAt !== -1, "the scan query changed shape");
    assert.ok(statusAt < fromAt && fromAt < toAt, "the clauses are not in index order");

    const index = JSON.parse(source("firestore.indexes.json"));
    const declared = index.indexes.find(
      (entry) =>
        entry.collectionGroup === "circulations" &&
        entry.fields.map((field) => field.fieldPath).join(",") === "status,dueDate",
    );
    assert.ok(declared, "the composite index this scan needs is not declared");
  });

  test("never orders the audience by a field the audience does not have", () => {
    // `submittedAt` is null on exactly the people this job wants, and Firestore
    // drops documents missing an ordered field: an orderBy here would empty it.
    assert.ok(!/\.orderBy\(/.test(src), "the audience query has an orderBy on it");
  });

  test("reads the kill switch once, before any marker is claimed", () => {
    const switchAt = src.indexOf("await isTaskEmailEnabled(db)");
    const claimAt = src.indexOf("await claim(db, marker");
    assert.ok(switchAt !== -1, "the kill switch is no longer read");
    assert.ok(switchAt < claimAt, "a marker is claimed before the kill switch is read");
    assert.equal(
      src.split("isTaskEmailEnabled(db)").length - 1,
      1,
      "the kill switch is read more than once",
    );
  });

  test("the skip reasons that land on markers are named constants, not literals", () => {
    // They land on markers an admin reads in the panel, so each has to be the
    // same string every time. The two reasons the handler decides for itself
    // are pinned; "suppressed" and "no-address" are the suppression list's and
    // the account's own words and are asserted where they are produced.
    assert.match(src, /SUPPRESSION_UNREADABLE_REASON = "suppression-unreadable"/);
    assert.match(src, /SENT_UNSTAMPED_REASON = "sent-unstamped"/);
    assert.equal(SUPPRESSION_UNREADABLE_REASON, "suppression-unreadable");
    assert.equal(SENT_UNSTAMPED_REASON, "sent-unstamped");
  });

  test("nothing in the handler derives a drop from maxLateHours", () => {
    // The mapping this file used to carry measured lateness from the moment
    // the 48-hour window OPENED, which silenced every deadline less than
    // `maxLateHours` away on a scheduler that had never missed a tick. There
    // is no instant here to be late for, and the scan's own `dueDate >= now`
    // clause is the whole lateness rule. See the header.
    assert.ok(!/isStaleWork/.test(src), "the handler derives staleness again");
    assert.ok(!/ctx\.maxLateHours/.test(src), "the handler reads a bound it cannot honour");
    assert.ok(
      /\.where\("dueDate", ">=", ctx\.now\)/.test(src),
      "the one clause that keeps a passed deadline out of the audience is gone",
    );
  });
});
