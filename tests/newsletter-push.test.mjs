/**
 * THE NEWSLETTER'S PUSH LEG, AND THE ENUMERATION IT SHARES, executed.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials, no
 * network). `tests/notification-classification.test.mjs` says this send is the
 * grid class on the newsletter row and reads the tree to check the claim;
 * `tests/push-preferences.test.mjs` proves the row's copy describes something
 * that exists. This file runs the code and checks what those claims are worth.
 *
 * ## What is worth executing, and why a source grep would not do
 *
 *  1. **The cell is honoured, per row, from one world.** The same seeded
 *     Firestore is pushed for `newsletter` and for `events` and the two reach
 *     DIFFERENT people, which is the whole of what the row parameter is for. A
 *     grep can see `wantsPushFor(uid, row)` in the helper; only running it can
 *     show that the row travelled from the call site to the answer.
 *  2. **Absent means off here.** Both rows this helper serves are opt-in, so a
 *     member who has never touched the switches must not be notified for owning
 *     a phone. That is the difference between this producer and the task and
 *     course mirrors, and it is the reason the helper refuses the opt-out rows
 *     at the type level.
 *  3. **A device whose owner has no user document.** `wantsPushFor` resolved
 *     that branch as YES on every row until 7 September 2026, which was safe
 *     only for a sender addressing a uid it already knew. This producer
 *     enumerates DEVICES, so it is exactly the sender that branch was wrong
 *     for: a stale row would have been pushed a newsletter nobody opted in to.
 *     Executed against a device with no owner, per row.
 *  4. **The ceiling refuses whole.** Over `MAX_PUSH_ROWS` nothing is pushed at
 *     all and the refusal is logged. A truncation would notify an arbitrary
 *     prefix of the audience and report success, so "nothing was sent" is the
 *     assertion, not "some of it was".
 *  5. **`pushed` counts notifications, not calls.** A member whose cell is on
 *     and whose only device the push service has forgotten is not somebody who
 *     was told. Driven through the real `sendPushToUid`, so the 410-and-prune
 *     path decides the count rather than the test asserting its own arithmetic.
 *  6. **The route, end to end.** The push happens once per send, the response
 *     and the draft carry the count, and a push leg that cannot read its
 *     collection leaves a delivered newsletter answering 200. A newsletter that
 *     has reached four hundred inboxes and then 500s is an invitation to send
 *     it again.
 *  7. **The send claim, under a race.** Two POSTs are fired at once and exactly
 *     one of them sends: the status check at the top of the route cannot
 *     separate them, because both read the draft before either wrote to it, so
 *     only the transaction can. Executed rather than reasoned about, since the
 *     route's comment claimed this property for a week before it held it. The
 *     interrupted case is here too: a standing claim refuses the retry and
 *     changes nothing.
 *  8. **The unsubscribe link reaches both cells of a subscription row.** The
 *     footer link and Gmail's one-click button are a refusal of the ROW, and a
 *     member who clicks one must stop getting the notification as well as the
 *     email. `courses` is the deliberate exception, because its two cells gate
 *     different messages: executed per row rather than asserted once.
 *  9. **The test send stays transactional**, pinned from its source: it must
 *     reach neither the shared enumeration nor a push preference.
 *
 * ## The fakes
 *
 * A fake Firestore, not the emulator, and a fake `web-push`: `npm test` must
 * not reach a project and must never put a notification on the wire. The push
 * pipeline itself (`lib/push/send.ts`, `lib/push/store.ts`) and the preference
 * read are REAL, so the outcome mapping, the pruning and the row defaults are
 * measured rather than restated. The VAPID keys are environment variables, set
 * here, which is also how the dormant case is exercised: unset them and the
 * helper must not read a collection at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (...parts) => readFileSync(join(REPO_ROOT, "src", ...parts), "utf8");

// ---------------------------------------------------------------------------
// A fake Firestore, small enough to read
// ---------------------------------------------------------------------------

/**
 * `store` is `{ [collection]: { [docId]: data } }`. It implements what these
 * two modules use and nothing else: a doc get, `getAll`, an equality query, a
 * limit, and the deletes the pruner makes.
 *
 * `reads` records every collection touched, so the dormant case can assert that
 * NOTHING was read rather than that nothing was sent. Two throwing switches sit
 * on it, both modelling a real failure this feature has to survive: the
 * subscription scan failing (the route's own catch) and one member's device
 * read failing (the helper's per-account catch).
 */
