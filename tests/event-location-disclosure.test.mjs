/**
 * An event's exact location reaches a person only through
 * `src/lib/events/location.ts`, and only when they hold a confirmed place.
 *
 * WHY. An organiser can mark an event's location hidden and give a public
 * label instead ("somewhere on University Park"). The rule for who sees the
 * exact one is short: a person holding a CONFIRMED place. On 8 September 2026
 * an audit found the rule re-derived inline in eight files and wrong in two of
 * them, in the same direction: the RSVP acknowledgement guarded its redaction
 * on the public label being non-empty, so clearing the label switched the
 * redaction OFF and every acknowledgement carried the exact address; and the
 * organiser broadcast used the exact text for its whole audience, which
 * includes the waitlist, whose own waitlist email had carried the public label
 * on purpose. The home page's upcoming list had the first fault too, which the
 * audit did not see. The fix is one module that decides, and this guard is
 * what keeps every other file out of the decision:
 *
 *  1. THE HELPER, executed. It fails closed: a hidden location with an empty
 *     label yields a placeholder, never the exact text, for anyone without a
 *     confirmed place; a holder gets the exact text and a disclosure note.
 *  2. THE ROUTES, executed against a fake Firestore with the real templates
 *     rendered to HTML: the acknowledgement, the waitlist email, the promoted
 *     email, the organiser broadcast to a mixed audience with a location diff,
 *     and the update route's refusal of a hidden location with no label. The
 *     assertion in each is on the rendered HTML, because a route can pass the
 *     right line to a template that then renders another prop.
 *  3. THE TREE, walked. Every file under `src` that touches an event's
 *     location fields is registered with a role and a reason, both directions.
 *     A renderer imports the helper and reads none of the three fields raw; a
 *     relay may pass the fields along but may not branch on `locationHidden`;
 *     a template takes a finished line; the chokepoint is exactly one file and
 *     is the only one that branches. The regexes are exercised on synthetic
 *     snippets so a guard that had quietly stopped matching fails rather than
 *     passes.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@react-email/render";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const CHOKEPOINT = "src/lib/events/location.ts";

const EXACT = "Flat 3, 21 Foo Road";
const LABEL = "Somewhere in Lenton";

// ---------------------------------------------------------------------------
// A fake Firestore: documents, equality and `in` queries with an orderBy and a
// limit, auto ids, and a transaction whose `get` takes a document or a query.
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

  const valueOf = (row, field) => field.split(".").reduce((acc, k) => acc?.[k], row);

  function runQuery(q) {
    let rows = Object.entries(data[q.__collection] ?? {}).filter(([, row]) =>
      q.__filters.every(([field, op, value]) => {
        const actual = valueOf(row, field);
        if (op === "==") return actual === value;
        if (op === "in") return value.includes(actual);
        throw new Error(`the fake Firestore does not implement "${op}"`);
      }),
    );
    for (const [field, direction] of q.__order) {
      rows = rows.sort(([, a], [, b]) => {
        const left = valueOf(a, field) ?? 0;
        const right = valueOf(b, field) ?? 0;
        return direction === "desc" ? (right > left ? 1 : -1) : left > right ? 1 : -1;
      });
    }
    if (typeof q.__limit === "number") rows = rows.slice(0, q.__limit);
    const docs = rows.map(([id]) => snapOf(q.__collection, id));
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  const resolve = (value) => {
    if (value && typeof value === "object" && value.__op === "serverTimestamp") {
      return { __op: "serverTimestamp", toMillis: () => NOW };
    }
    return value;
  };

  const write = (ref, patch, merge) => {
    data[ref.__collection] ??= {};
    const current = merge ? (data[ref.__collection][ref.__id] ?? {}) : {};
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === "object" && value.__op === "delete") delete next[key];
      else next[key] = resolve(value);
    }
    data[ref.__collection][ref.__id] = next;
  };

  function docRef(collection, id) {
    const ref = { __collection: collection, __id: id, id };
    ref.get = async () => snapOf(collection, id);
    ref.set = async (patch, options) => write(ref, patch, options?.merge === true);
    ref.update = async (patch) => write(ref, patch, true);
    return ref;
  }

  function collectionRef(name, filters = [], order = [], limit) {
    return {
      __collection: name,
      __filters: filters,
      __order: order,
      __limit: limit,
      doc: (id) => docRef(name, id ?? `auto-${(autoIds += 1)}`),
      where: (field, op, value) => collectionRef(name, [...filters, [field, op, value]], order, limit),
      orderBy: (field, direction = "asc") =>
        collectionRef(name, filters, [...order, [field, direction]], limit),
      limit: (n) => collectionRef(name, filters, order, n),
      get: async function () {
        return runQuery(this);
      },
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
        get: async (ref) => (ref.__id !== undefined ? snapOf(ref.__collection, ref.__id) : runQuery(ref)),
        set: (ref, patch) => write(ref, patch, false),
        update: (ref, patch) => write(ref, patch, true),
      });
    },
  };
}

const FIRESTORE_STUB =
  "export class Timestamp {\n" +
  "  constructor(ms) { this.ms = ms; }\n" +
  "  toMillis() { return this.ms; }\n" +
  "  toDate() { return new Date(this.ms); }\n" +
  "  static fromMillis(ms) { return new Timestamp(ms); }\n" +
  "  static fromDate(d) { return new Timestamp(d.getTime()); }\n" +
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

const TOKEN_STUB =
  "export const baseUrl = () => 'https://naisi.test';\n" +
  "export const signRsvpToken = () => 'tok';\n" +
  "export const verifyRsvpToken = () => false;\n" +
  "export const cancelUrl = (e, r) => `https://naisi.test/c/${e}/${r}`;\n" +
  "export const changeUrl = (e, r) => `https://naisi.test/u/${e}/${r}`;";

const { loadTs } = createLoader({
  stubs: new Map([
    ["server-only", "export {};"],
    ["next/server", NEXT_RESPONSE_STUB],
    ["firebase-admin/firestore", FIRESTORE_STUB],
    ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
    ["@/lib/firebase/session", "export const getCurrentUser = async () => globalThis.__user ?? null;"],
    // The transport, recorded with the React element intact so the test can
    // render the real template and read what the recipient would see.
    [
      "@/lib/email/send",
      "export const sendEmail = async (args) => { (globalThis.__sent ||= []).push(args); };",
    ],
    [
      "@/lib/email/notice",
      "export const sendNotice = async (args) => { (globalThis.__notices ||= []).push(args); };",
    ],
    [
      "@/lib/push/noticeNotifications",
      "export const sendNoticePush = async () => false;",
    ],
    [
      "@/lib/firestore/suppression",
      "export const isSuppressed = async () => false;\n" +
        "export const filterSuppressed = async (db, addrs) => ({ allowed: addrs, suppressed: [] });",
    ],
    ["@/lib/events/rsvpToken", TOKEN_STUB],
    ["./rsvpToken", TOKEN_STUB],
    // The publish route's two doors, closed: this suite asks it only whether
    // it refuses a hidden location with no label before it writes anything.
    ["@/lib/email/eventAnnouncement", "export const sendEventAnnouncement = async () => ({ sent: 0, skipped: 0, suppressed: 0, failed: 0, pushed: 0 });"],
    ["@/lib/scheduler/announcementQueue", "export const announcementQueueEnabled = async () => false;"],
  ]),
});

const location = await loadTs("lib/events/location.ts");
const rsvpRoute = await loadTs("app/api/events/[id]/rsvp/route.ts");
const approveRoute = await loadTs("app/api/events/[id]/rsvp/[rsvpId]/approve/route.ts");
const cancelRsvpRoute = await loadTs("app/api/events/[id]/rsvp/[rsvpId]/cancel/route.ts");
const broadcastRoute = await loadTs("app/api/events/[id]/broadcast/route.ts");
const updateRoute = await loadTs("app/api/events/[id]/update/route.ts");
const publishRoute = await loadTs("app/api/events/[id]/publish/route.ts");

const jsonRequest = (body) => ({ json: async () => body });
const ctxFor = (params) => ({ params: Promise.resolve(params) });

/** The HTML the last recorded RSVP email would render to. */
async function lastRsvpHtml() {
  const sent = globalThis.__sent;
  assert.ok(sent.length > 0, "no RSVP email was sent");
  return render(sent[sent.length - 1].react);
}

