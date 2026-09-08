/**
 * THE NOTICE LANE, executed.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials, no
 * network). `tests/notification-classification.test.mjs` says which sends are
 * notices and reads the tree to check the claim; this file runs the code and
 * checks what the claim is worth.
 *
 * ## What is worth executing, and why a source grep would not do
 *
 *  1. **The marker really renders.** `sendNotice` builds `NoticeMarker` and
 *     hands it to a template as a slot, so whether the recipient actually sees
 *     the line depends on the TEMPLATE putting the slot somewhere. The suite
 *     renders the real email through the real `@react-email/render` and reads
 *     the HTML. A grep for `notice` in the route would have passed on a
 *     template that took the prop and dropped it.
 *  2. **The receipt.** `kind: "notice"` and the surface are what the
 *     deliverability tab shows for a message that ignored somebody's settings.
 *     They are stamped by the door and are not a caller's to choose, which is a
 *     property of the door's code rather than of any route.
 *  3. **No unsubscribe, anywhere.** Asserted on the rendered HTML and on the
 *     SMTP headers, because the RFC 8058 header and the footer link are two
 *     different ways to offer the same false promise.
 *  4. **The push door reads nothing.** Two tests, deliberately: the file never
 *     names `wantsPushFor` (source), AND a member whose stored push cells are
 *     all `false` is still pushed (execution, against a Firestore that would
 *     answer "no" if anything asked it). Either alone is weak; a source grep
 *     cannot see a preference read through a helper, and an execution test on a
 *     module with no preference read passes trivially.
 *  5. **The widened event gate, as five different people.** Author,
 *     collaborator, SU-recognised committee and admin get in; a plain committee
 *     member does not. Test as a member, never only as an admin: an admin takes
 *     a resource-independent branch of this gate and would hide every mistake
 *     in the other four.
 *  6. **The caps, at their boundary and across requests.** A counter that
 *     refuses the fourth send in an hour is only worth having if it is DURABLE,
 *     so the second request in a test reads the row the first one wrote, and
 *     the over-ceiling case asserts that NOTHING was sent rather than that some
 *     of it was.
 *  7. **The announcement's claim.** Once per event, under the write that
 *     publishes, and a failure that never turns a published event into a 500.
 *
 * ## The fakes
 *
 * A fake Firestore, not the emulator: `npm test` has no emulator and must not
 * reach a project. It implements what these routes use (doc get, `getAll`,
 * equality and `in` queries, `limit`, and a transaction with get/set/update)
 * and nothing else. The transport, the push service, the suppression list, the
 * session and the Admin SDK are stubbed at the module boundary, so nothing here
 * can put mail on the wire or a notification on a phone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@react-email/render";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (...parts) => readFileSync(join(REPO_ROOT, "src", ...parts), "utf8");

// ---------------------------------------------------------------------------
// A fake Firestore, small enough to read
// ---------------------------------------------------------------------------

/**
 * `store` is `{ [collection]: { [docId]: data } }`. Every read and write below
 * goes through it, so a test can seed a world and then assert on what changed.
 */
function makeDb(store = {}) {
  const data = JSON.parse(JSON.stringify(store));

  const snapOf = (collection, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(data[collection] ?? {}, id),
    data: () => (data[collection] ?? {})[id],
  });

  function matches(row, filters) {
    return filters.every(([field, op, value]) => {
      const actual = field.split(".").reduce((acc, k) => acc?.[k], row);
      if (op === "==") return actual === value;
      if (op === "in") return value.includes(actual);
      throw new Error(`the fake Firestore does not implement "${op}"`);
    });
  }

  function query(collection, filters, limit) {
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
    // Firestore had dropped, which is the whole question the publish route's
    // released claim turns on.
    for (const [key, value] of Object.entries(next)) {
      if (value && typeof value === "object" && value.__op === "delete") delete next[key];
    }
    data[ref.__collection][ref.__id] = next;
  };

  function collectionRef(name, filters = [], limit) {
    return {
      __collection: name,
      doc(id) {
        const ref = { __collection: name, __id: id };
        ref.get = async () => snapOf(name, id);
        ref.set = async (patch, options) => write(ref, patch, options?.merge === true);
        ref.update = async (patch) => write(ref, patch, true);
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
    collection: (name) => collectionRef(name),
    async getAll(...refs) {
      return refs.map((ref) => snapOf(ref.__collection, ref.__id));
    },
    async runTransaction(fn) {
      return fn({
        get: async (ref) => snapOf(ref.__collection, ref.__id),
        set: (ref, patch) => write(ref, patch, false),
        update: (ref, patch) => write(ref, patch, true),
      });
    },
  };
}

/** The stub every suite section uses for `Timestamp` and `FieldValue`. */
const FIRESTORE_STUB =
  "export class Timestamp {\n" +
  "  constructor(ms) { this.ms = ms; }\n" +
  "  toMillis() { return this.ms; }\n" +
  "  static fromMillis(ms) { return new Timestamp(ms); }\n" +
  "}\n" +
  "export const FieldValue = {\n" +
  "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
  "  delete: () => ({ __op: 'delete' }),\n" +
  "};";

const NEXT_RESPONSE_STUB =
  "export const NextResponse = {\n" +
  "  json(body, init) {\n" +
  "    return { status: (init && init.status) || 200, body, headers: (init && init.headers) || {} };\n" +
  "  },\n};";

/** Every response body this suite reads, as JSON: never a Response object. */
const jsonOf = (res) => res.body;

// ===========================================================================
// 1. The email door
// ===========================================================================

const doorLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    [
      // The transport, recorded. `@react-email/render` is deliberately NOT
      // stubbed: the whole point of section 1 is what the recipient sees.
      "nodemailer",
      "export default {\n" +
        "  createTransport: () => ({\n" +
        "    sendMail: async (message) => {\n" +
        "      globalThis.__sentMail.push(message);\n" +
        "      return { messageId: '<test@naisi.uk>', response: '250 Ok' };\n" +
        "    },\n" +
        "  }),\n" +
        "};",
    ],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    [
      "@/lib/firestore/suppression",
      "export const filterSuppressed = async (db, addrs) => ({ allowed: addrs, suppressed: [] });",
    ],
  ]),
});

const { sendNotice } = await doorLoader.loadTs("lib/email/notice.ts");
const EventUpdateEmail = (await doorLoader.loadTs("emails/EventUpdateEmail.tsx")).default;
const ApplicationEmail = (await doorLoader.loadTs("emails/ApplicationEmail.tsx")).default;

function armTransport() {
  // The transport is faked; these only exist because `sendEmail` refuses to
  // build a From header without them, which is the correct thing for it to do.
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_USER = "harness@test.invalid";
  process.env.SMTP_PASSWORD = "not-a-real-password";
  process.env.SMTP_FROM_EMAIL = "hello@naisi.uk";
  process.env.SMTP_FROM_NAME = "NAISI";
  globalThis.__sentMail = [];
  const rows = [];
  globalThis.__db = {
    collection: () => ({
      doc: (id) => ({ id }),
      async add(doc) {
        rows.push(doc);
        return { id: `row-${rows.length}` };
      },
    }),
  };
  return rows;
}

