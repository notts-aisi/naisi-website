/**
 * The worksheet and circulation DELETE and DESTROY routes, EXECUTED, against a
 * fake Firestore and a fake bucket.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## Why this file exists
 *
 * A destroy is the one operation in this codebase that cannot be undone by
 * pressing something else, and every property that makes it safe is a property
 * ACROSS several documents and two round trips: the audit row exists before
 * anything dies, the circulation goes read-only before the first delete, the
 * cascade drains everything it promised in the manifest, the totals on the row
 * are the ones the receipt shows, and a pass that runs out of budget resumes
 * rather than lying about being finished. None of that is visible in any one
 * call, so the requests are made and the store is read afterwards.
 *
 * The harness is `tests/worksheet-routes.test.mjs`'s, extended with the three
 * things a cascade needs and a send does not: aggregate `count()`,
 * `recursiveDelete`, and a bucket that remembers what it listed and what it was
 * told to empty.
 *
 * ## What is faked, and what is real
 *
 * The route handlers, the destroy engine, the shared audit module, the access
 * helpers and the circulation normalisers are the REAL modules. Faked:
 * `next/server`, `firebase-admin/firestore` (sentinels this store interprets),
 * the Admin SDK handles, the session and the impersonation guard. Nothing here
 * can reach a Firestore project or a bucket.
 *
 * The audit module is deliberately NOT stubbed. The row it writes is the only
 * durable record that a destroy happened, and the cascade's contract with it
 * (open before deleting, increment per page, complete last, claim one pass at a
 * time) is exactly the kind of two-module agreement a stub would paper over.
 *
 * The loader is the shared one, `tests/lib/tsLoader.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every write in this file resolves `serverTimestamp()` to this instant. */
const STAMP = new Date("2026-09-07T12:00:00Z");

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = {\n" +
      "  json(body, init) {\n" +
      "    return { status: (init && init.status) || 200, body };\n  },\n};",
  ],
  // The two sentinels plus Timestamp, which the audit module's pass claim
  // needs. A fake Timestamp carries `toDate` and `toMillis` because the real
  // readers call both.
  [
    "firebase-admin/firestore",
    "function stamp(ms) {\n" +
      "  return { __ts: ms, toDate: () => new Date(ms), toMillis: () => ms };\n}\n" +
      "export const Timestamp = { fromMillis: (ms) => stamp(ms) };\n" +
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
]);

const { loadTs } = createLoader({ stubs: STUBS });

// ---------------------------------------------------------------------------
// A Firestore small enough to read
// ---------------------------------------------------------------------------

/** A Timestamp as this store hands one back. See the stub above. */
function fakeTimestamp(date) {
  const ms = date.getTime();
  return { __ts: ms, toDate: () => new Date(ms), toMillis: () => ms };
}

function isTimestamp(value) {
  return Boolean(value) && typeof value === "object" && "__ts" in value;
}

/**
 * Resolve sentinels anywhere in a document, nested maps included. Dates and
 * fake Timestamps pass through untouched: both ARE objects, and walking their
 * entries the way a plain map is walked would quietly replace them.
 */
