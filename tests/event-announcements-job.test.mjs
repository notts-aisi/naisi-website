/**
 * The queued new-event announcement job.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials, no
 * network).
 *
 * ## What is worth executing here, and why a source grep would not do
 *
 *  1. **It ships dark, and so does the path that feeds it.** The job emails
 *     and pushes to a whole list, and `config/scheduler` reads a missing row
 *     as the job's own default. What is new is that the same switch also
 *     decides what PUBLISHING does, so `announcementQueueEnabled` is executed
 *     against a real `config/scheduler` document rather than asserted about.
 *  2. **Exactly once, across ticks.** The whole design rests on one marker per
 *     recipient per leg: a tick that runs out of budget half way down the list
 *     leaves what it sent stamped, and the next tick's claim on those fails
 *     with ALREADY_EXISTS. That is not visible in a source read, so this suite
 *     runs two ticks and counts the messages.
 *  3. **The totals survive a tick boundary.** They are persisted onto the
 *     event at the end of every tick precisely so an announcement that took
 *     four ticks can still say what all four did, and a test that only ever
 *     ran one tick would never notice them being dropped.
 *  4. **The two release rules, which point in opposite directions.** A pure
 *     refusal hands `announcedAt` back so a republish can requeue; a STALE
 *     refusal keeps it, because there is no later moment at which announcing
 *     a past event becomes right. Both are executed.
 *  5. **The audience is the real one.** The junction read, the members-only
 *     guest drop, the per-address hydration and the events push cell all run
 *     for real against the fake database, because the point of factoring them
 *     out of `eventAnnouncement.ts` was that both paths ask one question.
 *
 * ## The fakes
 *
 * A fake Firestore, not the emulator, implementing what this graph uses: doc
 * get / set / update / create, an `in` query with a limit, a transaction with
 * get and update, a resolving server timestamp, a real `FieldValue.delete()`,
 * `FieldValue.increment` and DOTTED FIELD PATHS. The last two are not
 * decoration: the job writes its counts as increments on paths into
 * `announcementResult` so overlapping ticks cannot write each other's work
 * away, and a fake that stored `"announcementResult.sent"` as a literal key
 * would pass every one of those assertions while the shipping code clobbered
 * the map.
 * The transport, the push service, the subscription junction, the suppression
 * list and the token signer are stubbed at the module boundary, so nothing
 * here can put mail on the wire or a notification on a phone. Everything
 * between those doors is shipping code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (...parts) => readFileSync(join(REPO_ROOT, "src", ...parts), "utf8");

const SERVER_TIMESTAMP = "__serverTimestamp__";
const DELETE = "__delete__";
const INCREMENT = "__increment__";

/**
 * The doors, replaced.
 *
 * The email transport is stubbed as `"./send"`, matching the specifier
 * `eventAnnouncement.ts` writes, and the push transport as `"@/lib/push/send"`,
 * matching the one `rowAudience.ts` and the job write. Those are two different
 * modules with the same basename, which is the reason `rowAudience.ts` goes
 * out of its way to import through the alias; keying on the string as written
 * is how this loader tells them apart.
 *
 * The last five entries are other jobs' doors. This file loads `registry.ts`
 * (for `policyFor` and the dark-by-default assertion) and the registry imports
 * every registered job by value, so their send paths are in this graph whether
 * or not anything here runs them.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      `  serverTimestamp: () => ({ __sentinel: "${SERVER_TIMESTAMP}" }),\n` +
      `  delete: () => ({ __sentinel: "${DELETE}" }),\n` +
      `  increment: (by) => ({ __sentinel: "${INCREMENT}", by }),\n` +
      "};\n" +
      "export class FieldPath {\n" +
      "  constructor(...segments) { this.segments = segments; }\n" +
      "}",
  ],
  ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
  [
    // The EMAIL transport, recorded. Every option is kept so the receipt's
    // `kind` and `referenceId` can be asserted the way the inline path's are.
    "./send",
    "export const sendEmail = async (opts) => {\n" +
      "  if (globalThis.__sendHook) globalThis.__sendHook(opts);\n" +
      "  (globalThis.__sent ??= []).push(opts);\n" +
      "};",
  ],
  [
    "@/lib/push/send",
    "export const sendPushToUid = async (uid, n) => {\n" +
      "  (globalThis.__pushed ??= []).push({ uid, ...n });\n" +
      "  return globalThis.__pushCounts ?? { sent: 1, pruned: 0, deferred: 0, failed: 0, retried: 0 };\n" +
      "};",
  ],
  ["@/lib/push/config", "export const isPushConfigured = () => globalThis.__vapid !== false;"],
  [
    "@/lib/firestore/subscriptions",
    "export const findRecipientsForChannel = async (db, channel) => {\n" +
      "  globalThis.__channelAsked = channel;\n" +
      "  return globalThis.__channelRows ?? [];\n" +
      "};",
  ],
  [
    "@/lib/firestore/suppression",
    "export const isSuppressed = async () => false;\n" +
      "export const filterSuppressed = async (db, addrs) => ({\n" +
      "  allowed: addrs.filter((a) => !(globalThis.__suppressed ?? []).includes(a)),\n" +
      "  suppressed: addrs.filter((a) => (globalThis.__suppressed ?? []).includes(a)),\n" +
      "});",
  ],
  [
    "@/lib/signedTokens",
    "export const signToken = (payload) => `tok:${JSON.stringify(payload)}`;",
  ],
  ["@/lib/events/rsvpToken", "export const baseUrl = () => 'https://naisi.test';"],
  [
    "@/lib/events/changeSummary",
    "export const formatEventWhen = () => 'Fri 6 June, 18:00';",
  ],
  [
    "@/lib/email/worksheetReminderEmails",
    "export const worksheetRespondPath = () => '';\n" +
      "export const worksheetDueSoonSubject = () => '';\n" +
      "export const formatWorksheetDue = () => '';\n" +
      "export const sendWorksheetDueSoonEmail = async () => 'sent';",
  ],
  ["@/lib/push/taskNotifications", "export const mirrorTaskEmailToPush = async () => {};"],
  [
    "@/lib/push/courseNotifications",
    "export const mirrorCourseDecisionToPush = async () => {};",
  ],
  [
    "@/lib/email/admissionEmails",
    "export const admissionApplicationPath = () => '';\n" +
      "export const admissionApplicationUrl = () => '';\n" +
      "export const sendAdmissionEmail = async () => 'sent';",
  ],
  [
    "@/lib/email/courseFacilitatorEmails",
    "export const hasOptedOutOfCourseAnnouncements = () => false;\n" +
      "export const memberNameOf = () => '';",
  ],
]);

const { loadTs } = createLoader({ stubs: STUBS });

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code.
// ---------------------------------------------------------------------------

const {
  EVENT_ANNOUNCEMENTS_JOB_ID,
  EVENT_SCAN_CAP,
  MAX_QUEUED_PUSH_ROWS,
  NO_DEVICE_REASON,
  PUSH_CELL_OFF_REASON,
  SUPPRESSED_REASON,
  announcementIsStale,
  announcementStaleAnchor,
  eventAnnouncementsJob,
  runEventAnnouncements,
} = await loadTs("lib/scheduler/jobs/eventAnnouncements.ts");

const { SENT_UNSTAMPED_REASON } = await loadTs("lib/scheduler/markers.ts");

const { announcementRecipientKey, MAX_QUEUED_ANNOUNCEMENT_ROWS } = await loadTs(
  "lib/email/eventAnnouncement.ts",
);

const { announcementQueueEnabled } = await loadTs("lib/scheduler/announcementQueue.ts");

const { JOBS, SCHEDULER_JOB_IDS, jobDefaultEnabled, policyFor } = await loadTs(
  "lib/scheduler/registry.ts",
);

// ---------------------------------------------------------------------------
// 1. The fake Firestore
// ---------------------------------------------------------------------------

function alreadyExists(id) {
  const err = new Error(`already exists: ${id}`);
  err.code = 6;
  return err;
}

function matches(data, [field, op, value]) {
  const stored = data[field];
  // A document MISSING the field is outside every filter, which is what
  // Firestore does and why the job never orders by a sparse field.
  if (stored === undefined) return false;
  if (op === "==") return stored === value;
  if (op === "in") return Array.isArray(value) && value.includes(stored);
  throw new Error(`the fake does not serve the "${op}" operator`);
}

function makeDb(seed = {}) {
  const store = new Map();
  const col = (path) => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path);
  };
  for (const [path, rows] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(rows)) col(path).set(id, { ...data });
  }

  const sentinel = (value, kind) =>
    value !== null && typeof value === "object" && value.__sentinel === kind;

  /**
   * A DOTTED FIELD PATH is a write INTO a map, not a key with a dot in it.
   * The job writes `announcementResult.sent` that way precisely so its
   * increments merge into the map rather than replacing it, and a fake that
   * stored the literal key would let a test pass on a write that clobbers
   * every count a concurrent tick had made.
   */
  function setPath(target, key, apply) {
    const segments = key.split(".");
    let node = target;
    for (const segment of segments.slice(0, -1)) {
      if (node[segment] === null || typeof node[segment] !== "object") node[segment] = {};
      else node[segment] = { ...node[segment] };
      node = node[segment];
    }
    apply(node, segments[segments.length - 1]);
  }

  function applyWrite(path, id, data, merge) {
    const current = merge ? (col(path).get(id) ?? {}) : {};
    const next = { ...current };
    for (const [key, value] of Object.entries(data)) {
      // `FieldValue.delete()` REMOVES the field rather than storing a marker.
      // A store that kept the marker would answer truthy for a field the real
      // Firestore had dropped, which is the whole question the released claim
      // turns on.
      if (sentinel(value, DELETE)) {
        setPath(next, key, (node, leaf) => delete node[leaf]);
        continue;
      }
      if (sentinel(value, INCREMENT)) {
        setPath(next, key, (node, leaf) => {
          node[leaf] = (typeof node[leaf] === "number" ? node[leaf] : 0) + value.by;
        });
        continue;
      }
      const resolved = sentinel(value, SERVER_TIMESTAMP) ? new Date() : value;
      setPath(next, key, (node, leaf) => {
        node[leaf] = resolved;
      });
    }
    col(path).set(id, next);
  }

  const snapshotOf = (path, id) => {
    const row = col(path).get(id);
    return { id, exists: row !== undefined, data: () => (row ? { ...row } : undefined) };
  };

  function docRef(path, id) {
    return {
      id,
      __path: path,
      async create(data) {
        await Promise.resolve();
        globalThis.__createHook?.(path, id, data);
        if (col(path).has(id)) throw alreadyExists(id);
        applyWrite(path, id, data, false);
      },
      async set(data, options) {
        await Promise.resolve();
        // The hook is how a test makes ONE write fail. Firestore's own
        // failures are per-call, and the stamp that follows a successful send
        // is the one whose failure has to be survived rather than logged.
        globalThis.__setHook?.(path, id, data);
        applyWrite(path, id, data, options?.merge === true);
      },
      async update(data) {
        await Promise.resolve();
        globalThis.__updateHook?.(path, id, data);
        applyWrite(path, id, data, true);
      },
      async get() {
        await Promise.resolve();
        return snapshotOf(path, id);
      },
    };
  }

  function query(path, filters, limit) {
    return {
      where: (field, op, value) => query(path, [...filters, [field, op, value]], limit),
      limit: (n) => query(path, filters, n),
      async get() {
        await Promise.resolve();
        globalThis.__queryHook?.(path, filters);
        const docs = [...col(path).keys()]
          .sort()
          .filter((id) => filters.every((f) => matches(col(path).get(id), f)))
          .slice(0, limit ?? Infinity)
          .map((id) => snapshotOf(path, id));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
  }

  function collectionRef(path) {
    return {
      doc: (id) => docRef(path, id),
      where: (field, op, value) => query(path, [], null).where(field, op, value),
      limit: (n) => query(path, [], n),
    };
  }

  return {
    collection: collectionRef,
    async getAll(...refs) {
      return refs.map((ref) => snapshotOf(ref.__path, ref.id));
    },
    async runTransaction(body) {
      const writes = [];
      const result = await body({
        get: (ref) => {
          globalThis.__txGetHook?.(ref.__path, ref.id);
          return ref.get();
        },
        set: (ref, data, options) => writes.push([ref, data, options?.merge === true]),
        update: (ref, data) => writes.push([ref, data, true]),
      });
      for (const [ref, data, merge] of writes) await ref.set(data, { merge });
      return result;
    },
    read: (path, id) => {
      const row = col(path).get(id);
      return row === undefined ? null : { ...row };
    },
    ids: (path) => [...col(path).keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// 2. Fixtures
// ---------------------------------------------------------------------------

const EVENT_ID = "reading-group__k3f9a2b1";
const MARKERS = "schedulerMarkers";

/** Well after `QUEUED_AT` and well before `STARTS_AT`: an ordinary tick. */
const NOW = new Date("2026-10-01T12:00:00.000Z");
const QUEUED_AT = new Date("2026-10-01T11:50:00.000Z");
const STARTS_AT = new Date("2026-10-08T18:00:00.000Z");

function eventDoc(overrides = {}) {
  return {
    title: "Reading group",
    status: "published",
    visibility: "public",
    location: "B52",
    startAt: STARTS_AT,
    endAt: new Date("2026-10-08T20:00:00.000Z"),
    authorUid: "approver-1",
    announcedAt: QUEUED_AT,
    announcementState: "queued",
    announcementQueuedAt: QUEUED_AT,
    ...overrides,
  };
}

/** One member on the junction with one address, one guest, one push-only account. */
function seedWorld({ event = {}, users, pushSubscriptions, channelRows } = {}) {
  globalThis.__sent = [];
  globalThis.__pushed = [];
  globalThis.__suppressed = [];
  globalThis.__vapid = true;
  globalThis.__pushCounts = undefined;
  globalThis.__sendHook = null;
  globalThis.__createHook = null;
  globalThis.__updateHook = null;
  globalThis.__queryHook = null;
  globalThis.__txGetHook = null;
  globalThis.__setHook = null;
  globalThis.__channelAsked = undefined;
  globalThis.__channelRows = channelRows ?? [
    { email: "member@e2e.invalid", audience: "user", audienceId: "member-1" },
    { email: "guest@e2e.invalid", audience: "guest", audienceId: "guest@e2e.invalid" },
  ];
  globalThis.__db = makeDb({
    events: { [EVENT_ID]: eventDoc(event) },
    users: users ?? {
      "member-1": {
        email: "member@e2e.invalid",
        displayName: "Mem",
        profile: {
          notifications: { categories: { events: true }, push: { events: true } },
        },
      },
      "member-quiet": {
        email: "quiet@e2e.invalid",
        displayName: "Quiet",
        profile: { notifications: { push: { events: false } } },
      },
    },
    pushSubscriptions: pushSubscriptions ?? {
      "device-1": { uid: "member-1", endpoint: "https://push.test/1" },
      "device-2": { uid: "member-quiet", endpoint: "https://push.test/2" },
    },
  });
  return globalThis.__db;
}

/**
 * A tick's context. `expireWhen` is a predicate rather than a duration so a
 * test can stop the run after an exact number of units, which is the only way
 * to prove the resume path without guessing at wall-clock timings.
 */
function context({
  now = NOW,
  maxPerTick = eventAnnouncementsJob.maxPerTick,
  expireWhen = () => false,
} = {}) {
  const logged = [];
  return {
    ctx: {
      now,
      budget: { remainingMs: () => 60_000, expired: () => expireWhen() },
      log: (message, extra) => logged.push([message, extra]),
      policy: policyFor(eventAnnouncementsJob),
      maxPerTick,
      maxLateHours: eventAnnouncementsJob.maxLateHours,
    },
    logged,
  };
}

/**
 * Move a marker's claim back in time.
 *
 * The re-claim window is the only thing between an unstamped marker and a
 * second attempt, and a test that ran two ticks a millisecond apart would meet
 * "in flight" every time. This is the clock the job cannot be handed: `claim`
 * decides against `new Date()` rather than against `ctx.now`, deliberately, so
 * a stale claim is judged by the wall clock and not by a tick's idea of it.
 */
async function ageMarker(db, markerId, minutes) {
  await db
    .collection(MARKERS)
    .doc(markerId)
    .set({ claimedAt: new Date(Date.now() - minutes * 60_000) }, { merge: true });
}

const emailMarkerId = (recipient) =>
  `evannounce__${EVENT_ID}__email__${announcementRecipientKey(recipient)}`;
const pushMarkerId = (uid) => `evannounce__${EVENT_ID}__push__u${uid}`;

const MEMBER = {
  uid: "member-1",
  audience: "user",
  recipientName: "Mem",
  primaryEmail: "member@e2e.invalid",
  addresses: ["member@e2e.invalid"],
};
const GUEST = {
  uid: "",
  audience: "guest",
  recipientName: "there",
  primaryEmail: "guest@e2e.invalid",
  addresses: ["guest@e2e.invalid"],
};

// ---------------------------------------------------------------------------
// 3. The switch
// ---------------------------------------------------------------------------

describe("the switch that decides which path a publish takes", () => {
  test("it is off when nothing has been stored, which is how the job ships dark", async () => {
    const db = makeDb({});
    assert.equal(
      await announcementQueueEnabled(db),
      false,
      "with no `config/scheduler` row the job's own default decides, and it is off",
    );
  });

  test("a stored true is the queue, and a stored false is the inline path", async () => {
    const on = makeDb({ config: { scheduler: { jobs: { [EVENT_ANNOUNCEMENTS_JOB_ID]: { enabled: true } } } } });
    assert.equal(await announcementQueueEnabled(on), true);
    const off = makeDb({ config: { scheduler: { jobs: { [EVENT_ANNOUNCEMENTS_JOB_ID]: { enabled: false } } } } });
    assert.equal(await announcementQueueEnabled(off), false);
  });

  test("a row with no `enabled` key is not somebody having touched the switch", async () => {
    // Run now writes `lastRunAt` onto a job's row without an `enabled`, and a
    // job that ships dark must not read that as being armed.
    const db = makeDb({
      config: { scheduler: { jobs: { [EVENT_ANNOUNCEMENTS_JOB_ID]: { lastRunAt: NOW } } } },
    });
    assert.equal(await announcementQueueEnabled(db), false);
  });

  test("the site-wide kill switch does not silently arm the queue either", async () => {
    // `enabled: false` at the top level stops the tick; it must not change what
    // this helper answers, because a publish that queued into a stopped
    // scheduler would be an announcement nobody ever delivers.
    const db = makeDb({ config: { scheduler: { enabled: false } } });
    assert.equal(await announcementQueueEnabled(db), false);
  });
});

// ---------------------------------------------------------------------------
// 4. The registration
// ---------------------------------------------------------------------------

describe("the job is registered, dark", () => {
  test("its id is in the union and its registration is in JOBS", () => {
    assert.ok(SCHEDULER_JOB_IDS.includes(EVENT_ANNOUNCEMENTS_JOB_ID));
    assert.ok(JOBS.some((job) => job.id === EVENT_ANNOUNCEMENTS_JOB_ID));
  });

  test("it does not arm itself on deploy", () => {
    assert.equal(eventAnnouncementsJob.enabledByDefault, false);
    assert.equal(jobDefaultEnabled(eventAnnouncementsJob), false);
  });

  test("its description warns against arming it where no tick runs", () => {
    // The failure that warning prevents is specific and silent: with the
    // switch on and no scheduler calling the tick, every publish queues an
    // announcement and none of them is ever delivered.
    assert.match(eventAnnouncementsJob.description, /scheduler tick is actually armed/);
  });

  test("the ceilings are the job path's, not the request path's", () => {
    assert.equal(MAX_QUEUED_ANNOUNCEMENT_ROWS, 5000);
    assert.equal(MAX_QUEUED_PUSH_ROWS, 5000);
    assert.ok(EVENT_SCAN_CAP > 0);
  });
});

// ---------------------------------------------------------------------------
// 5. The happy path
// ---------------------------------------------------------------------------

describe("a queued announcement goes out", () => {
  test("every recipient is mailed once, every account notified once, and the state finishes", async () => {
    const db = seedWorld();
    const { ctx } = context();
    const { result, summary } = await runEventAnnouncements(ctx);

    assert.equal(globalThis.__channelAsked, "events");
    assert.deepEqual(
      globalThis.__sent.map((s) => s.to).sort(),
      ["guest@e2e.invalid", "member@e2e.invalid"],
    );
    assert.ok(globalThis.__sent.every((s) => s.kind === "event-announcement"));
    assert.ok(globalThis.__sent.every((s) => s.referenceId === EVENT_ID));
    // The push audience is NOT the junction: `member-quiet` holds no events
    // subscription row and is on no email, and is not pushed either because
    // their push cell is off. `member-1` is pushed because theirs is on.
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);

    assert.equal(summary.sent, 3, "two emails and one notification, counted in recipients");
    assert.equal(summary.pushed, 1);
    assert.equal(summary.finished, 1);
    assert.equal(result.hasMore, false);
    assert.equal(result.processed, summary.sent + summary.skipped);

    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "done");
    assert.equal(stored.announcementResult.sent, 2, "sends are counted in MESSAGES here");
    assert.equal(stored.announcementResult.pushed, 1);
    assert.ok(stored.announcementResult.finishedAt);
    assert.ok(stored.announcedAt, "a delivered announcement keeps its claim");
  });

  test("every unit leaves a marker, one per person per leg", async () => {
    const db = seedWorld();
    await runEventAnnouncements(context().ctx);
    const ids = db.ids(MARKERS);
    assert.deepEqual(ids.sort(), [
      emailMarkerId(GUEST),
      emailMarkerId(MEMBER),
      pushMarkerId("member-1"),
      pushMarkerId("member-quiet"),
    ].sort());
    // The two legs are two markers for one person, because they are two
    // messages that fail independently.
    assert.notEqual(emailMarkerId(MEMBER), pushMarkerId("member-1"));
    assert.ok(db.read(MARKERS, emailMarkerId(MEMBER)).sentAt);
    assert.equal(
      db.read(MARKERS, pushMarkerId("member-quiet")).skippedReason,
      PUSH_CELL_OFF_REASON,
      "an account whose cell is off is settled rather than reconsidered every tick",
    );
  });

  test("a guest's marker carries a hash, never their address", async () => {
    const db = seedWorld();
    await runEventAnnouncements(context().ctx);
    const id = emailMarkerId(GUEST);
    assert.match(id, /__g[0-9a-f]{16}$/);
    assert.ok(
      !db.ids(MARKERS).some((markerId) => markerId.includes("guest@e2e.invalid")),
      "a marker is kept for six months, which is no place for a mailing list",
    );
    assert.equal(db.read(MARKERS, id).recipientKey, announcementRecipientKey(GUEST));
  });

  test("a second tick sends nothing and changes nothing", async () => {
    const db = seedWorld();
    await runEventAnnouncements(context().ctx);
    const after = db.read("events", EVENT_ID);
    assert.equal(after.announcementState, "done");
    globalThis.__sent = [];
    globalThis.__pushed = [];

    const { result, summary } = await runEventAnnouncements(context().ctx);
    assert.equal(globalThis.__sent.length, 0, "the event left the queue when it finished");
    assert.equal(globalThis.__pushed.length, 0);
    assert.equal(summary.sent, 0);
    assert.equal(result.hasMore, false);
    assert.deepEqual(db.read("events", EVENT_ID), after);
  });
});

// ---------------------------------------------------------------------------
// 6. Resuming, and everything that keeps an event in the queue
// ---------------------------------------------------------------------------

describe("a run that cannot finish resumes without repeating itself", () => {
  test("the budget stops it, the totals are persisted, and the next tick completes the list", async () => {
    const db = seedWorld();
    // Expire once two units have been settled. The check runs BEFORE each
    // unit, so the third one is what does not happen.
    const first = context({
      expireWhen: () => globalThis.__sent.length + globalThis.__pushed.length >= 2,
    });
    const firstRun = await runEventAnnouncements(first.ctx);

    assert.equal(firstRun.result.hasMore, true, "unfinished work must re-arm the tick");
    assert.equal(globalThis.__sent.length, 2);
    const midway = db.read("events", EVENT_ID);
    assert.equal(midway.announcementState, "sending");
    assert.equal(
      midway.announcementResult.sent,
      2,
      "the totals are written at the end of every tick, so none is lost to a boundary",
    );
    assert.ok(!midway.announcementResult.finishedAt, "an unfinished run stamps no end");
    assert.ok(midway.announcementStartedAt);

    const before = [...globalThis.__sent];
    const second = await runEventAnnouncements(context().ctx);
    assert.equal(second.result.hasMore, false);
    assert.equal(
      globalThis.__sent.length,
      2,
      "the two already-stamped recipients were refused by their own markers",
    );
    assert.deepEqual(globalThis.__sent, before);
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);

    const done = db.read("events", EVENT_ID);
    assert.equal(done.announcementState, "done");
    assert.equal(done.announcementResult.sent, 2, "the totals accumulated across both ticks");
    assert.equal(done.announcementResult.pushed, 1);
    assert.ok(done.announcementResult.finishedAt);
  });

  test("`maxPerTick` is counted in UNITS, one per recipient per leg", async () => {
    const db = seedWorld();
    const run = await runEventAnnouncements(context({ maxPerTick: 1 }).ctx);
    assert.equal(run.result.hasMore, true);
    assert.equal(globalThis.__sent.length, 1);
    assert.equal(db.read("events", EVENT_ID).announcementState, "sending");

    // Two units is BOTH email recipients and no push at all, which is the
    // point: a member who is on the list and holds a device is two units,
    // because they are two claims and two messages.
    const world = seedWorld();
    const two = await runEventAnnouncements(context({ maxPerTick: 2 }).ctx);
    assert.equal(globalThis.__sent.length, 2);
    assert.equal(globalThis.__pushed.length, 0);
    assert.equal(two.result.hasMore, true);
    assert.equal(world.read("events", EVENT_ID).announcementState, "sending");
  });

  test("a budget that runs out on the audience read claims nothing and scans no devices", async () => {
    // SHOULD-FIX 7's first half. The junction read plus the `getAll` behind it
    // is the most expensive thing this job does, and the run used to walk
    // straight from it into the loops with no check between.
    const db = seedWorld();
    const queried = [];
    globalThis.__queryHook = (path) => queried.push(path);
    const run = await runEventAnnouncements(
      context({ expireWhen: () => globalThis.__channelAsked === "events" }).ctx,
    );
    assert.equal(run.result.hasMore, true);
    assert.equal(globalThis.__sent.length, 0);
    assert.deepEqual(db.ids(MARKERS), [], "nothing was claimed, so nothing is half done");
    assert.ok(
      !queried.includes("pushSubscriptions"),
      "a device scan this tick had no budget to use is a 5000-row read thrown away",
    );
    assert.equal(db.read("events", EVENT_ID).announcementState, "sending");
  });

  test("a tick stopped inside the email leg does not pay for the device scan", async () => {
    // SHOULD-FIX 7's second half: the push audience is resolved only once the
    // email leg has nothing left to do in this tick.
    seedWorld();
    const queried = [];
    globalThis.__queryHook = (path) => queried.push(path);
    await runEventAnnouncements(
      context({ expireWhen: () => globalThis.__sent.length >= 1 }).ctx,
    );
    assert.equal(globalThis.__sent.length, 1);
    assert.ok(!queried.includes("pushSubscriptions"));
  });

  test("the counts move by increment, so an overlapping tick's work is not written away", async () => {
    // SHOULD-FIX 3. Ticks overlap by design (the tick route's re-arm makes it
    // ordinary), so a tick that read the totals, added its own work and wrote
    // the sum back would silently discard whatever the other one committed in
    // between. The concurrent write below is that other tick.
    const db = seedWorld();
    await runEventAnnouncements(
      context({ expireWhen: () => globalThis.__sent.length >= 1 }).ctx,
    );
    assert.equal(db.read("events", EVENT_ID).announcementResult.sent, 1);

    await db
      .collection("events")
      .doc(EVENT_ID)
      .update({ "announcementResult.sent": 6 });

    await runEventAnnouncements(context().ctx);
    assert.equal(
      db.read("events", EVENT_ID).announcementResult.sent,
      7,
      "this tick added its own delta to what it found, rather than overwriting it",
    );
  });

  test("the finish transition re-reads, so a tick cannot finish an event another already did", async () => {
    // The other half of SHOULD-FIX 3. The hook stands in for an overlapping
    // tick committing between this one's last send and its settle.
    const db = seedWorld();
    globalThis.__txGetHook = (path, id) => {
      if (path !== "events" || id !== EVENT_ID) return;
      globalThis.__txGetHook = null;
      db.collection("events").doc(EVENT_ID).set(
        {
          announcementState: "done",
          announcementResult: { sent: 99, pushed: 9, finishedAt: new Date(0) },
        },
        { merge: true },
      );
    };
    await runEventAnnouncements(context().ctx);
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "done");
    assert.equal(
      stored.announcementResult.sent,
      99,
      "the settle wrote over an event the other tick had already finished",
    );
    assert.deepEqual(stored.announcementResult.finishedAt, new Date(0));
  });
});