describe("sendNotice: the lane's email door", () => {
  test("it goes through sendEmail and never builds a transport of its own", () => {
    const source = src("lib", "email", "notice.ts");
    assert.match(
      source,
      /import \{ sendEmail(?:, [^}]*)? \} from "\.\/send"/,
      "the notice door must send through the one chokepoint, which is where the " +
        "suppression list is read. A notice bypasses preferences, never deliverability.",
    );
    assert.doesNotMatch(source, /nodemailer|createTransport/);
  });

  test("the recipient sees the marker, above the body, in their own terms", async () => {
    armTransport();
    await sendNotice({
      to: "attendee@e2e.invalid",
      subject: "Room change",
      surface: "event-broadcast",
      actorUid: "organiser-1",
      referenceId: "event-1",
      render: (marker) =>
        EventUpdateEmail({
          notice: marker,
          eventTitle: "Reading group",
          recipientName: "Sam",
          whenLine: "Fri 6 June, 18:00",
          locationLine: "B52",
          subject: "Room change",
          body: "We have moved to B52.",
        }),
    });

    assert.equal(globalThis.__sentMail.length, 1);
    const { html, text } = globalThis.__sentMail[0];
    assert.match(html, /Sent as an important notice/);
    assert.match(html, /you have a place at this event/);
    assert.match(html, /whatever your notification settings say/);
    assert.match(html, /never marketing/);
    // The plain-text alternative carries it too: a client that renders text is
    // not a client the explanation may be missing from.
    assert.match(text, /Sent as an important notice/);
    // ABOVE the body, not appended under it. The greeting, then the marker,
    // then the organiser's words.
    assert.ok(
      html.indexOf("Sent as an important notice") < html.indexOf("We have moved to B52"),
      "the marker renders below the body, where the reader meets the message " +
        "before the explanation of why it reached them",
    );
  });

  test("the receipt says what bypassed, and from where", async () => {
    const rows = armTransport();
    await sendNotice({
      to: "member@e2e.invalid",
      subject: "Session update",
      surface: "course-room",
      actorUid: "facilitator-1",
      referenceId: "group-7",
      render: (marker) =>
        ApplicationEmail({ subject: "Session update", blocks: [], notice: marker }),
    });

    assert.equal(rows.length, 1, "a notice must leave a deliverability row");
    assert.equal(rows[0].kind, "notice");
    assert.equal(rows[0].surface, "course-room");
    assert.equal(rows[0].actorUid, "facilitator-1");
    assert.equal(rows[0].referenceId, "group-7");
    // The surface drives the sentence as well as the row, so the two cannot
    // disagree about which lane a message came from.
    assert.match(globalThis.__sentMail[0].html, /you are in this course group/);
  });

  test("it offers no unsubscribe, in the body or in the headers", async () => {
    armTransport();
    await sendNotice({
      to: "member@e2e.invalid",
      subject: "Session update",
      surface: "course-run",
      actorUid: "lead-1",
      referenceId: "run-1",
      render: (marker) =>
        ApplicationEmail({ subject: "Session update", blocks: [], notice: marker }),
    });
    const message = globalThis.__sentMail[0];
    assert.doesNotMatch(
      message.html.toLowerCase(),
      /unsubscribe/,
      "a notice cannot be unsubscribed from, so a link saying otherwise would be " +
        "the one dishonest thing this lane could carry",
    );
    assert.equal(
      message.headers?.["List-Unsubscribe"],
      undefined,
      "the RFC 8058 header is the same false promise in a machine-readable form",
    );
  });

  test("the argument list has no way to pass one", () => {
    // Not a style point: `listUnsubscribe` being absent from `SendNoticeArgs` is
    // what stops a future caller adding a footer without reading this file.
    const source = src("lib", "email", "notice.ts");
    const args = /export type SendNoticeArgs = \{[\s\S]*?\n\};/.exec(source);
    assert.ok(args, "SendNoticeArgs moved: re-read this file");
    assert.doesNotMatch(args[0], /listUnsubscribe/);
  });
});

// ===========================================================================
// 2. The push door
// ===========================================================================

const pushLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["./config", "export const isPushConfigured = () => globalThis.__vapid !== false;"],
    [
      "./send",
      "export const sendPushToUid = async (uid, n) => {\n" +
        "  if (globalThis.__pushThrows) throw new Error('push service down');\n" +
        "  (globalThis.__pushes ||= []).push({ uid, ...n });\n" +
        "  return { sent: 1, pruned: 0, deferred: 0, failed: 0, retried: 0 };\n" +
        "};",
    ],
    // A Firestore that would answer "this member refuses everything" if the
    // module ever asked it. It must never be read.
    [
      "@/lib/firebase/admin",
      "export const getAdminDb = () => {\n" +
        "  globalThis.__prefsRead = true;\n" +
        "  return null;\n" +
        "};",
    ],
  ]),
});

const { sendNoticePush } = await pushLoader.loadTs("lib/push/noticeNotifications.ts");

describe("sendNoticePush: the one push that reads no preference", () => {
  test("the file never names the preference helper", () => {
    // Read RAW, comments included. A file that only mentioned `wantsPushFor` in
    // a header would pass a stripped-source check and would be one edit away
    // from calling it.
    const source = src("lib", "push", "noticeNotifications.ts");
    assert.doesNotMatch(
      source,
      /wantsPushFor/,
      "the notice push door consults the push column. The moment it does, an " +
        "organiser's `we have moved to B52` reaches some of the room and not the " +
        "rest, and the email hides the failure by reaching everyone.",
    );
    assert.doesNotMatch(source, /from "\.\/preferences"|firestore\/notifications/);
  });

  test("a member who refuses every push still gets a notice", async () => {
    globalThis.__pushes = [];
    globalThis.__prefsRead = false;
    globalThis.__vapid = true;
    await sendNoticePush("member-refuses-all", {
      title: "Reading group",
      body: "We have moved to B52",
      url: "/events/event-1",
    });
    assert.deepEqual(globalThis.__pushes, [
      {
        uid: "member-refuses-all",
        title: "Reading group",
        body: "We have moved to B52",
        url: "/events/event-1",
      },
    ]);
    assert.equal(
      globalThis.__prefsRead,
      false,
      "the door reached for a database, which is where a preference read starts",
    );
  });

  test("no VAPID keys, no uid, and a hostile destination are all quiet no-ops", async () => {
    globalThis.__pushes = [];
    globalThis.__vapid = false;
    await sendNoticePush("member-1", { title: "t", body: "b", url: "/events/e" });
    assert.deepEqual(globalThis.__pushes, [], "pushed with the feature dormant");

    globalThis.__vapid = true;
    await sendNoticePush("", { title: "t", body: "b", url: "/events/e" });
    assert.deepEqual(globalThis.__pushes, [], "pushed to nobody in particular");

    for (const url of ["https://elsewhere.example/x", "//elsewhere.example", ""]) {
      await sendNoticePush("member-1", { title: "t", body: "b", url });
    }
    assert.deepEqual(
      globalThis.__pushes,
      [],
      "a notification carrying this site's name that opens somebody else's page " +
        "is the worst thing this module could do",
    );
  });

  test("a push service having a bad day never reaches the caller", async () => {
    globalThis.__vapid = true;
    globalThis.__pushThrows = true;
    await sendNoticePush("member-1", { title: "t", body: "b", url: "/events/e" });
    globalThis.__pushThrows = false;
    // The absence of a rejection IS the assertion: a broadcast that delivered
    // forty emails must not answer 500 because one phone was unreachable.
    assert.ok(true);
  });
});

// ===========================================================================
// 3. The course group composer: two lanes, one wrapper
// ===========================================================================

const groupWrapperLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    [
      "./send",
      "export const sendEmail = async (args) => { (globalThis.__sent ||= []).push(args); };",
    ],
    [
      "./notice",
      "export const sendNotice = async (args) => { (globalThis.__notices ||= []).push(args); };",
    ],
  ]),
});

const { sendCourseGroupEmail } = await groupWrapperLoader.loadTs(
  "lib/email/courseFacilitatorEmails.ts",
);

