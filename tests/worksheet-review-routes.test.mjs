/**
 * The review half of the worksheet routes, EXECUTED, against a fake Firestore:
 * returning feedback, unfreezing a submission, and telling people the questions
 * changed.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## Why these three get a harness rather than a source pin
 *
 * Each of them is a fact about somebody else's record, and each is invisible in
 * any one document. Returning COPIES from a staff-only document into one the
 * recipient reads, so what it does not copy is the interesting half: the whole
 * promise that "scores are never seen by the recipient" lives in the shape of
 * one object built inside a transaction. Unfreezing takes a submission back and
 * has to leave three documents and two counters agreeing about a response that
 * has moved backwards. And the copy-edited message is defined by who it does
 * NOT reach: a broadcast that widened by one state would tell people who have
 * already submitted that the questions changed after they answered.
 *
 * So the requests are made and the store is read afterwards. `returned` in
 * particular is asserted as a whole object, not sampled, because a score
 * leaking into it would be a field somebody added rather than a value somebody
 * changed, and a sampled assertion cannot see a new key.
 *
 * ## What is faked, and what is real
 *
 * The handlers, the circulation model, the notifier's dispatch, the mint and
 * the four email templates are the REAL modules. Faked: `next/server`,
 * `firebase-admin/firestore` (sentinels this store interprets), the Admin SDK
 * handles, the session, the impersonation guard, the SMTP transport, the push
 * mirror and the roster resolver. Nothing here can reach a Firestore project or
 * an inbox.
 *
 * The loader, the fake store and the seed world are the ones from
 * `tests/worksheet-routes.test.mjs`, deliberately identical: the two files test
 * the two halves of one tree, and a second dialect of the same fake would be a
 * second thing to keep true. The loader is the shared
 * `tests/lib/tsLoader.mjs`, which compiles JSX, so the "no scores, no feedback
 * text" promise below is checked against the rendered message rather than
 * against a stub's props.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { render } from "@react-email/render";
import { createLoader } from "./lib/tsLoader.mjs";

/** Every write in this file resolves `serverTimestamp()` to this instant. */
const STAMP = new Date("2026-09-06T12:00:00Z");

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
      "  increment: (by) => ({ __op: 'increment', by }),\n" +
      "};",
  ],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() {\n  return globalThis.__fakeDb;\n}\n" +
      "export function getAdminStorage() {\n  return globalThis.__fakeStorage;\n}",
  ],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() {\n  return globalThis.__fakeUser;\n}",
  ],
  [
    "@/lib/firebase/impersonation",
    "export async function assertNotImpersonating() {\n  return globalThis.__blocked ?? null;\n}",
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
  [
    "@/lib/email/taskMembership",
    "export async function resolveTaskUsers(db, uids) {\n" +
      "  const out = new Map();\n" +
      "  for (const uid of uids) {\n" +
      "    const snap = await db.collection('users').doc(uid).get();\n" +
      "    if (!snap.exists) continue;\n" +
      "    const data = snap.data() || {};\n" +
      "    if (!data.email) continue;\n" +
      "    out.set(uid, { email: data.email, displayName: data.displayName || 'there' });\n" +
      "  }\n  return out;\n}",
  ],
]);

const { loadTs } = createLoader({ stubs: STUBS });

// ---------------------------------------------------------------------------
// A Firestore small enough to read: addressed documents, one-field queries,
// batched writes that fail whole, one transaction at a time, and the two
// sentinels these routes write.
// ---------------------------------------------------------------------------

function alreadyExists() {
  const err = new Error("ALREADY_EXISTS");
  err.code = 6;
  return err;
}

/**
 * Resolve sentinels anywhere in a document, nested maps included. Dates pass
 * through untouched: a Date IS an object, and walking its (empty) entries the
 * way a plain map is walked would silently replace every timestamp with `{}`.
 *
 * The nesting matters here more than it did in the send tests: `returned` is a
 * map with a `serverTimestamp()` inside it, which is the shape the return route
 * writes and the shape a reader has to be able to read back.
 */