function resolveSentinels(value) {
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value instanceof Date) return value;
  if (isTimestamp(value)) return value;
  if (value && typeof value === "object") {
    if ("__op" in value) {
      if (value.__op === "serverTimestamp") return fakeTimestamp(STAMP);
      if (value.__op === "increment") return value.by;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

/** `a.b.c` reads through nested maps, which is what a Firestore field path does. */
function readPath(data, field) {
  let cursor = data ?? {};
  for (const part of field.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function matchesFilter(data, filter) {
  const actual = readPath(data, filter.field);
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(actual);
  return actual === filter.value;
}

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  /** Every mutation, in order. The ordering assertions read this. */
  const ops = [];
  let autoId = 0;

  /** One field of an update, including the dotted form Firestore treats as a path. */
  function applyField(target, field, value) {
    const parts = field.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
      else cursor[part] = { ...cursor[part] };
      cursor = cursor[part];
    }
    const leaf = parts[parts.length - 1];
    if (value && typeof value === "object" && !(value instanceof Date) && !isTimestamp(value) && "__op" in value) {
      if (value.__op === "serverTimestamp") cursor[leaf] = fakeTimestamp(STAMP);
      else if (value.__op === "increment") {
        cursor[leaf] = (typeof cursor[leaf] === "number" ? cursor[leaf] : 0) + value.by;
      }
    } else {
      cursor[leaf] = resolveSentinels(value);
    }
  }

  function apply(path, data) {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [field, value] of Object.entries(data)) applyField(next, field, value);
    docs.set(path, next);
    ops.push({ kind: "update", path, data });
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
      async set(data) {
        docs.set(path, resolveSentinels(data));
        ops.push({ kind: "set", path, data });
      },
      async update(data) {
        if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
        apply(path, data);
      },
      async delete() {
        docs.delete(path);
        ops.push({ kind: "delete", path });
      },
    };
  }

  function query(path, filters, max) {
    const self = {
      where: (field, op, value) => query(path, [...filters, { field, op, value }], max),
      limit: (n) => query(path, filters, n),
      count: () => ({
        async get() {
          const snap = await self.get();
          return { data: () => ({ count: snap.size }) };
        },
      }),
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
    return self;
  }

  function collectionRef(path) {
    return {
      path,
      doc: (id) => docRef(`${path}/${id ?? `auto${(autoId += 1)}`}`),
      ...query(path, [], undefined),
    };
  }

  return {
    docs,
    ops,
    collection: collectionRef,
    doc: (path) => docRef(path),
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    /** BulkWriter-backed in production: the document and everything under it. */
    async recursiveDelete(ref) {
      for (const path of [...docs.keys()]) {
        if (path === ref.path || path.startsWith(`${ref.path}/`)) {
          docs.delete(path);
          ops.push({ kind: "delete", path });
        }
      }
    },
    batch() {
      const queued = [];
      return {
        set(ref, data) {
          queued.push({ kind: "set", ref, data });
        },
        update(ref, data) {
          queued.push({ kind: "update", ref, data });
        },
        delete(ref) {
          queued.push({ kind: "delete", ref });
        },
        async commit() {
          for (const op of queued) {
            if (op.kind === "delete") {
              docs.delete(op.ref.path);
              ops.push({ kind: "delete", path: op.ref.path });
            } else if (op.kind === "update") {
              apply(op.ref.path, op.data);
            } else {
              docs.set(op.ref.path, resolveSentinels(op.data));
              ops.push({ kind: "set", path: op.ref.path, data: op.data });
            }
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
      // A handler that refuses throws before any write, so a throw must leave
      // the store untouched: writes are collected and applied at the end.
      const result = await fn(tx);
      for (const write of writes) {
        if (write.kind === "delete") {
          docs.delete(write.ref.path);
          ops.push({ kind: "delete", path: write.ref.path });
        } else if (write.kind === "update") {
          apply(write.ref.path, write.data);
        } else {
          docs.set(write.ref.path, resolveSentinels(write.data));
          ops.push({ kind: "set", path: write.ref.path, data: write.data });
        }
      }
      return result;
    },
  };
}

/**
 * A bucket that remembers what it was asked to list and to empty, and never
 * leaves the process. `deleteFiles({ prefix })` removes every object under the
 * prefix, which is what the real one does after paginating internally.
 */
function makeStorage(paths = []) {
  const files = new Set(paths);
  const deletedPrefixes = [];
  const deletedFiles = [];
  return {
    files,
    deletedPrefixes,
    deletedFiles,
    bucket() {
      return {
        name: "naisi-test.firebasestorage.app",
        async getFiles({ prefix }) {
          return [[...files].filter((p) => p.startsWith(prefix)).map((name) => ({ name }))];
        },
        async deleteFiles({ prefix }) {
          deletedPrefixes.push(prefix);
          for (const path of [...files]) if (path.startsWith(prefix)) files.delete(path);
        },
        file(path) {
          return {
            async delete() {
              deletedFiles.push(path);
              files.delete(path);
            },
          };
        },
      };
    },
  };
}

/**
 * A bucket that will not answer. Every call throws, the way the real client
 * does when the store is unreachable or the credentials are wrong, and the
 * prefixes it was asked about are recorded so a test can prove it was asked.
 *
 * It exists because the interesting failure here is not the throw, it is what
 * the manifest DOES with it: a listing reported as 0 would tell an admin there
 * were no uploaded answers when nobody had counted them.
 */
function makeBrokenStorage() {
  const attempts = [];
  const fail = () => {
    throw new Error("bucket unavailable");
  };
  return {
    attempts,
    bucket() {
      return {
        name: "naisi-test.firebasestorage.app",
        async getFiles({ prefix }) {
          attempts.push(prefix);
          return fail();
        },
        async deleteFiles({ prefix }) {
          attempts.push(prefix);
          return fail();
        },
        file: fail,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The routes and the world they run in
// ---------------------------------------------------------------------------

const API = join("app", "api", "worksheets");
const { DELETE: deleteWorksheet } = await loadTs(join(API, "[worksheetId]", "route.ts"));
const { POST: destroyCirculation } = await loadTs(
  join(API, "circulations", "[circulationId]", "destroy", "route.ts"),
);
const { GET: destroyManifest } = await loadTs(
  join(API, "circulations", "[circulationId]", "destroy-manifest", "route.ts"),
);

const ADMIN = { uid: "admin1", role: "admin", displayName: "Ada Admin", suRecognised: true };
const SENDER = {
  uid: "sender1",
  role: "committee",
  displayName: "Sam Sender",
  suRecognised: true,
  permissions: { circulateWorksheet: true },
};
const OUTSIDER = { uid: "member1", role: "member", displayName: "Mo Member" };

const ITEMS = [
  { kind: "question", id: "q1", type: "shortText", title: "Your name", body: [], required: true },
];

/**
 * One circulation of one worksheet, sent to two people, with everything a
 * destroy is supposed to reach and two things it must leave alone: a task
 * belonging to a DIFFERENT circulation, and a committee task somebody aimed at
 * this one by writing the pointer onto it themselves.
 */
function seedWorld(extra = {}) {
  return makeDb({
    "worksheets/ws1": {
      title: "Term plan",
      description: "What we are doing this term.",
      authorUid: "sender1",
      private: false,
      items: ITEMS,
    },
    "circulations/c1": {
      worksheetId: "ws1",
      title: "Term plan",
      description: "Please fill this in.",
      items: ITEMS,
      senderUid: "sender1",
      authorUid: "sender1",
      reviewerUids: [],
      staffUids: ["sender1"],
      status: "open",
      recipientCount: 2,
      submittedCount: 1,
      reviewedCount: 0,
    },
    "circulations/c1/responses/recip1": {
      uid: "recip1",
      circulationId: "c1",
      taskId: "task1",
      state: "submitted",
      answers: { q1: { type: "text", text: "Rae" } },
    },
    "circulations/c1/responses/recip2": {
      uid: "recip2",
      circulationId: "c1",
      taskId: "task2",
      state: "started",
      answers: {},
    },
    "circulations/c1/reviews/recip1": {
      perQuestion: { q1: { feedback: "Good", score: 8 } },
      overall: "Solid",
      updatedByUid: "sender1",
    },
    "tasks/task1": {
      title: "Term plan",
      source: "worksheet",
      kind: "worksheet",
      completerUids: ["recip1"],
      visibility: "assignees-only",
      artefact: { kind: "worksheet-response", circulationId: "c1" },
    },
    "tasks/task1/comments/cm1": { body: "Started this", authorUid: "recip1" },
    "tasks/task1/activity/a1": { kind: "created" },
    "tasks/task1/attachments/at1": {
      filename: "notes.pdf",
      storagePath: "tasks/task1/notes.pdf",
    },
    "tasks/task2": {
      title: "Term plan",
      source: "worksheet",
      kind: "worksheet",
      completerUids: ["recip2"],
      visibility: "assignees-only",
      artefact: { kind: "worksheet-response", circulationId: "c1" },
    },
    // Another circulation's card. Same source, different pointer.
    "tasks/other": {
      title: "Something else",
      source: "worksheet",
      kind: "worksheet",
      completerUids: ["recip1"],
      artefact: { kind: "worksheet-response", circulationId: "c2" },
    },
    // A committee task somebody aimed at this circulation by writing the
    // pointer onto it. `firestore.rules` does not pin `artefact` on the
    // committee create lane, so this is reachable; the cascade's `source`
    // filter is what keeps it out of an admin's destroy.
    "tasks/forged": {
      title: "Somebody else's committee task",
      source: "committee",
      visibility: "committee",
      completerUids: ["sender1"],
      artefact: { kind: "worksheet-response", circulationId: "c1" },
    },
    "tasks/forged/comments/cm9": { body: "A whole discussion", authorUid: "sender1" },
    "schedulerMarkers/wsremind__c1__recip1__2026-09-10T1000": {
      family: "wsremind",
      circulationId: "c1",
      uid: "recip1",
    },
    "schedulerMarkers/wsremind__c2__recip1__2026-09-10T1000": {
      family: "wsremind",
      circulationId: "c2",
      uid: "recip1",
    },
    "dataExports/exp1": { kind: "worksheet-responses", scope: { circulationId: "c1" }, rowCount: 2 },
    "emailSends/send1": { referenceId: "c1", to: "recip1@example.com" },
    "emailSends/send2": { referenceId: "c1", to: "recip2@example.com" },
    ...extra,
  });
}

function seedFiles() {
  return makeStorage([
    "worksheet-uploads/c1/recip1/photo.jpg",
    "worksheet-uploads/c1/recip2/screenshot.png",
    "worksheet-images/c1/question.png",
    "worksheet-images/ws1/library.png",
    "worksheet-uploads/c2/recip1/other.jpg",
    "tasks/task1/notes.pdf",
  ]);
}

function circulationContext(circulationId) {
  return { params: Promise.resolve({ circulationId }) };
}

function worksheetContext(worksheetId) {
  return { params: Promise.resolve({ worksheetId }) };
}

function jsonRequest(body) {
  return { json: async () => body };
}

function manifestRequest(circulationId, search = "") {
  return { url: `https://naisi.test/api/worksheets/circulations/${circulationId}/destroy-manifest${search}` };
}

/** Run the destroy to completion the way the client's resume loop does. */
async function destroyToCompletion(db, storage, user, confirmName, circulationId = "c1") {
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = storage;
  globalThis.__fakeUser = user;
  const passes = [];
  for (let i = 0; i < 10; i += 1) {
    const res = await destroyCirculation(
      jsonRequest({ confirmName }),
      circulationContext(circulationId),
    );
    passes.push(res);
    if (res.status !== 200 || res.body.complete) break;
  }
  return passes;
}

function pathsUnder(db, prefix) {
  return [...db.docs.keys()].filter((path) => path.startsWith(prefix)).sort();
}

/** The one audit row this store holds. */
function auditRow(db) {
  const entry = [...db.docs.entries()].find(([path]) => path.startsWith("destroyAudits/"));
  return entry ? { id: entry[0].split("/")[1], data: entry[1] } : null;
}

// ---------------------------------------------------------------------------
// 1. Who may destroy a circulation
// ---------------------------------------------------------------------------

test("the destroy refuses a non-admin before it looks the circulation up", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();

  // The SENDER of this circulation, who is staff of it and could close it, and
  // who the owner's decision deliberately does not trust with destroying it.
  globalThis.__fakeUser = SENDER;
  const res = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(res.status, 403);

  // And on an id that does not exist, the answer is STILL 403 rather than 404:
  // authorisation runs first, so nobody learns which ids are real by asking.
  const missing = await destroyCirculation(
    jsonRequest({ confirmName: "anything" }),
    circulationContext("no-such-circulation"),
  );
  assert.equal(missing.status, 403);

  globalThis.__fakeUser = null;
  const anonymous = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(anonymous.status, 401);

  // Nothing moved on any of the three.
  assert.ok(db.docs.has("circulations/c1"));
  assert.equal(db.ops.length, 0);
});

test("the manifest is admin-only, and answers before it checks existence", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();

  globalThis.__fakeUser = SENDER;
  assert.equal((await destroyManifest(manifestRequest("c1"), circulationContext("c1"))).status, 403);
  assert.equal(
    (await destroyManifest(manifestRequest("nope"), circulationContext("nope"))).status,
    403,
  );

  globalThis.__fakeUser = OUTSIDER;
  assert.equal((await destroyManifest(manifestRequest("c1"), circulationContext("c1"))).status, 403);
});

test("a wrong confirmation is refused and an untitled circulation cannot be confirmed at all", async () => {
  const db = seedWorld({
    "circulations/untitled": {
      worksheetId: "ws1",
      title: "",
      items: [],
      senderUid: "sender1",
      authorUid: "sender1",
      staffUids: ["sender1"],
      status: "open",
    },
  });
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();
  globalThis.__fakeUser = ADMIN;

  // Close, but not byte-equal: trailing space, wrong case, and the empty body.
  for (const confirmName of ["Term plan ", "term plan", ""]) {
    const res = await destroyCirculation(jsonRequest({ confirmName }), circulationContext("c1"));
    assert.equal(res.status, 400, `"${confirmName}" must not confirm anything`);
  }
  const missingField = await destroyCirculation(jsonRequest({}), circulationContext("c1"));
  assert.equal(missingField.status, 400);

  // An empty title would make the typed confirmation pass by typing nothing.
  const untitled = await destroyCirculation(
    jsonRequest({ confirmName: "" }),
    circulationContext("untitled"),
  );
  assert.equal(untitled.status, 409);
  assert.match(untitled.body.error, /no title/);

  // Not one of those five requests wrote anything.
  assert.equal(db.ops.length, 0);
  assert.ok(db.docs.has("circulations/c1"));
  assert.ok(db.docs.has("circulations/untitled"));
});

// ---------------------------------------------------------------------------
// 2. The opening write
// ---------------------------------------------------------------------------

test("the audit row is opened, and the circulation closed and flagged, before anything is deleted", async () => {
  const db = seedWorld();
  const storage = seedFiles();
  await destroyToCompletion(db, storage, ADMIN, "Term plan");

  // The FIRST write of the whole destroy is the audit row. Everything after it
  // is evidence that already has somewhere to be recorded.
  assert.equal(db.ops[0].kind, "set");
  assert.ok(
    db.ops[0].path.startsWith("destroyAudits/"),
    `first write was ${db.ops[0].path}, expected the audit row`,
  );

  const markerIndex = db.ops.findIndex(
    (op) => op.kind === "update" && op.path === "circulations/c1" && op.data.destroying === true,
  );
  assert.ok(markerIndex > 0, "the circulation must be marked as destroying");
  assert.equal(
    db.ops[markerIndex].data.status,
    "closed",
    "the same write closes it, so every listen goes read-only at once",
  );

  const firstDelete = db.ops.findIndex((op) => op.kind === "delete");
  assert.ok(
    firstDelete > markerIndex,
    "nothing may be deleted before the circulation is flagged and closed",
  );
});

// ---------------------------------------------------------------------------
// 3. What the cascade removes, and what it leaves
// ---------------------------------------------------------------------------

test("a completed destroy removes every response, review, task, marker and image", async () => {
  const db = seedWorld();
  const storage = seedFiles();
  const passes = await destroyToCompletion(db, storage, ADMIN, "Term plan");

  const last = passes[passes.length - 1];
  assert.equal(last.status, 200);
  assert.equal(last.body.complete, true);
  assert.equal(last.body.ok, true);
  assert.ok(last.body.auditId);

  // Gone: the circulation, both subcollections, both recipient tasks with
  // everything under them, and this circulation's reminder marker.
  assert.equal(db.docs.has("circulations/c1"), false);
  assert.deepEqual(pathsUnder(db, "circulations/c1"), []);
  assert.deepEqual(pathsUnder(db, "tasks/task1"), []);
  assert.deepEqual(pathsUnder(db, "tasks/task2"), []);
  assert.equal(db.docs.has("schedulerMarkers/wsremind__c1__recip1__2026-09-10T1000"), false);

  // Still there: another circulation's card, another circulation's marker, and
  // the committee task somebody had aimed at this circulation. The cascade
  // filters on the source the mint writes, so a forged pointer names nothing
  // it will touch, and the discussion on that task survives with it.
  assert.ok(db.docs.has("tasks/other"));
  assert.ok(db.docs.has("schedulerMarkers/wsremind__c2__recip1__2026-09-10T1000"));
  assert.ok(db.docs.has("tasks/forged"));
  assert.ok(db.docs.has("tasks/forged/comments/cm9"));

  // RETAINED by design, and counted rather than deleted: the delivery log and
  // the record that somebody exported these answers.
  assert.ok(db.docs.has("emailSends/send1"));
  assert.ok(db.docs.has("emailSends/send2"));
  assert.ok(db.docs.has("dataExports/exp1"));

  // The library worksheet is a different document and is not touched.
  assert.ok(db.docs.has("worksheets/ws1"));

  // Storage: both of the circulation's folders emptied, the attachment blob on
  // a destroyed task deleted by name, and nothing else touched.
  assert.deepEqual(
    [...storage.files].sort(),
    ["worksheet-images/ws1/library.png", "worksheet-uploads/c2/recip1/other.jpg"],
  );
  assert.deepEqual(storage.deletedPrefixes.sort(), [
    "worksheet-images/c1/",
    "worksheet-uploads/c1/",
  ]);
  assert.deepEqual(storage.deletedFiles, ["tasks/task1/notes.pdf"]);
});

test("the audit row accumulates the counts and is completed last", async () => {
  const db = seedWorld();
  const passes = await destroyToCompletion(db, seedFiles(), ADMIN, "Term plan");

  const row = auditRow(db);
  assert.ok(row, "a destroy writes exactly one audit row");
  assert.equal(row.data.kind, "circulation");
  assert.equal(row.data.targetId, "c1");
  // The label is the point of the row: once the cascade has run, the id names
  // nothing and this is the only thing that says what was destroyed.
  assert.equal(row.data.label, "Term plan");
  assert.equal(row.data.startedByUid, "admin1");
  assert.equal(row.data.startedByName, "Ada Admin");
  assert.ok(row.data.completedAt, "the row is stamped complete on the finishing pass");
  assert.equal(row.data.passInFlightUntil, null, "and hands its claim back");

  assert.deepEqual(row.data.deleted, {
    reviews: 1,
    responses: 2,
    tasks: 2,
    schedulerMarkers: 1,
    uploadedImages: 2,
    questionImages: 1,
    circulation: 1,
  });

  // The route reports the row's own totals, not its pass's.
  assert.deepEqual(passes[passes.length - 1].body.deleted, row.data.deleted);
});

test("the manifest counts exactly what the cascade goes on to remove", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();
  globalThis.__fakeUser = ADMIN;

  const res = await destroyManifest(manifestRequest("c1"), circulationContext("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.target.label, "Term plan");
  assert.deepEqual(res.body.blockers, []);
  assert.equal(res.body.interrupted, null);
  assert.deepEqual(res.body.counts, {
    responses: 2,
    reviews: 1,
    tasks: 2,
    uploadedImages: 2,
    questionImages: 1,
    schedulerMarkers: 1,
    dataExportRows: 1,
    emailSendRows: 2,
  });
  // Reading a manifest changes nothing.
  assert.equal(db.ops.length, 0);
});

// ---------------------------------------------------------------------------
// 4. The budget, and resuming
// ---------------------------------------------------------------------------

test("a destroy that spends its budget reports incomplete, and the same call finishes it", async () => {
  // Over the 500-document budget on the leaf stages alone, so the first pass
  // cannot reach the tasks, the markers or the images.
  const many = {};
  for (let i = 0; i < 260; i += 1) {
    many[`circulations/c1/responses/r${i}`] = { uid: `r${i}`, circulationId: "c1", state: "started" };
    many[`circulations/c1/reviews/r${i}`] = { overall: `note ${i}`, updatedByUid: "sender1" };
  }
  const db = seedWorld(many);
  const storage = seedFiles();

  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = storage;
  globalThis.__fakeUser = ADMIN;

  const first = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, false, "the budget ran out, and it says so");
  assert.ok(db.docs.has("circulations/c1"), "the circulation survives an incomplete pass");
  assert.ok(
    pathsUnder(db, "circulations/c1/responses").length > 0,
    "with work still to do under it",
  );

  const auditAfterFirst = auditRow(db);
  assert.equal(auditAfterFirst.data.completedAt, null, "and its row reads as interrupted");
  assert.equal(
    auditAfterFirst.data.passInFlightUntil,
    null,
    "the claim is handed back between passes, or the resume would refuse itself",
  );

  // The manifest now reports the interrupted destroy, which is what puts the
  // resume banner in front of whoever opens the page next.
  const manifest = await destroyManifest(manifestRequest("c1"), circulationContext("c1"));
  assert.equal(manifest.body.interrupted.auditId, first.body.auditId);
  assert.ok(manifest.body.interrupted.deleted.reviews > 0);

  // And the cheap read answers the same question with no counts at all, which
  // is what makes it affordable on every visit to the page. A missing counter
  // has to be ABSENT rather than zero: the client reads an absent one as "not
  // read" and a zero as "there are none".
  const probe = await destroyManifest(
    manifestRequest("c1", "?probe=interrupted"),
    circulationContext("c1"),
  );
  assert.equal(probe.body.interrupted.auditId, first.body.auditId);
  assert.equal("counts" in probe.body, false);
  assert.equal("blockers" in probe.body, false);
  assert.equal(probe.body.target.label, "Term plan");

  // The IDENTICAL call resumes. Two more passes at most for this world.
  let last = first;
  for (let i = 0; i < 5 && !last.body.complete; i += 1) {
    last = await destroyCirculation(
      jsonRequest({ confirmName: "Term plan" }),
      circulationContext("c1"),
    );
  }
  assert.equal(last.body.complete, true);
  assert.equal(last.body.auditId, first.body.auditId, "one destroy, one audit row");
  assert.equal(db.docs.has("circulations/c1"), false);
  assert.deepEqual(pathsUnder(db, "circulations/c1"), []);

  const row = auditRow(db);
  assert.equal(row.data.deleted.responses, 262);
  assert.equal(row.data.deleted.reviews, 261);
  assert.equal(row.data.deleted.circulation, 1);
  assert.ok(row.data.completedAt);
  // The totals the last pass reported are the row's, not that pass's own page.
  assert.deepEqual(last.body.deleted, row.data.deleted);
});

test("a second pass arriving while one is running is refused rather than double counting", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();
  globalThis.__fakeUser = ADMIN;

  // Stand a live claim up the way an in-flight pass would: the marker names
  // the row, and the row is claimed for the lease window.
  const auditModule = await loadTs(join("lib", "firestore", "destroyAudit.ts"));
  const auditId = await auditModule.openDestroyAudit(db, {
    kind: "circulation",
    targetId: "c1",
    label: "Term plan",
    actorUid: "admin1",
    actorName: "Ada Admin",
  });
  await db.collection("circulations").doc("c1").update({ destroying: true, destroyAuditId: auditId });
  await auditModule.claimDestroyAuditPass(db, auditId, { first: true });

  const refused = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already running/);
  assert.ok(db.docs.has("circulations/c1/responses/recip1"), "and it deleted nothing");

  // Once the claim is handed back, the same call resumes.
  await auditModule.releaseDestroyAuditPass(db, auditId);
  const resumed = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.complete, true);
  assert.equal(resumed.body.auditId, auditId, "the resume accumulates into the row that exists");
});

// ---------------------------------------------------------------------------
// 5. Deleting the library worksheet
// ---------------------------------------------------------------------------

test("a worksheet cannot be deleted while a circulation of it is open, and can once it is closed", async () => {
  const db = seedWorld();
  const storage = seedFiles();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = storage;
  globalThis.__fakeUser = SENDER;

  const refused = await deleteWorksheet(null, worksheetContext("ws1"));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 circulation of this worksheet is still open/);
  assert.ok(db.docs.has("worksheets/ws1"), "and the worksheet is still there");
  assert.ok(storage.files.has("worksheet-images/ws1/library.png"));

  // Closing it is what clears the blocker: a closed circulation is its own
  // document with its own copy of the questions, so it does not need the
  // library worksheet to survive.
  await db.collection("circulations").doc("c1").update({ status: "closed" });

  const done = await deleteWorksheet(null, worksheetContext("ws1"));
  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true);
  assert.equal(db.docs.has("worksheets/ws1"), false);

  // THE IMAGES STAY, and this is the assertion the whole rule hangs on. A
  // circulation copies the items verbatim, so its `imageUrl` points into
  // `worksheet-images/ws1/` unless somebody re-uploaded that picture on the
  // circulation's own copy. Sweeping the folder here would blank the pictures
  // inside a closed, archived record of what people were asked, which is the
  // one thing a library delete must not reach.
  assert.equal(done.body.imagesDeleted, 0);
  assert.equal(done.body.imagesKept, 1);
  assert.equal(done.body.circulations, 1);
  assert.ok(
    storage.files.has("worksheet-images/ws1/library.png"),
    "the worksheet's images survive while a circulation of it exists",
  );
  assert.deepEqual(storage.deletedPrefixes, [], "and nothing was swept at all");

  // The closed circulation and everything under it are untouched.
  assert.ok(db.docs.has("circulations/c1"));
  assert.ok(db.docs.has("circulations/c1/responses/recip1"));
  assert.ok(storage.files.has("worksheet-images/c1/question.png"));
});

test("a worksheet nobody ever circulated takes its question images with it", async () => {
  // The other half of the rule above: with no circulation to point at them,
  // nothing keeps the folder and leaving it would be litter forever.
  const db = makeDb({
    "worksheets/ws9": {
      title: "Never sent",
      description: "Drafted and abandoned.",
      authorUid: "sender1",
      private: false,
      items: ITEMS,
    },
  });
  const storage = makeStorage([
    "worksheet-images/ws9/one.png",
    "worksheet-images/ws9/two.png",
    // A different worksheet's folder, which must not be touched by a prefix
    // that only differs by what follows the id.
    "worksheet-images/ws90/other.png",
  ]);
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = storage;
  globalThis.__fakeUser = SENDER;

  const done = await deleteWorksheet(null, worksheetContext("ws9"));
  assert.equal(done.status, 200);
  assert.equal(done.body.imagesDeleted, 2);
  assert.equal(done.body.imagesKept, 0);
  assert.equal(done.body.circulations, 0);
  assert.deepEqual(storage.deletedPrefixes, ["worksheet-images/ws9/"]);
  assert.equal(storage.files.has("worksheet-images/ws9/one.png"), false);
  assert.ok(storage.files.has("worksheet-images/ws90/other.png"));
  assert.equal(db.docs.has("worksheets/ws9"), false);
});

test("only the author or an admin may delete a worksheet", async () => {
  const db = seedWorld();
  await db.collection("circulations").doc("c1").update({ status: "closed" });
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();

  globalThis.__fakeUser = OUTSIDER;
  const refused = await deleteWorksheet(null, worksheetContext("ws1"));
  assert.equal(refused.status, 403);
  assert.ok(db.docs.has("worksheets/ws1"));

  globalThis.__fakeUser = null;
  assert.equal((await deleteWorksheet(null, worksheetContext("ws1"))).status, 401);

  // An admin who did not write it may, which is what the withdrawn client rule
  // allowed and therefore what this route has to keep allowing.
  globalThis.__fakeUser = ADMIN;
  const done = await deleteWorksheet(null, worksheetContext("ws1"));
  assert.equal(done.status, 200);
  assert.equal(db.docs.has("worksheets/ws1"), false);
});

test("a worksheet that is not there is a 404, and the view-as guard runs first", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = seedFiles();
  globalThis.__fakeUser = ADMIN;

  assert.equal((await deleteWorksheet(null, worksheetContext("nope"))).status, 404);

  // The guard is the first thing every mutating handler in this tree does, and
  // it answers before the session is even read.
  globalThis.__blocked = { status: 403, body: { error: "viewing as another member" } };
  globalThis.__fakeUser = null;
  const blocked = await deleteWorksheet(null, worksheetContext("ws1"));
  assert.equal(blocked.status, 403);
  const blockedDestroy = await destroyCirculation(
    jsonRequest({ confirmName: "Term plan" }),
    circulationContext("c1"),
  );
  assert.equal(blockedDestroy.status, 403);
  globalThis.__blocked = null;

  assert.ok(db.docs.has("worksheets/ws1"));
  assert.equal(db.ops.length, 0);
});