function makeDb(store = {}) {
  const data = JSON.parse(JSON.stringify(store));
  const reads = [];

  const snapOf = (collection, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(data[collection] ?? {}, id),
    data: () => (data[collection] ?? {})[id],
  });

  function matches(row, filters) {
    return filters.every(([field, op, value]) => {
      const actual = field.split(".").reduce((acc, k) => acc?.[k], row);
      if (op === "==") return actual === value;
      throw new Error(`the fake Firestore does not implement "${op}"`);
    });
  }

  function query(collection, filters, limit) {
    if (collection === "pushSubscriptions" && globalThis.__pushScanThrows) {
      throw new Error("pushSubscriptions unreadable");
    }
    const uidFilter = filters.find(([field]) => field === "uid");
    if (
      collection === "pushSubscriptions" &&
      uidFilter &&
      uidFilter[2] === globalThis.__subReadThrowsFor
    ) {
      throw new Error("device read failed");
    }
    const rows = Object.entries(data[collection] ?? {})
      .filter(([, row]) => matches(row, filters))
      .map(([id, row]) => ({ id, exists: true, data: () => row }));
    const docs = typeof limit === "number" ? rows.slice(0, limit) : rows;
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  const write = (ref, patch, merge) => {
    data[ref.__collection] ??= {};
    const current = merge ? (data[ref.__collection][ref.__id] ?? {}) : {};
    const next = { ...current, ...patch };
    // `FieldValue.delete()` REMOVES the field rather than storing a marker. A
    // store that kept the marker would answer truthy for a field the real
    // Firestore had dropped, which is exactly the question a released send
    // claim turns on.
    for (const [key, value] of Object.entries(next)) {
      if (value && typeof value === "object" && value.__op === "delete") delete next[key];
    }
    data[ref.__collection][ref.__id] = next;
  };

  /**
   * TRANSACTIONS RUN ONE AT A TIME, which is the property the send claim is
   * built on and the only thing that makes the concurrency test mean anything.
   * A fake that just called `fn` would let two racing requests both await their
   * `tx.get` before either wrote, so both would read an unclaimed draft and
   * both would send: the fake would report a bug the real Firestore does not
   * have, since it aborts and retries a transaction whose read set changed
   * underneath it. Serialising is the cheapest honest model of that.
   */
  let transactions = Promise.resolve();
  const runTransaction = (fn) => {
    const result = transactions.then(() => {
      // The window a test cannot otherwise reach: the route reads the draft,
      // resolves a mailing list, then claims. An author saving in between is a
      // real sequence, and the only way to see WHICH read is mailed.
      if (typeof globalThis.__beforeTransaction === "function") {
        const hook = globalThis.__beforeTransaction;
        globalThis.__beforeTransaction = null;
        hook(data);
      }
      return fn({
        get: async (ref) => snapOf(ref.__collection, ref.__id),
        set: (ref, patch) => write(ref, patch, false),
        update: (ref, patch) => write(ref, patch, true),
      });
    });
    // The queue must survive a transaction body that throws, or one failure
    // would wedge every later transaction in the same test.
    transactions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  function collectionRef(name, filters = [], limit) {
    reads.push(name);
    return {
      __collection: name,
      doc(id) {
        const ref = { __collection: name, __id: id };
        ref.get = async () => snapOf(name, id);
        ref.set = async (patch, options) => write(ref, patch, options?.merge === true);
        ref.update = async (patch) => write(ref, patch, true);
        ref.delete = async () => {
          delete (data[name] ?? {})[id];
        };
        return ref;
      },
      where(field, op, value) {
        return collectionRef(name, [...filters, [field, op, value]], limit);
      },
      limit(n) {
        return collectionRef(name, filters, n);
      },
      get: async () => query(name, filters, limit),
    };
  }

  return {
    data,
    reads,
    collection: (name) => collectionRef(name),
    async getAll(...refs) {
      return refs.map((ref) => snapOf(ref.__collection, ref.__id));
    },
    runTransaction,
  };
}

/**
 * The push service. It records what it was handed and answers 201, unless
 * `__pushStatus` names a status for that endpoint: 410 is how a push service
 * says a subscription is gone, which is what makes an account with a cell on
 * still count as nobody told.
 */
const WEB_PUSH_STUB =
  "const webpush = {\n" +
  "  setVapidDetails: () => {},\n" +
  "  sendNotification: async (subscription, payload) => {\n" +
  "    const status = (globalThis.__pushStatus ?? {})[subscription.endpoint];\n" +
  "    if (status) {\n" +
  "      const err = new Error('push service refused');\n" +
  "      err.statusCode = status;\n" +
  "      throw err;\n" +
  "    }\n" +
  "    (globalThis.__pushes ||= []).push({\n" +
  "      endpoint: subscription.endpoint,\n" +
  "      payload: JSON.parse(payload),\n" +
  "    });\n" +
  "  },\n" +
  "};\n" +
  "export default webpush;";

const FIRESTORE_STUB =
  "export class Timestamp {\n" +
  "  constructor(ms) { this.ms = ms; }\n" +
  "  toDate() { return new Date(this.ms); }\n" +
  "}\n" +
  "export const FieldValue = {\n" +
  "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
  "  delete: () => ({ __op: 'delete' }),\n" +
  "};";

const NEXT_RESPONSE_STUB =
  "export const NextResponse = {\n" +
  "  json(body, init) {\n" +
  "    return { status: (init && init.status) || 200, body };\n" +
  "  },\n};";

/** VAPID is read from the environment by the real config module. */
function armPush() {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
}

function disarmPush() {
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
}

const device = (uid, n) => ({
  uid,
  endpoint: `https://push.test/${uid}-${n}`,
  keys: { p256dh: "p", auth: "a" },
});

/**
 * Rows keyed the way the store keys them, by the hash of the endpoint, because
 * the pruner deletes by that id and nothing else. A seed keyed `d1` would make
 * every prune a silent no-op and the count assertions would pass over a store
 * that never changed.
 */
const subsById = (devices) =>
  Object.fromEntries(devices.map((d) => [subscriptionDocId(d.endpoint), d]));

/**
 * One world, five accounts, and the two opt-in rows answered differently by
 * each. Reading a single row's audience off it is the point: the sets differ.
 */
function seedWorld() {
  return {
    users: {
      // Newsletter yes, events no.
      "on-1": {
        email: "on1@e2e.invalid",
        profile: { notifications: { push: { newsletter: true, events: false } } },
      },
      // Both, and two devices: one account, one notification.
      "on-2": {
        email: "on2@e2e.invalid",
        profile: { notifications: { push: { newsletter: true, events: true } } },
      },
      // A stored refusal on the newsletter, and a yes on the other row.
      "off-1": {
        email: "off1@e2e.invalid",
        profile: { notifications: { push: { newsletter: false, events: true } } },
      },
      // Has never touched the switches. Both rows are opt-in, so both are off.
      "silent-1": { email: "silent@e2e.invalid", profile: {} },
      // "ghost" is deliberately absent: see the header, point 3.
    },
    pushSubscriptions: subsById([
      device("on-1", 1),
      device("on-2", 1),
      device("on-2", 2),
      device("off-1", 1),
      device("silent-1", 1),
      device("ghost", 1),
    ]),
  };
}

// ===========================================================================
// 1. The shared enumeration
// ===========================================================================

const helperLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["web-push", WEB_PUSH_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
  ]),
});