// ---------------------------------------------------------------------------
// 7. Failure, one recipient at a time, and the event stays in the queue
// ---------------------------------------------------------------------------

describe("one bad recipient costs one recipient, and is not abandoned", () => {
  test("a send that throws leaves the event SENDING, and a later tick reaches that person", async (t) => {
    // The hole this closes: the scan finds `queued` and `sending` and nothing
    // else, so an event written `done` with an unstamped marker under it is a
    // person who is never told, however correct the marker's own re-claim rule
    // is. `sendAnnouncementToRecipient` logs the failure by uid; muting keeps
    // the module graph's data: URL out of the runner's output
    // (tests/lib/outputGuard.mjs).
    t.mock.method(console, "error", () => {});
    const db = seedWorld();
    globalThis.__sendHook = (opts) => {
      if (opts.to === "member@e2e.invalid") throw new Error("relay refused");
    };

    const first = await runEventAnnouncements(context().ctx);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["guest@e2e.invalid"]);
    assert.equal(first.summary.failures.length, 1);
    assert.equal(first.summary.failures[0].who, "member-1");
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
    assert.equal(
      first.result.hasMore,
      true,
      "an unsettled unit must re-arm the tick, or nothing ever comes back for it",
    );
    assert.equal(
      db.read("events", EVENT_ID).announcementState,
      "sending",
      "writing `done` here takes the event out of the scan for good",
    );
    // LEFT RECLAIMABLE: `stampError` writes only `lastError`, so a later tick
    // picks this person up again once the re-claim window has passed.
    const marker = db.read(MARKERS, emailMarkerId(MEMBER));
    assert.equal(marker.sentAt, null);
    assert.ok(marker.lastError);

    // Age the claim past the re-claim window, which is the only thing between
    // that marker and a second attempt, and let the relay behave.
    await ageMarker(db, emailMarkerId(MEMBER), 60);
    globalThis.__sendHook = null;
    globalThis.__sent = [];
    const second = await runEventAnnouncements(context().ctx);
    assert.deepEqual(
      globalThis.__sent.map((s) => s.to),
      ["member@e2e.invalid"],
      "the retry reached exactly the person the first tick could not, and nobody twice",
    );
    assert.equal(second.result.hasMore, false);
    const done = db.read("events", EVENT_ID);
    assert.equal(done.announcementState, "done");
    assert.equal(done.announcementResult.sent, 2);
  });

  test("a claim another tick is holding in flight also keeps the event in the queue", async () => {
    // An overlapping tick may have died between its claim and its stamp, and
    // the only thing that will ever notice is a later tick finding the marker
    // past its window. That cannot happen if this tick writes `done`.
    const db = seedWorld();
    await db
      .collection(MARKERS)
      .doc(emailMarkerId(MEMBER))
      .set({ job: "event-announcements", claimedAt: new Date(), attempts: 1 });

    const run = await runEventAnnouncements(context().ctx);
    assert.equal(run.result.hasMore, true);
    assert.equal(db.read("events", EVENT_ID).announcementState, "sending");
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["guest@e2e.invalid"]);
  });

  test("a recipient out of attempts is SETTLED, so the event can finish without them", async () => {
    // The bound on the retry loop above. Without it an address that will never
    // accept mail would hold one event in the queue for ever.
    const db = seedWorld();
    await db
      .collection(MARKERS)
      .doc(emailMarkerId(MEMBER))
      .set({
        job: "event-announcements",
        claimedAt: new Date(Date.now() - 60 * 60_000),
        attempts: 3,
      });

    const run = await runEventAnnouncements(context().ctx);
    assert.equal(run.result.hasMore, false, "a given-up marker is settled, not owed");
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "done");
    assert.equal(stored.announcementResult.failed, 1, "counted once, on the tick that gave up");
    assert.ok(db.read(MARKERS, emailMarkerId(MEMBER)).failedAt, "and surfaced under Stuck sends");
    assert.equal(run.summary.failures.length, 1);

    // A LATER tick counts it again for nobody: the marker now reads `failed`,
    // which is somebody else's business.
    await runEventAnnouncements(context().ctx);
    assert.equal(db.read("events", EVENT_ID).announcementResult.failed, 1);
  });

  test("a send that goes out but cannot be stamped is settled, never re-sent", async (t) => {
    // The duplicate this closes: `stampSent` inside a try/catch that only logs
    // leaves `claimedAt` with `sentAt` null, and the re-claim rule then sends
    // the same person a second copy. `stampSentOrSettle` retries once and then
    // settles the marker a way the re-claim rule will not touch.
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    const db = seedWorld();
    globalThis.__setHook = (path, id, data) => {
      if (path === MARKERS && id === emailMarkerId(MEMBER) && "sentAt" in data) {
        throw new Error("marker write rejected");
      }
    };

    await runEventAnnouncements(context().ctx);
    assert.ok(
      globalThis.__sent.some((s) => s.to === "member@e2e.invalid"),
      "the message really did go out, which is what makes the stamp load-bearing",
    );
    const marker = db.read(MARKERS, emailMarkerId(MEMBER));
    assert.equal(marker.skippedReason, SENT_UNSTAMPED_REASON);
    assert.ok(marker.expiresAt, "a settled marker starts its retention clock");

    globalThis.__setHook = null;
    globalThis.__sent = [];
    await ageMarker(db, emailMarkerId(MEMBER), 60);
    await runEventAnnouncements(context().ctx);
    assert.deepEqual(
      globalThis.__sent,
      [],
      "the re-claim rule refuses a settled marker, which is the whole point of settling it",
    );
  });

  test("a suppressed address is settled, not retried", async () => {
    const db = seedWorld();
    globalThis.__suppressed = ["member@e2e.invalid"];
    const run = await runEventAnnouncements(context().ctx);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["guest@e2e.invalid"]);
    assert.equal(db.read(MARKERS, emailMarkerId(MEMBER)).skippedReason, SUPPRESSED_REASON);
    assert.ok(run.summary.skipped >= 1);
    assert.equal(run.result.hasMore, false, "a conscious skip is settled work");
  });

  test("a cell that is on with no device is nobody told", async () => {
    const db = seedWorld();
    globalThis.__pushCounts = { sent: 0, pruned: 1, deferred: 0, failed: 0, retried: 0 };
    await runEventAnnouncements(context().ctx);
    assert.equal(db.read(MARKERS, pushMarkerId("member-1")).skippedReason, NO_DEVICE_REASON);
    assert.equal(db.read("events", EVENT_ID).announcementResult.pushed, 0);
    assert.equal(
      globalThis.__sent.length,
      2,
      "a quiet phone says nothing about the email",
    );
  });

  test("a missing user document is not pushed, because the events cell is opt-in", async () => {
    const db = seedWorld({
      users: {},
      pushSubscriptions: { "device-9": { uid: "ghost-1", endpoint: "https://push.test/9" } },
      channelRows: [],
    });
    await runEventAnnouncements(context().ctx);
    assert.deepEqual(globalThis.__pushed, [], "an absent cell resolves OFF on this row");
    assert.equal(db.read(MARKERS, pushMarkerId("ghost-1")).skippedReason, PUSH_CELL_OFF_REASON);
  });
});