function resolveSentinels(value) {
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if ("__op" in value) {
      if (value.__op === "serverTimestamp") return STAMP;
      if (value.__op === "increment") return value.by;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

function matchesFilter(data, filter) {
  const actual = (data ?? {})[filter.field];
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(actual);
  return actual === filter.value;
}

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));

  function apply(path, data) {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && "__op" in value) {
        if (value.__op === "serverTimestamp") next[key] = STAMP;
        else if (value.__op === "increment") {
          next[key] = (typeof next[key] === "number" ? next[key] : 0) + value.by;
        }
      } else {
        next[key] = resolveSentinels(value);
      }
    }
    docs.set(path, next);
  }

  function snapshot(path) {
    const data = docs.get(path);
    return {
      id: path.split("/").pop(),
      path,
      ref: docRef(path),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
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
      async create(data) {
        if (docs.has(path)) throw alreadyExists();
        docs.set(path, resolveSentinels(data));
      },
      async set(data) {
        docs.set(path, resolveSentinels(data));
      },
      async update(data) {
        apply(path, data);
      },
    };
  }

  function query(path, filters, max) {
    return {
      where: (field, op, value) => query(path, [...filters, { field, op, value }], max),
      limit: (n) => query(path, filters, n),
      async get() {
        const out = [];
        for (const [docPath, data] of docs) {
          if (!docPath.startsWith(`${path}/`)) continue;
          // Direct children only: a subcollection's documents are not rows of
          // their parent collection.
          if (docPath.slice(path.length + 1).includes("/")) continue;
          if (!filters.every((f) => matchesFilter(data, f))) continue;
          out.push(snapshot(docPath));
        }
        const docsOut = typeof max === "number" ? out.slice(0, max) : out;
        return { docs: docsOut, empty: docsOut.length === 0, size: docsOut.length };
      },
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      ...query(path, [], undefined),
    };
  }

  return {
    docs,
    collection: collectionRef,
    doc: (path) => docRef(path),
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    batch() {
      const ops = [];
      return {
        create(ref, data) {
          ops.push({ kind: "create", ref, data });
        },
        set(ref, data) {
          ops.push({ kind: "set", ref, data });
        },
        update(ref, data) {
          ops.push({ kind: "update", ref, data });
        },
        delete(ref) {
          ops.push({ kind: "delete", ref });
        },
        async commit() {
          for (const op of ops) {
            if (op.kind === "create" && docs.has(op.ref.path)) throw alreadyExists();
          }
          for (const op of ops) {
            if (op.kind === "delete") docs.delete(op.ref.path);
            else if (op.kind === "update") apply(op.ref.path, op.data);
            else docs.set(op.ref.path, resolveSentinels(op.data));
          }
        },
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async (ref) => snapshot(ref.path),
        getAll: async (...refs) => refs.map((ref) => snapshot(ref.path)),
        set: (ref, data) => writes.push({ kind: "set", ref, data }),
        update: (ref, data) => writes.push({ kind: "update", ref, data }),
        delete: (ref) => writes.push({ kind: "delete", ref }),
      };
      // The handler throws before any write when it refuses, so a throw must
      // leave the store untouched: writes are collected and applied at the end.
      const result = await fn(tx);
      for (const write of writes) {
        if (write.kind === "delete") docs.delete(write.ref.path);
        else if (write.kind === "update") apply(write.ref.path, write.data);
        else docs.set(write.ref.path, resolveSentinels(write.data));
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The routes and the world they run in
// ---------------------------------------------------------------------------

const API = join("app", "api", "worksheets");
const { POST: circulate } = await loadTs(join(API, "circulations", "route.ts"));
const { POST: submit } = await loadTs(
  join(API, "circulations", "[circulationId]", "submit", "route.ts"),
);
const { POST: returnFeedback } = await loadTs(
  join(API, "circulations", "[circulationId]", "responses", "[uid]", "return", "route.ts"),
);
const { POST: unfreeze } = await loadTs(
  join(API, "circulations", "[circulationId]", "responses", "[uid]", "unfreeze", "route.ts"),
);
const { POST: notifyCopyEdited } = await loadTs(
  join(API, "circulations", "[circulationId]", "notify-copy-edited", "route.ts"),
);

const ITEMS = [
  { kind: "question", id: "q1", type: "shortText", title: "Your name", body: [], required: true },
  { kind: "question", id: "q2", type: "longText", title: "Why", body: [], required: false },
];

function seedWorld(extra = {}) {
  return makeDb({
    "users/sender1": {
      uid: "sender1",
      role: "committee",
      email: "sender@example.com",
      displayName: "Sam Sender",
      permissions: { circulateWorksheet: true },
    },
    "users/author1": {
      uid: "author1",
      role: "committee",
      email: "author@example.com",
      displayName: "Ada Author",
    },
    "users/recip1": {
      uid: "recip1",
      role: "committee",
      email: "recip1@example.com",
      displayName: "Rae One",
    },
    "users/recip2": {
      uid: "recip2",
      role: "committee",
      email: "recip2@example.com",
      displayName: "Bo Two",
    },
    "users/admin1": {
      uid: "admin1",
      role: "admin",
      email: "admin@example.com",
      displayName: "Al Admin",
    },
    "worksheets/ws1": {
      title: "Term plan",
      description: "What we are doing this term.",
      authorUid: "author1",
      private: false,
      items: ITEMS,
    },
    ...extra,
  });
}

/** The sender: staff of everything they send, and not an admin. */
const SENDER = {
  uid: "sender1",
  role: "committee",
  displayName: "Sam Sender",
  suRecognised: false,
  permissions: { circulateWorksheet: true },
};

const ADMIN = {
  uid: "admin1",
  role: "admin",
  displayName: "Al Admin",
  suRecognised: true,
  permissions: {},
};

function jsonRequest(body) {
  return { json: async () => body };
}

/** The circulation-only context, for the routes that name no response. */
function ctx(circulationId) {
  return { params: Promise.resolve({ circulationId }) };
}

/** The response context: both segments, as Next hands them over decoded. */
function responseCtx(circulationId, uid) {
  return { params: Promise.resolve({ circulationId, uid }) };
}

function pathsUnder(db, prefix) {
  return [...db.docs.keys()].filter((path) => path.startsWith(prefix)).sort();
}

function responseOf(db, circulationId, uid) {
  return db.docs.get(`circulations/${circulationId}/responses/${uid}`);
}

function taskOf(db, circulationId, uid) {
  const taskId = responseOf(db, circulationId, uid).taskId;
  return db.docs.get(`tasks/${taskId}`);
}

/** Send `ws1` as `SENDER`, and hand back the id it got. */
async function sendWorksheet(db, body = {}) {
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...SENDER };
  const res = await circulate(
    jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"], ...body }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.circulationId;
}

/** Put an answer on a recipient's response, the way their autosave would. */
function answer(db, circulationId, uid, answers) {
  const path = `circulations/${circulationId}/responses/${uid}`;
  db.docs.set(path, { ...db.docs.get(path), answers, state: "started" });
}

/** Answer and submit as one recipient, then hand the session back to `SENDER`. */
async function submitAs(db, circulationId, uid) {
  answer(db, circulationId, uid, { q1: { type: "text", text: "an answer" } });
  globalThis.__fakeUser = { uid, role: "committee", displayName: "A Recipient", permissions: {} };
  const res = await submit({}, ctx(circulationId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  globalThis.__fakeUser = { ...SENDER };
  globalThis.__sent = [];
  globalThis.__pushed = [];
}

/** Write a review the way the panel's client-direct save would. */
function seedReview(db, circulationId, uid, review) {
  db.docs.set(`circulations/${circulationId}/reviews/${uid}`, {
    updatedAt: STAMP,
    updatedByUid: "sender1",
    ...review,
  });
}

/** Send, submit, and leave a review sitting on it, ready to be returned. */
async function readyToReturn(db, body = {}) {
  const circulationId = await sendWorksheet(db, body);
  await submitAs(db, circulationId, "recip1");
  seedReview(db, circulationId, "recip1", {
    perQuestion: {
      q1: { feedback: "Clear and to the point.", score: 80 },
      // Scored but not written to: the return must not invent a remark out of
      // an entry that only ever held a number.
      q2: { score: 40 },
    },
    overall: "Good work overall.",
  });
  return circulationId;
}

test.beforeEach(() => {
  globalThis.__fakeUser = { ...SENDER };
  globalThis.__blocked = null;
  globalThis.__sent = [];
  globalThis.__pushed = [];
  globalThis.__taskEmails = true;
  globalThis.__sendThrows = false;
});

// ---------------------------------------------------------------------------
// Returning feedback
// ---------------------------------------------------------------------------

test("somebody who is not staff of this circulation cannot return anything", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  // A committee member with the circulate key, who is simply not on this
  // circulation: the key is not the gate, staffUids is.
  globalThis.__fakeUser = {
    uid: "recip2",
    role: "committee",
    displayName: "Bo Two",
    permissions: { circulateWorksheet: true },
  };

  const res = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 403);
  assert.equal(responseOf(db, circulationId, "recip1").state, "submitted");
  assert.equal(responseOf(db, circulationId, "recip1").returned, null);
  assert.equal(db.docs.get(`circulations/${circulationId}`).reviewedCount, 0);
  assert.equal(globalThis.__sent.length, 0);
});

test("the view-as guard refuses the return before anything is read", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  globalThis.__blocked = { status: 403, body: { error: "blocked" } };

  const res = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 403);
  assert.equal(responseOf(db, circulationId, "recip1").state, "submitted");
});

test("a response that has not been submitted cannot be returned", async () => {
  const db = seedWorld();
  const circulationId = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "half done" } });

  const res = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /hasn't submitted/);
  assert.equal(responseOf(db, circulationId, "recip1").state, "started");
  assert.equal(db.docs.get(`circulations/${circulationId}`).reviewedCount, 0);
});