/** Wait for the fire-and-forget send the routes issue after answering. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function hiddenEvent(extra = {}) {
  return {
    title: "Reading group",
    status: "published",
    visibility: "public",
    location: EXACT,
    locationHidden: true,
    locationPublicText: LABEL,
    authorUid: "organiser-1",
    collaboratorUids: [],
    signupForm: [],
    capacity: 1,
    waitlistEnabled: true,
    rsvpCountPending: 0,
    rsvpCountConfirmed: 0,
    rsvpCountWaitlisted: 0,
    ...extra,
  };
}

const approver = {
  uid: "organiser-1",
  email: "organiser@e2e.invalid",
  displayName: "Organiser",
  role: "committee",
  suRecognised: true,
  permissions: { approveEvent: true, draftEvent: true },
};

beforeEach(() => {
  globalThis.__sent = [];
  globalThis.__notices = [];
  globalThis.__user = null;
});

// ===========================================================================
// 1. The helper
// ===========================================================================

describe("the location helper decides, and fails closed", () => {
  const hidden = { location: EXACT, locationHidden: true, locationPublicText: LABEL };
  const hiddenNoLabel = { location: EXACT, locationHidden: true, locationPublicText: "" };
  const open = { location: EXACT, locationHidden: false, locationPublicText: null };

  test("only a confirmed place holds the exact location", () => {
    assert.equal(location.holdsPlace("confirmed"), true);
    for (const status of ["pending", "waitlisted", "denied", "cancelled", "", null, undefined]) {
      assert.equal(location.holdsPlace(status), false, `${String(status)} must not hold a place`);
    }
  });

  test("a holder gets the exact text, with a disclosure when it was hidden", () => {
    assert.deepEqual(location.locationForAttendee(hidden, { holdsPlace: true }), {
      line: EXACT,
      disclosure: location.HIDDEN_LOCATION_DISCLOSURE,
    });
    assert.deepEqual(location.locationForAttendee(open, { holdsPlace: true }), { line: EXACT });
  });

  test("everybody else gets the label, and the label's absence tightens rather than opens", () => {
    const withLabel = location.locationForAttendee(hidden, { holdsPlace: false });
    assert.ok(withLabel.line.startsWith(LABEL), withLabel.line);
    assert.ok(!withLabel.line.includes(EXACT));
    // THE REGRESSION. The old rule was `if (hidden && label)`, so an empty
    // label fell through to the exact text.
    const noLabel = location.locationForAttendee(hiddenNoLabel, { holdsPlace: false });
    assert.equal(noLabel.line, location.LOCATION_WITHHELD);
    assert.ok(!noLabel.line.includes(EXACT));
    assert.equal(noLabel.disclosure, undefined);
    assert.equal(location.locationForAttendee(open, { holdsPlace: false }).line, EXACT);
  });

  test("the public text is empty rather than exact when the label is missing", () => {
    assert.equal(location.publicLocationText(hidden), LABEL);
    assert.equal(location.publicLocationText(hiddenNoLabel), "");
    assert.equal(location.publicLocationText(open), EXACT);
    assert.equal(location.publicLocationLine(hiddenNoLabel), location.LOCATION_SHARED_WITH_ATTENDEES);
    assert.equal(location.publicLocationLine({ location: "", locationHidden: false }), location.LOCATION_TO_BE_CONFIRMED);
    assert.equal(location.publicLocationLine(hidden), LABEL);
  });

  test("a calendar entry carries the exact location for a holder and nothing for anyone else", () => {
    assert.equal(location.exactLocationFor(hidden, { holdsPlace: true }), EXACT);
    assert.equal(location.exactLocationFor(hidden, { holdsPlace: false }), undefined);
    assert.equal(location.exactLocationFor(open, { holdsPlace: false }), undefined);
    assert.equal(location.exactLocationFor({ location: " " }, { holdsPlace: true }), undefined);
  });

  test("a change summary for a non-holder at a hidden event is an allowlist: When passes, Where is redacted, the rest is dropped", () => {
    const changes = [
      { label: "When", from: "Fri 18:00", to: "Fri 19:00" },
      { label: "Where", from: "Old room", to: EXACT },
      { label: "Note", from: "x", to: `Now at ${EXACT.toLowerCase()}` },
      // A caller's entry carrying the PREVIOUS exact address, which this
      // module cannot recognise by content: it must not be shown.
      { label: "Venue", from: "Flat 9, 1 Old Street", to: "elsewhere" },
    ];
    const holder = location.changesForAttendee(changes, hidden, { holdsPlace: true });
    assert.deepEqual(holder, changes);
    const other = location.changesForAttendee(changes, hidden, { holdsPlace: false });
    assert.equal(other.length, 2, "only When and Where survive for a non-holder");
    assert.deepEqual(other[0], changes[0]);
    assert.equal(other[1].label, "Where");
    assert.ok(!other[1].to.includes(EXACT) && !other[1].from.includes(EXACT));
    assert.ok(other[1].to.startsWith(LABEL));
    assert.ok(!JSON.stringify(other).includes("Old Street"), "an unrecognised entry reached a non-holder");
    // A When entry that quotes the exact text is dropped rather than shown.
    const dirtyWhen = location.changesForAttendee(
      [{ label: "When", from: "x", to: `Fri 19:00 at ${EXACT}` }],
      hidden,
      { holdsPlace: false },
    );
    assert.deepEqual(dirtyWhen, []);
    // An open event's diff is everybody's.
    assert.deepEqual(location.changesForAttendee(changes, open, { holdsPlace: false }), changes);
  });

  test("the pairing predicate names the state the write paths refuse", () => {
    assert.equal(location.hiddenLocationLacksLabel(hiddenNoLabel), true);
    assert.equal(location.hiddenLocationLacksLabel({ locationHidden: true, locationPublicText: "  " }), true);
    assert.equal(location.hiddenLocationLacksLabel(hidden), false);
    assert.equal(location.hiddenLocationLacksLabel(open), false);
  });
});

// ===========================================================================
// 2. The routes, executed, with the real templates rendered
// ===========================================================================

describe("the RSVP acknowledgement", () => {
  test("never carries the exact location of a hidden event, label or no label", async () => {
    for (const label of [LABEL, "", undefined]) {
      globalThis.__sent = [];
      globalThis.__db = makeDb({ events: { "event-1": hiddenEvent({ locationPublicText: label }) } });
      const res = await rsvpRoute.POST(
        jsonRequest({ name: "Guest", email: "guest@e2e.invalid", answers: {} }),
        ctxFor({ id: "event-1" }),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await settle();
      const html = await lastRsvpHtml();
      assert.ok(!html.includes(EXACT), `label ${JSON.stringify(label)}: the acknowledgement carried the exact location`);
      assert.match(html, /exact location shared once your RSVP is confirmed/i);
      if (label) assert.ok(html.includes(label));
    }
  });
});

describe("the approval email", () => {
  async function approve(seed) {
    globalThis.__db = makeDb(seed);
    globalThis.__user = approver;
    const res = await approveRoute.POST({}, ctxFor({ id: "event-1", rsvpId: "rsvp-1" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await settle();
    return { status: res.body.status, html: await lastRsvpHtml() };
  }

  const pendingRow = {
    eventId: "event-1",
    status: "pending",
    email: "guest@e2e.invalid",
    name: "Guest",
    uid: null,
    answers: {},
    signupSnapshot: { scheduleLabel: "x", locationLabel: "Old room" },
  };

  test("a confirmed place gets the exact location, the disclosure and the diff", async () => {
    const { status, html } = await approve({
      events: { "event-1": hiddenEvent() },
      eventRsvps: { "rsvp-1": pendingRow },
    });
    assert.equal(status, "confirmed");
    assert.ok(html.includes(EXACT));
    assert.match(html, /kept off the public event page/);
  });

  test("a waitlisted place gets the label and no diff, whatever the label", async () => {
    for (const label of [LABEL, ""]) {
      globalThis.__sent = [];
      const { status, html } = await approve({
        events: { "event-1": hiddenEvent({ rsvpCountConfirmed: 1, locationPublicText: label }) },
        eventRsvps: { "rsvp-1": pendingRow },
      });
      assert.equal(status, "waitlisted");
      assert.ok(!html.includes(EXACT), `label ${JSON.stringify(label)}: the waitlist email carried the exact location`);
      assert.ok(!html.includes("Old room"), "the signup diff reached a waitlisted attendee");
    }
  });
});

describe("the promotion off the waitlist", () => {
  test("carries the exact location, because the promoted person now holds a place", async () => {
    globalThis.__db = makeDb({
      events: { "event-1": hiddenEvent({ rsvpCountConfirmed: 1, rsvpCountWaitlisted: 1 }) },
      eventRsvps: {
        "rsvp-1": { eventId: "event-1", status: "confirmed", email: "a@e2e.invalid", name: "A", uid: "member-a", createdAt: 1 },
        "rsvp-2": { eventId: "event-1", status: "waitlisted", email: "b@e2e.invalid", name: "B", uid: null, createdAt: 2 },
      },
    });
    globalThis.__user = approver;
    const res = await cancelRsvpRoute.POST({ url: "https://naisi.test/x", json: async () => ({}) }, ctxFor({ id: "event-1", rsvpId: "rsvp-1" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await settle();
    const promoted = globalThis.__sent.find((s) => s.to === "b@e2e.invalid");
    assert.ok(promoted, "the promoted attendee was not emailed");
    const html = await render(promoted.react);
    assert.ok(html.includes(EXACT));
    const cancelled = globalThis.__sent.find((s) => s.to === "a@e2e.invalid");
    assert.ok(cancelled, "the cancelled attendee was not emailed");
    // A cancelled RSVP renders no details at all, so no location either way.
    assert.ok(!(await render(cancelled.react)).includes(EXACT));
  });
});

describe("the organiser broadcast", () => {
  const changes = [{ label: "Where", from: "Old room", to: EXACT }];

  async function broadcast(label) {
    globalThis.__notices = [];
    globalThis.__db = makeDb({
      events: { "event-1": hiddenEvent({ locationPublicText: label }) },
      eventRsvps: {
        "rsvp-c": { eventId: "event-1", status: "confirmed", email: "holder@e2e.invalid", name: "Holder", uid: "member-c" },
        "rsvp-w": { eventId: "event-1", status: "waitlisted", email: "waiting@e2e.invalid", name: "Waiting", uid: null },
        "rsvp-p": { eventId: "event-1", status: "pending", email: "pending@e2e.invalid", name: "Pending", uid: null },
      },
    });
    globalThis.__user = approver;
    const res = await broadcastRoute.POST(
      jsonRequest({ subject: "Room note", body: "See the diff.", changes }),
      ctxFor({ id: "event-1" }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sent, 2, "confirmed and waitlisted, and nobody else");
    const byAddress = Object.fromEntries(globalThis.__notices.map((n) => [n.to, n]));
    return {
      holder: await render(byAddress["holder@e2e.invalid"].render(null)),
      waiting: await render(byAddress["waiting@e2e.invalid"].render(null)),
    };
  }

  test("a confirmed attendee sees the exact location and the exact diff", async () => {
    const { holder } = await broadcast(LABEL);
    assert.ok(holder.includes(EXACT));
    assert.ok(holder.includes("Old room"));
  });

  test("a waitlisted attendee sees the label, and the diff is redacted, label or no label", async () => {
    for (const label of [LABEL, ""]) {
      const { waiting } = await broadcast(label);
      assert.ok(!waiting.includes(EXACT), `label ${JSON.stringify(label)}: the broadcast carried the exact location to the waitlist`);
      assert.ok(!waiting.includes("Old room"), "the exact diff reached the waitlist");
      assert.match(waiting, /exact location shared once your RSVP is confirmed/i);
      if (label) assert.ok(waiting.includes(label));
    }
  });

  test("an open event's broadcast is the same for everybody", async () => {
    globalThis.__notices = [];
    globalThis.__db = makeDb({
      events: { "event-1": hiddenEvent({ locationHidden: false, locationPublicText: null }) },
      eventRsvps: {
        "rsvp-w": { eventId: "event-1", status: "waitlisted", email: "waiting@e2e.invalid", name: "Waiting", uid: null },
      },
    });
    globalThis.__user = approver;
    await broadcastRoute.POST(jsonRequest({ subject: "Room note", body: "Hi", changes }), ctxFor({ id: "event-1" }));
    const html = await render(globalThis.__notices[0].render(null));
    assert.ok(html.includes(EXACT));
    assert.ok(html.includes("Old room"));
  });
});

describe("the live-save route", () => {
  test("refuses a hidden location with no public label, as the review path does", async () => {
    globalThis.__db = makeDb({ events: { "event-1": hiddenEvent() } });
    globalThis.__user = approver;
    const body = {
      title: "Reading group",
      startAt: "2026-10-01T18:00:00.000Z",
      location: EXACT,
      locationHidden: true,
      locationPublicText: "   ",
      blocks: [],
      signupForm: [],
    };
    const refused = await updateRoute.POST(jsonRequest(body), ctxFor({ id: "event-1" }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /hidden the exact location/);
    assert.equal(globalThis.__db.data.events["event-1"].locationPublicText, LABEL, "the refusal wrote anyway");
    // The publish route refuses the same state, so a draft written
    // client-direct without a label cannot go live.
    globalThis.__db = makeDb({ events: { "event-1": hiddenEvent({ status: "approved", locationPublicText: "" }) } });
    globalThis.__user = { ...approver, role: "admin" };
    const publish = await publishRoute.POST({}, ctxFor({ id: "event-1" }));
    assert.equal(publish.status, 400, JSON.stringify(publish.body));
    assert.match(publish.body.error, /hidden the exact location/);
    assert.equal(globalThis.__db.data.events["event-1"].status, "approved", "the refusal published anyway");
    const accepted = await updateRoute.POST(
      jsonRequest({ ...body, locationPublicText: "Somewhere on campus" }),
      ctxFor({ id: "event-1" }),
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });
});

// ===========================================================================
// 3. The tree
// ===========================================================================

/**
 * What each role may do. The checks below read the role off this registry,
 * so an entry's role is a claim the test verifies against the source.
 *
 *  chokepoint  the one file that branches on `locationHidden` to choose text
 *  renderer    turns an event into text for a person: imports the helper and
 *              reads none of the three fields raw
 *  relay       passes the fields to a renderer, or snapshots them onto a row
 *              only SU-recognised committee can read; branches on nothing
 *  template    takes a finished line and renders it; reads no field
 *  writer      the form and the write paths that SET the fields
 *  schema      the field definitions and the normaliser
 */
