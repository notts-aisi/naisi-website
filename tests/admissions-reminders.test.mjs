/**
 * The admissions deadline reminders: the due-date maths, and the job that
 * hangs off it.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing here
 *
 *  1. **The due instants.** Every reminder date is derived at tick time from
 *     `closesAt` minus an offset, moved to a London wall clock. Getting that
 *     wrong by an hour is invisible in April and wrong for half the year, so
 *     the BST and GMT cases are both executed rather than reasoned about.
 *  2. **The marker key.** It is the RESOLVED CIVIL DATE, never the offset id,
 *     and that single decision is what makes editing a round's schedule safe
 *     and what collapses two same-day offsets onto one email. Both halves are
 *     asserted directly.
 *  3. **The order of operations.** Claim, then send, then stamp. The fake
 *     below inspects the marker FROM INSIDE the send, which is the only way
 *     to prove the claim really precedes the send rather than merely
 *     appearing earlier in the file.
 *  4. **The ceiling and the stale rule**, because both are policies about
 *     what NOT to do, and a policy nobody executes is a comment.
 *
 * ## The fake Firestore
 *
 * A double, not the emulator: `npm test` has no emulator and must not reach a
 * project. It implements the six things the handler uses (doc get, doc
 * create, doc set with merge, an equality query with a limit and a cursor, a
 * transaction, and a resolving server timestamp) and nothing else. The email
 * send, the suppression list and the Admin SDK are stubbed at the module
 * boundary, so no test in this file can put mail on the wire.
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
 * They talk to the test through `globalThis` rather than through an injected
 * argument because the handler resolves them by import, exactly as it does in
 * production: a handler that took its database as a parameter would be a
 * handler this suite tested in a shape the tick never runs.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      `  serverTimestamp: () => ({ __sentinel: "${SERVER_TIMESTAMP}" }),\n` +
      "};\n" +
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
      "};",
  ],
  [
    "@/lib/email/courseFacilitatorEmails",
    "export const hasOptedOutOfCourseAnnouncements = (data) =>\n" +
      "  data?.profile?.notifications?.categories?.courses === false;\n" +
      "export const memberNameOf = (data) =>\n" +
      "  (typeof data?.profile?.preferredName === 'string' && data.profile.preferredName) ||\n" +
      "  (typeof data?.displayName === 'string' && data.displayName) || '';",
  ],
  [
    "@/lib/email/admissionEmails",
    "export const admissionApplicationUrl = (roundId, surface) =>\n" +
      "  `https://naisi.uk/${surface === 'apply' ? 'apply' : 'applications'}/${roundId}`;\n" +
      "export const sendAdmissionEmail = async (opts) => {\n" +
      "  const sends = (globalThis.__sends ??= []);\n" +
      "  sends.push(opts);\n" +
      "  return globalThis.__sendHook ? globalThis.__sendHook(opts) : 'sent';\n" +
      "};",
  ],
  // The worksheet due-soon reminders job's two doors. Nothing here runs it,
  // but this file loads `registry.ts` for `policyFor`, and the registry
  // imports every job by value: its email door reaches a `.tsx` component and
  // its push mirror's graph imports `Timestamp` as a value, neither of which
  // this loader can serve.
  [
    "@/lib/email/worksheetReminderEmails",
    "export const worksheetRespondPath = () => '';\n" +
      "export const worksheetDueSoonSubject = () => '';\n" +
      "export const formatWorksheetDue = () => '';\n" +
      "export const sendWorksheetDueSoonEmail = async () => 'sent';",
  ],
  ["@/lib/push/taskNotifications", "export const mirrorTaskEmailToPush = async () => {};"],
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
  DEFAULT_REMINDER_TIME_LOCAL,
  markerDateKey,
  reminderDueAt,
  resolveReminderDueDates,
} = await loadTs("lib/admissions/reminderSchedule.ts");

const {
  ADMISSIONS_REMINDERS_JOB_ID,
  APPLICATION_PAGE_SIZE,
  SENT_UNSTAMPED_REASON,
  STALE_MARKER_UID,
  SUPPRESSION_UNREADABLE_REASON,
  admissionsRemindersJob,
  runAdmissionsReminders,
} = await loadTs("lib/scheduler/jobs/admissionsReminders.ts");

const { policyFor } = await loadTs("lib/scheduler/registry.ts");

// ---------------------------------------------------------------------------
// 1. The due-date maths
// ---------------------------------------------------------------------------

/** The facilitator round: applications close 23:59 London on Sunday 4 Oct 2026. */
const CLOSES_AT = new Date("2026-10-04T22:59:00.000Z");

