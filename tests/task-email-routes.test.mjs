/**
 * The five task email routes, EXECUTED, against a fake Firestore.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## Why these five get a harness
 *
 * They are the whole of the tasks row's email traffic: added to a task (twice,
 * batched and per person), a comment or a mention, a review request, a review
 * outcome. Until now nothing executed any of them; what they did was inferred
 * from reading them, and the notification grid has just given each of them a
 * third gate that decides whether a member hears from us at all. A gate that
 * has never been run is a gate nobody knows the shape of, and the shape here is
 * specific: the row switches the EMAIL off and leaves the PUSH alone, because
 * they are two cells of one row and a member may keep either.
 *
 * ## What each test says, in one line
 *
 * Three gates in series, any one a skip: the site-wide `config/taskEmails`
 * kill switch, then the route's own rules, then the member's tasks row. Absent
 * is not a refusal on an opt-out row, only a stored `false` is, and the push
 * leg runs either way.
 *
 * ## What is faked, and what is real
 *
 * The five handlers, the membership payload builder, the four email templates
 * and the normalisers are REAL. Faked: `next/server`, the two Firestore value
 * imports, the Admin SDK handle, the session, the transport and the push
 * mirror. Nothing here can reach a project or an inbox. The push mirror is
 * recorded rather than executed on purpose: what it does with `push.tasks` is
 * `tests/push-preferences.test.mjs`'s subject, and what matters here is only
 * whether these routes still hand it the recipient.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createLoader } from "./lib/tsLoader.mjs";

/** Every `serverTimestamp()` in this file resolves to this instant. */
const STAMP = new Date("2026-09-07T09:00:00Z");

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = {\n" +
      "  json(body, init) {\n" +
      "    return { status: (init && init.status) || 200, body };\n  },\n};",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
      "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n" +
      "};\n" +
      "export const Timestamp = { fromDate: (date) => ({ __ts: date }) };",
  ],
  ["@/lib/firebase/admin", "export function getAdminDb() {\n  return globalThis.__db;\n}"],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() {\n  return globalThis.__viewer;\n}",
  ],
  [
    "@/lib/email/send",
    "export async function sendEmail(args) {\n" +
      "  if (globalThis.__sendThrows) throw new Error('transport down');\n" +
      "  (globalThis.__sent ||= []).push(args);\n}",
  ],
  [
    "@/lib/push/taskNotifications",
    "export async function mirrorTaskEmailToPush(uid, payload) {\n" +
      "  (globalThis.__pushed ||= []).push({ uid, ...payload });\n}",
  ],
  [
    "@/lib/firestore/taskEmailConfig",
    "export async function isTaskEmailEnabled() {\n" +
      "  return globalThis.__taskEmails !== false;\n}",
  ],
]);

const { loadTs } = createLoader({ stubs: STUBS });

// ---------------------------------------------------------------------------
// A Firestore small enough to read: addressed documents, `getAll`, one
// subcollection query with `==` and `in`, and one transaction.
// ---------------------------------------------------------------------------