const SITES = {
  [CHOKEPOINT]: {
    role: "chokepoint",
    reason: "The one place that decides. Every other role either calls it or carries what it said.",
  },
  "src/lib/events/sendRsvpEmail.ts": {
    role: "renderer",
    reason: "Every RSVP lifecycle email. Maps its variant to holdsPlace and asks the helper for the line and the calendar location.",
  },
  "src/app/api/events/[id]/broadcast/route.ts": {
    role: "renderer",
    reason: "The organiser broadcast: one rendering for holders, one for the waitlist, both from the helper.",
  },
  "src/app/api/events/[id]/publish/route.ts": {
    role: "renderer",
    reason: "The inline announcement to the events list: the public line.",
  },
  "src/lib/scheduler/jobs/eventAnnouncements.ts": {
    role: "renderer",
    reason: "The queued announcement: the same public line as the publish route.",
  },
  "src/app/api/events/[id]/calendar.ics/route.ts": {
    role: "renderer",
    reason: "The public calendar download: the public text, or no LOCATION line at all.",
  },
  "src/features/events/EventDetailView.tsx": {
    role: "renderer",
    reason: "The public event page and the editor's preview: the public text and the withheld note.",
  },
  "src/app/(public)/events/page.tsx": {
    role: "renderer",
    reason: "The public events list: the public text.",
  },
  "src/app/(public)/UpcomingEvents.tsx": {
    role: "renderer",
    reason: "The home page's upcoming list. Its inline rule fell back to the exact text on an empty label until 8 September 2026.",
  },
  "src/app/api/events/[id]/rsvp/route.ts": {
    role: "relay",
    reason: "Hands the event to sendRsvpEmail, and snapshots the exact location onto the RSVP row, which only SU-recognised committee and admins may read.",
  },
  "src/app/api/events/[id]/rsvp/[rsvpId]/approve/route.ts": {
    role: "relay",
    reason: "Hands the event to sendRsvpEmail; builds the since-signup diff for a CONFIRMED place only, which the executed test above pins.",
  },
  "src/app/api/events/[id]/rsvp/[rsvpId]/deny/route.ts": {
    role: "relay",
    reason: "Hands the event to sendRsvpEmail, whose denied variant renders no details.",
  },
  "src/app/api/events/[id]/rsvp/[rsvpId]/cancel/route.ts": {
    role: "relay",
    reason: "Hands the event to sendRsvpEmail for the cancelled and promoted variants.",
  },
  "src/lib/email/eventAnnouncement.ts": {
    role: "relay",
    reason: "Takes a finished locationLine from its two callers, the publish route and the job, and passes it to the template.",
  },
  "src/emails/EventRsvpEmail.tsx": { role: "template", reason: "Renders the locationLine it is given." },
  "src/emails/EventUpdateEmail.tsx": { role: "template", reason: "Renders the locationLine and the changes it is given." },
  "src/emails/EventAnnouncementEmail.tsx": { role: "template", reason: "Renders the public locationLine it is given." },
  "src/app/api/events/[id]/update/route.ts": {
    role: "writer",
    reason: "Stores the three fields for a live event and refuses a hidden location with no label.",
  },
  "src/features/events/EventEditor.tsx": {
    role: "writer",
    reason: "The form that sets the three fields, and the review-time check that a hidden location has a label.",
  },
  "src/features/events/eventMutations.ts": {
    role: "writer",
    reason: "The client-direct write of a draft's fields.",
  },
  "src/lib/firestore/events.ts": {
    role: "schema",
    reason: "EventDoc, normalizeEvent, and the signup snapshot's locationLabel.",
  },
};

