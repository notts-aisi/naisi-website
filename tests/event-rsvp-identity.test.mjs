/**
 * The public RSVP route keys identity correctly and tells a stranger nothing.
 *
 * WHY. Until 8 September 2026 `POST /api/events/[id]/rsvp` stored each RSVP
 * under `<eventId>_<sha256(email)>` and refused a duplicate with a 409 that
 * quoted the existing row's status. Three things followed, all reachable with
 * no account: anyone could ask "is this address attending, and in what state"
 * one address per request, over rows `firestore.rules` restricts to
 * SU-recognised committee; a stranger who typed a member's address first
 * occupied the member's one slot, so the member's own submission was refused;
 * and a fresh submission over a cancelled or denied row overwrote the
 * organiser's decision. The route now uses Firestore's own ids, keys a
 * signed-in submission on the ACCOUNT and a signed-out one on the ADDRESS,
 * answers every signed-out submission identically and tells the address
 * owner the truth by email, and files a new row after a decision rather than
 * resetting the old one. This guard executes each of those and walks the tree
 * for the class:
 *
 *  1. THE ROUTE, executed against a fake Firestore as a guest, as a member, as
 *     a pending and a rejected account.
 *  2. THE TREE: every document id under `src` built from an email address is
 *     registered with the reason it is keyed that way, both directions, and
 *     every route handler that hashes anything is registered with what it
 *     hashes. A new email-keyed id fails here until somebody writes down why
 *     the caller cannot turn it into a question.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "src/app/api/events/[id]/rsvp/route.ts";

// ---------------------------------------------------------------------------
// A fake Firestore: documents, auto ids, equality queries, and a transaction
// whose `get` takes a document or a query.
// ---------------------------------------------------------------------------

const NOW = Date.now();

function makeDb(store = {}) {
  const data = JSON.parse(JSON.stringify(store));
  let autoIds = 0;
  const snapOf = (collection, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(data[collection] ?? {}, id),
    data: () => (data[collection] ?? {})[id],
    ref: { __collection: collection, __id: id },
  });
  const runQuery = (q) => {
    const docs = Object.entries(data[q.__collection] ?? {})
      .filter(([, row]) =>
        q.__filters.every(([field, op, value]) => {
          if (op !== "==") throw new Error(`the fake Firestore does not implement "${op}"`);
          return row[field] === value;
        }),
      )
      .map(([id]) => snapOf(q.__collection, id));
    return { docs, empty: docs.length === 0, size: docs.length };
  };
  const resolve = (value) =>
    value && typeof value === "object" && value.__op === "serverTimestamp"
      ? { __op: "serverTimestamp", toMillis: () => NOW }
      : value;
  const write = (ref, patch, merge) => {
    data[ref.__collection] ??= {};
    const next = { ...(merge ? (data[ref.__collection][ref.__id] ?? {}) : {}) };
    for (const [key, value] of Object.entries(patch)) next[key] = resolve(value);
    data[ref.__collection][ref.__id] = next;
  };
  const docRef = (collection, id) => ({
    __collection: collection,
    __id: id,
    id,
    get: async () => snapOf(collection, id),
    set: async (patch) => write({ __collection: collection, __id: id }, patch, false),
    update: async (patch) => write({ __collection: collection, __id: id }, patch, true),
  });
  const collectionRef = (name, filters = []) => ({
    __collection: name,
    __filters: filters,
    doc: (id) => docRef(name, id ?? `auto-${(autoIds += 1)}`),
    where: (field, op, value) => collectionRef(name, [...filters, [field, op, value]]),
    get: async function () {
      return runQuery(this);
    },
  });
  return {
    data,
    collection: (name) => collectionRef(name),
    async runTransaction(fn) {
      return fn({
        get: async (ref) => (ref.__id !== undefined ? snapOf(ref.__collection, ref.__id) : runQuery(ref)),
        set: (ref, patch) => write(ref, patch, false),
        update: (ref, patch) => write(ref, patch, true),
      });
    },
  };
}

const { loadTs } = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    [
      "next/server",
      "export const NextResponse = { json(body, init) { return { status: (init && init.status) || 200, body }; } };",
    ],
    [
      "firebase-admin/firestore",
      "export const FieldValue = { serverTimestamp: () => ({ __op: 'serverTimestamp' }) };\n" +
        "export const Timestamp = { fromDate: (d) => ({ __ts: d }) };",
    ],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    // The wrapper, recorded. What it renders is tests/event-location-disclosure.test.mjs's subject.
    [
      "@/lib/events/sendRsvpEmail",
      "export const sendRsvpEmail = async (args) => { (globalThis.__rsvpMail ||= []).push(args); };",
    ],
  ]),
});

const route = await loadTs("app/api/events/[id]/rsvp/route.ts");

const ctx = (id = "event-1") => ({ params: Promise.resolve({ id }) });
const post = (body, id) => route.POST({ json: async () => body }, ctx(id));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const GUEST = { name: "Guest", email: "Target@Example.com", answers: {} };
const ADDRESS = "target@example.com";

function eventDoc(extra = {}) {
  return {
    title: "Reading group",
    status: "published",
    visibility: "public",
    location: "B52",
    locationHidden: false,
    signupForm: [],
    rsvpCountPending: 0,
    ...extra,
  };
}

function liveRow(status, extra = {}) {
  return {
    eventId: "event-1",
    status,
    email: ADDRESS,
    name: "Someone",
    uid: null,
    answers: {},
    decidedBy: "organiser-1",
    decisionNote: "seen",
    ...extra,
  };
}

const rows = () => globalThis.__db.data.eventRsvps ?? {};
const observable = (res) => ({ status: res.status, body: JSON.stringify(res.body) });

function user(role, extra = {}) {
  return {
    uid: `uid-${role}`,
    email: ADDRESS,
    displayName: "Member",
    role,
    suRecognised: false,
    permissions: {},
    ...extra,
  };
}

beforeEach(() => {
  globalThis.__rsvpMail = [];
  globalThis.__user = null;
});

// ===========================================================================
// 1. Signed out
// ===========================================================================

describe("a signed-out submission", () => {
  test("files a pending row under a Firestore id, not one derived from the address", async () => {
    globalThis.__db = makeDb({ events: { "event-1": eventDoc() } });
    const res = await post(GUEST);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, status: "pending" });
    const [id, row] = Object.entries(rows())[0];
    assert.notEqual(id, `event-1_${createHash("sha256").update(ADDRESS).digest("hex").slice(0, 16)}`);
    assert.equal(row.status, "pending");
    assert.equal(row.uid, null);
    assert.equal(row.email, ADDRESS, "the address is normalised");
    assert.equal(globalThis.__db.data.events["event-1"].rsvpCountPending, 1);
    await settle();
    assert.equal(globalThis.__rsvpMail.length, 1);
    assert.equal(globalThis.__rsvpMail[0].variant, "requested");
    assert.equal(globalThis.__rsvpMail[0].to, ADDRESS);
  });

  test("is answered identically whether or not the address already holds an RSVP, in any state", async () => {
    globalThis.__db = makeDb({ events: { "event-1": eventDoc() } });
    const fresh = observable(await post(GUEST));
    for (const status of ["pending", "confirmed", "waitlisted"]) {
      globalThis.__db = makeDb({ events: { "event-1": eventDoc() }, eventRsvps: { existing: liveRow(status) } });
      const before = JSON.parse(JSON.stringify(rows().existing));
      const again = observable(await post(GUEST));
      assert.deepEqual(again, fresh, `an existing ${status} RSVP is distinguishable from a fresh submission`);
      assert.equal(Object.keys(rows()).length, 1, `a duplicate over a ${status} row filed a second row`);
      const after = rows().existing;
      delete after.duplicateNoticeAt;
      assert.deepEqual(after, before, "the existing row was changed by a stranger's submission");
      assert.equal(globalThis.__db.data.events["event-1"].rsvpCountPending, 0, "the counter moved on a duplicate");
    }
  });

  test("tells the address, not the caller, that an RSVP is already on file, once an hour", async () => {
    globalThis.__db = makeDb({ events: { "event-1": eventDoc() }, eventRsvps: { existing: liveRow("waitlisted") } });
    await post(GUEST);
    await settle();
    assert.equal(globalThis.__rsvpMail.length, 1);
    const note = globalThis.__rsvpMail[0];
    assert.equal(note.variant, "existing");
    assert.equal(note.to, ADDRESS);
    assert.equal(note.existingStatus, "waitlisted");
    assert.equal(note.rsvpId, "existing");
    assert.ok(typeof rows().existing.duplicateNoticeAt?.toMillis === "function", "the notice was not stamped on the row");
    // The second duplicate inside the hour: same answer, no second note.
    const again = await post(GUEST);
    assert.deepEqual(again.body, { ok: true, status: "pending" });
    await settle();
    assert.equal(globalThis.__rsvpMail.length, 1, "a stranger can make the route mail an address repeatedly");
  });

  test("files a new row after a cancellation or a denial and leaves the decided row intact", async () => {
    for (const status of ["cancelled", "denied"]) {
      globalThis.__db = makeDb({ events: { "event-1": eventDoc() }, eventRsvps: { decided: liveRow(status) } });
      const before = JSON.parse(JSON.stringify(rows().decided));
      const res = await post(GUEST);
      assert.equal(res.status, 200);
      assert.equal(Object.keys(rows()).length, 2, `no new row after a ${status} one`);
      assert.deepEqual(rows().decided, before, `the ${status} row was reset by the resubmission`);
      const fresh = Object.entries(rows()).find(([id]) => id !== "decided")[1];
      assert.equal(fresh.status, "pending");
      assert.equal(fresh.decidedBy, null);
    }
  });

  test("two submissions by the same address do not share an id", async () => {
    globalThis.__db = makeDb({ events: { "event-1": eventDoc() } });
    await post(GUEST);
    const [first] = Object.keys(rows());
    globalThis.__db.data.eventRsvps[first].status = "cancelled";
    await post(GUEST);
    const ids = Object.keys(rows());
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

// ===========================================================================
// 2. Signed in
// ===========================================================================

describe("a signed-in submission", () => {
  test("is keyed on the account, so a stranger's row under the member's address blocks nothing", async () => {
    globalThis.__db = makeDb({ events: { "event-1": eventDoc() }, eventRsvps: { stranger: liveRow("pending") } });
    globalThis.__user = user("member");
    const res = await post({ name: "ignored", email: "ignored@example.com", answers: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Object.keys(rows()).length, 2, "the member's own submission was refused because of the stranger's row");
    const own = Object.values(rows()).find((r) => r.uid === "uid-member");
    assert.ok(own, "the member's row carries no uid");
    assert.equal(own.email, ADDRESS, "the session address wins over the body");
    assert.equal(rows().stranger.uid, null, "the stranger's row was attributed to the member");
  });

  test("is told about its own live RSVP, because that is its own row", async () => {
    globalThis.__db = makeDb({
      events: { "event-1": eventDoc() },
      eventRsvps: { own: liveRow("confirmed", { uid: "uid-member" }) },
    });
    globalThis.__user = user("member");
    const res = await post({ answers: {} });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /confirmed/);
    assert.equal(Object.keys(rows()).length, 1);
  });

  test("may submit again after its own cancellation", async () => {
    globalThis.__db = makeDb({
      events: { "event-1": eventDoc() },
      eventRsvps: { own: liveRow("cancelled", { uid: "uid-member" }) },
    });
    globalThis.__user = user("member");
    const res = await post({ answers: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Object.keys(rows()).length, 2);
  });
});

// ===========================================================================
// 3. A members-only event, as every persona
// ===========================================================================

describe("a members-only event", () => {
  const seed = () => makeDb({ events: { "event-1": eventDoc({ visibility: "members" }) } });

  test("asks a signed-out visitor to sign in", async () => {
    globalThis.__db = seed();
    const res = await post(GUEST);
    assert.equal(res.status, 401);
    assert.equal(Object.keys(rows()).length, 0);
  });

  for (const role of ["pending", "rejected"]) {
    test(`refuses a ${role} account: signed in is not a member`, async () => {
      globalThis.__db = seed();
      globalThis.__user = user(role);
      const res = await post({ answers: {} });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(Object.keys(rows()).length, 0, `a ${role} account took a place at a members-only event`);
      await settle();
      assert.equal(globalThis.__rsvpMail.length, 0);
    });
  }

  for (const role of ["member", "committee", "admin"]) {
    test(`admits a ${role}`, async () => {
      globalThis.__db = seed();
      globalThis.__user = user(role);
      const res = await post({ answers: {} });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Object.values(rows())[0].uid, `uid-${role}`);
    });
  }

  test("still admits everybody to a public event, whatever their role", async () => {
    for (const role of ["pending", "rejected", "member"]) {
      globalThis.__db = makeDb({ events: { "event-1": eventDoc() } });
      globalThis.__user = user(role);
      const res = await post({ answers: {} });
      assert.equal(res.status, 200, `${role}: ${JSON.stringify(res.body)}`);
    }
  });
});

// ===========================================================================
// 4. The tree
// ===========================================================================

/**
 * Every `.doc(...)` under `src` whose argument is built from an email
 * address, with the reason each is keyed that way and why a caller cannot
 * turn the id into a question. Counts are per file, so a second one dropped
 * into a listed file fails rather than hiding behind the entry.
 */
