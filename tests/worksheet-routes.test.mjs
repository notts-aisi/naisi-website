/**
 * The worksheet circulation routes, EXECUTED, against a fake Firestore and a
 * fake bucket.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## Why these routes get a harness rather than a source pin
 *
 * They are the only writers of `circulations`, of a response document and of a
 * worksheet task: `firestore.rules` closes `create` on all three. So what they
 * have to get right is invisible in any one call. Sending a worksheet writes
 * one circulation, one task and one response PER RECIPIENT and then emails
 * them; submitting moves a response, a counter and a card on somebody's board
 * in one transaction; and the two eligibility gates (who may be sent a
 * worksheet, who may be named a reviewer) decide who ends up able to read
 * everybody else's answers. Each of those is a before-and-after over several
 * documents, so the requests are made and the store is read afterwards.
 *
 * The task payload in particular is asserted WHOLE, field for field, rather
 * than sampled. A worksheet task is machine-minted and no human ever fills one
 * in, so a field quietly renamed, dropped or defaulted would show up as a card
 * that renders wrong on somebody's board weeks later, and nowhere else.
 *
 * ## What is faked, and what is real
 *
 * The handlers, the item and answer model, the circulation normalisers, the
 * mint, the notifier's dispatch logic, the four email templates and
 * `sniffImageType` are the REAL modules. Faked: `next/server`,
 * `firebase-admin/firestore` (sentinels this store interprets), the Admin SDK
 * handles, the session, the impersonation guard, the SMTP transport, the push
 * mirror and the roster resolver. Nothing here can reach a Firestore project, a
 * bucket or an inbox.
 *
 * The loader is the shared one, `tests/lib/tsLoader.mjs`, which compiles JSX.
 * That is why the templates above are real: they used to be stubbed for no
 * better reason than that a hand-copied loader could not read a `.tsx`, and the
 * stub took the messages this file sends out of anybody's reach. Each one is
 * now asserted as the HTML the recipient is handed.
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
  // nodemailer plus the deliverability log. Recorded rather than thrown so the
  // tests can read what each recipient was actually sent.
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
  // The real one is a `getAll` over `users`; the fake reads the same store so
  // a recipient with no address is still resolved the same way (not at all).
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
 * way a plain map is walked would silently replace every `addedAt` and
 * `dueDate` with `{}` and pass tests the real thing would fail.
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
          // A real batch fails WHOLE on a create collision, so every op is
          // checked before any of them lands.
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

/** A bucket that remembers what it was handed and never leaves the process. */
function makeStorage() {
  const saved = [];
  return {
    saved,
    bucket() {
      return {
        name: "naisi-test.firebasestorage.app",
        file(path) {
          return {
            async save(buffer, options) {
              saved.push({ path, bytes: buffer.length, options });
            },
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The routes and the world they run in
// ---------------------------------------------------------------------------

const API = join("app", "api", "worksheets");
const { POST: circulate } = await loadTs(join(API, "circulations", "route.ts"));
const { POST: addRecipients } = await loadTs(
  join(API, "circulations", "[circulationId]", "recipients", "route.ts"),
);
const { POST: submit } = await loadTs(
  join(API, "circulations", "[circulationId]", "submit", "route.ts"),
);
const { POST: upload } = await loadTs(
  join(API, "circulations", "[circulationId]", "upload", "route.ts"),
);
const { GET: recipients } = await loadTs(join(API, "recipients", "route.ts"));
const { sniffImageType } = await loadTs(join("lib", "worksheets", "imageMagic.ts"));

const ITEMS = [
  { kind: "question", id: "q1", type: "shortText", title: "Your name", body: [], required: true },
  { kind: "question", id: "q2", type: "longText", title: "Why", body: [], required: false },
  {
    kind: "question",
    id: "q3",
    type: "imageUpload",
    title: "A photo",
    body: [],
    required: false,
    upload: { maxImages: 2 },
  },
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
      role: "admin",
      email: "recip2@example.com",
      displayName: "Bo Two",
    },
    "users/member1": {
      uid: "member1",
      role: "member",
      email: "member1@example.com",
      displayName: "Mo Member",
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

const SENDER = {
  uid: "sender1",
  role: "committee",
  displayName: "Sam Sender",
  suRecognised: false,
  permissions: { circulateWorksheet: true },
};

/** Run `fn` with `console.error` muted. See its one caller for why. */
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function jsonRequest(body) {
  return { json: async () => body };
}

function context(circulationId) {
  return { params: Promise.resolve({ circulationId }) };
}

function pathsUnder(db, prefix) {
  return [...db.docs.keys()].filter((path) => path.startsWith(prefix)).sort();
}

/** Send `ws1` to `recipientUids` as `SENDER`, and hand back the id it got. */
async function sendWorksheet(db, body = {}) {
  globalThis.__fakeDb = db;
  const res = await circulate(
    jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"], ...body }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test.beforeEach(() => {
  globalThis.__fakeUser = { ...SENDER };
  globalThis.__blocked = null;
  globalThis.__fakeStorage = makeStorage();
  globalThis.__sent = [];
  globalThis.__pushed = [];
  globalThis.__taskEmails = true;
  globalThis.__sendThrows = false;
});

// ---------------------------------------------------------------------------
// sniffImageType, on its own
// ---------------------------------------------------------------------------

test("sniffImageType reads the format out of the bytes, and refuses anything else", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const gif87 = new Uint8Array([...Buffer.from("GIF87a"), 1, 2]);
  const gif89 = new Uint8Array([...Buffer.from("GIF89a"), 1, 2]);
  const webp = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(jpeg), "image/jpeg");
  assert.equal(sniffImageType(gif87), "image/gif");
  assert.equal(sniffImageType(gif89), "image/gif");
  assert.equal(sniffImageType(webp), "image/webp");

  const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.equal(sniffImageType(svg), null, "an SVG is a document, not an image this accepts");
  // RIFF is also WAV and AVI, so the second half of the header is what makes
  // it a WebP. Matching "RIFF" alone would store an audio file as an image.
  const wav = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]);
  assert.equal(sniffImageType(wav), null);
  assert.equal(sniffImageType(new Uint8Array([])), null);
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50])), null, "a truncated header is not a match");
});