describe("when a reminder is due", () => {
  test("T minus 7 on a 4 Oct deadline lands on 27 Sep, in BST", () => {
    // The date this whole PR was pulled forward for. 27 September 2026 is
    // BST, so 10:00 local is 09:00 UTC; subtracting seven 24-hour blocks
    // from the stored instant would have produced 22:59 on the 27th.
    const { dueAtKey, dueAt } = reminderDueAt(CLOSES_AT, {
      id: "t7",
      daysBefore: 7,
      atLocalTime: "10:00",
    });
    assert.equal(dueAtKey, "2026-09-27");
    assert.equal(dueAt.toISOString(), "2026-09-27T09:00:00.000Z");
  });

  test("the same wall clock in GMT is an hour later in UTC", () => {
    // Same offset, same time typed by the same admin, a different month.
    const december = new Date("2026-12-13T23:59:00.000Z");
    const { dueAtKey, dueAt } = reminderDueAt(december, {
      id: "t3",
      daysBefore: 3,
      atLocalTime: "10:00",
    });
    assert.equal(dueAtKey, "2026-12-10");
    assert.equal(dueAt.toISOString(), "2026-12-10T10:00:00.000Z");
  });

  test("the clocks going back does not move the civil date", () => {
    // 25 Oct 2026 is the day the clocks go back. Counting back in CIVIL days
    // from a deadline the far side of it must still name the day an admin
    // would name, not the day 24-hour arithmetic lands on.
    const nov = new Date("2026-11-01T23:59:00.000Z");
    assert.equal(markerDateKey(nov, 7), "2026-10-25");
    assert.equal(markerDateKey(nov, 8), "2026-10-24");
  });

  test("deadline day is the deadline's own civil date", () => {
    assert.equal(markerDateKey(CLOSES_AT, 0), "2026-10-04");
  });

  test("an offset with no usable local time falls back rather than throwing", () => {
    const { dueAt } = reminderDueAt(CLOSES_AT, {
      id: "t7",
      daysBefore: 7,
      atLocalTime: "",
    });
    const { dueAt: expected } = reminderDueAt(CLOSES_AT, {
      id: "t7",
      daysBefore: 7,
      atLocalTime: DEFAULT_REMINDER_TIME_LOCAL,
    });
    assert.equal(dueAt.toISOString(), expected.toISOString());
  });

  test("a round with no deadline has no reminders", () => {
    assert.deepEqual(
      resolveReminderDueDates({
        closesAt: null,
        offsets: [{ id: "t7", daysBefore: 7, atLocalTime: "10:00" }],
        now: new Date(),
        maxLateHours: 24,
      }),
      [],
    );
  });
});