// ---------------------------------------------------------------------------
// 6. When the file store will not answer
// ---------------------------------------------------------------------------

test("a bucket that will not list is reported as a refusal, never as zero images", async () => {
  const db = seedWorld();
  const storage = makeBrokenStorage();
  globalThis.__fakeDb = db;
  globalThis.__fakeStorage = storage;
  globalThis.__fakeUser = ADMIN;

  // The listing failure IS logged, and the log line carries a transpiled
  // module's stack, which is megabytes of base64 in this loader. Captured
  // rather than printed: it makes the suite's output readable, and it lets the
  // test assert the failure was recorded rather than swallowed, which is the
  // other half of not reporting it as a zero.
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(String(args[0]));

  let manifest;
  let res;
  try {
    manifest = await destroyManifest(manifestRequest("c1"), circulationContext("c1"));
    res = await destroyCirculation(
      jsonRequest({ confirmName: "Term plan" }),
      circulationContext("c1"),
    );
  } finally {
    console.error = realError;
  }
  assert.ok(
    logged.some((line) => line.includes("could not list")),
    "a listing failure has to reach the server log: it is the only trace of it",
  );

  assert.equal(manifest.status, 200, "the rest of the manifest is still worth reading");

  // THE POINT. `uploadedImages: 0` and "nobody counted the uploads" render as
  // the same row on the last screen before an irreversible action, so the key
  // is absent instead and the sentence below says why.
  assert.equal("uploadedImages" in manifest.body.counts, false);
  assert.equal("questionImages" in manifest.body.counts, false);
  assert.equal(manifest.body.counts.responses, 2, "the counts that answered are still there");
  assert.equal(manifest.body.counts.tasks, 2);
  assert.equal(manifest.body.blockers.length, 1);
  assert.match(manifest.body.blockers[0], /Storage could not be read/);
  assert.match(manifest.body.blockers[0], /answer images recipients uploaded/);

  // And the refusal is not decoration on a screen: the destroy above, made the
  // way a caller who never read the manifest would make it, is refused by the
  // engine before anything is written.
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Storage could not be read/);
  assert.ok(db.docs.has("circulations/c1/responses/recip1"), "nothing was deleted");
  assert.equal(auditRow(db), null, "and no audit row was opened for a destroy that never began");
  assert.equal(db.docs.get("circulations/c1").destroying, undefined);
  assert.equal(db.docs.get("circulations/c1").status, "open");
});