const { sendPushToRowAudience, MAX_PUSH_ROWS } =
  await helperLoader.loadTs("lib/push/rowAudience.ts");
// The real doc-id function, so the seeded rows sit where the pruner looks.
const { subscriptionDocId } = await helperLoader.loadTs("lib/push/store.ts");

const NOTIFICATION = {
  title: "New NAISI newsletter",
  body: "What we did in September",
  url: "/dashboard",
};
const LOG = { tag: "newsletter send", reference: "draft-1" };

describe("the row audience: every account with a device whose cell is on", () => {
  function world() {
    armPush();
    globalThis.__pushes = [];
    globalThis.__pushStatus = {};
    globalThis.__pushScanThrows = false;
    globalThis.__subReadThrowsFor = null;
    globalThis.__db = makeDb(seedWorld());
    return globalThis.__db;
  }

  test("one row's audience is not another's, from the same world", async () => {
    const db = world();
    const newsletter = await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    const newsletterEndpoints = globalThis.__pushes.map((p) => p.endpoint).sort();

    globalThis.__pushes = [];
    const events = await sendPushToRowAudience(
      db,
      "events",
      { title: "New NAISI event", body: "Reading group", url: "/events/e1" },
      { tag: "event announcement", reference: "e1" },
    );
    const eventEndpoints = globalThis.__pushes.map((p) => p.endpoint).sort();

    // Two accounts each, and only `on-2` is in both. The row travelled from the
    // call site to the answer; it is not a label on one fixed audience.
    assert.equal(newsletter.pushed, 2);
    assert.equal(events.pushed, 2);
    assert.equal(newsletter.refusal, null, "nobody being missed is not a refusal");
    assert.equal(events.refusal, null);
    assert.deepEqual(newsletterEndpoints, [
      "https://push.test/on-1-1",
      "https://push.test/on-2-1",
      "https://push.test/on-2-2",
    ]);
    assert.deepEqual(eventEndpoints, [
      "https://push.test/off-1-1",
      "https://push.test/on-2-1",
      "https://push.test/on-2-2",
    ]);
  });

  test("distinct owners are deduped: two devices are one account notified", async () => {
    const db = world();
    const result = await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    const forOn2 = globalThis.__pushes.filter((p) => p.endpoint.startsWith("https://push.test/on-2"));
    assert.equal(forOn2.length, 2, "both of that member's devices get the notification");
    assert.equal(result.pushed, 2, "and the count is accounts, not devices");
  });

  test("a stored false is a refusal and an absent cell is not an answer", async () => {
    const db = world();
    await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    const endpoints = globalThis.__pushes.map((p) => p.endpoint);
    assert.ok(
      !endpoints.includes("https://push.test/off-1-1"),
      "a member who switched this row off must not be pushed",
    );
    assert.ok(
      !endpoints.includes("https://push.test/silent-1-1"),
      "both rows this helper serves are opt-in: owning a phone is not consent",
    );
  });

  test("a device whose owner has no user document is not pushed, on either row", async () => {
    // The branch PR #300 corrected. A device-enumerating producer reaches it for
    // every stale row, and before that fix it answered yes on every row.
    const db = world();
    await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    await sendPushToRowAudience(db, "events", NOTIFICATION, LOG);
    assert.ok(
      !globalThis.__pushes.some((p) => p.endpoint === "https://push.test/ghost-1"),
      "a device whose owner's document is gone was pushed an opt-in row's notification",
    );
  });

  test("the notification itself is carried through untouched", async () => {
    const db = world();
    await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    const payload = globalThis.__pushes[0].payload;
    assert.equal(payload.notification.title, "New NAISI newsletter");
    assert.equal(payload.notification.body, "What we did in September");
    assert.equal(payload.notification.navigate, "/dashboard");
  });

  test("over the ceiling it refuses whole, pushes nothing, and says so", async (t) => {
    // Muted rather than silent: the line is the only way an operator learns the
    // audience outgrew the request, so it is asserted, not just swallowed.
    const errors = t.mock.method(console, "error", () => {});
    armPush();
    globalThis.__pushes = [];
    globalThis.__pushStatus = {};
    const over = Array.from({ length: MAX_PUSH_ROWS + 1 }, (_, i) => device("on-1", i));
    globalThis.__db = makeDb({ users: seedWorld().users, pushSubscriptions: subsById(over) });

    const result = await sendPushToRowAudience(globalThis.__db, "newsletter", NOTIFICATION, LOG);
    assert.equal(result.pushed, 0);
    assert.equal(globalThis.__pushes.length, 0, "a partial fan-out looks like a whole one");
    assert.match(
      result.refusal ?? "",
      /more registered devices than one request can notify/,
      "a zero the sender can do something about must not look like nobody opting in",
    );
    assert.equal(errors.mock.calls.length, 1);
    assert.match(errors.mock.calls[0].arguments[0], /exceeds ceiling, not pushing/);
    assert.match(errors.mock.calls[0].arguments[0], /newsletter send/);
  });

  test("with no VAPID keys nothing is read at all", async () => {
    world();
    disarmPush();
    const db = makeDb(seedWorld());
    const result = await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    assert.equal(result.pushed, 0);
    assert.equal(globalThis.__pushes.length, 0);
    assert.equal(
      result.refusal,
      null,
      "an unprovisioned backend is silence by design, not something to report on every send",
    );
    assert.deepEqual(
      db.reads,
      [],
      "the dormant case must cost nothing: the cheapest gate runs before the scan",
    );
    armPush();
  });

  test("`pushed` counts notifications: a cell on with a forgotten device is nobody told", async () => {
    const db = world();
    // 410 is the push service saying the subscription is gone. `on-1` has one
    // device and it has been forgotten; `on-2` has two and keeps them.
    globalThis.__pushStatus = { "https://push.test/on-1-1": 410 };
    const result = await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    assert.equal(result.pushed, 1, "an account whose only device is gone was not told");
    assert.equal(
      db.data.pushSubscriptions[subscriptionDocId("https://push.test/on-1-1")],
      undefined,
      "and the dead row is pruned, which is the only signal iOS ever gives",
    );
  });

  test("one member's failure costs that member alone", async (t) => {
    t.mock.method(console, "warn", () => {});
    const db = world();
    globalThis.__subReadThrowsFor = "on-1";
    const result = await sendPushToRowAudience(db, "newsletter", NOTIFICATION, LOG);
    assert.equal(result.pushed, 1, "best effort per account, never a failed audience");
    assert.equal(result.refusal, null, "one member's bad luck is not the audience refused");
    assert.deepEqual(
      globalThis.__pushes.map((p) => p.endpoint).sort(),
      ["https://push.test/on-2-1", "https://push.test/on-2-2"],
    );
  });
});