function resolveSentinels(value, current) {
  if (Array.isArray(value)) return value.map((v) => resolveSentinels(v));
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if (value.__op === "serverTimestamp") return STAMP;
    if (value.__op === "arrayRemove") {
      const before = Array.isArray(current) ? current : [];
      return before.filter((entry) => !value.values.includes(entry));
    }
    if (value.__ts) return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

function matches(data, [field, op, value]) {
  const actual = (data ?? {})[field];
  if (op === "in") return Array.isArray(value) && value.includes(actual);
  if (op === ">=") return true; // no test here turns on a time bound
  return actual === value;
}

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, { ...data }]));
  let added = 0;

  function apply(path, patch) {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = resolveSentinels(value, next[key]);
    }
    docs.set(path, next);
  }

  function snapshot(path) {
    const data = docs.get(path);
    return {
      id: path.split("/").pop(),
      path,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  function query(path, filters) {
    return {
      where: (field, op, value) => query(path, [...filters, [field, op, value]]),
      async get() {
        const out = [];
        for (const [docPath, data] of docs) {
          if (!docPath.startsWith(`${path}/`)) continue;
          if (docPath.slice(path.length + 1).includes("/")) continue;
          if (!filters.every((filter) => matches(data, filter))) continue;
          out.push(snapshot(docPath));
        }
        return { docs: out, empty: out.length === 0, size: out.length };
      },
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      async add(data) {
        added += 1;
        const id = `auto${added}`;
        docs.set(`${path}/${id}`, resolveSentinels(data));
        return docRef(`${path}/${id}`);
      },
      ...query(path, []),
    };
  }

  function docRef(path) {
    return {
      id: path.split("/").pop(),
      path,
      collection: (name) => collectionRef(`${path}/${name}`),
      async get() {
        return snapshot(path);
      },
      async update(patch) {
        apply(path, patch);
      },
    };
  }

  return {
    docs,
    collection: collectionRef,
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    async runTransaction(body) {
      const writes = [];
      const result = await body({
        get: async (ref) => snapshot(ref.path),
        update: (ref, patch) => writes.push([ref.path, patch]),
      });
      for (const [path, patch] of writes) apply(path, patch);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const TASKS = join("app", "api", "tasks", "[id]");
const { POST: notify } = await loadTs(join(TASKS, "notify", "route.ts"));
const { POST: sendInitial } = await loadTs(join(TASKS, "send-initial-notifications", "route.ts"));
const { POST: notifyMember } = await loadTs(join(TASKS, "notify-member", "route.ts"));
const { POST: sendForReview } = await loadTs(join(TASKS, "send-for-review", "route.ts"));
const { POST: sendReviewOutcome } = await loadTs(join(TASKS, "send-review-outcome", "route.ts"));

const TASK_ID = "task1";
const ctx = { params: Promise.resolve({ id: TASK_ID }) };
const jsonRequest = (body) => ({ json: async () => body });

const ADMIN = { uid: "admin1", role: "admin", suRecognised: true };

/**
 * One world per test: an admin, two people on the task, and the task itself.
 *
 * `profiles` maps a uid to the profile stored on their user document, which is
 * the only thing any test here varies.
 */
function world({ profiles = {}, task = {} } = {}) {
  const user = (uid, name) => ({
    uid,
    email: `${uid}@example.com`,
    displayName: name,
    ...(profiles[uid] === undefined ? {} : { profile: profiles[uid] }),
  });
  return makeDb({
    "users/admin1": user("admin1", "Al Admin"),
    "users/doer1": user("doer1", "Dee One"),
    "users/doer2": user("doer2", "Dev Two"),
    "users/rev1": user("rev1", "Ray Reviewer"),
    [`tasks/${TASK_ID}`]: {
      title: "Term plan",
      visibility: "committee",
      completerUids: ["doer1", "doer2"],
      reviewerUids: ["rev1"],
      creatorUid: "admin1",
      ...task,
    },
  });
}

beforeEach(() => {
  globalThis.__viewer = { ...ADMIN };
  globalThis.__sent = [];
  globalThis.__pushed = [];
  globalThis.__taskEmails = true;
  globalThis.__sendThrows = false;
});

const REFUSED = { notifications: { categories: { tasks: false } } };
const recipientsOf = (list) => list.map((entry) => entry.to ?? entry.uid).sort();

// ---------------------------------------------------------------------------
// The four senders whose recipient list is a roster
// ---------------------------------------------------------------------------

/**
 * Each entry runs one route on one world and reports who was mailed and who
 * was pushed. Written as a table because the assertion is the same four times
 * and the setup is not: a comment needs a comment document, a per-uid notify
 * needs a pending queue, a review outcome needs a sealed block.
 */
const SENDERS = [
  {
    name: "send-initial-notifications",
    run: (db) => {
      globalThis.__db = db;
      return sendInitial({}, ctx);
    },
    world: (profiles) => world({ profiles }),
    everyone: ["doer1", "doer2", "rev1"],
  },
  {
    name: "notify",
    run: (db) => {
      globalThis.__db = db;
      return notify(jsonRequest({ commentId: "c1", forceEmailCompleters: true }), ctx);
    },
    world: (profiles) => {
      const db = world({ profiles });
      db.docs.set(`tasks/${TASK_ID}/comments/c1`, {
        authorUid: "admin1",
        bodyMarkdown: "Have a look at @[Ray Reviewer](uid:rev1) please",
        mentions: ["rev1"],
      });
      return db;
    },
    everyone: ["doer1", "doer2", "rev1"],
  },
  {
    name: "send-for-review",
    run: (db) => {
      globalThis.__db = db;
      return sendForReview(jsonRequest({}), ctx);
    },
    world: (profiles) => world({ profiles }),
    everyone: ["rev1"],
  },
  {
    name: "send-review-outcome",
    run: (db) => {
      globalThis.__db = db;
      return sendReviewOutcome(jsonRequest({ blockId: "b1" }), ctx);
    },
    world: (profiles) =>
      world({
        profiles,
        task: {
          blocks: [{ id: "b1", name: "Draft", sealState: "sealed", reviewMode: "review" }],
          subtasks: [
            { id: "s1", title: "Write it", blockId: "b1", done: true },
            {
              id: "s2",
              title: "Sign it off",
              blockId: "b1",
              done: true,
              roleHint: "reviewer",
              reviewerUids: ["rev1"],
            },
          ],
        },
      }),
    everyone: ["doer1", "doer2", "rev1"],
  },
];

for (const sender of SENDERS) {
  describe(`${sender.name}, against the member's tasks row`, () => {
    test("an unwritten profile is not a refusal: everybody is emailed", async () => {
      const res = await sender.run(sender.world({}));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        recipientsOf(globalThis.__sent),
        sender.everyone.map((uid) => `${uid}@example.com`).sort(),
      );
      assert.equal(globalThis.__sent.length, sender.everyone.length);
    });

    test("a stored false skips that recipient's email and nobody else's", async () => {
      const refused = sender.everyone[0];
      const res = await sender.run(sender.world({ [refused]: REFUSED }));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        recipientsOf(globalThis.__sent),
        sender.everyone
          .filter((uid) => uid !== refused)
          .map((uid) => `${uid}@example.com`)
          .sort(),
      );
      assert.equal(res.body.optedOut, 1, "the skip is reported, not swallowed");
      assert.equal(res.body.failed ?? 0, 0, "a preference was counted as a failure");
    });

    test("the push leg still runs for the member who switched email off", async () => {
      // Two cells, two answers. `mirrorTaskEmailToPush` reads `push.tasks`
      // for itself, so a member who kept the push cell on hears about it on
      // the channel they kept.
      await sender.run(sender.world({ [sender.everyone[0]]: REFUSED }));
      assert.deepEqual(recipientsOf(globalThis.__pushed), [...sender.everyone].sort());
    });

    test("an explicit true is honoured and the kill switch still outranks it", async () => {
      const on = { notifications: { categories: { tasks: true } } };
      await sender.run(sender.world({ [sender.everyone[0]]: on }));
      assert.equal(globalThis.__sent.length, sender.everyone.length);

      globalThis.__sent = [];
      globalThis.__pushed = [];
      globalThis.__taskEmails = false;
      await sender.run(sender.world({ [sender.everyone[0]]: on }));
      assert.equal(globalThis.__sent.length, 0, "the kill switch outranks the row");
      assert.equal(globalThis.__pushed.length, 0, "the kill switch covers push too");
    });

    test("junk in the cell reads as the row's default, which is on", async () => {
      for (const stored of ["false", 0, null, { email: false }]) {
        globalThis.__sent = [];
        const profile = { notifications: { categories: { tasks: stored } } };
        await sender.run(sender.world({ [sender.everyone[0]]: profile }));
        assert.equal(
          globalThis.__sent.length,
          sender.everyone.length,
          `${JSON.stringify(stored)} was read as a refusal`,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// notify-member: one recipient, and a queue that empties either way
// ---------------------------------------------------------------------------

describe("notify-member, against the member's tasks row", () => {
  const NOTIFIED = { initialNotifyAt: STAMP, pendingNotifyUids: ["doer1"] };
  const run = (db) => {
    globalThis.__db = db;
    return notifyMember(jsonRequest({ uid: "doer1" }), ctx);
  };

  test("an unwritten profile is not a refusal", async () => {
    const db = world({ task: NOTIFIED });
    const res = await run(db);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sent, 1);
    assert.deepEqual(recipientsOf(globalThis.__sent), ["doer1@example.com"]);
  });

  test("a stored false sends no email, pushes anyway, and still clears the queue", async () => {
    // The queue is cleared either way for the reason the route already gives:
    // pressing Notify is the sender's declaration that this person has been
    // dealt with, and an inline button that never goes away is an invitation
    // to press it again.
    const db = world({ profiles: { doer1: REFUSED }, task: NOTIFIED });
    const res = await run(db);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sent, 0);
    assert.equal(res.body.optedOut, 1);
    assert.equal(globalThis.__sent.length, 0);
    assert.deepEqual(recipientsOf(globalThis.__pushed), ["doer1"]);
    assert.deepEqual(
      db.docs.get(`tasks/${TASK_ID}`).pendingNotifyUids,
      [],
      "a refused email left the person queued forever",
    );
  });

  test("the kill switch runs before the row and clears the queue on its own", async () => {
    globalThis.__taskEmails = false;
    const db = world({ task: NOTIFIED });
    const res = await run(db);

    assert.equal(res.body.skipped, "task-emails-disabled");
    assert.equal(globalThis.__sent.length, 0);
    assert.equal(globalThis.__pushed.length, 0);
    assert.deepEqual(db.docs.get(`tasks/${TASK_ID}`).pendingNotifyUids, []);
  });
});

// ---------------------------------------------------------------------------
// The gates are in series, and the order is the cheap one first
// ---------------------------------------------------------------------------

describe("the three gates, in series", () => {
  test("the kill switch answers before a single user document is read", async () => {
    globalThis.__taskEmails = false;
    const db = world({ profiles: { doer1: { notifications: { categories: { tasks: true } } } } });
    let reads = 0;
    const wrapped = {
      ...db,
      getAll: async (...refs) => {
        reads += 1;
        return db.getAll(...refs);
      },
    };
    globalThis.__db = wrapped;

    const res = await notify(jsonRequest({ commentId: "c1" }), ctx);

    assert.equal(res.body.skipped, "task-emails-disabled");
    assert.equal(reads, 0, "the kill switch paid for a roster read it never used");
  });

  test("a transport failure is still a failure, not an opt-out", async () => {
    // The two must not blur: `failed` is the number an admin reads as "somebody
    // was not told and should have been", and a preference is not that.
    globalThis.__sendThrows = true;
    const db = world();
    globalThis.__db = db;
    const res = await sendInitial({}, ctx);

    assert.equal(res.body.sent, 0);
    assert.equal(res.body.failed, 3);
    assert.equal(res.body.optedOut, 0);
  });
});