// ---------------------------------------------------------------------------
// Circulating
// ---------------------------------------------------------------------------

test("a committee member without circulateWorksheet cannot send anything", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...SENDER, permissions: {} };

  const res = await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"] }));
  assert.equal(res.status, 403);
  assert.deepEqual(pathsUnder(db, "circulations"), [], "a refusal writes nothing");
  assert.deepEqual(pathsUnder(db, "tasks"), []);
  assert.equal(globalThis.__sent.length, 0);
});

test("an admin needs no explicit key, because admins hold every key", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "recip2", role: "admin", displayName: "Bo Two", permissions: {} };

  const res = await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"] }));
  assert.equal(res.status, 201);
});

test("the view-as guard refuses before anything is read or written", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__blocked = { status: 403, body: { error: "blocked" } };

  const res = await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"] }));
  assert.equal(res.status, 403);
  assert.deepEqual(pathsUnder(db, "circulations"), []);
});

test("sending writes the circulation, one task and one response, with the exact task shape", async () => {
  const db = seedWorld();
  const { circulationId, added, skipped } = await sendWorksheet(db);
  assert.equal(added, 1);
  assert.deepEqual(skipped, []);

  const circulation = db.docs.get(`circulations/${circulationId}`);
  assert.equal(circulation.worksheetId, "ws1");
  assert.equal(circulation.title, "Term plan");
  assert.equal(circulation.status, "open");
  assert.equal(circulation.anonymity, "named");
  assert.deepEqual(circulation.source, { kind: "worksheet" });
  assert.equal(circulation.recipientCount, 1, "the counter moves with the mint");
  assert.equal(circulation.submittedCount, 0);
  assert.deepEqual(circulation.items, ITEMS, "the questions are COPIED, not pointed at");

  const taskPaths = pathsUnder(db, "tasks/");
  assert.equal(taskPaths.length, 1);
  const task = db.docs.get(taskPaths[0]);
  // Asserted WHOLE: nobody hand-edits a worksheet task, so a field that
  // quietly changes shape is only ever noticed here.
  assert.deepEqual(task, {
    title: "Term plan",
    description: "",
    source: "worksheet",
    kind: "worksheet",
    projectId: null,
    creatorUid: "sender1",
    completerUids: ["recip1"],
    reviewerUids: ["sender1"],
    status: "todo",
    priority: "normal",
    dueDate: null,
    archived: false,
    visibility: "assignees-only",
    subtasks: [],
    blocks: [],
    blockConsents: {},
    subtaskStats: { done: 0, total: 0 },
    attachmentCount: 0,
    commentCount: 0,
    tags: [],
    sourceRef: null,
    sourceTemplateId: null,
    artefact: { kind: "worksheet-response", circulationId },
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null,
    // Born already notified: the task system's own membership mail must never
    // fire about a worksheet, because the circulation owns that message.
    initialNotifyAt: STAMP,
    pendingNotifyUids: [],
  });

  const response = db.docs.get(`circulations/${circulationId}/responses/recip1`);
  assert.equal(response.uid, "recip1");
  assert.equal(response.state, "not-opened");
  assert.equal(response.taskId, taskPaths[0].split("/").pop());
  assert.deepEqual(response.answers, {});
  assert.deepEqual(response.progress, {
    answered: 0,
    total: 3,
    requiredAnswered: 0,
    required: 1,
  });
  assert.deepEqual(response.activity, {
    firstOpenedAt: null,
    pageOpens: 0,
    activeMs: 0,
    lastActiveAt: null,
  });
  assert.equal(response.addedByUid, "sender1");
  assert.ok(response.addedAt instanceof Date);
  assert.equal(response.returned, null);

  assert.ok(
    db.docs.get("worksheets/ws1").lastCirculatedAt instanceof Date,
    "the library card records that this worksheet has been sent",
  );
});