test("returning twice is refused, so the reviewed counter can only move once", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);

  const again = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already been returned/);
  assert.equal(db.docs.get(`circulations/${circulationId}`).reviewedCount, 1);
});

test("returning copies the feedback, never a score, and marks the work reviewed", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);

  const res = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const response = responseOf(db, circulationId, "recip1");
  assert.equal(response.state, "reviewed");
  assert.equal(response.reviewedAt, STAMP);
  // Asserted WHOLE. A score leaking in would be a new key, and a sampled
  // assertion cannot see one.
  assert.deepEqual(response.returned, {
    perQuestion: { q1: { feedback: "Clear and to the point." } },
    overall: "Good work overall.",
    returnedAt: STAMP,
    returnedByUid: "sender1",
  });
  assert.ok(
    !JSON.stringify(response.returned).includes("score"),
    "a score must not reach a document the recipient can read",
  );

  // The staff document is untouched: the return is a copy, not a move, and the
  // scores stay where only staff can read them.
  const review = db.docs.get(`circulations/${circulationId}/reviews/recip1`);
  assert.equal(review.perQuestion.q1.score, 80);

  assert.equal(db.docs.get(`circulations/${circulationId}`).reviewedCount, 1);
  const task = taskOf(db, circulationId, "recip1");
  assert.equal(task.status, "done");
  assert.equal(task.completedAt, STAMP, "there is nothing left for anybody to do");
});