const EMAIL_KEYED_DOCS = {
  "src/app/api/subscriptions/route.ts": {
    count: 1,
    reason:
      "A subscription row IS an address's relationship with a channel, so the id is the pair by design. What the route answers about the row is the identity pass's subject, not this one's.",
  },
  "src/lib/firestore/subscriptions.ts": {
    count: 2,
    reason: "The same junction id, written by the two server-side helpers the routes call.",
  },
  "src/lib/firestore/suppression.ts": {
    count: 3,
    reason:
      "The bounce and complaint list is keyed by address because that is what a bounce is about. Read server-side only; no route answers a caller from it.",
  },
};

/**
 * Every route handler that hashes anything, with what it hashes. A hash of
 * request input used as a document id is the shape this guard exists for;
 * comparing two secrets is not.
 */
const HASHING_ROUTES = {
  "src/app/api/scheduler/tick/route.ts": {
    reason: "Hashes the presented and the configured scheduler secret to compare them in constant time. Nothing addressed by it.",
  },
  "src/app/api/webhooks/resend-events/route.ts": {
    reason: "An HMAC over the webhook body to verify Svix's signature. Nothing addressed by it.",
  },
};

const DOC_CALL = /\.doc\(((?:[^()]|\([^()]*\))*)\)/g;
/**
 * The identifier itself, as a word, or the suppression list's own `docId(e)`
 * helper, whose argument is always an address. `EMAIL_TEMPLATE_ID`,
 * `emailrate__`, `attendanceDocId(runId, ...)` and the push store's
 * `subscriptionDocId(endpoint)` are not addresses and are not matched.
 */