/** A file is in the tree when its code (comments stripped) says any of these, or imports the helper. */
const MENTION = /\blocation(Hidden|PublicText|Line|Label)\b|\b(event|evt|e|old|outcome\.event|result\.event)\.location\b|\bwhereText\b/;
/** A raw read of one of the three fields off an object. */
const RAW_READ = /\.(location|locationHidden|locationPublicText)\b(?!\s*[?]?:)/;
/** Branching on the flag: the decision the chokepoint owns. */
const DECISION = /\blocationHidden\b\s*(\?(?!:)|&&|\|\||===|!==)|(\?|&&|\|\||if\s*\(|!)\s*[\w.]*\blocationHidden\b/;
const IMPORTS_HELPER = /from "(@\/lib\/events\/location|\.\/location)"/;

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const discovered = [...walk(SRC)]
  .filter((file) => {
    const code = codeOf(file);
    return MENTION.test(code) || IMPORTS_HELPER.test(code);
  })
  .map((file) => relative(REPO_ROOT, file))
  .sort();

describe("the tree: every file touching an event's location is registered, and behaves as its role says", () => {
  test("the regexes match what they are for and nothing else", () => {
    assert.match("const x = event.locationHidden ? a : b;", DECISION);
    assert.match("if (evt.locationHidden && exact) {", DECISION);
    assert.match("if (!event.locationHidden) return;", DECISION);
    assert.match("locationHidden === true", DECISION);
    assert.doesNotMatch("locationHidden: evt.locationHidden,", DECISION);
    assert.doesNotMatch("locationHidden: Boolean(data.locationHidden),", DECISION);
    assert.doesNotMatch("type EventLike = { locationHidden?: boolean | null };", DECISION);
    assert.match("line: event.location ?? ''", RAW_READ);
    assert.match("event.locationPublicText.trim()", RAW_READ);
    assert.doesNotMatch("type X = { locationHidden?: boolean; location: string }", RAW_READ);
    assert.match("const l = e.location || 'TBA'", MENTION);
    assert.match("session.locationLine", MENTION);
    assert.doesNotMatch("const where = session.location.trim();", MENTION);
    assert.doesNotMatch("window.location.href", MENTION);
    assert.match('import { publicLocationText } from "@/lib/events/location";', IMPORTS_HELPER);
  });

  test("both directions: discovered files are registered, registered files are discovered", () => {
    const registered = Object.keys(SITES).sort();
    const unregistered = discovered.filter((f) => !(f in SITES));
    assert.deepEqual(
      unregistered,
      [],
      "These files touch an event's location and are not in SITES. Give each a role and a reason; a renderer goes through @/lib/events/location.",
    );
    const stale = registered.filter((f) => !discovered.includes(f));
    assert.deepEqual(stale, [], "These registered files no longer touch an event's location: remove them.");
    for (const [file, entry] of Object.entries(SITES)) {
      assert.ok(entry.reason.trim().length >= 20, `${file}: the reason is a placeholder.`);
    }
  });

  test("exactly one file branches on locationHidden, and it is the chokepoint", () => {
    const deciders = discovered.filter((f) => {
      const role = SITES[f]?.role;
      if (role === "writer") return false;
      return DECISION.test(codeOf(join(REPO_ROOT, f)));
    });
    assert.deepEqual(deciders, [CHOKEPOINT], "Only src/lib/events/location.ts may decide what a hidden location shows.");
  });

  test("every renderer imports the helper and reads none of the fields raw", () => {
    for (const [file, { role }] of Object.entries(SITES)) {
      if (role !== "renderer") continue;
      const code = codeOf(join(REPO_ROOT, file));
      assert.match(code, IMPORTS_HELPER, `${file} renders a location without @/lib/events/location.`);
      const raw = code.match(RAW_READ);
      assert.equal(raw, null, `${file} reads ${raw?.[0]} raw. Ask the helper instead.`);
    }
  });

  test("every template takes a finished line and reads no field", () => {
    for (const [file, { role }] of Object.entries(SITES)) {
      if (role !== "template") continue;
      const code = codeOf(join(REPO_ROOT, file));
      assert.doesNotMatch(code, /\.(locationHidden|locationPublicText)\b/, `${file} reads a location field.`);
    }
  });
});
