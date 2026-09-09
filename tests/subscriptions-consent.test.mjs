/**
 * The public subscribe endpoint never resumes delivery without a fresh
 * confirmation, and never tells an anonymous caller an address's state.
 *
 * WHY. Until 8 September 2026 `POST /api/subscriptions` had two flaws reachable
 * with no account. (1) RE-SUBSCRIBE: `subscribe()` flipped `subscribed` back on
 * for a once-confirmed, then-unsubscribed row unconditionally, and for a guest
 * row nothing gated delivery after that, so an anonymous POST undid an
 * unsubscribe the recipient had performed (Gmail's one-click list-unsubscribe
 * included), repeatable every cooldown. (2) ORACLE: the response body differed
 * by the address's stored state (`confirmation-sent` / `added` / bare `ok`), so
 * a single unauthenticated request told the caller whether an arbitrary address
 * had a relationship with NAISI, the exact thing the route's own docblock says
 * it does not. Both are fixed here and executed by this guard:
 *
 *  1. `subscribe()` / `confirmAllForEmail()` run against a fake Firestore across
 *     every prior row state, as an unproven caller and as an inbox-proven one.
 *  2. `POST /api/subscriptions` runs as an ANONYMOUS caller across those states,
 *     and every non-validation body is asserted byte-identical.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./lib/tsLoader.mjs";

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// A fake Firestore: docs, auto ids, equality queries, a batch, and the two
// FieldValue operators the module uses (increment, delete).
// ---------------------------------------------------------------------------
function makeDb(store = {}) {
  // No JSON clone — that would strip the `toMillis` method off seeded Timestamp
  // objects. Each test passes a freshly-built store literal, so using it
  // directly is safe.
  const data = store;
  let autoIds = 0;
  const resolve = (existing, value) => {
    if (value && typeof value === "object" && value.__op === "inc") {
      return (typeof existing === "number" ? existing : 0) + value.n;
    }
    if (value && typeof value === "object" && value.__ts) return value;
    return value;
  };
  const write = (ref, patch, merge) => {
    data[ref.__collection] ??= {};
    const prev = merge ? data[ref.__collection][ref.__id] ?? {} : {};
    const next = { ...prev };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && v.__op === "del") delete next[k];
      else next[k] = resolve(prev[k], v);
    }
    data[ref.__collection][ref.__id] = next;
  };
  const snapOf = (collection, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(data[collection] ?? {}, id),
    data: () => (data[collection] ?? {})[id],
    ref: { __collection: collection, __id: id },
  });
  const docRef = (collection, id) => {
    const rid = id ?? `auto-${(autoIds += 1)}`;
    return {
      __collection: collection,
      __id: rid,
      id: rid,
      get: async () => snapOf(collection, rid),
      set: async (patch) => write({ __collection: collection, __id: rid }, patch, false),
      update: async (patch) => write({ __collection: collection, __id: rid }, patch, true),
    };
  };
  const collectionRef = (name, filters = []) => ({
    __collection: name,
    __filters: filters,
    doc: (id) => docRef(name, id),
    add: async (patch) => docRef(name).set(patch),
    where: (field, op, value) => collectionRef(name, [...filters, [field, op, value]]),
    get: async function () {
      const docs = Object.entries(data[name] ?? {})
        .filter(([, row]) =>
          this.__filters.every(([f, op, v]) => {
            if (op !== "==") throw new Error(`fake db has no "${op}"`);
            return row[f] === v;
          }),
        )
        .map(([id]) => snapOf(name, id));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  return {
    data,
    collection: (name) => collectionRef(name),
    batch() {
      const ops = [];
      return {
        set: (ref, patch) => ops.push(() => write(ref, patch, false)),
        update: (ref, patch) => ops.push(() => write(ref, patch, true)),
        delete: (ref) => ops.push(() => delete (data[ref.__collection] ?? {})[ref.__id]),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
}

const firestoreStub =
  "export const FieldValue = { increment: (n) => ({ __op: 'inc', n }), delete: () => ({ __op: 'del' }) };\n" +
  `export const Timestamp = { now: () => ({ __ts: ${NOW}, toMillis: () => ${NOW} }), ` +
  `fromMillis: (m) => ({ __ts: m, toMillis: () => m }), fromDate: (d) => ({ __ts: +d }) };`;

const { loadTs } = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["firebase-admin/firestore", firestoreStub],
    ["next/server", "export const NextResponse = { json(body, init) { return { status: (init && init.status) || 200, body }; } };"],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    ["@/lib/firestore/suppression", "export const isSuppressed = async () => globalThis.__suppressed ?? false;"],
    ["@/lib/email/send", "export const sendEmail = async (args) => { (globalThis.__mail ||= []).push(args); };"],
    ["@/lib/signedTokens", "export const signToken = () => 'signed-token';"],
    ["@/lib/firestore/notifications", "export const getVerifiedEmails = () => [];"],
    ["@/lib/rateLimit", "export const rateLimit = () => ({ ok: true, retryAfterSeconds: 0 }); export const clientIp = () => 'ip';"],
    // The two subscription email templates are NOT stubbed: the shared loader
    // compiles JSX, and tests/ts-loader.test.mjs forbids stubbing a template to
    // dodge it. `sendEmail` is the door that is stubbed, so the rendered element
    // is built for real and then discarded.
  ]),
});

const subs = await loadTs("lib/firestore/subscriptions.ts");
const route = await loadTs("app/api/subscriptions/route.ts");

const CHANNEL = "newsletter";
const EMAIL = "person@example.com";
const docId = (email, channel) => subs.subscriptionDocId({ email, channel });

function rowFor(state) {
  // The prior stored row, by (confirmed, subscribed).
  const base = { email: EMAIL, channel: CHANNEL, audience: "guest", audienceId: "x", source: "s" };
  if (state === "confirmed-subscribed") return { ...base, confirmed: true, subscribed: true };
  if (state === "unsubscribed") return { ...base, confirmed: true, subscribed: false };
  if (state === "pending") return { ...base, confirmed: false, subscribed: true };
  return null; // "fresh": no row
}

function seedRow(state) {
  const row = rowFor(state);
  return row ? { subscriptions: { [docId(EMAIL, CHANNEL)]: row } } : {};
}

const call = (args) =>
  subs.subscribe(globalThis.__db, {
    email: EMAIL,
    channel: CHANNEL,
    audience: args.inboxProven ? "user" : "guest",
    audienceId: "x",
    source: "s",
    actor: { kind: args.inboxProven ? "member" : "guest", label: "t" },
    inboxProven: args.inboxProven,
  });

const theRow = () => globalThis.__db.data.subscriptions[docId(EMAIL, CHANNEL)];

// ===========================================================================
// 1. subscribe(): the re-subscribe gate
// ===========================================================================
describe("subscribe()", () => {
  test("an UNPROVEN caller cannot resume delivery on a once-confirmed, unsubscribed row", async () => {
    globalThis.__db = makeDb(seedRow("unsubscribed"));
    const res = await call({ inboxProven: false });
    assert.equal(theRow().subscribed, false, "delivery resumed without a confirmation click");
    assert.equal(theRow().pendingResubscribe, true, "the row was not marked for reactivation");
    assert.equal(res.requiresConfirmation, true, "no confirmation was demanded");
    assert.equal(res.newlyAddedChannel, false, "the resubscribe was reported as an immediate add");
  });

  test("the recipient's confirmation click reactivates it, and only then", async () => {
    globalThis.__db = makeDb(seedRow("unsubscribed"));
    await call({ inboxProven: false });
    assert.equal(theRow().subscribed, false);
    const { channels } = await subs.confirmAllForEmail(globalThis.__db, EMAIL, {
      kind: "guest",
      label: "email confirmation link",
    });
    assert.equal(theRow().subscribed, true, "the click did not reactivate the row");
    assert.equal(theRow().pendingResubscribe, undefined, "the reactivation marker was not cleared");
    assert.deepEqual(channels, [CHANNEL], "the reactivated channel is not in the welcome list");
  });

  test("an INBOX-PROVEN caller resumes delivery immediately (their own address)", async () => {
    globalThis.__db = makeDb(seedRow("unsubscribed"));
    const res = await call({ inboxProven: true });
    assert.equal(theRow().subscribed, true);
    assert.equal(theRow().pendingResubscribe, undefined);
    assert.equal(res.requiresConfirmation, false);
    assert.equal(res.newlyAddedChannel, true);
  });

  test("a never-confirmed (lapsed) row flips subscribed but still needs a click before delivery", async () => {
    globalThis.__db = makeDb({ subscriptions: { [docId(EMAIL, CHANNEL)]: { ...rowFor("unsubscribed"), confirmed: false } } });
    const res = await call({ inboxProven: false });
    assert.equal(theRow().subscribed, true, "a lapsed row should return to pending");
    assert.equal(theRow().confirmed, false, "delivery must still be gated on confirmation");
    assert.equal(res.requiresConfirmation, true);
  });

  test("a fresh address mints an unconfirmed row and demands a click", async () => {
    globalThis.__db = makeDb({});
    const res = await call({ inboxProven: false });
    assert.equal(theRow().confirmed, false);
    assert.equal(theRow().subscribed, true);
    assert.equal(res.requiresConfirmation, true);
  });
});

// ===========================================================================
// 2. POST /api/subscriptions: the anonymous response is uniform
// ===========================================================================
describe("POST /api/subscriptions as an anonymous caller", () => {
  const post = (email = EMAIL) =>
    route.POST({ json: async () => ({ email, channels: [CHANNEL], source: "s" }), headers: { get: () => "" } });

  beforeEach(() => {
    globalThis.__user = null;
    globalThis.__suppressed = false;
    globalThis.__mail = [];
  });

  test("every prior state answers with an identical body", async () => {
    const bodies = [];
    for (const state of ["fresh", "confirmed-subscribed", "unsubscribed", "pending"]) {
      globalThis.__db = makeDb(seedRow(state));
      const res = await post();
      assert.equal(res.status, 200, `${state}: ${JSON.stringify(res.body)}`);
      bodies.push([state, JSON.stringify(res.body)]);
    }
    // Suppressed and cooldown short-circuits must also match.
    globalThis.__db = makeDb({});
    globalThis.__suppressed = true;
    bodies.push(["suppressed", JSON.stringify((await post()).body)]);
    globalThis.__suppressed = false;
    globalThis.__db = makeDb({ subscriptions: { [docId(EMAIL, CHANNEL)]: { ...rowFor("fresh") ?? {}, email: EMAIL, channel: CHANNEL, lastAttemptAt: { __ts: NOW, toMillis: () => NOW } } } });
    bodies.push(["cooldown", JSON.stringify((await post()).body)]);

    const distinct = new Set(bodies.map(([, b]) => b));
    assert.equal(
      distinct.size,
      1,
      "The anonymous response body differs by the address's stored state, which is " +
        "an enumeration oracle:\n" + bodies.map(([s, b]) => `  ${s}: ${b}`).join("\n"),
    );
    assert.equal([...distinct][0], JSON.stringify({ ok: true }), "the uniform body should be a bare { ok: true }");
  });

  test("a fresh anonymous signup still sends its confirmation email (uniformity is in the RESPONSE, not the inbox)", async () => {
    globalThis.__db = makeDb({});
    await post();
    assert.equal(globalThis.__mail.length, 1, "the confirmation email was not sent");
    assert.equal(globalThis.__mail[0].kind, "subscription-confirm");
  });

  test("an anonymous re-subscribe of an unsubscribed row does NOT immediately resume delivery", async () => {
    globalThis.__db = makeDb(seedRow("unsubscribed"));
    await post();
    assert.equal(theRow().subscribed, false, "the anonymous POST resumed a delivery the recipient had stopped");
    assert.equal(theRow().pendingResubscribe, true);
  });
});