const EMAIL_ARG = /\b(email|address)\b|\bdocId\(/;

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

describe("the tree: document ids built from an address, and routes that hash", () => {
  test("the scanner sees a doc id built from an email and ignores one that is not", () => {
    const hits = (code) => [...code.matchAll(DOC_CALL)].filter((m) => EMAIL_ARG.test(m[1])).length;
    assert.equal(hits('db.collection("x").doc(docId(email))'), 1);
    assert.equal(hits('db.collection("x").doc(subscriptionDocId({ email, channel }))'), 1);
    assert.equal(hits('db.collection("x").doc(rsvpDocId(eventId, email))'), 1);
    assert.equal(hits('db.collection("suppressedEmails").doc(docId(e))'), 1);
    assert.equal(hits('db.collection("attendance").doc(attendanceDocId(runId, groupId, w, o))'), 0);
    assert.equal(hits('db.collection("pushSubscriptions").doc(subscriptionDocId(endpoint))'), 0);
    assert.equal(hits('db.collection("x").doc(uid).get()'), 0);
    assert.equal(hits('db.collection("x").doc()'), 0);
    assert.equal(hits('db.collection("x").doc(TASK_EMAIL_CONFIG_PATH.doc)'), 0);
    assert.equal(hits('db.collection("x").doc(`emailrate__${window.key}`)'), 0);
  });

  test("every email-keyed document id is registered with its reason, both directions", () => {
    const found = {};
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const count = [...codeOf(file).matchAll(DOC_CALL)].filter((m) => EMAIL_ARG.test(m[1])).length;
      if (count > 0) found[relative(REPO_ROOT, file)] = count;
    }
    const unregistered = Object.keys(found).filter((f) => !(f in EMAIL_KEYED_DOCS));
    assert.deepEqual(
      unregistered,
      [],
      "These files build a document id from an email address. An address a caller supplies is a question they can ask; write down why this one cannot be, or use a Firestore id.",
    );
    const stale = Object.keys(EMAIL_KEYED_DOCS).filter((f) => !(f in found));
    assert.deepEqual(stale, [], "These registered files no longer build an id from an address: remove them.");
    for (const [file, { count, reason }] of Object.entries(EMAIL_KEYED_DOCS)) {
      assert.equal(found[file], count, `${file}: ${found[file]} email-keyed ids, the registry says ${count}.`);
      assert.ok(reason.trim().length >= 40, `${file}: the reason is a placeholder.`);
    }
    assert.ok(!(ROUTE in found), "the RSVP route builds its id from the address again.");
  });

  test("every route handler that hashes is registered with what it hashes", () => {
    const found = [];
    for (const file of walk(join(REPO_ROOT, "src", "app", "api"))) {
      if (/\b(createHash|createHmac)\b/.test(codeOf(file))) found.push(relative(REPO_ROOT, file));
    }
    found.sort();
    assert.deepEqual(
      found.filter((f) => !(f in HASHING_ROUTES)),
      [],
      "These route handlers hash something. Register each with what it hashes, and never a caller's input into a document id.",
    );
    assert.deepEqual(
      Object.keys(HASHING_ROUTES).filter((f) => !found.includes(f)),
      [],
      "These registered routes no longer hash anything: remove them.",
    );
    assert.doesNotMatch(codeOf(join(REPO_ROOT, ROUTE)), /node:crypto/);
  });
});