// ---------------------------------------------------------------------------
// 7. The panel that drives all of this
// ---------------------------------------------------------------------------

const CIRCULATION_PAGE = readFileSync(
  join(SRC, "features", "worksheets", "circulation", "CirculationPage.tsx"),
  "utf8",
);

test("GUARD: the mid-destroy circulation page keeps the destroy panel mounted for an admin", () => {
  // The danger zone at the foot of the circulation page is the ONLY place a
  // circulation destroy can be run from, and the engine's opening write lands
  // `destroying: true` on the document the page is listening to before the
  // first delete. So a "being removed" state that returns early for everybody
  // unmounts the panel mid-cascade: a pass that ran out of budget then has
  // nothing offering to resume it, and the circulation stays half destroyed
  // for good. The early return must let an admin through.
  assert.match(
    CIRCULATION_PAGE,
    /if \(circulation\.destroying && !isAdmin\)/,
    "the mid-destroy early return no longer lets an admin past it",
  );

  // ONE mount, reached from both branches, so flipping between them does not
  // remount the panel and throw away the pass in flight.
  assert.equal(
    (CIRCULATION_PAGE.match(/<DestroyPanel/g) ?? []).length,
    1,
    "two DestroyPanel mounts means the progress view dies when the page swaps branch",
  );
  assert.equal((CIRCULATION_PAGE.match(/\{dangerZone\}/g) ?? []).length, 2);
});