// ---------------------------------------------------------------------------
// 8. Audience rules
// ---------------------------------------------------------------------------

describe("the audience is the events row's, on both columns", () => {
  test("a members-only event never reaches an address with no account", async () => {
    const db = seedWorld({ event: { visibility: "members" } });
    await runEventAnnouncements(context().ctx);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["member@e2e.invalid"]);
    assert.equal(db.read("events", EVENT_ID).announcementResult.audienceSkipped, 1);
    // The push audience is accounts by construction, so it is untouched.
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
  });

  test("a member whose events email cell is off is skipped, junction row or not", async () => {
    const users = {
      "member-1": {
        email: "member@e2e.invalid",
        displayName: "Mem",
        profile: {
          notifications: { categories: { events: false }, push: { events: true } },
        },
      },
    };
    const world = seedWorld({ users, pushSubscriptions: { "device-1": { uid: "member-1" } } });
    await runEventAnnouncements(context().ctx);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["guest@e2e.invalid"]);
    // ...and their PUSH cell is a separate answer, still on.
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
    assert.equal(world.read("events", EVENT_ID).announcementResult.audienceSkipped, 1);
  });

  test("the audience-level drops are a SNAPSHOT, counted once however many ticks it takes", async () => {
    // SHOULD-FIX 6. `audienceSkipped` is re-derived on every tick that
    // resolves the audience, so an incremented version would report the same
    // dropped guest row four times over a four-tick run.
    const db = seedWorld({ event: { visibility: "members" } });
    await runEventAnnouncements(
      context({ expireWhen: () => globalThis.__sent.length >= 1 }).ctx,
    );
    assert.equal(db.read("events", EVENT_ID).announcementResult.audienceSkipped, 1);
    await runEventAnnouncements(context().ctx);
    assert.equal(
      db.read("events", EVENT_ID).announcementResult.audienceSkipped,
      1,
      "the same guest row was dropped on both ticks and is one dropped row",
    );
  });

  test("with push dormant nothing is pushed and the email is unaffected", async () => {
    const db = seedWorld();
    globalThis.__vapid = false;
    await runEventAnnouncements(context().ctx);
    assert.equal(globalThis.__pushed.length, 0);
    assert.equal(globalThis.__sent.length, 2);
    assert.equal(
      db.read("events", EVENT_ID).announcementResult.pushRefusal,
      null,
      "an unprovisioned backend is silence by design, not a refusal",
    );
    assert.equal(db.read("events", EVENT_ID).announcementState, "done");
  });
});