test("the sender is always a reviewer and always staff", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db, { reviewerUids: ["recip2"] });

  const circulation = db.docs.get(`circulations/${circulationId}`);
  assert.deepEqual(circulation.reviewerUids, ["sender1", "recip2"]);
  assert.deepEqual(
    circulation.staffUids,
    ["sender1", "author1", "recip2"],
    "sender, then the worksheet's author, then the named reviewers",
  );
  assert.equal(circulation.senderUid, "sender1");
  assert.equal(circulation.authorUid, "author1");
});

test("a recipient who is not committee or admin is skipped by name", async () => {
  const db = seedWorld();
  const res = await (async () => {
    globalThis.__fakeDb = db;
    return circulate(
      jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1", "member1", "ghost"] }),
    );
  })();

  assert.equal(res.status, 201);
  assert.equal(res.body.added, 1);
  assert.deepEqual(
    res.body.skipped.sort(),
    ["ghost", "member1"],
    "a plain member and a uid nobody owns are both reported, not silently dropped",
  );
  const { circulationId } = res.body;
  assert.deepEqual(pathsUnder(db, `circulations/${circulationId}/responses/`), [
    `circulations/${circulationId}/responses/recip1`,
  ]);
  assert.equal(pathsUnder(db, "tasks/").length, 1);
});

test("naming a plain member as a REVIEWER is refused, because reviewers read everybody", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  const res = await circulate(
    jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"], reviewerUids: ["member1"] }),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /committee members or admins/);
  assert.deepEqual(pathsUnder(db, "circulations"), []);
});

test("an empty recipient list and an over-cap one are both refused", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  assert.equal(
    (await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: [] }))).status,
    400,
  );
  const tooMany = Array.from({ length: 101 }, (_, i) => `u${i}`);
  const res = await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: tooMany }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /100 people at a time/);
});

test("a private worksheet somebody else wrote is 404, not 403", async () => {
  const db = seedWorld();
  db.docs.get("worksheets/ws1").private = true;
  globalThis.__fakeDb = db;

  const res = await circulate(jsonRequest({ worksheetId: "ws1", recipientUids: ["recip1"] }));
  assert.equal(
    res.status,
    404,
    "a private worksheet must not be distinguishable from one that is not there",
  );
  assert.equal(res.body.error, "Worksheet not found");
});

test("an unknown notification event is refused rather than quietly ignored", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  const res = await circulate(
    jsonRequest({
      worksheetId: "ws1",
      recipientUids: ["recip1"],
      notifications: { assigend: { email: false, push: false } },
    }),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /"assigend" is not a notification/);
});

// ---------------------------------------------------------------------------
// The "assigned" message
// ---------------------------------------------------------------------------