test("with per-question feedback off, only the overall box travels", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db, {
    reviewConfig: {
      perQuestionFeedback: false,
      perQuestionScoring: true,
      overallFeedback: true,
      returnToRecipient: true,
    },
  });

  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);
  const returned = responseOf(db, circulationId, "recip1").returned;
  assert.deepEqual(returned.perQuestion, {});
  assert.equal(returned.overall, "Good work overall.");
});

test("with overall feedback off, the overall box is written empty rather than left", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db, {
    reviewConfig: {
      perQuestionFeedback: true,
      perQuestionScoring: false,
      overallFeedback: false,
      returnToRecipient: true,
    },
  });

  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);
  const returned = responseOf(db, circulationId, "recip1").returned;
  assert.equal(returned.overall, "");
  assert.deepEqual(returned.perQuestion, { q1: { feedback: "Clear and to the point." } });
});

test("feedback on a question the copy editor removed is left behind", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  // The staff document is written client-direct with `merge: true`, and a merge
  // never deletes a nested key: an entry written before somebody removed the
  // question is still sitting there afterwards. Sent, it would be a remark
  // about a question that is no longer on the worksheet, in a document the
  // recipient reads and nothing renders.
  const circulation = db.docs.get(`circulations/${circulationId}`);
  circulation.items = circulation.items.filter((item) => item.id !== "q2");
  seedReview(db, circulationId, "recip1", {
    perQuestion: {
      q1: { feedback: "Clear and to the point.", score: 80 },
      q2: { feedback: "This one asked two things at once.", score: 20 },
    },
    overall: "Good work overall.",
  });

  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);
  assert.deepEqual(responseOf(db, circulationId, "recip1").returned.perQuestion, {
    q1: { feedback: "Clear and to the point." },
  });
  // Left behind, not deleted: the return is a copy, and a colleague's writing
  // is not this route's to throw away.
  assert.equal(
    db.docs.get(`circulations/${circulationId}/reviews/recip1`).perQuestion.q2.feedback,
    "This one asked two things at once.",
  );
});