// ---------------------------------------------------------------------------
// 9. Refusals, and the two directions they release in
// ---------------------------------------------------------------------------

describe("a refusal is terminal, and only one kind hands the claim back", () => {
  /** The junction over its ceiling: the deterministic pre-dispatch refusal. */
  function overTheCeiling() {
    globalThis.__channelRows = Array.from(
      { length: MAX_QUEUED_ANNOUNCEMENT_ROWS + 1 },
      (_, i) => ({
        email: `guest${i}@e2e.invalid`,
        audience: "guest",
        audienceId: `guest${i}@e2e.invalid`,
      }),
    );
  }

  test("an unreadable email audience with nobody reached releases the claim", async (t) => {
    // THE INLINE PATH'S RULE, EXACTLY: the publish route releases when the
    // announcement refused and nothing was sent, failed or pushed. The push
    // leg being quiet (dormant, or nobody opted in) is not a second condition,
    // and requiring one used to leave this event `done` with the claim spent
    // and no supported way to get the announcement out.
    t.mock.method(console, "error", () => {});
    const db = seedWorld({ pushSubscriptions: {} });
    overTheCeiling();

    const run = await runEventAnnouncements(context().ctx);
    assert.equal(run.summary.refused, 1);
    assert.equal(globalThis.__sent.length, 0, "a partial announcement looks like a whole one");
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "refused");
    assert.match(stored.announcementResult.refusal, /larger than a single announcement/);
    assert.equal(stored.announcementResult.released, true);
    assert.equal(
      stored.announcedAt,
      undefined,
      "the claim bought nothing, so publishing again must be able to requeue it",
    );
  });

  test("an unreadable email audience whose PUSH leg delivered keeps the claim", async (t) => {
    // The other side of the same rule: something reached somebody, so
    // releasing would announce this event to them twice.
    t.mock.method(console, "error", () => {});
    const db = seedWorld();
    overTheCeiling();

    await runEventAnnouncements(context().ctx);
    const stored = db.read("events", EVENT_ID);
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
    assert.equal(stored.announcementState, "done");
    assert.equal(stored.announcementResult.released, false);
    assert.ok(stored.announcedAt);
    assert.match(
      stored.announcementResult.refusal,
      /larger than a single announcement/,
      "the email leg's refusal is still reported: half the announcement did not happen",
    );
  });

  test("both legs unreadable, and nothing ever sent, releases", async (t) => {
    t.mock.method(console, "error", () => {});
    const db = seedWorld();
    overTheCeiling();
    globalThis.__queryHook = (path) => {
      if (path === "pushSubscriptions") throw new Error("push subscriptions unreadable");
    };

    await runEventAnnouncements(context().ctx);
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "refused");
    assert.match(stored.announcementResult.pushRefusal, /could not be read/);
    assert.equal(stored.announcementResult.released, true);
    assert.equal(stored.announcedAt, undefined);
  });

  test("one leg refusing while the other delivers KEEPS the claim", async (t) => {
    t.mock.method(console, "error", () => {});
    const db = seedWorld();
    globalThis.__queryHook = (path) => {
      if (path === "pushSubscriptions") throw new Error("push subscriptions unreadable");
    };
    await runEventAnnouncements(context().ctx);
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "done");
    assert.equal(stored.announcementResult.sent, 2);
    assert.match(stored.announcementResult.pushRefusal, /could not be read/);
    assert.equal(stored.announcementResult.released, false);
    assert.ok(stored.announcedAt, "releasing here would re-mail the people who have it");
  });

  test("an event that has already started is refused as stale, and keeps its claim", async () => {
    const db = seedWorld({
      event: { startAt: new Date("2026-09-30T18:00:00.000Z") },
    });
    const run = await runEventAnnouncements(context().ctx);
    assert.equal(run.summary.refused, 1);
    assert.equal(globalThis.__sent.length, 0);
    assert.equal(globalThis.__pushed.length, 0);
    const stored = db.read("events", EVENT_ID);
    assert.equal(stored.announcementState, "refused");
    assert.match(stored.announcementResult.refusal, /had already started/);
    assert.equal(
      stored.announcementResult.released,
      false,
      "a screen that derived this from the counts would tell an approver to republish a past event",
    );
    assert.ok(
      stored.announcedAt,
      "there is no later moment at which announcing a past event is right, so nothing is released",
    );
    assert.equal(db.ids(MARKERS).length, 0, "a stale event costs no audience read at all");
  });

  test("the stale rule reads the event, and falls back to the queue only with no start time", () => {
    const hours = eventAnnouncementsJob.maxLateHours;
    const started = { startAt: new Date(NOW.getTime() - 1), announcementQueuedAt: QUEUED_AT };
    const ahead = { startAt: new Date(NOW.getTime() + 1), announcementQueuedAt: QUEUED_AT };
    assert.ok(announcementIsStale(started, NOW, hours));
    assert.equal(
      announcementIsStale(ahead, NOW, hours),
      null,
      "an announcement a day late is still worth sending while the event is ahead",
    );
    // Deliberately NOT stale on age alone: an event page that went live stays
    // news until the event itself happens.
    const oldButAhead = {
      startAt: new Date(NOW.getTime() + 86_400_000),
      announcementQueuedAt: new Date(NOW.getTime() - (hours + 100) * 3_600_000),
    };
    assert.equal(announcementIsStale(oldButAhead, NOW, hours), null);
    // The fallback, for a document whose start time is missing or malformed:
    // nothing else could ever rule on it.
    const noStart = {
      startAt: null,
      announcementQueuedAt: new Date(NOW.getTime() - (hours + 1) * 3_600_000),
    };
    assert.match(announcementIsStale(noStart, NOW, hours), /no start time/);
    assert.equal(
      announcementIsStale({ startAt: null, announcementQueuedAt: QUEUED_AT }, NOW, hours),
      null,
    );
  });

  test("with no start time and no queued-at it ages against the CLAIM, not against nothing", () => {
    // NIT 12. `announcementQueuedAt` is only absent on a hand-edited document,
    // and the fallback bound had a hole exactly there: an entry with neither
    // instant could never be judged and would sit in the queue for ever.
    const hours = eventAnnouncementsJob.maxLateHours;
    const old = new Date(NOW.getTime() - (hours + 1) * 3_600_000);
    assert.equal(announcementStaleAnchor({ announcementQueuedAt: QUEUED_AT }), QUEUED_AT);
    assert.equal(
      announcementStaleAnchor({ announcementQueuedAt: null, announcedAt: old }),
      old,
    );
    assert.equal(
      announcementStaleAnchor({ announcementQueuedAt: null, announcedAt: null }),
      null,
    );
    assert.match(
      announcementIsStale({ startAt: null, announcementQueuedAt: null, announcedAt: old }, NOW, hours),
      /no start time/,
    );
  });

  test("an entry with nothing to age against is announced, and said out loud", async () => {
    const db = seedWorld({
      event: { startAt: null, endAt: null, announcementQueuedAt: null, announcedAt: null },
    });
    const { ctx, logged } = context();
    await runEventAnnouncements(ctx);
    assert.equal(
      db.read("events", EVENT_ID).announcementState,
      "done",
      "a hand-edited document is not a reason to withhold somebody's mail",
    );
    assert.ok(
      logged.some(([message]) => message === "a queued announcement has no instant to age against"),
      "and it must not become a silent unbounded queue entry either",
    );
  });
});
// ---------------------------------------------------------------------------
// 10. The scan
// ---------------------------------------------------------------------------