test("GUARD: the page can still show the panel after the document it listens to is gone", () => {
  // The receipt (the totals, the audit id, the Done button that navigates) is
  // rendered by the panel, and the last thing the cascade does is delete the
  // document this page's listener is attached to. Without a hold, the snapshot
  // goes empty at the moment of success and the admin is shown "that
  // circulation isn't here" instead of what their destroy removed.
  assert.match(CIRCULATION_PAGE, /function useCirculationThroughDestroy/);
  assert.match(CIRCULATION_PAGE, /return live \?\? \(kept\?\.destroying \? kept : null\);/);
  // The hold is only reachable for a document already flagged by the engine, so
  // an ordinary deletion or a refused read still empties the page at once.
  assert.match(CIRCULATION_PAGE, /if \(live\?\.destroying && live !== kept\) setKept\(live\);/);
});

test("GUARD: the recipient is told a destroy is running before being told the worksheet is missing", () => {
  // A recipient's read of the circulation is proved by an `exists()` on their
  // own response row, so the moment the cascade deletes that row their read is
  // refused. If the missing-document state were tested first, somebody who was
  // a recipient thirty seconds ago would be told the worksheet was never theirs
  // while an admin was in the middle of deleting their answers.
  const page = readFileSync(
    join(SRC, "features", "worksheets", "respond", "RespondPage.tsx"),
    "utf8",
  );
  const destroying = page.indexOf("if (circulation?.destroying) {");
  const missing = page.indexOf("if (!circulation || !response ||");
  assert.ok(destroying > 0, "the respond page no longer has a mid-destroy state");
  assert.ok(missing > 0, "the respond page no longer has a missing-document state");
  assert.ok(
    destroying < missing,
    "the missing-document state now runs first, so the mid-destroy sentence is unreachable",
  );
});