describe("the group composer sends notices, and rehearses transactionally", () => {
  test("a real send goes through the notice door with the group surface", async () => {
    globalThis.__sent = [];
    globalThis.__notices = [];
    await sendCourseGroupEmail({
      to: "member@e2e.invalid",
      subject: "We are in B52",
      body: "Different room tonight.",
      senderName: "Ada",
      actorUid: "facilitator-1",
      test: false,
      groupId: "group-7",
      groupName: "Tuesday 6pm",
    });
    assert.equal(globalThis.__sent.length, 0, "a real group send bypassed the notice door");
    assert.equal(globalThis.__notices.length, 1);
    assert.equal(globalThis.__notices[0].surface, "course-group");
    assert.equal(globalThis.__notices[0].referenceId, "group-7");
    assert.equal(globalThis.__notices[0].subject, "We are in B52");
  });

  test("a rehearsal stays transactional, keeps its own kind and carries no marker", async () => {
    globalThis.__sent = [];
    globalThis.__notices = [];
    await sendCourseGroupEmail({
      to: "facilitator@e2e.invalid",
      subject: "We are in B52",
      body: "Different room tonight.",
      senderName: "Ada",
      actorUid: "facilitator-1",
      test: true,
      groupId: "group-7",
      groupName: "Tuesday 6pm",
    });
    assert.equal(globalThis.__notices.length, 0, "a rehearsal claimed to bypass a preference");
    assert.equal(globalThis.__sent.length, 1);
    assert.equal(globalThis.__sent[0].kind, "course-test");
    assert.match(globalThis.__sent[0].subject, /^\[TEST\] /);
    const html = await render(globalThis.__sent[0].react);
    assert.doesNotMatch(
      html,
      /Sent as an important notice/,
      "the marker's sentence would be false about a message to its own sender",
    );
  });
});

// ===========================================================================
// 4. The cohort audience, with and without the opt-out override
// ===========================================================================

const audienceLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => null;"],
    ["./send", "export const sendEmail = async () => {};"],
    ["./notice", "export const sendNotice = async () => {};"],
    [
      "@/lib/firestore/subscriptions",
      "export const findRecipientsForChannel = async () => globalThis.__channelRows ?? [];\n" +
        "export const findUnsubscribedOnChannel = async () => globalThis.__unsubscribedRows ?? [];",
    ],
    [
      "@/lib/firestore/suppression",
      "export const filterSuppressed = async (db, addrs) => ({ allowed: addrs, suppressed: [] });",
    ],
  ]),
});

const { resolveCohortAudience, countCohortUnreachable } = await audienceLoader.loadTs(
  "lib/email/courseFacilitatorEmails.ts",
);

const LANE = { logTag: "test", overCapAdvice: "split it" };

describe("the courses row is honoured on the announcement lane and overridden on the notice lane", () => {
  const world = () => {
    globalThis.__channelRows = [
      { email: "keen@e2e.invalid", audience: "user", audienceId: "keen" },
      { email: "refuser@e2e.invalid", audience: "user", audienceId: "refuser" },
    ];
    globalThis.__db = makeDb({
      courseEnrolments: {
        "run-1__keen": { runId: "run-1", uid: "keen", status: "active", groupId: "g1" },
        "run-1__refuser": { runId: "run-1", uid: "refuser", status: "active", groupId: "g1" },
      },
      users: {
        keen: { displayName: "Keen", profile: {} },
        refuser: {
          displayName: "Refuser",
          // A STORED false: the only thing an opt-out row reads as a refusal.
          profile: { notifications: { categories: { courses: false } } },
        },
      },
    });
    return globalThis.__db;
  };

  test("without the override, a stored refusal is dropped before anything renders", async () => {
    world();
    const audience = await resolveCohortAudience(globalThis.__db, "run-1", LANE);
    assert.deepEqual(
      audience.members.map((m) => m.uid).sort(),
      ["keen"],
      "the announcement lane is opt-outable and must stay so",
    );
    assert.equal(audience.skipped, 1);
  });

  test("with it, the refuser is in the audience and nothing else changes", async () => {
    world();
    const audience = await resolveCohortAudience(globalThis.__db, "run-1", LANE, {
      ignoreCategoryOptOut: true,
    });
    assert.deepEqual(audience.members.map((m) => m.uid).sort(), ["keen", "refuser"]);
    assert.equal(audience.skipped, 0);
    assert.equal(audience.enrolledCount, 2);
  });

  test("the override reaches no further than the preference: an ex-member stays out", async () => {
    world();
    globalThis.__db.data.courseEnrolments["run-1__refuser"].status = "withdrawn";
    const audience = await resolveCohortAudience(globalThis.__db, "run-1", LANE, {
      ignoreCategoryOptOut: true,
    });
    assert.deepEqual(
      audience.members.map((m) => m.uid),
      ["keen"],
      "a notice may bypass what somebody chose, never who they are",
    );
  });
});

describe("what a cohort send could not reach, and says so", () => {
  test("the run's ACTIVE members who left the list are counted, and nobody else", async () => {
    globalThis.__unsubscribedRows = [
      // Clicked the unsubscribe link in an announcement, still on the run.
      { email: "left@e2e.invalid", audience: "user", audienceId: "quit-the-list" },
      // Unsubscribed BECAUSE they left the run: not a member this failed to
      // reach, and counting them would be a different wrong number.
      { email: "gone@e2e.invalid", audience: "user", audienceId: "left-the-run" },
      // A guest row cannot hold an enrolment at all.
      { email: "stranger@e2e.invalid", audience: "guest", audienceId: "stranger@e2e.invalid" },
    ];
    globalThis.__db = makeDb({
      courseEnrolments: {
        "run-1__quit-the-list": { runId: "run-1", uid: "quit-the-list", status: "active" },
        "run-1__left-the-run": { runId: "run-1", uid: "left-the-run", status: "withdrawn" },
      },
    });
    assert.equal(await countCohortUnreachable(globalThis.__db, "run-1"), 1);
  });

  test("nobody unsubscribed is nobody to report, and no second read", async () => {
    globalThis.__unsubscribedRows = [];
    globalThis.__db = makeDb({ courseEnrolments: {} });
    assert.equal(await countCohortUnreachable(globalThis.__db, "run-1"), 0);
  });
});

// ===========================================================================
// 5. The event lanes: gate, audience, counts and caps
// ===========================================================================

const eventLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["next/server", NEXT_RESPONSE_STUB],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    [
      "@/lib/email/notice",
      "export const sendNotice = async (args) => {\n" +
        "  if (globalThis.__noticeThrows) throw new Error('transport down');\n" +
        "  (globalThis.__notices ||= []).push(args);\n" +
        "};",
    ],
    [
      "@/lib/push/noticeNotifications",
      // Returns TRUE, like the real door does when a device took the
      // notification: every route counts the answer rather than the call.
      "export const sendNoticePush = async (uid, n) => {\n" +
        "  (globalThis.__pushed ||= []).push({ uid, ...n });\n" +
        "  return globalThis.__pushLands !== false;\n" +
        "};",
    ],
    [
      "@/lib/firestore/suppression",
      "export const filterSuppressed = async (db, addrs) => ({\n" +
        "  allowed: addrs.filter((a) => !(globalThis.__suppressed ?? []).includes(a)),\n" +
        "  suppressed: addrs.filter((a) => (globalThis.__suppressed ?? []).includes(a)),\n" +
        "});",
    ],
    [
      "@/lib/events/rsvpToken",
      "export const baseUrl = () => 'https://naisi.test';\n" +
        "export const signRsvpToken = () => 'tok';\n" +
        "export const cancelUrl = (e, r) => `https://naisi.test/c/${e}/${r}`;\n" +
        "export const changeUrl = (e, r) => `https://naisi.test/u/${e}/${r}`;",
    ],
    [
      "@/lib/events/changeSummary",
      "export const formatEventWhen = () => 'Fri 6 June, 18:00';\n" +
        "export const parseEventChanges = () => [];",
    ],
  ]),
});