test("everyone added gets one email and one push, pointed at the respond page", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db, { recipientUids: ["recip1", "recip2"] });

  assert.equal(globalThis.__sent.length, 2);
  const first = globalThis.__sent[0];
  assert.equal(first.to, "recip1@example.com");
  assert.equal(first.subject, 'You\'ve been added to "Term plan"');
  assert.equal(first.kind, "task");
  assert.equal(first.fromName, "NAISI Worksheets");
  assert.equal(first.referenceId, circulationId);
  // The message itself, rendered the way the transport renders it. Asserting on
  // the HTML rather than on the props is what the real templates buy: a link
  // built correctly and then dropped from the layout is a message nobody can
  // act on, and a props assertion cannot see that.
  const firstHtml = await render(first.react);
  assert.match(firstHtml, /Hi Rae One,/);
  assert.match(firstHtml, /Open task/, "the button that opens their own copy");
  // The closing quote is the anchor. Reading the link out of the HTML rather
  // than off the props costs the `$` that used to end this pattern, and without
  // something in its place a link that grew a suffix (a second id, a stray
  // query) would still match somewhere inside itself. The quote is where the
  // href ends.
  assert.match(firstHtml, new RegExp(`/worksheets/respond/${circulationId}"`));

  assert.equal(globalThis.__pushed.length, 2);
  assert.equal(globalThis.__pushed[0].uid, "recip1");
  assert.equal(globalThis.__pushed[0].url, `/worksheets/respond/${circulationId}`);
  assert.ok(
    globalThis.__pushed[0].taskId,
    "the push carries the recipient's own task id, not a guess",
  );
});

test("the per-circulation switch and the site-wide kill switch each silence the send", async () => {
  const off = seedWorld();
  await sendWorksheet(off, {
    notifications: { assigned: { email: false, push: false } },
  });
  assert.equal(globalThis.__sent.length, 0, "the sender turned this message off");
  assert.equal(globalThis.__pushed.length, 0);

  globalThis.__sent = [];
  globalThis.__taskEmails = false;
  const killed = seedWorld();
  const { circulationId } = await sendWorksheet(killed);
  assert.equal(globalThis.__sent.length, 0, "the task-email kill switch covers worksheets");
  assert.ok(
    killed.docs.get(`circulations/${circulationId}/responses/recip1`),
    "the work still exists; only the message was suppressed",
  );
});

test("a transport failure is counted, not thrown: the circulation still lands", async () => {
  const db = seedWorld();
  globalThis.__sendThrows = true;
  // Muted: this path logs the thrown error, and every frame of its stack is a
  // `data:` URL carrying a whole transpiled module, so one deliberate failure
  // prints most of a megabyte into the suite's output.
  const { circulationId, added } = await quietly(() => sendWorksheet(db));
  assert.equal(added, 1);
  assert.ok(db.docs.get(`circulations/${circulationId}/responses/recip1`));
});

// ---------------------------------------------------------------------------
// Adding recipients
// ---------------------------------------------------------------------------

test("adding recipients skips the people already on the list", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  globalThis.__sent = [];

  const res = await addRecipients(
    jsonRequest({ recipientUids: ["recip1", "recip2"] }),
    context(circulationId),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.added, 1);
  assert.deepEqual(res.body.skipped, ["recip1"]);

  assert.equal(
    db.docs.get(`circulations/${circulationId}`).recipientCount,
    2,
    "the counter moves by what was actually added",
  );
  assert.equal(pathsUnder(db, "tasks/").length, 2);
  assert.equal(globalThis.__sent.length, 1, "only the new person hears about it");
  assert.equal(globalThis.__sent[0].to, "recip2@example.com");
});

test("a reviewer without the circulation permission cannot add people", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db, { reviewerUids: ["recip2"] });
  // recip2 is staff (a named reviewer) and an admin, so drop them to a
  // committee member with no key: staff alone must not be enough.
  globalThis.__fakeUser = {
    uid: "recip2",
    role: "committee",
    displayName: "Bo Two",
    permissions: {},
  };

  const res = await addRecipients(
    jsonRequest({ recipientUids: ["member1"] }),
    context(circulationId),
  );
  assert.equal(res.status, 403);
});

test("a closed circulation takes no more recipients", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  db.docs.get(`circulations/${circulationId}`).status = "closed";

  const res = await addRecipients(
    jsonRequest({ recipientUids: ["recip2"] }),
    context(circulationId),
  );
  assert.equal(res.status, 409);
  assert.equal(pathsUnder(db, "tasks/").length, 1);
});

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