describe("the marker key", () => {
  test("editing an offset to a different date is a different key", () => {
    const before = reminderDueAt(CLOSES_AT, { id: "t7", daysBefore: 7, atLocalTime: "10:00" });
    const after = reminderDueAt(CLOSES_AT, { id: "t7", daysBefore: 6, atLocalTime: "10:00" });
    assert.notEqual(before.dueAtKey, after.dueAtKey);
  });

  test("editing an offset's TIME on the same day is the same key, so it cannot re-send", () => {
    // The failure this design exists to prevent: an admin nudging "10:00" to
    // "12:00" on the morning it has already gone out, and everybody getting
    // it twice.
    const morning = reminderDueAt(CLOSES_AT, { id: "t7", daysBefore: 7, atLocalTime: "10:00" });
    const noon = reminderDueAt(CLOSES_AT, { id: "t7", daysBefore: 7, atLocalTime: "12:00" });
    assert.equal(morning.dueAtKey, noon.dueAtKey);
  });

  test("two offsets resolving to the same day collapse onto one send", () => {
    const due = resolveReminderDueDates({
      closesAt: CLOSES_AT,
      offsets: [
        { id: "t3", daysBefore: 3, atLocalTime: "16:00" },
        { id: "dday", daysBefore: 3, atLocalTime: "09:00" },
      ],
      now: new Date("2026-10-01T12:00:00.000Z"),
      maxLateHours: 24,
    });
    assert.equal(due.length, 1, "two offsets on one day are two sends");
    assert.deepEqual(due[0].offsetIds, ["t3", "dday"]);
    // The EARLIER of the two times wins: the point of the earlier offset is
    // that it goes out earlier.
    assert.equal(due[0].dueAt.toISOString(), "2026-10-01T08:00:00.000Z");
  });
});

describe("a reminder that resolves past the deadline", () => {
  /** A round that shuts at 09:00 London on 4 Oct, not at 23:59. */
  const MORNING_CLOSE = new Date("2026-10-04T08:00:00.000Z");

  test("an offset timed after the deadline's own time of day sends nothing", () => {
    // The email would have read "applications close on Sun 4 Oct, 09:00" and
    // linked to a form that had already stopped accepting anybody, three
    // hours earlier.
    const due = resolveReminderDueDates({
      closesAt: MORNING_CLOSE,
      offsets: [{ id: "dday", daysBefore: 0, atLocalTime: "12:00" }],
      now: new Date("2026-10-04T11:30:00.000Z"),
      maxLateHours: 24,
    });
    assert.deepEqual(due, [], "a reminder resolved past the deadline was kept");
  });

  test("the offsets that land before it are untouched", () => {
    const due = resolveReminderDueDates({
      closesAt: MORNING_CLOSE,
      offsets: [
        { id: "t7", daysBefore: 7, atLocalTime: "10:00" },
        { id: "dday", daysBefore: 0, atLocalTime: "12:00" },
      ],
      now: new Date("2026-10-04T11:30:00.000Z"),
      maxLateHours: 24 * 30,
    });
    assert.deepEqual(
      due.map((entry) => entry.offsetIds),
      [["t7"]],
      "dropping the late offset took the early one with it",
    );
  });
});