const broadcastRoute = await eventLoader.loadTs("app/api/events/[id]/broadcast/route.ts");
const cancelRoute = await eventLoader.loadTs("app/api/events/[id]/cancel/route.ts");
// The same module instance the routes hold: one loader, one graph, one stubbed
// `Timestamp`, so a counter this file fills is one they can read.
const caps = await eventLoader.loadTs("lib/email/noticeCaps.ts");

/** Spend a day window's whole budget on the audience `key`. */
async function fillDayCounter(key) {
  for (let i = 0; i < caps.NOTICES_PER_DAY; i += 1) {
    const claim = await caps.reserveNoticeSlots(globalThis.__db, {
      day: { key, limit: caps.NOTICES_PER_DAY, windowMs: caps.DAY_MS },
      noun: "notices",
    });
    assert.equal(claim.ok, true, `seeding claim ${i + 1} was refused`);
  }
}

const jsonRequest = (body) => ({ json: async () => body });
const ctxFor = (id) => ({ params: Promise.resolve({ id }) });

function seedEvent(extra = {}) {
  const rsvps = {};
  for (let i = 0; i < (extra.attendees ?? 2); i += 1) {
    rsvps[`rsvp-${i}`] = {
      eventId: "event-1",
      status: "confirmed",
      email: `person${i}@e2e.invalid`,
      name: `Person ${i}`,
      uid: `member-${i}`,
    };
  }
  globalThis.__notices = [];
  globalThis.__pushed = [];
  globalThis.__suppressed = [];
  globalThis.__pushLands = true;
  globalThis.__db = makeDb({
    events: {
      "event-1": {
        title: "Reading group",
        status: "published",
        authorUid: "author-1",
        collaboratorUids: ["collab-1"],
        location: "B52",
        ...(extra.event ?? {}),
      },
    },
    eventRsvps: rsvps,
    ...(extra.store ?? {}),
  });
  return globalThis.__db;
}

const viewer = (uid, role, extra = {}) => ({
  uid,
  role,
  suRecognised: false,
  permissions: {},
  ...extra,
});

describe("the event broadcast gate, as each person it now admits", () => {
  const message = jsonRequest({ subject: "Room change", body: "We are in B52." });

  const cases = [
    { who: "the event's author", user: viewer("author-1", "committee"), allowed: true },
    { who: "a named collaborator", user: viewer("collab-1", "member"), allowed: true },
    {
      who: "SU-recognised committee",
      user: viewer("su-1", "committee", { suRecognised: true }),
      allowed: true,
    },
    { who: "an admin", user: viewer("admin-1", "admin"), allowed: true },
    {
      who: "a plain committee member with no part in this event",
      user: viewer("stranger-1", "committee"),
      allowed: false,
    },
    { who: "a plain member", user: viewer("nobody-1", "member"), allowed: false },
    // BEING NAMED ON AN EVENT IS NOT A STANDING CREDENTIAL. `getCurrentUser`
    // hands back a session for every role, and an author's uid stays on the
    // event after the account is rejected or demoted to waiting-for-approval.
    // Either would otherwise keep the right to mail an attendee list they
    // cannot so much as read.
    {
      who: "the author of the event, since rejected",
      user: viewer("author-1", "rejected"),
      allowed: false,
    },
    {
      who: "a named collaborator who is still pending approval",
      user: viewer("collab-1", "pending"),
      allowed: false,
    },
  ];

  for (const { who, user, allowed } of cases) {
    test(`${who} is ${allowed ? "admitted" : "refused"}`, async () => {
      seedEvent();
      globalThis.__user = user;
      const res = await broadcastRoute.POST(message, ctxFor("event-1"));
      if (allowed) {
        assert.equal(res.status, 200, JSON.stringify(jsonOf(res)));
        assert.equal(jsonOf(res).sent, 2);
      } else {
        assert.equal(res.status, 403);
        assert.equal(globalThis.__notices.length, 0);
      }
    });
  }

  test("a signed-out caller is refused before the event is read", async () => {
    seedEvent();
    globalThis.__user = null;
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(res.status, 401);
  });

  test("a stranger cannot tell a missing event from somebody else's", async () => {
    seedEvent();
    globalThis.__user = viewer("stranger-1", "committee");
    const missing = await broadcastRoute.POST(message, ctxFor("no-such-event"));
    const present = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(missing.status, 403);
    assert.equal(present.status, 403);
  });
});

describe("the broadcast's audience and what it hands back", () => {
  const message = jsonRequest({ subject: "Room change", body: "We are in B52." });

  test("confirmed and waitlisted are attending; pending, denied and cancelled are not", async () => {
    seedEvent({ attendees: 0 });
    globalThis.__user = viewer("admin-1", "admin");
    const statuses = ["confirmed", "waitlisted", "pending", "denied", "cancelled"];
    globalThis.__db.data.eventRsvps = Object.fromEntries(
      statuses.map((status, i) => [
        `rsvp-${status}`,
        {
          eventId: "event-1",
          status,
          email: `${status}@e2e.invalid`,
          name: status,
          uid: `member-${i}`,
        },
      ]),
    );
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(res.status, 200);
    assert.deepEqual(
      globalThis.__notices.map((n) => n.to).sort(),
      ["confirmed@e2e.invalid", "waitlisted@e2e.invalid"],
    );
  });

  test("the response is counts, never an address", async () => {
    seedEvent({ attendees: 3 });
    globalThis.__suppressed = ["person1@e2e.invalid"];
    globalThis.__user = viewer("author-1", "committee");
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    const payload = jsonOf(res);
    assert.deepEqual(payload, { ok: true, sent: 2, failed: 0, suppressed: 1, pushed: 3 });
    assert.doesNotMatch(
      JSON.stringify(payload),
      /@e2e\.invalid/,
      "the RSVP list is PII this gate now admits people who cannot read it",
    );
  });

  test("`pushed` counts notifications, not calls", async () => {
    seedEvent({ attendees: 2 });
    // The door's silent outcomes: no VAPID keys on this backend, no device on
    // this account, a subscription pruned since. A count of CALLS would answer
    // "2 notified" on a backend where the feature is dormant.
    globalThis.__pushLands = false;
    globalThis.__user = viewer("admin-1", "admin");
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(jsonOf(res).pushed, 0);
    assert.equal(jsonOf(res).sent, 2, "the email is unaffected by a quiet phone");
  });

  test("push reaches every attendee with an account, suppressed inbox or not", async () => {
    seedEvent({ attendees: 2 });
    globalThis.__suppressed = ["person0@e2e.invalid"];
    globalThis.__db.data.eventRsvps["rsvp-guest"] = {
      eventId: "event-1",
      status: "confirmed",
      email: "guest@e2e.invalid",
      name: "Guest",
      uid: null,
    };
    globalThis.__user = viewer("admin-1", "admin");
    await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.deepEqual(
      globalThis.__pushed.map((p) => p.uid).sort(),
      ["member-0", "member-1"],
      "a guest with no account has nothing to push to, and a suppressed inbox " +
        "says nothing about a phone",
    );
    assert.deepEqual(
      globalThis.__notices.map((n) => n.to).sort(),
      ["guest@e2e.invalid", "person1@e2e.invalid"],
    );
  });
});