// ===========================================================================
// 2. The newsletter send, end to end
// ===========================================================================

const routeLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["next/server", NEXT_RESPONSE_STUB],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["web-push", WEB_PUSH_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    [
      "@/lib/email/send",
      "export const sendEmail = async (args) => { (globalThis.__sent ||= []).push(args); };",
    ],
    [
      "@/lib/firestore/suppression",
      "export const filterSuppressed = async (db, addrs) => ({ allowed: addrs, suppressed: [] });",
    ],
    [
      "@/lib/firestore/subscriptions",
      "export const findRecipientsForChannel = async (db, channel) => {\n" +
        "  globalThis.__channelAsked = channel;\n" +
        "  return globalThis.__channelRows ?? [];\n" +
        "};",
    ],
    ["@/lib/signedTokens", "export const signToken = (payload) => `tok:${JSON.stringify(payload)}`;"],
  ]),
});

const sendRoute = await routeLoader.loadTs("app/api/newsletter/[id]/send/route.ts");

const ctxFor = (id) => ({ params: Promise.resolve({ id }) });

describe("the newsletter send pushes its row once, and never fails because it did", () => {
  function seed() {
    armPush();
    globalThis.__sent = [];
    globalThis.__pushes = [];
    globalThis.__pushStatus = {};
    globalThis.__pushScanThrows = false;
    globalThis.__subReadThrowsFor = null;
    globalThis.__beforeTransaction = null;
    globalThis.__user = { uid: "approver-1", role: "admin", permissions: {} };
    globalThis.__channelRows = [
      { email: "on1@e2e.invalid", audience: "user", audienceId: "on-1" },
    ];
    const world = seedWorld();
    // The email leg's own opt-in, which is a different answer to the push cell:
    // `on-1` takes both, `on-2` takes only the notification.
    world.users["on-1"].profile.notifications.categories = { newsletter: true };
    world.newsletterDrafts = {
      "draft-1": {
        subject: "What we did in September",
        status: "approved",
        blocks: [{ id: "b1", type: "richText", html: "<p>Hello</p>" }],
      },
    };
    globalThis.__db = makeDb(world);
  }

  test("it emails the junction, pushes the row, and reports both", async () => {
    seed();
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 200);
    assert.equal(globalThis.__channelAsked, "newsletter");
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["on1@e2e.invalid"]);
    assert.equal(res.body.sentCount, 1);
    // Two accounts hold the push cell, and only one of them is on the mailing
    // list: the two columns are two answers, asked of two audiences.
    assert.equal(res.body.pushed, 2);
    assert.deepEqual(
      globalThis.__pushes.map((p) => p.endpoint).sort(),
      [
        "https://push.test/on-1-1",
        "https://push.test/on-2-1",
        "https://push.test/on-2-2",
      ],
    );
    assert.equal(globalThis.__pushes[0].payload.notification.navigate, "/dashboard");
  });

  test("the draft records the push beside the emails, and releases the claim", async () => {
    seed();
    await sendRoute.POST({}, ctxFor("draft-1"));
    const stored = globalThis.__db.data.newsletterDrafts["draft-1"];
    assert.equal(stored.status, "sent");
    assert.equal(stored.sentCount, 1);
    assert.equal(stored.pushedCount, 2);
    assert.equal(
      stored.sendClaimedAt,
      undefined,
      "a finished send leaves no claim, so a draft still carrying one is a send that " +
        "did not finish and the only case an admin has to decide about",
    );
  });

  test("two sends at once: one mails and pushes, the other is refused", async () => {
    // The failure the claim exists for. Both requests pass the status check at
    // the top of the route, because both read the draft before either wrote to
    // it; only the transaction can separate them, and it is asserted here
    // rather than reasoned about, because the route's own comment used to claim
    // this property without holding it.
    seed();
    const [first, second] = await Promise.all([
      sendRoute.POST({}, ctxFor("draft-1")),
      sendRoute.POST({}, ctxFor("draft-1")),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one request may send");
    const refused = first.status === 409 ? first : second;
    assert.match(refused.body.error, /already started, or was interrupted/);
    assert.equal(globalThis.__sent.length, 1, "one email, not two");
    assert.equal(
      globalThis.__pushes.length,
      3,
      "one push leg: two accounts, three devices, and no second fan-out",
    );
  });

  test("a claim left by an interrupted send refuses the retry, sending nothing", async () => {
    // Deliberately sticky: nothing expires the claim, because a rule that
    // released it after N minutes would re-mail the list on the day a send took
    // longer than N. An admin clears the field once they know from the send log
    // who already has the mail.
    seed();
    globalThis.__db.data.newsletterDrafts["draft-1"].sendClaimedAt = { seconds: 1 };
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Ask an admin before trying again/);
    assert.equal(globalThis.__sent.length, 0);
    assert.equal(globalThis.__pushes.length, 0);
    assert.equal(
      globalThis.__db.data.newsletterDrafts["draft-1"].status,
      "approved",
      "a refused send changes nothing at all",
    );
  });

  test("the body that goes out is the one the claim was taken over", async () => {
    // An approved draft is still editable. A correction saved while an approver
    // is pressing Send would otherwise be mailed to nobody and the stale text
    // mailed to everybody, with nothing in the report to say the two differed.
    seed();
    globalThis.__beforeTransaction = (data) => {
      data.newsletterDrafts["draft-1"].subject = "What we did in September (corrected)";
      data.newsletterDrafts["draft-1"].blocks = [
        { id: "b2", type: "richText", html: "<p>Corrected</p>" },
      ];
    };
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 200);
    assert.equal(globalThis.__sent[0].subject, "What we did in September (corrected)");
    assert.equal(
      globalThis.__pushes[0].payload.notification.body,
      "What we did in September (corrected)",
      "the notification carries the subject, so it reads from the same snapshot",
    );
  });

  test("a draft emptied in that window sends nothing and hands the claim back", async () => {
    seed();
    globalThis.__beforeTransaction = (data) => {
      data.newsletterDrafts["draft-1"].subject = "";
      data.newsletterDrafts["draft-1"].blocks = [];
    };
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /missing subject or body/);
    assert.equal(globalThis.__sent.length, 0);
    assert.equal(globalThis.__pushes.length, 0);
    assert.equal(
      globalThis.__db.data.newsletterDrafts["draft-1"].sendClaimedAt,
      undefined,
      "nothing was sent, so the claim is worth nothing and must not strand the draft",
    );
    assert.equal(globalThis.__db.data.newsletterDrafts["draft-1"].status, "approved");
  });

  test("a sent draft cannot be sent again", async () => {
    seed();
    await sendRoute.POST({}, ctxFor("draft-1"));
    globalThis.__pushes = [];
    globalThis.__sent = [];
    const again = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(again.status, 400);
    assert.match(again.body.error, /Only approved drafts/);
    assert.equal(globalThis.__sent.length, 0);
    assert.equal(globalThis.__pushes.length, 0);
  });

  test("a push leg that cannot read its collection leaves the send delivered", async (t) => {
    t.mock.method(console, "error", () => {});
    seed();
    globalThis.__pushScanThrows = true;
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 200, "a delivered newsletter must not answer 500");
    assert.equal(res.body.sentCount, 1);
    assert.equal(res.body.pushed, 0);
    assert.match(
      res.body.pushRefusal ?? "",
      /could not be read/,
      "the sender is told why nobody was notified, rather than reading a bare zero",
    );
    assert.equal(globalThis.__db.data.newsletterDrafts["draft-1"].status, "sent");
  });

  test("with push dormant the newsletter still goes out, and says nothing about it", async () => {
    seed();
    disarmPush();
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 200);
    assert.equal(res.body.sentCount, 1);
    assert.equal(res.body.pushed, 0);
    assert.equal(
      res.body.pushRefusal,
      null,
      "an unprovisioned backend is not a refusal to report to a drafter",
    );
    armPush();
  });

  test("an empty mailing list refuses before either leg, and says which list", async () => {
    seed();
    globalThis.__channelRows = [];
    const res = await sendRoute.POST({}, ctxFor("draft-1"));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No email subscribers/);
    assert.equal(globalThis.__pushes.length, 0, "the push leg runs only alongside an email leg");
    assert.equal(
      globalThis.__db.data.newsletterDrafts["draft-1"].sendClaimedAt,
      undefined,
      "and nothing was claimed, so the draft can still be sent once the list is fixed",
    );
  });
});