test("a circulation that keeps feedback with the reviewers refuses to return it", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db, {
    reviewConfig: {
      perQuestionFeedback: true,
      perQuestionScoring: false,
      overallFeedback: true,
      returnToRecipient: false,
    },
  });

  const res = await returnFeedback({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /keeps feedback with the reviewers/);
  assert.equal(responseOf(db, circulationId, "recip1").returned, null);
  assert.equal(db.docs.get(`circulations/${circulationId}`).reviewedCount, 0);
});

test("the recipient is emailed about their feedback, pointed at their own copy", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);

  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);

  assert.equal(globalThis.__sent.length, 1);
  const mail = globalThis.__sent[0];
  assert.equal(mail.to, "recip1@example.com");
  assert.equal(mail.subject, 'Feedback on "Term plan"');
  assert.equal(mail.kind, "task");
  assert.equal(mail.referenceId, circulationId);
  // The message as the recipient receives it, not as it was assembled. The
  // template is the real one, so the promise it makes in its own header ("IT
  // CARRIES NO FEEDBACK") is checked against the HTML: feedback written for one
  // person lands in a mailbox that is forwarded, previewed on a lock screen and
  // quoted in a reply, and a props assertion cannot see whether the words made
  // it into the body.
  const html = await render(mail.react);
  assert.match(html, /Sam Sender/, "feedback is somebody's judgement, so it is signed");
  assert.match(html, /Read the feedback/);
  // The closing quote is the anchor: the pattern ends where the href does, so a
  // link that grew a suffix fails instead of matching inside itself.
  assert.match(html, new RegExp(`/worksheets/respond/${circulationId}"`));
  assert.doesNotMatch(
    html,
    /Clear and to the point\./,
    "the feedback itself stays on the page; the email says it is there",
  );
  assert.doesNotMatch(
    html,
    /\bscore\b/i,
    "and no score reaches the recipient: the return route never copies one anywhere they can read",
  );

  assert.equal(globalThis.__pushed.length, 1);
  assert.equal(globalThis.__pushed[0].uid, "recip1");
  assert.equal(globalThis.__pushed[0].url, `/worksheets/respond/${circulationId}`);
});

test("the feedbackReturned switch silences the message without touching the work", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db, {
    notifications: { feedbackReturned: { email: false, push: false } },
  });

  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);
  assert.equal(globalThis.__sent.length, 0);
  assert.equal(responseOf(db, circulationId, "recip1").state, "reviewed");
});

// ---------------------------------------------------------------------------
// Unfreezing
// ---------------------------------------------------------------------------

test("staff of the circulation cannot unfreeze: it is an admin action", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  // The sender, who is staff of this very circulation and holds the circulate
  // key. Neither is enough.
  const res = await unfreeze({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 403);
  assert.equal(responseOf(db, circulationId, "recip1").state, "submitted");
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 1);
});