describe("the notice caps refuse rather than truncate, and they are durable", () => {
  const message = jsonRequest({ subject: "Room change", body: "We are in B52." });

  test("the fourth send in an hour is refused, and the counter survives the request", async () => {
    seedEvent();
    globalThis.__user = viewer("author-1", "committee");
    for (let i = 0; i < 3; i += 1) {
      const ok = await broadcastRoute.POST(message, ctxFor("event-1"));
      assert.equal(ok.status, 200, `send ${i + 1} was refused`);
    }
    const refused = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(refused.status, 429);
    assert.match(jsonOf(refused).error, /already had 3 notices in the last hour/);
    assert.ok(
      Number(refused.headers["Retry-After"]) > 0,
      "a refusal has to say when the window rolls over",
    );
    // Durable: the fourth request read the row the first three wrote. A counter
    // that lived in one process would have started again on every call.
    assert.equal(globalThis.__db.data.courseNudges["emailrate__eventnotice__event-1__author-1"].count, 3);
    assert.equal(globalThis.__notices.length, 6, "a refused send delivered mail anyway");
  });

  test("the daily cap counts the audience, whoever is sending", async () => {
    seedEvent();
    // Ten already spent today by somebody else. Claimed through the helper the
    // route uses, on the same loader instance, so the counter row is written by
    // the code that will read it rather than hand-forged into a shape the
    // window arithmetic might not recognise. The hourly key is per sender, so a
    // fresh sender still meets the audience's own ceiling.
    await fillDayCounter("eventnotice__event-1");
    globalThis.__user = viewer("collab-1", "member");
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(res.status, 429);
    assert.match(jsonOf(res).error, /already had 10 notices in the last day/);
    assert.equal(globalThis.__notices.length, 0);
  });

  test("an audience over the ceiling is refused whole, with nothing sent", async () => {
    seedEvent({ attendees: 301 });
    globalThis.__user = viewer("admin-1", "admin");
    const res = await broadcastRoute.POST(message, ctxFor("event-1"));
    assert.equal(res.status, 400);
    assert.match(jsonOf(res).error, /301 people, over the 300-recipient limit/);
    assert.equal(
      globalThis.__notices.length,
      0,
      "a partial send is the worst outcome available: it looks like a whole one",
    );
    assert.equal(
      globalThis.__db.data.courseNudges,
      undefined,
      "a refused send spent a rate-limit slot it never used",
    );
  });
});

describe("cancelling an event", () => {
  const notify = jsonRequest({ notify: true, note: "Sorry about this." });

  test("attendees are told through the notice lane, by email and notification", async () => {
    seedEvent({ event: { status: "published" }, attendees: 2 });
    globalThis.__user = viewer("approver-1", "member", { permissions: { approveEvent: true } });
    const res = await cancelRoute.POST(notify, ctxFor("event-1"));
    assert.equal(res.status, 200);
    assert.deepEqual(jsonOf(res), {
      ok: true,
      notified: true,
      sent: 2,
      failed: 0,
      suppressed: 0,
      pushed: 2,
    });
    assert.equal(globalThis.__db.data.events["event-1"].status, "cancelled");
    assert.ok(globalThis.__notices.every((n) => n.surface === "event-cancel"));
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid).sort(), ["member-0", "member-1"]);
  });

  test("a capped notice leaves the event uncancelled rather than cancelled in silence", async () => {
    seedEvent({ event: { status: "published" }, attendees: 2 });
    await fillDayCounter("eventnotice__event-1");
    globalThis.__user = viewer("approver-1", "member", { permissions: { approveEvent: true } });
    const res = await cancelRoute.POST(notify, ctxFor("event-1"));
    assert.equal(res.status, 429);
    assert.match(jsonOf(res).error, /has NOT been cancelled/);
    assert.equal(
      globalThis.__db.data.events["event-1"].status,
      "published",
      "the event was cancelled with nobody told, which is the outcome the " +
        "claim-before-write ordering exists to prevent",
    );
    assert.equal(globalThis.__notices.length, 0);
  });

  test("a cancellation is not rationed by the hour's change notices", async () => {
    seedEvent({ event: { status: "published" }, attendees: 2 });
    globalThis.__user = viewer("admin-1", "admin");
    const change = jsonRequest({ subject: "Room change", body: "We are in B52." });
    for (let i = 0; i < 3; i += 1) {
      const ok = await broadcastRoute.POST(change, ctxFor("event-1"));
      assert.equal(ok.status, 200, `change notice ${i + 1} was refused`);
    }
    assert.equal(
      (await broadcastRoute.POST(change, ctxFor("event-1"))).status,
      429,
      "the shared hourly window has to be spent for this test to mean anything",
    );

    globalThis.__notices = [];
    const res = await cancelRoute.POST(notify, ctxFor("event-1"));
    assert.equal(
      res.status,
      200,
      "the most time-critical send in the lane was rationed by the most routine one",
    );
    assert.equal(globalThis.__db.data.events["event-1"].status, "cancelled");
    assert.equal(globalThis.__notices.length, 2);
  });

  test("cancelling without notifying spends no slot and sends nothing", async () => {
    seedEvent({ event: { status: "published" }, attendees: 2 });
    globalThis.__user = viewer("admin-1", "admin");
    const res = await cancelRoute.POST(jsonRequest({ notify: false }), ctxFor("event-1"));
    assert.equal(res.status, 200);
    assert.equal(jsonOf(res).notified, false);
    assert.equal(globalThis.__db.data.events["event-1"].status, "cancelled");
    assert.equal(globalThis.__notices.length, 0);
    assert.equal(globalThis.__db.data.courseNudges, undefined);
  });
});

// ===========================================================================
// 6. The event announcement
// ===========================================================================

const announceLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    [
      "./send",
      "export const sendEmail = async (args) => {\n" +
        "  if (globalThis.__announceThrows) throw new Error('transport down');\n" +
        "  (globalThis.__sent ||= []).push(args);\n" +
        "};",
    ],
    [
      "@/lib/push/send",
      "export const sendPushToUid = async (uid, n) => {\n" +
        "  (globalThis.__pushed ||= []).push({ uid, ...n });\n" +
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
      "export const filterSuppressed = async (db, addrs) => ({\n" +
        "  allowed: addrs.filter((a) => !(globalThis.__suppressed ?? []).includes(a)),\n" +
        "  suppressed: addrs.filter((a) => (globalThis.__suppressed ?? []).includes(a)),\n" +
        "});",
    ],
    [
      "@/lib/signedTokens",
      "export const signToken = (payload) => `tok:${JSON.stringify(payload)}`;",
    ],
    // The REAL preference read, against the fake db, so the events push cell is
    // resolved by the one table of defaults rather than by this suite.
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
  ]),
});

const { sendEventAnnouncement, MAX_ANNOUNCEMENT_SENDS } =
  await announceLoader.loadTs("lib/email/eventAnnouncement.ts");
// The push ceiling moved out with the enumeration it bounds: the newsletter
// send pushes through the same helper, and two copies of one figure would have
// drifted. `tests/newsletter-push.test.mjs` executes the helper itself.
const { MAX_PUSH_ROWS } = await announceLoader.loadTs("lib/push/rowAudience.ts");

const ANNOUNCEMENT = {
  eventId: "event-1",
  title: "Reading group",
  whenLine: "Fri 6 June, 18:00",
  locationLine: "Somewhere on campus",
  eventUrl: "https://naisi.test/events/event-1",
  coverImageUrl: null,
  membersOnly: false,
  actorUid: "approver-1",
};