// ===========================================================================
// 3. The unsubscribe link, which now has a notification to switch off
// ===========================================================================

const unsubLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["next/server", NEXT_RESPONSE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    [
      "@/lib/signedTokens",
      "export const verifyToken = () => globalThis.__token ?? null;",
    ],
    [
      "@/lib/firestore/subscriptions",
      "export const isValidChannel = (c) => typeof c === 'string' && c.length > 0;\n" +
        "export const channelLabel = (c) => c;\n" +
        "export const unsubscribe = async (db, args) => {\n" +
        "  (globalThis.__dropped ||= []).push(args);\n" +
        "};\n" +
        "export const unsubscribeAll = async (db, email) => {\n" +
        "  (globalThis.__dropped ||= []).push({ email, channel: 'all' });\n" +
        "};",
    ],
  ]),
});

const unsubRoute = await unsubLoader.loadTs("app/api/unsubscribe/route.ts");

describe("the unsubscribe link refuses the row, not the email column", () => {
  function seedMember() {
    globalThis.__dropped = [];
    globalThis.__db = makeDb({
      users: {
        "member-1": {
          email: "member@e2e.invalid",
          profile: {
            notifications: {
              categories: { newsletter: true, events: true, courses: true },
              push: { newsletter: true, events: true, courses: true },
            },
          },
        },
      },
    });
  }

  const post = async (payload) => {
    globalThis.__token = payload;
    return unsubRoute.POST(new Request("https://naisi.test/api/unsubscribe?t=tok", {
      method: "POST",
    }));
  };

  const patchOf = () => globalThis.__db.data.users["member-1"];

  test("a newsletter token switches off both cells of that row", async () => {
    // The regression this closes: before the newsletter had a producer the
    // email cell was the whole row, and flipping it was the whole unsubscribe.
    // From the producer on, a member who clicked the footer link kept getting
    // the notification from the very message they unsubscribed from.
    seedMember();
    const res = await post({ s: "unsubscribe", uid: "member-1", c: "newsletter" });
    assert.equal(res.status, 200);
    const stored = patchOf();
    assert.equal(stored["profile.notifications.categories.newsletter"], false);
    assert.equal(stored["profile.notifications.push.newsletter"], false);
  });

  test("a courses token switches off the email cell and leaves the push cell alone", async () => {
    // The two cells of the courses row gate different messages: the email cell
    // gates cohort announcements and session nudges, the push cell gates an
    // admissions decision, a stage release and a placement. A click at the foot
    // of a cohort email is not a refusal of a decision about somebody's own
    // application.
    seedMember();
    const res = await post({ s: "unsubscribe", uid: "member-1", c: "courses" });
    assert.equal(res.status, 200);
    const stored = patchOf();
    assert.equal(stored["profile.notifications.categories.courses"], false);
    assert.equal(
      stored["profile.notifications.push.courses"],
      undefined,
      "a cohort-mail unsubscribe must not silence a decision notification",
    );
  });

  test("an `all` token reaches both subscription rows, on both columns", async () => {
    seedMember();
    const res = await post({ s: "unsubscribe", uid: "member-1", c: "all" });
    assert.equal(res.status, 200);
    const stored = patchOf();
    for (const row of ["newsletter", "events"]) {
      assert.equal(stored[`profile.notifications.categories.${row}`], false);
      assert.equal(stored[`profile.notifications.push.${row}`], false);
    }
    assert.equal(stored["profile.notifications.categories.courses"], false);
    assert.equal(stored["profile.notifications.push.courses"], undefined);
    assert.equal(
      stored["profile.notifications.categories.tasks"],
      undefined,
      "tasks is outside UNSUBSCRIBABLE_CATEGORIES and stays outside it",
    );
    assert.equal(stored["profile.notifications.push.tasks"], undefined);
  });

  test("it still writes leaves only, never the whole map", async () => {
    // The rule the previous fix established, restated as an executed one: a
    // whole-map write collapses ABSENT into false on every row, which is how an
    // unsubscribe click once stamped a course-mail refusal nobody made. Adding
    // a second column to this route is exactly the change that could undo it.
    seedMember();
    await post({ s: "unsubscribe", uid: "member-1", c: "newsletter" });
    const written = Object.keys(patchOf()).filter((k) => k.startsWith("profile."));
    assert.ok(written.length > 0, "the route wrote nothing at all");
    for (const key of written) {
      assert.match(
        key,
        /^profile\.(notifications\.(categories|push)\.[a-z]+|newsletter\.subscribed)$/,
        `${key} is not a leaf: a whole-map write invents refusals nobody made`,
      );
    }
  });
});