test("unfreezing a submitted response reopens it and takes the counter back", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  globalThis.__fakeUser = { ...ADMIN };

  const res = await unfreeze({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const response = responseOf(db, circulationId, "recip1");
  assert.equal(response.state, "started");
  assert.equal(response.submittedAt, null);
  assert.equal(response.reviewedAt, null);
  assert.equal(response.returned, null);
  assert.equal(response.unfrozenAt, STAMP);
  assert.equal(response.unfrozenByUid, "admin1");
  assert.deepEqual(
    response.answers,
    { q1: { type: "text", text: "an answer" } },
    "unfreezing reopens the answers; it does not clear them",
  );

  const circulation = db.docs.get(`circulations/${circulationId}`);
  assert.equal(circulation.submittedCount, 0);
  assert.equal(circulation.reviewedCount, 0, "it was never reviewed, so nothing to take back");

  const task = taskOf(db, circulationId, "recip1");
  assert.equal(task.status, "in-progress");
  assert.equal(task.completedAt, null);
});

test("unfreezing a returned response clears the feedback and both counters", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  assert.equal((await returnFeedback({}, responseCtx(circulationId, "recip1"))).status, 200);
  globalThis.__fakeUser = { ...ADMIN };

  assert.equal((await unfreeze({}, responseCtx(circulationId, "recip1"))).status, 200);

  const response = responseOf(db, circulationId, "recip1");
  assert.equal(response.state, "started");
  assert.equal(response.returned, null, "the returned copy goes with the answers it was about");
  const circulation = db.docs.get(`circulations/${circulationId}`);
  assert.equal(circulation.submittedCount, 0);
  assert.equal(circulation.reviewedCount, 0);

  // The staff notes survive: they are what the next return is built from.
  const review = db.docs.get(`circulations/${circulationId}/reviews/recip1`);
  assert.equal(review.overall, "Good work overall.");
  assert.equal(review.perQuestion.q1.score, 80);
});

test("a response nobody has submitted is not locked, so there is nothing to unfreeze", async () => {
  const db = seedWorld();
  const circulationId = await sendWorksheet(db);
  globalThis.__fakeUser = { ...ADMIN };

  const res = await unfreeze({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 409);
  assert.equal(responseOf(db, circulationId, "recip1").state, "not-opened");
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 0);
});

test("the counters never go below zero, whatever the stored numbers say", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  // A counter that has drifted (a restored backup, a hand edit in the console).
  // `increment(-1)` would write minus one here, and a circulation reading
  // "-1 of 1 submitted" is a bug nobody can explain or repair from the page.
  db.docs.get(`circulations/${circulationId}`).submittedCount = 0;
  globalThis.__fakeUser = { ...ADMIN };

  assert.equal((await unfreeze({}, responseCtx(circulationId, "recip1"))).status, 200);
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 0);
});

test("a closed circulation cannot be unlocked, because nothing could be submitted", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  db.docs.get(`circulations/${circulationId}`).status = "closed";
  globalThis.__fakeUser = { ...ADMIN };

  const res = await unfreeze({}, responseCtx(circulationId, "recip1"));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /closed/);
  assert.equal(
    responseOf(db, circulationId, "recip1").state,
    "submitted",
    "a refusal must not half-open the response",
  );
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 1);
});

test("unfreezing sends nothing: it is not one of the circulation's five messages", async () => {
  const db = seedWorld();
  const circulationId = await readyToReturn(db);
  globalThis.__fakeUser = { ...ADMIN };

  assert.equal((await unfreeze({}, responseCtx(circulationId, "recip1"))).status, 200);
  assert.equal(globalThis.__sent.length, 0);
  assert.equal(globalThis.__pushed.length, 0);
});

// ---------------------------------------------------------------------------
// Telling people the questions changed
// ---------------------------------------------------------------------------

const COPY_EDITED_ON = { notifications: { copyEdited: { email: true, push: true } } };

/**
 * One circulation with a recipient in each state that matters: `recip1` is
 * part-way through, `author1` has submitted, `recip2` has never opened it.
 */
async function threeStates(db, body = {}) {
  const circulationId = await sendWorksheet(db, {
    recipientUids: ["recip1", "recip2", "author1"],
    ...body,
  });
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "part way" } });
  await submitAs(db, circulationId, "author1");
  return circulationId;
}