// ---------------------------------------------------------------------------
// 8. The count vocabulary the dialog renders
// ---------------------------------------------------------------------------

const { countMeta } = await loadTs(join("features", "courses", "useDestroy.ts"));
const HOOK = readFileSync(join(SRC, "features", "courses", "useDestroy.ts"), "utf8");
const PANEL = readFileSync(join(SRC, "features", "destroy", "DestroyPanel.tsx"), "utf8");
const ROUND_ENGINE = readFileSync(join(SRC, "lib", "admissions", "destroy.ts"), "utf8");
const CIRCULATION_ENGINE = readFileSync(join(SRC, "lib", "worksheets", "destroy.ts"), "utf8");

/** The keys of one `export type X = { … }` literal, in source order. */
function countKeys(source, typeName) {
  const match = new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(match, `${typeName} is no longer a type literal, so this guard cannot read it`);
  return [...match[1].matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
}

/** The keys of one `const NAME … = { … }` object literal. */
function objectKeys(source, name) {
  const match = new RegExp(`const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(match, `${name} is no longer an object literal, so this guard cannot read it`);
  return [...match[1].matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
}

/**
 * The counters these two manifests report whose rows DO NOT die, and why each
 * survives. Checked in BOTH directions: a survivor the dialog would call
 * destroyed is the bug this list exists for, and a name here that no manifest
 * emits any more is the same drift arriving from the other side.
 */
const SURVIVORS = {
  emailSendRows: "the append-only delivery log outlives whatever a message was about",
  dataExportRows: "the append-only download log outlives whatever a spreadsheet described",
  memberRecordEntriesWritten:
    "WRITTEN by the round destroy rather than removed by it: the owner's rule is that a destroy never deletes what the committee wants to remember about a person",
};

test("GUARD: every counter the two new manifests report has copy, and no survivor is called destroyed", () => {
  const metaKeys = new Set(objectKeys(HOOK, "COUNT_META"));
  const extraKeys = new Set(objectKeys(PANEL, "EXTRA_COUNT_COPY"));
  const keys = [
    ...countKeys(CIRCULATION_ENGINE, "CirculationDestroyCounts"),
    ...countKeys(ROUND_ENGINE, "RoundDestroyCounts"),
  ];
  assert.ok(keys.length >= 15, "one of the two count types stopped being read");

  for (const key of keys) {
    // Copy from one of the two maps. A key in neither renders as a humanised
    // guess ("Applicationprivaterows") under a fate nobody chose.
    assert.ok(
      metaKeys.has(key) || extraKeys.has(key),
      `${key} has no copy in COUNT_META or EXTRA_COUNT_COPY, so the dialog is guessing`,
    );
    assert.ok(countMeta(key).label.length > 0, `${key} has no label`);
    assert.ok(
      ["destroyed", "retained", "orphaned"].includes(countMeta(key).fate),
      `${key} has no fate`,
    );

    if (key in SURVIVORS) {
      // The fate lives in COUNT_META and nowhere else: the panel's overlay is
      // wording only, so a survivor with no entry there is reported as a death
      // whatever the note beside it says.
      assert.ok(
        metaKeys.has(key),
        `${key} survives (${SURVIVORS[key]}) but has no COUNT_META entry, so it takes the destroyed fallback`,
      );
      assert.notEqual(
        countMeta(key).fate,
        "destroyed",
        `${key} is reported as destroyed, but ${SURVIVORS[key]}`,
      );
    } else {
      assert.equal(
        countMeta(key).fate,
        "destroyed",
        `${key} is reported as surviving; if that is right it belongs in SURVIVORS with its reason`,
      );
    }
  }

  for (const key of Object.keys(SURVIVORS)) {
    assert.ok(keys.includes(key), `SURVIVORS names ${key}, which no manifest reports any more`);
  }
});

test("GUARD: the overlay in the panel cannot change a fate", () => {
  // Stated as a property of the code rather than of the copy: the moment the
  // overlay can carry a fate, two files decide the same thing and the one that
  // renders is the one nobody thinks of when a route changes.
  const overlay = /function describeRows\(rows: CountRow\[\]\): CountRow\[\] \{([\s\S]*?)\n\}/.exec(
    PANEL,
  );
  assert.ok(overlay, "describeRows is no longer where this guard can read it");
  assert.equal(/fate/.test(overlay[1]), false, "describeRows now touches a fate");
});