// ===========================================================================
// 4. The test send is transactional, and stays that way
// ===========================================================================

describe("a standing claim is visible before the Send button is pressed", () => {
  test("the editor renders sendClaimedAt on an approved draft", () => {
    // The claim is deliberately sticky and there is no button here to clear it,
    // so the only thing that keeps it from being invisible is this line. Without
    // it the 409 is the first anybody hears of a send that stopped half way.
    const editor = readFileSync(
      join(REPO_ROOT, "src", "features", "newsletter", "DraftEditor.tsx"),
      "utf8",
    );
    assert.match(
      editor,
      /status === "approved" && draft\.sendClaimedAt/,
      "an approved draft carrying a claim must say so where the Send button is",
    );
    assert.match(editor, /did not finish/);
    assert.match(
      editor,
      /An admin can clear it/,
      "the line has to name the recovery, because there is no control here that performs it",
    );
  });
});

describe("the test send reaches its own sender and consults nothing", () => {
  test("it references neither the shared enumeration nor a push preference", () => {
    // A rehearsal is addressed to the person rehearsing, so there is no row to
    // read and nobody else to notify. The classification guard fails a
    // transactional file that names a grid marker; this is the same claim made
    // where somebody editing this route will see it.
    const source = src("app", "api", "newsletter", "[id]", "send-test", "route.ts");
    assert.doesNotMatch(source, /sendPushToRowAudience|wantsPushFor|rowAudience/);
    assert.doesNotMatch(source, /lib\/push/);
  });
});