describe("the event announcement: the events row's own sender", () => {
  function world({ membersOnly = false } = {}) {
    globalThis.__sent = [];
    globalThis.__pushed = [];
    globalThis.__suppressed = [];
    globalThis.__vapid = true;
    globalThis.__pushCounts = undefined;
    globalThis.__channelRows = [
      { email: "member@e2e.invalid", audience: "user", audienceId: "member-1" },
      { email: "guest@e2e.invalid", audience: "guest", audienceId: "guest@e2e.invalid" },
    ];
    globalThis.__db = makeDb({
      users: {
        "member-1": {
          email: "member@e2e.invalid",
          displayName: "Mem",
          // Both cells ON: the junction row is the email opt-in, and the push
          // cell is a separate answer that has to be given explicitly.
          profile: {
            notifications: {
              categories: { events: true },
              push: { events: true },
            },
          },
        },
        "member-quiet": {
          email: "quiet@e2e.invalid",
          displayName: "Quiet",
          profile: { notifications: { push: { events: false } } },
        },
      },
      pushSubscriptions: {
        "device-1": { uid: "member-1", endpoint: "https://push.test/1" },
        "device-2": { uid: "member-quiet", endpoint: "https://push.test/2" },
      },
    });
    return { ...ANNOUNCEMENT, membersOnly };
  }

  test("email goes to the junction, push goes to the push cell, and they are two answers", async () => {
    const input = world();
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.equal(globalThis.__channelAsked, "events");
    assert.deepEqual(
      globalThis.__sent.map((s) => s.to).sort(),
      ["guest@e2e.invalid", "member@e2e.invalid"],
    );
    assert.ok(globalThis.__sent.every((s) => s.kind === "event-announcement"));
    assert.ok(globalThis.__sent.every((s) => s.referenceId === "event-1"));
    // The push audience is NOT the junction: `member-quiet` holds no events
    // subscription row and is pushed on nothing, while `member-1` is pushed
    // because their push cell is on.
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
    assert.equal(result.sent, 2);
    assert.equal(result.pushed, 1);
  });

  test("every message carries an unsubscribe link and the RFC 8058 header", async () => {
    const input = world();
    await sendEventAnnouncement(globalThis.__db, input);
    for (const message of globalThis.__sent) {
      assert.ok(message.listUnsubscribe?.url, "an opt-in list must be leaveable");
      assert.match(decodeURIComponent(message.listUnsubscribe.url), /"c":"events"/);
    }
    // Members get a uid token (one click drops both their addresses); guests get
    // an email token, which is the only handle they have.
    const byTo = Object.fromEntries(
      globalThis.__sent.map((m) => [m.to, decodeURIComponent(m.listUnsubscribe.url)]),
    );
    assert.match(byTo["member@e2e.invalid"], /"uid":"member-1"/);
    assert.match(byTo["guest@e2e.invalid"], /"email":"guest@e2e.invalid"/);
  });

  test("a members-only event never reaches an address with no account", async () => {
    const input = world({ membersOnly: true });
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["member@e2e.invalid"]);
    assert.equal(result.skipped, 1);
  });

  test("a member whose events email cell is off is skipped, junction row or not", async () => {
    const input = world();
    globalThis.__db.data.users["member-1"].profile.notifications.categories.events = false;
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.deepEqual(globalThis.__sent.map((s) => s.to), ["guest@e2e.invalid"]);
    assert.equal(result.skipped, 1);
    // ...and their PUSH cell is a separate answer, still on.
    assert.deepEqual(globalThis.__pushed.map((p) => p.uid), ["member-1"]);
  });

  test("a list over the ceiling is refused whole", async () => {
    const input = world();
    globalThis.__channelRows = Array.from({ length: 501 }, (_, i) => ({
      email: `guest${i}@e2e.invalid`,
      audience: "guest",
      audienceId: `guest${i}@e2e.invalid`,
    }));
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.match(result.refusal ?? "", /larger than a single announcement/);
    assert.equal(globalThis.__sent.length, 0);
  });

  test("THE CEILING COUNTS MESSAGES, NOT JUNCTION ROWS", async () => {
    const input = world();
    // 120 members, each holding a verified university address on both channels:
    // 240 messages out of 120 rows. Under the 500-row read ceiling and over the
    // 200-message send one, which is the case a row count cannot see and the
    // case that runs the publish request past its 60s budget.
    const rows = [];
    const users = {};
    for (let i = 0; i < 120; i += 1) {
      rows.push({ email: `both${i}@e2e.invalid`, audience: "user", audienceId: `both-${i}` });
      users[`both-${i}`] = {
        email: `both${i}@e2e.invalid`,
        displayName: `Both ${i}`,
        profile: {
          universityEmail: `both${i}@nottingham.ac.uk`,
          notifications: {
            channels: { gmail: true, uniEmail: true },
            categories: { events: true },
          },
        },
      };
    }
    globalThis.__channelRows = rows;
    globalThis.__db.data.users = users;

    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.match(
      result.refusal ?? "",
      new RegExp(`240 emails, over the ${MAX_ANNOUNCEMENT_SENDS}`),
    );
    assert.equal(globalThis.__sent.length, 0, "a partial announcement looks like a whole one");
  });

  test("both ceilings are sized against the pacer's sum, and the sum names this lane", () => {
    const source = src("lib", "email", "eventAnnouncement.ts");
    // Counted on ADDRESSES, after hydration: the only count that is the number
    // of sends.
    assert.match(source, /r\.addresses\.length/);
    // The two legs run together, so the request's budget is the larger rather
    // than the sum of the two.
    assert.match(source, /Promise\.all\(\[\s*\n\s*announceByEmail/);
    // Tripwires, not preferences: these are the figures `dispatch.ts` did the
    // 60s arithmetic for, at each leg's own per-item cost. Raising either means
    // redoing that sum, which is the whole point of failing here first.
    assert.ok(
      MAX_ANNOUNCEMENT_SENDS <= 300,
      "the notice lane's 300 messages is the outer bound the sum was redone for",
    );
    assert.ok(MAX_PUSH_ROWS <= 500, "the push leg's ~34s worst case is sized at 500 owners");
    assert.match(
      src("lib", "email", "dispatch.ts"),
      /MAX_ANNOUNCEMENT_SENDS/,
      "a capped `dispatchSends` caller that the wall-clock sum does not name is " +
        "a cap nobody checked against the request timeout",
    );
  });

  test("`pushed` counts notifications: a cell that is on with no device is nobody told", async () => {
    const input = world();
    globalThis.__pushCounts = { sent: 0, pruned: 1, deferred: 0, failed: 0, retried: 0 };
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.equal(result.pushed, 0);
    assert.equal(result.sent, 2, "the email is unaffected by a quiet phone");
  });

  test("with push dormant nothing is pushed and the email is unaffected", async () => {
    const input = world();
    globalThis.__vapid = false;
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.equal(result.pushed, 0);
    assert.equal(result.sent, 2);
    assert.equal(
      result.pushRefusal,
      null,
      "an unprovisioned backend is silence by design, and a publisher must not be " +
        "told the announcement was refused when it was not",
    );
  });

  test("the two legs refuse independently, and both refusals reach the publisher", async () => {
    // The email leg is over its row ceiling and the push leg is fine. One
    // refusal must not stand in for the other: a publisher told "the events
    // list is too large" has learnt nothing about whether the phones buzzed.
    const input = world();
    globalThis.__channelRows = Array.from({ length: 501 }, (_, i) => ({
      email: `guest${i}@e2e.invalid`,
      audience: "guest",
      audienceId: `guest${i}@e2e.invalid`,
    }));
    const result = await sendEventAnnouncement(globalThis.__db, input);
    assert.match(result.refusal ?? "", /larger than a single announcement/);
    assert.equal(result.pushRefusal, null);
    assert.equal(result.pushed, 1, "the push audience is told even when the list is not");
  });
});

// ===========================================================================
// 7. Publishing: the claim, and the failure that must not propagate
// ===========================================================================

const publishLoader = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["next/server", NEXT_RESPONSE_STUB],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    ["@/lib/events/rsvpToken", "export const baseUrl = () => 'https://naisi.test';"],
    ["@/lib/events/changeSummary", "export const formatEventWhen = () => 'Fri 6 June, 18:00';"],
    // THE SWITCH, AS A DOOR. The real helper reads `config/scheduler` through
    // the registry, which would pull every registered job into this suite's
    // graph for one boolean. It is exercised for real in
    // `tests/event-announcements-job.test.mjs`, against a fake config
    // document; here it is the knob that says which path a publish takes.
    [
      "@/lib/scheduler/announcementQueue",
      "export const announcementQueueEnabled = async () => globalThis.__queueAnnouncements === true;",
    ],
    [
      "@/lib/email/eventAnnouncement",
      "export const sendEventAnnouncement = async (db, input) => {\n" +
        "  if (globalThis.__announceThrows) throw new Error('subscriptions unreadable');\n" +
        "  (globalThis.__announcements ||= []).push(input);\n" +
        "  return (\n" +
        "    globalThis.__announceResult ??\n" +
        "    { sent: 1, skipped: 0, suppressed: 0, failed: 0, pushed: 1, refusal: null }\n" +
        "  );\n" +
        "};",
    ],
  ]),
});