/** Put an answer on a recipient's response, the way their autosave would. */
function answer(db, circulationId, uid, answers) {
  const path = `circulations/${circulationId}/responses/${uid}`;
  db.docs.set(path, { ...db.docs.get(path), answers, state: "started" });
}

function asRecipient(uid = "recip1") {
  globalThis.__fakeUser = {
    uid,
    role: "committee",
    displayName: "Rae One",
    permissions: {},
  };
}

test("somebody who was never sent the worksheet gets a 404, not a permission error", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  asRecipient("recip2");

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 404);
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 0);
});

test("a required question with no answer comes back as a named problem", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q2: { type: "text", text: "because" } });
  asRecipient();

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.problems, [
    { questionId: "q1", message: "This question needs an answer." },
  ]);
  assert.equal(
    db.docs.get(`circulations/${circulationId}/responses/recip1`).state,
    "started",
    "a refused submission changes nothing",
  );
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 0);
});

test("an already-submitted response is frozen against a second submit", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  asRecipient();
  assert.equal((await submit({}, context(circulationId))).status, 200);

  const again = await submit({}, context(circulationId));
  assert.equal(again.status, 409);
  assert.equal(
    db.docs.get(`circulations/${circulationId}`).submittedCount,
    1,
    "the counter must not move twice for one submission",
  );
});

test("a closed circulation refuses a submission", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  db.docs.get(`circulations/${circulationId}`).status = "closed";
  asRecipient();

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 409);
  assert.equal(
    db.docs.get(`circulations/${circulationId}/responses/recip1`).state,
    "started",
  );
});

test("submitting freezes the response, moves the counter and sends the task to Review", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db, { reviewerUids: ["recip2"] });
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  globalThis.__sent = [];
  globalThis.__pushed = [];
  asRecipient();

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 200);
  assert.equal(res.body.state, "submitted");
  assert.equal(res.body.taskStatus, "review");

  const response = db.docs.get(`circulations/${circulationId}/responses/recip1`);
  assert.equal(response.state, "submitted");
  assert.equal(response.submittedAt, STAMP);
  assert.deepEqual(
    response.progress,
    { answered: 1, total: 3, requiredAnswered: 1, required: 1 },
    "progress is re-derived by the route, never taken from the client",
  );
  assert.equal(db.docs.get(`circulations/${circulationId}`).submittedCount, 1);

  const task = db.docs.get(pathsUnder(db, "tasks/")[0]);
  assert.equal(task.status, "review");
  assert.equal(task.completedAt, null, "there is still work for staff to do");

  // The reviewers, and not the person who just submitted.
  assert.deepEqual(
    globalThis.__sent.map((mail) => mail.to).sort(),
    ["recip2@example.com", "sender@example.com"],
  );
  const mail = globalThis.__sent[0];
  const mailHtml = await render(mail.react);
  assert.match(mailHtml, /Rae One/, "a review request names who is asking");
  assert.match(mailHtml, /Term plan/);
  assert.match(mailHtml, /Open task to review/);
  assert.match(
    mailHtml,
    new RegExp(`/worksheets/ws1/circulations/${circulationId}"`),
    "a reviewer's message opens the circulation, where everybody's answers are",
  );
  assert.equal(
    globalThis.__pushed[0].url,
    `/worksheets/ws1/circulations/${circulationId}`,
    "a reviewer's push opens the circulation, not the board",
  );
});

test("with returnToRecipient off, submitting finishes the task outright", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db, {
    reviewConfig: {
      perQuestionFeedback: false,
      perQuestionScoring: false,
      overallFeedback: false,
      returnToRecipient: false,
    },
  });
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  asRecipient();

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 200);
  assert.equal(res.body.taskStatus, "done");

  const task = db.docs.get(pathsUnder(db, "tasks/")[0]);
  assert.equal(task.status, "done");
  assert.equal(task.completedAt, STAMP, "nothing is left to do, so the card is finished");
});