test("only the people part-way through are told the questions changed", async () => {
  const db = seedWorld();
  const circulationId = await threeStates(db, COPY_EDITED_ON);

  const res = await notifyCopyEdited({}, ctx(circulationId));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sent: 1 });

  assert.equal(globalThis.__sent.length, 1);
  const mail = globalThis.__sent[0];
  assert.equal(mail.to, "recip1@example.com");
  assert.equal(mail.subject, '"Term plan" has changed');
  const html = await render(mail.react);
  assert.match(html, /Sam Sender/, "somebody made this change, and the message says who");
  assert.match(
    html,
    /already answered is still there/,
    "the reassurance is the message: a changed worksheet reads as lost work without it",
  );
  assert.match(html, new RegExp(`/worksheets/respond/${circulationId}"`));
  assert.deepEqual(
    globalThis.__pushed.map((push) => push.uid),
    ["recip1"],
    "somebody who has submitted cannot act on the news, and has already answered",
  );
});

test("with the questions-edited switch off, the button reaches nobody", async () => {
  const db = seedWorld();
  // The default: `copyEdited` is the one notification that ships off, so a
  // sender fixing a typo does not have to remember to silence a broadcast.
  const circulationId = await threeStates(db);

  const res = await notifyCopyEdited({}, ctx(circulationId));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sent: 0 });
  assert.equal(globalThis.__sent.length, 0);
});

test("the site-wide task-email kill switch covers the copy-edited message too", async () => {
  const db = seedWorld();
  const circulationId = await threeStates(db, COPY_EDITED_ON);
  globalThis.__taskEmails = false;

  const res = await notifyCopyEdited({}, ctx(circulationId));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sent: 0 });
  assert.equal(globalThis.__sent.length, 0);
});

test("a closed circulation tells nobody the questions changed", async () => {
  const db = seedWorld();
  const circulationId = await threeStates(db, COPY_EDITED_ON);
  db.docs.get(`circulations/${circulationId}`).status = "closed";

  // The message asks people to look again before they submit, and nobody can
  // submit to a closed circulation: a send here would be asking for something
  // the site itself refuses.
  const res = await notifyCopyEdited({}, ctx(circulationId));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /closed/);
  assert.equal(globalThis.__sent.length, 0);
  assert.equal(globalThis.__pushed.length, 0);

  // And the staff check still comes first, so a stranger learns nothing about
  // the state of a circulation they are not on.
  globalThis.__fakeUser = {
    uid: "recip2",
    role: "committee",
    displayName: "Bo Two",
    permissions: { circulateWorksheet: true },
  };
  assert.equal((await notifyCopyEdited({}, ctx(circulationId))).status, 403);
});

test("a stranger cannot make a circulation email its recipients", async () => {
  const db = seedWorld();
  const circulationId = await threeStates(db, COPY_EDITED_ON);
  globalThis.__fakeUser = {
    uid: "recip2",
    role: "committee",
    displayName: "Bo Two",
    permissions: { circulateWorksheet: true },
  };

  const res = await notifyCopyEdited({}, ctx(circulationId));
  assert.equal(res.status, 403);
  assert.equal(globalThis.__sent.length, 0);
});

test("an unknown circulation is a 404 from all three routes, and writes nothing", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...ADMIN };

  assert.equal((await returnFeedback({}, responseCtx("nope", "recip1"))).status, 404);
  assert.equal((await unfreeze({}, responseCtx("nope", "recip1"))).status, 404);
  assert.equal((await notifyCopyEdited({}, ctx("nope"))).status, 404);
  assert.deepEqual(pathsUnder(db, "circulations"), []);
});

test("an id that is not addressable is refused before it reaches a document path", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...ADMIN };

  // Dynamic segments arrive URL-decoded, so a `%2F` is a real path separator by
  // the time a handler sees it, and `doc()` would throw a 500 out of it.
  assert.equal((await returnFeedback({}, responseCtx("a/b", "recip1"))).status, 404);
  assert.equal((await returnFeedback({}, responseCtx("c1", "a/b"))).status, 404);
  assert.equal((await unfreeze({}, responseCtx("c1", ".."))).status, 404);
});