const publishRoute = await publishLoader.loadTs("app/api/events/[id]/publish/route.ts");

describe("publishing announces once, and never fails because the announcement did", () => {
  function seed(event = {}) {
    globalThis.__announcements = [];
    globalThis.__announceThrows = false;
    globalThis.__announceResult = undefined;
    // OFF by default, which is the shipped default and the state every
    // assertion below the queued pair describes.
    globalThis.__queueAnnouncements = false;
    globalThis.__user = viewer("approver-1", "member", { permissions: { approveEvent: true } });
    globalThis.__db = makeDb({
      events: {
        "event-1": {
          title: "Reading group",
          status: "approved",
          visibility: "public",
          location: "B52",
          ...event,
        },
      },
    });
  }

  test("it publishes and announces in one pass", async () => {
    seed();
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(res.status, 200);
    assert.equal(jsonOf(res).announced, true);
    const stored = globalThis.__db.data.events["event-1"];
    assert.equal(stored.status, "published");
    assert.ok(stored.announcedAt, "the claim is stamped inside the write that publishes");
    assert.equal(globalThis.__announcements.length, 1);
    assert.equal(globalThis.__announcements[0].membersOnly, false);
  });

  test("with the queue switched ON it queues and sends nothing", async () => {
    seed();
    globalThis.__queueAnnouncements = true;
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(res.status, 200);
    const payload = jsonOf(res);
    assert.equal(payload.announcementQueued, true);
    assert.equal(
      payload.announced,
      false,
      "`announced` has always meant somebody was told, and on this path nobody has been yet",
    );
    assert.equal(
      globalThis.__announcements.length,
      0,
      "the request sent the announcement itself, which is the whole thing the queue exists to stop",
    );
    const stored = globalThis.__db.data.events["event-1"];
    assert.equal(stored.status, "published");
    assert.ok(
      stored.announcedAt,
      "the once-per-event claim is stamped on both paths: queueing is not announcing twice",
    );
    assert.equal(stored.announcementState, "queued");
    assert.ok(stored.announcementQueuedAt, "the job orders its backlog by this");
  });

  test("a republish with the queue ON re-queues nothing either", async () => {
    // The claim is what stops a second announcement, and it stops the QUEUED
    // one for the same reason it stops the inline one: an event pulled back to
    // approved and pushed live again is not news twice.
    seed({ announcedAt: { __op: "serverTimestamp" } });
    globalThis.__queueAnnouncements = true;
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(jsonOf(res).announced, false);
    assert.equal(jsonOf(res).announcementQueued, undefined);
    assert.equal(globalThis.__db.data.events["event-1"].announcementState, undefined);
  });

  test("with the queue switched OFF the inline path writes no queue state", async () => {
    // The shipped default, said out loud: an environment nobody has flipped
    // the switch on sees exactly what it saw before this feature landed.
    seed();
    await publishRoute.POST({}, ctxFor("event-1"));
    const stored = globalThis.__db.data.events["event-1"];
    assert.equal(stored.announcementState, undefined);
    assert.equal(stored.announcementQueuedAt, undefined);
    assert.equal(globalThis.__announcements.length, 1);
  });

  test("a republish announces nothing, because the claim is already stamped", async () => {
    seed({ announcedAt: { __op: "serverTimestamp" } });
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(res.status, 200);
    assert.equal(jsonOf(res).announced, false);
    assert.equal(globalThis.__db.data.events["event-1"].status, "published");
    assert.equal(globalThis.__announcements.length, 0);
  });

  test("a second publish of a live event is refused by the status transition", async () => {
    seed();
    await publishRoute.POST({}, ctxFor("event-1"));
    const again = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(again.status, 400);
    assert.equal(globalThis.__announcements.length, 1);
  });

  test("a members-only event says so, and its hidden location stays hidden", async () => {
    seed({
      visibility: "members",
      locationHidden: true,
      locationPublicText: "Somewhere on University Park",
    });
    await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(globalThis.__announcements[0].membersOnly, true);
    assert.equal(
      globalThis.__announcements[0].locationLine,
      "Somewhere on University Park",
      "the announcement list is not the attendee list, so the exact room is not theirs",
    );
  });

  test("a failed announcement leaves the event published and says so", async (t) => {
    // The route logs the failure with its stack, and under this loader a
    // stack frame is a whole module as a data: URL. See tests/lib/outputGuard.mjs.
    t.mock.method(console, "error", () => {});
    seed();
    globalThis.__announceThrows = true;
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(res.status, 200, "a missing email turned into a failed publish");
    assert.equal(jsonOf(res).ok, true);
    assert.equal(jsonOf(res).announcementFailed, true);
    assert.equal(globalThis.__db.data.events["event-1"].status, "published");
  });

  test("a REFUSED announcement hands the claim back, so it can go out later", async () => {
    seed();
    // The deterministic pre-dispatch refusal: nothing sent, nothing failed,
    // nothing pushed, and a sentence saying why. The claim bought nothing.
    globalThis.__announceResult = {
      sent: 0,
      skipped: 0,
      suppressed: 0,
      failed: 0,
      pushed: 0,
      refusal: "The events list is larger than a single announcement can handle.",
    };
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    const payload = jsonOf(res);
    assert.equal(res.status, 200);
    assert.equal(payload.announced, false);
    assert.equal(payload.announcementRefused, true);
    const stored = globalThis.__db.data.events["event-1"];
    assert.equal(stored.status, "published", "a refused announcement failed the publish");
    assert.ok(
      !stored.announcedAt,
      "the once-per-event claim stayed spent on a send that never happened, so " +
        "no republish can ever announce this event",
    );
  });

  test("a partly delivered announcement KEEPS its claim, refusal or not", async () => {
    seed();
    globalThis.__announceResult = {
      sent: 4,
      skipped: 0,
      suppressed: 0,
      failed: 1,
      pushed: 0,
      refusal: "The push leg was refused.",
    };
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(jsonOf(res).announced, true);
    assert.ok(
      globalThis.__db.data.events["event-1"].announcedAt,
      "releasing here would re-mail the four people who already have it",
    );
  });

  test("`announced` is whether anybody was told, not whether the attempt ran", async () => {
    seed();
    // Nobody subscribed, or everybody's cell is off: the send ran correctly and
    // reached nobody. No refusal, so the claim stands.
    globalThis.__announceResult = {
      sent: 0,
      skipped: 4,
      suppressed: 0,
      failed: 0,
      pushed: 0,
      refusal: null,
    };
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(jsonOf(res).announced, false);
    assert.ok(globalThis.__db.data.events["event-1"].announcedAt);
  });

  test("the publisher is told what the announcement did, and warned before it happens", () => {
    const editor = src("features", "events", "EventEditor.tsx");
    // The route's three answers all reach a person. A response nobody reads is
    // the same as no response: the event is live and nobody heard.
    assert.match(editor, /announcementLine\(body\)/);
    assert.match(editor, /body\.announcementFailed/);
    assert.match(editor, /body\.announcementRefused/);
    // The fourth answer, which is the queued path's only one: the request can
    // say nothing more than "it is queued", and everything after that is read
    // off the event document by `queuedAnnouncementLine`.
    assert.match(editor, /body\.announcementQueued/);
    assert.match(editor, /queuedAnnouncementLine\(event\)/);
    assert.match(editor, /goes out with the next\s*\+?\s*"?scheduler run/);
    // And the confirm says what pressing Publish does.
    assert.match(editor, /subscribed[\s\S]{0,40}to event announcements is emailed/);

    // ORDER MATTERS INSIDE `announcementLine`, and it is the one thing a
    // reader of that function cannot see at a glance. The two legs fail
    // independently, so an empty events list (announced false, no refusal)
    // can sit beside a push leg that refused. If the `!body.announced` return
    // came first, that publisher would be shown nothing at all about the leg
    // that failed, which is the same silence the whole function exists to
    // end. So the trailer is built, and consulted, above it.
    const trailerAt = editor.indexOf("const trailer = [refusal, pushRefusal]");
    const notAnnouncedAt = editor.indexOf("if (!body.announced)");
    assert.ok(trailerAt > 0, "the push refusal trailer has moved: re-read announcementLine");
    assert.ok(notAnnouncedAt > 0, "the not-announced branch has moved: re-read announcementLine");
    assert.ok(
      trailerAt < notAnnouncedAt,
      "the not-announced branch returns before the push refusal is used, so a publish " +
        "that told nobody by email and could not notify anybody either says nothing",
    );
    assert.match(
      editor.slice(notAnnouncedAt, notAnnouncedAt + 1200),
      /return trailer \? `The event is published\. \$\{trailer\}` : null;/,
      "the not-announced branch must still report a refusal when there is one",
    );
  });

  test("a member with no approve permission cannot publish at all", async () => {
    seed();
    globalThis.__user = viewer("member-1", "member");
    const res = await publishRoute.POST({}, ctxFor("event-1"));
    assert.equal(res.status, 403);
    assert.equal(globalThis.__db.data.events["event-1"].status, "approved");
  });
});

describe("the course lanes push to the room, not to the deliverable half of it", () => {
  const EMAIL = src("app", "api", "courses", "groups", "[groupId]", "email", "route.ts");
  const NOTICE = src("app", "api", "courses", "groups", "[groupId]", "notice", "route.ts");

  test("both push loops run over the whole audience", () => {
    // Suppression is a fact about an INBOX and says nothing about a phone:
    // the rule both event lanes state in their own comments. A push leg over
    // `deliverable` would silently apply an email fact to a device.
    for (const [name, source] of [["email", EMAIL], ["notice", NOTICE]]) {
      assert.match(
        source,
        /for \(const recipient of recipients\)/,
        `the ${name} lane pushes over a filtered list`,
      );
      assert.doesNotMatch(source, /for \(const recipient of deliverable\)/);
    }
  });

  test("a room whose addresses have all bounced is not an early return", () => {
    // It still has devices, and a room change on a lock screen an hour before
    // the session is the whole point of the lane.
    assert.doesNotMatch(
      NOTICE,
      /if \(deliverable\.length === 0\) \{/,
      "an all-suppressed group sent nothing at all, email or notification",
    );
    // The email lane keeps ONE, for the rehearsal: a test send has no push leg,
    // so an undeliverable one really is nothing to do.
    assert.match(EMAIL, /if \(testOnly && deliverable\.length === 0\)/);
    assert.doesNotMatch(EMAIL, /\n  if \(deliverable\.length === 0\) \{/);
  });

  test("both count notifications rather than calls", () => {
    for (const source of [EMAIL, NOTICE]) {
      assert.match(source, /if \(buzzed\) pushed \+= 1;/);
    }
  });
});

// ===========================================================================
// 8. The run composer's two lanes, at the source
// ===========================================================================

describe("the run composer carries a grid lane and a notice lane, visibly", () => {
  const ROUTE = src("app", "api", "courses", "runs", "[runId]", "email", "route.ts");
  const COMPOSER = src("features", "courses", "StaffEmailComposer.tsx");

  test("the flag is a literal true, and a test send is never a notice", () => {
    assert.match(ROUTE, /\(raw as Record<string, unknown>\)\.asNotice === true/);
    assert.match(ROUTE, /const asNotice =\s*\n\s*!testOnly &&/);
  });

  test("the two audiences differ by exactly one option", () => {
    assert.match(
      ROUTE,
      /resolveCohortAudience\(db, runId, LANE, \{ ignoreCategoryOptOut: true \}\)/,
    );
    assert.match(ROUTE, /resolveCohortAudience\(db, runId, LANE\)/);
  });

  test("the notice lane mints no unsubscribe token and pushes; the grid lane does neither", () => {
    const noticeLane = /if \(asNotice\) \{[\s\S]*?\n    \}/.exec(ROUTE);
    assert.ok(noticeLane, "the notice lane moved: re-read this route");
    assert.doesNotMatch(noticeLane[0], /unsubscribeUrl|signToken/);
    assert.match(noticeLane[0], /surface: "course-run"/);
    // Push is inside the flag, so an opt-outable announcement never buzzes a
    // phone: that is how people learn to switch notifications off for good.
    assert.match(ROUTE, /if \(asNotice\) \{\s*\n\s*for \(const recipient of recipients\)/);
  });

  test("the notice lane reports the cohort members it could not reach", () => {
    // `ignoreCategoryOptOut` relaxes the `courses` ROW and nothing else: the
    // audience is still the subscription channel, so somebody who unsubscribed
    // from the cohort's emails is not reached and is not in `skipped` either.
    // Invisible is the one thing that must not be.
    assert.match(ROUTE, /countCohortUnreachable\(db, runId\)/);
    assert.match(COMPOSER, /could not be reached at all/);
    assert.match(COMPOSER, /who unsubscribed from this cohort's emails is not on the list/);
    assert.doesNotMatch(
      COMPOSER,
      /reaches everyone in the cohort whatever/,
      "the tick promised a reach the lane does not have",
    );
  });

  test("the composer offers the tick, and says what it costs the recipient", () => {
    assert.match(COMPOSER, /label="Send as an important notice"/);
    assert.match(COMPOSER, /whatever their notification/);
    assert.match(COMPOSER, /asNotice: audience\.kind === "run" && asNotice && !testOnly/);
    // The tick is off on arrival and is not remembered: a class this
    // consequential is chosen per message.
    assert.match(COMPOSER, /useState\(false\);\s*\n\s*const \[busy/);
  });
});

// ===========================================================================
// 9. The deliverability tab shows what bypassed
// ===========================================================================

describe("a bypass is visible in the send log", () => {
  test("the row carries the surface, and the route hands it to the tab", () => {
    assert.match(src("lib", "firestore", "emailSends.ts"), /if \(entry\.surface\) doc\.surface/);
    assert.match(
      src("app", "api", "admin", "deliverability", "sends", "route.ts"),
      /surface: data\.surface as string \| undefined/,
    );
  });

  test("the dashboard names the kind and the surface", () => {
    const dashboard = src("features", "admin", "DeliverabilityDashboard.tsx");
    assert.match(dashboard, /notice: "Important notice"/);
    assert.match(dashboard, /"event-broadcast": "event attendees"/);
    assert.match(dashboard, /kindBadge\(s\.kind, s\.surface\)/);
  });

  test("a withheld notice keeps its surface too", () => {
    // A suppression row is the trace of a message that was never sent. If it
    // dropped the surface, "what bypassed the grid" would answer only for the
    // half that was deliverable.
    const sends = src("lib", "firestore", "emailSends.ts");
    const suppressed = /export async function logSuppressedSend[\s\S]*?\n}/.exec(sends);
    assert.ok(suppressed, "logSuppressedSend moved");
    assert.match(suppressed[0], /entry\.surface/);
  });
});