test("a submission survives its task having been deleted", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  // Admins can delete a worksheet task; the member's answers must not be
  // collateral damage when they do.
  db.docs.delete(pathsUnder(db, "tasks/")[0]);
  asRecipient();

  const res = await submit({}, context(circulationId));
  assert.equal(res.status, 200);
  assert.equal(
    db.docs.get(`circulations/${circulationId}/responses/recip1`).state,
    "submitted",
  );
});

// ---------------------------------------------------------------------------
// Uploading an image answer
// ---------------------------------------------------------------------------

function uploadRequest({ bytes, name, type, questionId = "q3" }) {
  const form = new FormData();
  form.append("questionId", questionId);
  form.append("file", new Blob([bytes], { type }), name);
  return { formData: async () => form };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

test("an image answer is stored under the recipient's own folder, typed from its bytes", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  asRecipient();

  const res = await upload(
    uploadRequest({ bytes: PNG_BYTES, name: "my photo.png", type: "image/png" }),
    context(circulationId),
  );
  assert.equal(res.status, 200);
  assert.match(
    res.body.storagePath,
    new RegExp(`^worksheet-uploads/${circulationId}/recip1/\\d+-my-photo\\.png$`),
  );
  assert.match(res.body.url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//);
  assert.match(res.body.url, /alt=media&token=/);

  const [saved] = globalThis.__fakeStorage.saved;
  assert.equal(saved.path, res.body.storagePath);
  assert.equal(saved.options.contentType, "image/png");
  assert.ok(saved.options.metadata.metadata.firebaseStorageDownloadTokens);

  assert.deepEqual(
    db.docs.get(`circulations/${circulationId}/responses/recip1`).answers,
    {},
    "the route writes the BYTES; the recipient's own autosave writes the answer",
  );
});

test("an SVG is refused by name and by bytes, and nothing reaches the bucket", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  asRecipient();

  const svg = new Uint8Array(Buffer.from("<svg></svg>"));
  const declared = await upload(
    uploadRequest({ bytes: svg, name: "logo.svg", type: "image/svg+xml" }),
    context(circulationId),
  );
  assert.equal(declared.status, 415);

  // The same file, lying about its type. The sniff is what actually decides.
  const disguised = await upload(
    uploadRequest({ bytes: svg, name: "logo.png", type: "image/png" }),
    context(circulationId),
  );
  assert.equal(disguised.status, 415);
  assert.equal(globalThis.__fakeStorage.saved.length, 0);
});

test("an upload against a question that takes no image is refused", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  asRecipient();

  const res = await upload(
    uploadRequest({ bytes: PNG_BYTES, name: "a.png", type: "image/png", questionId: "q1" }),
    context(circulationId),
  );
  assert.equal(res.status, 400);
  assert.equal(globalThis.__fakeStorage.saved.length, 0);
});

test("a submitted response takes no more images", async () => {
  const db = seedWorld();
  const { circulationId } = await sendWorksheet(db);
  answer(db, circulationId, "recip1", { q1: { type: "text", text: "Rae" } });
  asRecipient();
  await submit({}, context(circulationId));

  const res = await upload(
    uploadRequest({ bytes: PNG_BYTES, name: "a.png", type: "image/png" }),
    context(circulationId),
  );
  assert.equal(res.status, 409);
  assert.equal(globalThis.__fakeStorage.saved.length, 0);
});

// ---------------------------------------------------------------------------
// The picker's roster
// ---------------------------------------------------------------------------

test("the recipient roster needs the key, names nobody's email, and sorts by name", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  globalThis.__fakeUser = { ...SENDER, permissions: {} };
  assert.equal((await recipients()).status, 403);

  globalThis.__fakeUser = { ...SENDER };
  const res = await recipients();
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.members.map((m) => m.uid),
    ["author1", "recip2", "recip1", "sender1"].sort(
      (a, b) =>
        ({ author1: "Ada Author", recip1: "Rae One", recip2: "Bo Two", sender1: "Sam Sender" })[
          a
        ].localeCompare(
          { author1: "Ada Author", recip1: "Rae One", recip2: "Bo Two", sender1: "Sam Sender" }[b],
        ),
    ),
  );
  assert.ok(
    res.body.members.every((m) => !("email" in m)),
    "the picker is not a mailing list: there is nowhere here to put an address",
  );
  assert.ok(
    !res.body.members.some((m) => m.uid === "member1"),
    "a plain member is not offered, matching the v1 policy the routes enforce",
  );
});