describe("the stale rule", () => {
  const offsets = [{ id: "t7", daysBefore: 7, atLocalTime: "10:00" }];
  const stateAt = (now) =>
    resolveReminderDueDates({ closesAt: CLOSES_AT, offsets, now, maxLateHours: 24 })[0].state;

  test("a due date still ahead is pending", () => {
    assert.equal(stateAt(new Date("2026-09-27T08:59:00.000Z")), "pending");
  });

  test("a due date twelve hours old is still worth sending", () => {
    assert.equal(stateAt(new Date("2026-09-27T21:00:00.000Z")), "due");
  });

  test("a due date three days old is stale, and nobody is mailed", () => {
    assert.equal(stateAt(new Date("2026-09-30T09:00:00.000Z")), "stale");
  });

  test("the boundary is exclusive, so exactly 24 hours late still sends", () => {
    assert.equal(stateAt(new Date("2026-09-28T09:00:00.000Z")), "due");
    assert.equal(stateAt(new Date("2026-09-28T09:00:01.000Z")), "stale");
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
  /** collection name -> id -> { data, version } */
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
      async create(data) {
        stats.creates += 1;
        await Promise.resolve();
        // The hooks are how a test makes ONE write fail. Firestore's own
        // failures are per-call and transient, and the handler's whole
        // resilience story is about surviving them one at a time.
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
        // Sorted by id, which is what Firestore does for an equality-only
        // query, and what makes the cursor below mean anything.
        let ids = [...col(name).keys()].sort();
        if (after !== null) ids = ids.filter((id) => id > after);
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

  return {
    collection(name) {
      return {
        doc: (id) => docRef(name, id),
        where: (field, op, value) => query(name, [], null, null).where(field, op, value),
      };
    },
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
    ids: (name) => [...col(name).keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// 3. The job
// ---------------------------------------------------------------------------

const ROUND_ID = "facilitators-autumn-2026__k3f9a2b1";

function round(overrides = {}) {
  return {
    kind: "appointment",
    label: "Facilitators, autumn 2026",
    status: "open",
    archived: false,
    closesAt: CLOSES_AT,
    reminderOffsets: [{ id: "t7", daysBefore: 7, atLocalTime: "10:00" }],
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

function context({ now, maxPerTick = admissionsRemindersJob.maxPerTick, remainingMs = 60_000 }) {
  const logged = [];
  return {
    ctx: {
      now,
      budget: { remainingMs: () => remainingMs, expired: () => remainingMs <= 0 },
      log: (message, extra) => logged.push([message, extra]),
      policy: policyFor(admissionsRemindersJob),
      maxPerTick,
      maxLateHours: admissionsRemindersJob.maxLateHours,
    },
    logged,
  };
}

function reset(db) {
  globalThis.__db = db;
  globalThis.__sends = [];
  globalThis.__suppressed = new Set();
  globalThis.__sendHook = null;
  globalThis.__suppressionError = null;
  globalThis.__createHook = null;
  globalThis.__setHook = null;
  globalThis.__queryHook = null;
}

/** The one date the fixtures are due on: T minus 7 from 4 Oct, plus two hours. */
const JUST_AFTER_DUE = new Date("2026-09-27T11:00:00.000Z");
const DUE_KEY = "2026-09-27";
const markerId = (uid) => `remind__${ROUND_ID}__${uid}__${DUE_KEY}`;

describe("the reminders job", () => {
  test("mails every draft applicant once, and stamps each marker", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(3),
      users: users(3),
    });
    reset(db);
    const { ctx } = context({ now: JUST_AFTER_DUE });

    const { result, summary } = await runAdmissionsReminders(ctx);

    assert.equal(summary.sent, 3);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.stale, 0);
    assert.equal(summary.failures.length, 0);
    assert.equal(result.hasMore, false);
    assert.equal(globalThis.__sends.length, 3);

    const first = globalThis.__sends[0];
    assert.equal(first.kind, "deadline-reminder");
    assert.equal(first.roundLabel, "Facilitators, autumn 2026");
    // The audience holds drafts, so the link is the FORM, not the status hub.
    assert.match(first.applicationUrl, /\/apply\//);
    assert.ok(first.deadline, "the deadline token is not supplied");

    for (const uid of ["uid001", "uid002", "uid003"]) {
      const marker = db.read("schedulerMarkers", markerId(uid));
      assert.ok(marker, `no marker for ${uid}`);
      assert.equal(marker.job, ADMISSIONS_REMINDERS_JOB_ID);
      assert.ok(marker.sentAt instanceof Date, `${uid}'s marker was never stamped`);
      assert.ok(marker.expiresAt instanceof Date, "a settled marker has no TTL horizon");
      // Every id component is stored as a field, so a sweep never parses ids.
      assert.equal(marker.roundId, ROUND_ID);
      assert.equal(marker.uid, uid);
      assert.equal(marker.dueAtKey, DUE_KEY);
    }
  });

  test("a second run sends nothing, however many times it is asked", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(3),
      users: users(3),
    });
    reset(db);

    await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);
    globalThis.__sends = [];
    const { summary } = await runAdmissionsReminders(
      context({ now: new Date("2026-09-27T12:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "the second run re-sent");
    assert.equal(summary.sent, 0);
  });

  test("the marker is claimed BEFORE the send, not after it", async () => {
    // Checked from inside the send: the order has to be a fact about the run,
    // not about where two lines sit in a file. A crash here must cost a
    // missed email, never a duplicate one.
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(1),
      users: users(1),
    });
    reset(db);
    let markerDuringSend = null;
    globalThis.__sendHook = (opts) => {
      markerDuringSend = db.read("schedulerMarkers", markerId(opts.uid));
      return "sent";
    };

    await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.ok(markerDuringSend, "the send ran with no marker claimed");
    assert.ok(markerDuringSend.claimedAt instanceof Date);
    assert.equal(markerDuringSend.sentAt, null, "the marker was stamped before the send");
  });

  test("a due date three days past is stamped stale and mails nobody", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(3),
      users: users(3),
    });
    reset(db);

    const { summary } = await runAdmissionsReminders(
      context({ now: new Date("2026-09-30T09:00:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "a stale reminder went out anyway");
    assert.equal(summary.sent, 0);
    assert.equal(summary.stale, 1);
    // ONE marker for the whole round and date rather than one per applicant:
    // the verdict is identical for everybody on it, and re-derived every tick.
    const stale = db.read("schedulerMarkers", markerId(STALE_MARKER_UID));
    assert.ok(stale, "the dropped date left no record");
    assert.equal(stale.skippedReason, "stale");
    assert.equal(db.ids("schedulerMarkers").length, 1);
  });

  test("the per-tick ceiling stops the sends and reports what is left", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(5),
      users: users(5),
    });
    reset(db);

    const { result, summary } = await runAdmissionsReminders(
      context({ now: JUST_AFTER_DUE, maxPerTick: 2 }).ctx,
    );

    assert.equal(summary.sent, 2);
    assert.equal(result.hasMore, true, "a capped run must ask the tick to come back");
    assert.ok(
      !("remaining" in summary),
      "the receipt is back to counting loaded-but-unexamined candidates",
    );

    // The next run picks up exactly the people the first one did not reach.
    globalThis.__sends = [];
    await runAdmissionsReminders(context({ now: JUST_AFTER_DUE, maxPerTick: 200 }).ctx);
    assert.equal(globalThis.__sends.length, 3);
  });

  test("the audience pages, so a round bigger than one page is fully reached", async () => {
    // The cursor is the part that is easy to get wrong and invisible when it
    // is: without it the job re-reads page one forever and everybody past the
    // hundredth applicant is never mailed.
    const count = APPLICATION_PAGE_SIZE + 50;
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(count),
      users: users(count),
    });
    reset(db);

    const { result, summary } = await runAdmissionsReminders(
      context({ now: JUST_AFTER_DUE }).ctx,
    );

    assert.equal(summary.sent, count);
    assert.equal(result.hasMore, false);
    assert.ok(db.stats.queries >= 2, "one page was read, so the cursor did nothing");
  });

  test("the real registration's ceiling is the 200 the contract names", () => {
    assert.equal(admissionsRemindersJob.maxPerTick, 200);
    assert.equal(admissionsRemindersJob.maxLateHours, 24);
    assert.equal(admissionsRemindersJob.id, "admissions-deadline-reminders");
    // The audience is paged, so the ceiling is not the page size: 200 sends
    // has to be reachable across more than one page of candidates.
    assert.ok(APPLICATION_PAGE_SIZE <= admissionsRemindersJob.maxPerTick);
  });

  test("a suppressed address is skipped, settled, and never mailed", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(2),
      users: users(2),
    });
    reset(db);
    globalThis.__suppressed = new Set(["uid001@example.com"]);

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(globalThis.__sends.length, 1);
    assert.equal(globalThis.__sends[0].to, "uid002@example.com");
    assert.equal(
      db.read("schedulerMarkers", markerId("uid001")).skippedReason,
      "suppressed",
    );
  });

  test("an explicit courses opt-out is honoured; an unanswered one is not a refusal", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(2),
      users: users(2, (uid) =>
        uid === "uid001"
          ? { profile: { notifications: { categories: { courses: false } } } }
          : {},
      ),
    });
    reset(db);

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(
      db.read("schedulerMarkers", markerId("uid001")).skippedReason,
      "opted-out",
    );
  });

  test("a submitted application is not in the audience", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: {
        ...applications(1),
        [`${ROUND_ID}__uid002`]: application("uid002", { status: "submitted" }),
      },
      users: users(2),
    });
    reset(db);

    await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.deepEqual(
      globalThis.__sends.map((s) => s.uid),
      ["uid001"],
    );
  });

  test("a failed send leaves the marker unstamped, so a later tick retries it", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(1),
      users: users(1),
    });
    reset(db);
    globalThis.__sendHook = () => "failed";

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(summary.sent, 0);
    assert.equal(summary.failures.length, 1);
    const marker = db.read("schedulerMarkers", markerId("uid001"));
    assert.equal(marker.sentAt, null, "a failed send was stamped as sent");
    assert.equal(marker.skippedReason, null, "a failed send was settled as skipped");
    assert.ok(marker.lastError, "the failure left no reason on the marker");
  });

  test("one recipient throwing does not cost the people behind them", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(3),
      users: users(3),
    });
    reset(db);
    globalThis.__sendHook = (opts) => {
      if (opts.uid === "uid001") throw new Error("resend said no");
      return "sent";
    };

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(summary.sent, 2);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].uid, "uid001");
    assert.match(summary.failures[0].error, /resend said no/);
  });

  test("a round that is not open, or has no schedule, is left alone", async () => {
    for (const overrides of [
      { status: "closed" },
      { archived: true },
      { closesAt: null },
      { reminderOffsets: [] },
    ]) {
      const db = makeDb({
        admissionRounds: { [ROUND_ID]: { ...round(), ...overrides } },
        admissionApplications: applications(2),
        users: users(2),
      });
      reset(db);
      await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);
      assert.equal(
        globalThis.__sends.length,
        0,
        `a round with ${JSON.stringify(overrides)} was mailed`,
      );
    }
  });

  test("a stamp that will not stick still cannot become a second email", async () => {
    // The nastiest of the failure orders: the mail is on the wire and the
    // marker cannot record it. An unstamped marker is RECLAIMABLE, so a later
    // tick would derive this person again, win the re-claim and send them a
    // second deadline email. The marker has to settle instead.
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(1),
      users: users(1),
    });
    reset(db);
    let stampAttempts = 0;
    globalThis.__setHook = (name, id, data) => {
      if (name !== "schedulerMarkers" || !("sentAt" in data) || data.sentAt === null) return;
      stampAttempts += 1;
      throw new Error("firestore refused the stamp");
    };

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(globalThis.__sends.length, 1, "the email did not go out at all");
    assert.equal(summary.sent, 1, "a send on the wire was not counted");
    assert.equal(stampAttempts, 2, "the stamp was not retried exactly once");

    const marker = db.read("schedulerMarkers", markerId("uid001"));
    assert.equal(marker.sentAt, null, "the stamp somehow landed");
    assert.equal(
      marker.skippedReason,
      SENT_UNSTAMPED_REASON,
      "the marker was left in a state the re-claim rule will pick up",
    );
    assert.match(marker.lastError, /WAS sent/, "the marker does not say the mail went out");

    // The proof: a later tick, with the writes working again, sends nothing.
    globalThis.__setHook = null;
    globalThis.__sends = [];
    await runAdmissionsReminders(
      context({ now: new Date("2026-09-28T08:00:00.000Z") }).ctx,
    );
    assert.equal(globalThis.__sends.length, 0, "the applicant was mailed twice");
  });

  test("one applicant's claim throwing does not cost the people behind them", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(3),
      users: users(3),
    });
    reset(db);
    globalThis.__createHook = (name, id) => {
      if (name === "schedulerMarkers" && id === markerId("uid002")) {
        throw new Error("firestore refused the claim");
      }
    };

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

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

  test("a suppression list that will not read is a recorded skip, not an aborted run", async () => {
    // Failing open here would mail addresses the platform has been told to
    // stop mailing, which outlives this send.
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(2),
      users: users(2),
    });
    reset(db);
    globalThis.__suppressionError = "suppression list unavailable";

    const { summary } = await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx);

    assert.equal(globalThis.__sends.length, 0);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failures.length, 0, "a handled skip was reported as a failure");
    assert.equal(
      db.read("schedulerMarkers", markerId("uid001")).skippedReason,
      SUPPRESSION_UNREADABLE_REASON,
    );
  });

  test("a page of applicants that will not read ends the date, not the run", async () => {
    const db = makeDb({
      admissionRounds: { [ROUND_ID]: round() },
      admissionApplications: applications(2),
      users: users(2),
    });
    reset(db);
    globalThis.__queryHook = (name) => {
      if (name === "admissionApplications") throw new Error("the read failed");
    };

    const { result, summary } = await runAdmissionsReminders(
      context({ now: JUST_AFTER_DUE }).ctx,
    );

    assert.equal(result.hasMore, true, "the unread date was not reported as outstanding");
    assert.equal(summary.sent, 0);
    assert.equal(summary.failures.length, 1);
    assert.equal(
      summary.failures[0].uid,
      `date:${DUE_KEY}`,
      "a failure with no applicant behind it was filed under a uid",
    );
    assert.deepEqual(db.ids("schedulerMarkers"), [], "a claim was made on an unread page");
  });

  test("a round whose deadline has passed mails nobody, whatever its status says", async () => {
    // The failure this gate exists for: a round still stamped `open` because
    // nobody has moved it on, a deadline-day reminder timed for the morning,
    // and a tick that runs after the form has stopped accepting people. The
    // email would arrive with a link that refuses the reader.
    const db = makeDb({
      admissionRounds: {
        [ROUND_ID]: round({
          reminderOffsets: [{ id: "dday", daysBefore: 0, atLocalTime: "09:00" }],
        }),
      },
      admissionApplications: applications(2),
      users: users(2),
    });
    reset(db);

    const { summary } = await runAdmissionsReminders(
      // 23:30 London on deadline day: past the 23:59 close in UTC terms, and
      // well inside the 24-hour staleness window, so only the window gate can
      // stop this send.
      context({ now: new Date("2026-10-04T23:30:00.000Z") }).ctx,
    );

    assert.equal(globalThis.__sends.length, 0, "a shut round was mailed anyway");
    assert.equal(summary.sent, 0);
    assert.equal(summary.rounds, 0, "a shut round was counted as examined");
    assert.deepEqual(db.ids("schedulerMarkers"), [], "a shut round left markers");
  });

  test("the same round mails everyone while it is still open", async () => {
    // The other half of the gate: it must not be refusing live rounds.
    const db = makeDb({
      admissionRounds: {
        [ROUND_ID]: round({
          reminderOffsets: [{ id: "dday", daysBefore: 0, atLocalTime: "09:00" }],
        }),
      },
      admissionApplications: applications(2),
      users: users(2),
    });
    reset(db);

    const { summary } = await runAdmissionsReminders(
      context({ now: new Date("2026-10-04T12:00:00.000Z") }).ctx,
    );

    assert.equal(summary.sent, 2);
    assert.equal(summary.rounds, 1);
  });

  test("Send now runs the same handler, scoped to one round", async () => {
    const other = "autumn-2026-intake__aa11bb22";
    const db = makeDb({
      admissionRounds: {
        [ROUND_ID]: round(),
        [other]: { ...round(), label: "Autumn 2026 intake" },
      },
      admissionApplications: {
        ...applications(1),
        [`${other}__uid009`]: { ...application("uid009"), roundId: other },
      },
      users: { ...users(1), uid009: { email: "uid009@example.com" } },
    });
    reset(db);

    await runAdmissionsReminders(context({ now: JUST_AFTER_DUE }).ctx, { roundId: other });

    assert.deepEqual(
      globalThis.__sends.map((s) => s.uid),
      ["uid009"],
      "a round-scoped run reached somebody else's round",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Source pins on the Send now route
// ---------------------------------------------------------------------------

const SEND_NOW = "src/app/api/admissions/rounds/[roundId]/reminders/send-now/route.ts";
const JOB_FILE = "src/lib/scheduler/jobs/admissionsReminders.ts";

describe("the Send now route", () => {
  const src = source(SEND_NOW);

  test("refuses a view-as session before it reads anything", () => {
    const guard = src.indexOf("assertNotImpersonating()");
    assert.ok(guard !== -1, "the route does not call the impersonation guard at all");
    for (const later of ["getCurrentUser(", "getAdminDb(", "runAdmissionsReminders("]) {
      const at = src.indexOf(later);
      // Asserted present FIRST. An `at === -1` escape here would pass this
      // test by renaming the call it is meant to be ordering against.
      assert.ok(at !== -1, `${later} is not in the route at all`);
      assert.ok(guard < at, `${later} runs before the view-as guard`);
    }
  });

  test("checks the caller may author rounds", () => {
    assert.match(src, /canAuthorRounds\(user\)/);
  });

  test("refuses a round that is not open", () => {
    assert.match(src, /round\.status !== "open"/);
  });

  test("calls the job's own handler rather than a copy of it", () => {
    // A second implementation here would be a second path through the one
    // thing on this platform that must not double-send.
    assert.match(src, /runAdmissionsReminders\(/);
    assert.match(src, /policyFor\(admissionsRemindersJob\)/);
    assert.match(src, /maxLateHours: admissionsRemindersJob\.maxLateHours/);
    assert.ok(
      !/sendAdmissionEmail/.test(src),
      "the route sends mail itself instead of going through the job",
    );
  });

  test("refuses while the reminders job's own switch is off", () => {
    // The tick honours that switch, so the manual lane has to as well: this
    // job ships dark, and without the check Send now would mail a whole round
    // during the deliberate dark period before anybody armed it.
    assert.match(src, /jobStateFor\(\s*config,\s*ADMISSIONS_REMINDERS_JOB_ID/);
    assert.match(src, /jobDefaultEnabled\(admissionsRemindersJob\)/);
    assert.match(src, /if \(!jobState\.enabled\)/);
  });

  test("answers with the receipt the button shows", () => {
    for (const key of ["sent:", "skipped:", "stale:", "hasMore:"]) {
      assert.ok(src.includes(key), `the receipt has no ${key}`);
    }
    // Not a "still to go" count: the run has only loaded a page of the
    // audience, and most of it may already be stamped, so the number would
    // promise work the next press does not do.
    assert.ok(
      !src.includes("summary.remaining") && !src.includes("remaining:"),
      "the receipt is back to promising a remainder",
    );
  });
});

describe("the handler's own ordering", () => {
  const src = source(JOB_FILE);

  test("claims before it sends, and stamps after", () => {
    const claimAt = src.indexOf("await claim(db, marker");
    const sendAt = src.indexOf("await sendAdmissionEmail(");
    const stampAt = src.indexOf("await stampSentOrSettle(");
    assert.ok(claimAt !== -1, "the handler no longer claims a marker");
    assert.ok(sendAt !== -1, "the handler no longer sends through sendAdmissionEmail");
    assert.ok(stampAt !== -1, "the handler no longer stamps the marker after a send");
    assert.ok(claimAt < sendAt, "the send runs before the claim");
    assert.ok(sendAt < stampAt, "the marker is stamped before the send");
  });

  test("gates the round on the shared window predicate", () => {
    // Not a bare `status === "open"`: the round page, the apply route and this
    // job have to agree about what open means, or the reminder advertises a
    // form that refuses the reader.
    assert.match(src, /isRoundOpen\(round, ctx\.now\)/);
  });

  test("checks suppression before the send", () => {
    // Through `resolveRecipient`, which is called before the send and returns
    // a skip reason rather than an address.
    assert.match(src, /await resolveRecipient\(db, candidate\)/);
    const resolveAt = src.indexOf("async function resolveRecipient");
    const suppressedAt = src.indexOf("isSuppressed(db, to)");
    assert.ok(suppressedAt > resolveAt, "suppression is not checked in the resolver");
  });

  test("never orders the audience by a field a draft does not have", () => {
    // `submittedAt` is null until submission, and Firestore drops documents
    // missing an ordered field: an orderBy here would empty the audience.
    assert.ok(!/\.orderBy\(/.test(src), "the audience query has an orderBy on it");
  });
});