describe("the scan", () => {
  test("it takes queued and sending, in the order they were queued, and nothing else", async () => {
    const db = makeDb({
      events: {
        "zzz-queued-late": eventDoc({ announcementQueuedAt: new Date("2026-10-01T11:59:00.000Z") }),
        "aaa-sending-early": eventDoc({
          announcementState: "sending",
          announcementQueuedAt: new Date("2026-10-01T10:00:00.000Z"),
        }),
        "mmm-done": eventDoc({ announcementState: "done" }),
        "nnn-inline": eventDoc({ announcementState: undefined, announcementQueuedAt: undefined }),
      },
      users: {},
      pushSubscriptions: {},
    });
    globalThis.__db = db;
    globalThis.__sent = [];
    globalThis.__pushed = [];
    globalThis.__vapid = true;
    globalThis.__suppressed = [];
    globalThis.__channelRows = [];
    globalThis.__queryHook = null;
    globalThis.__sendHook = null;

    const { ctx, logged } = context();
    const { summary } = await runEventAnnouncements(ctx);
    assert.equal(summary.finished, 2, "an announced or inline event is not in the queue");
    assert.equal(db.read("events", "mmm-done").announcementState, "done");
    assert.equal(db.read("events", "nnn-inline").announcementState, undefined);

    const found = logged.find(([message]) => message === "queued announcements found");
    assert.deepEqual(found[1], { count: 2 });
  });

  test("the unit budget is the TICK's, spent across every event it touches", async () => {
    // Not per event: `maxPerTick` bounds what one tick hands Resend and the
    // push service, and three queued events each spending it would be three
    // times the load the number describes.
    const db = makeDb({
      events: {
        "aaa-first": eventDoc({ announcementQueuedAt: new Date("2026-10-01T10:00:00.000Z") }),
        "bbb-second": eventDoc({ announcementQueuedAt: new Date("2026-10-01T11:00:00.000Z") }),
      },
      users: {},
      pushSubscriptions: {},
    });
    globalThis.__db = db;
    globalThis.__sent = [];
    globalThis.__pushed = [];
    globalThis.__vapid = true;
    globalThis.__suppressed = [];
    globalThis.__queryHook = null;
    globalThis.__setHook = null;
    globalThis.__txGetHook = null;
    globalThis.__sendHook = null;
    globalThis.__channelAsked = undefined;
    globalThis.__channelRows = [
      { email: "one@e2e.invalid", audience: "guest", audienceId: "one@e2e.invalid" },
      { email: "two@e2e.invalid", audience: "guest", audienceId: "two@e2e.invalid" },
    ];

    const run = await runEventAnnouncements(context({ maxPerTick: 2 }).ctx);
    assert.equal(globalThis.__sent.length, 2, "both units went to the event queued first");
    assert.equal(run.result.hasMore, true);
    assert.equal(db.read("events", "aaa-first").announcementState, "done");
    assert.equal(
      db.read("events", "bbb-second").announcementState,
      "queued",
      "the second event was never started, so it is still exactly where it was",
    );
  });

  test("it names one field with one `in`, so no composite index is owed", () => {
    // `tests/firestore-indexes.test.mjs` is the guard; this is the sentence
    // that says the shape was chosen for it. A second clause or an `orderBy`
    // here would need a declared index, and the ordering is done in code
    // instead for exactly that reason.
    const source = src("lib", "scheduler", "jobs", "eventAnnouncements.ts");
    assert.match(source, /\.where\("announcementState", "in", \[\.\.\.PENDING_ANNOUNCEMENT_STATES\]\)/);
    assert.doesNotMatch(source, /\.orderBy\(/);
  });

  test("it logs by event id and uid, never by address", () => {
    const source = src("lib", "scheduler", "jobs", "eventAnnouncements.ts");
    assert.doesNotMatch(
      source,
      /ctx\.log\([^)]*\b(address|email|to)\b\s*[,:]/,
      "the log is not the place a mailing list accumulates",
    );
  });
});
