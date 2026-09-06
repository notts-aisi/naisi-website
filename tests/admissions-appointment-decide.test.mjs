/**
 * The appointment round's decide path: the queue projection, the idempotency
 * rule, the eligible-run filter, the two new templates' token contracts and
 * the hub sentences.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth EXECUTING rather than reading
 *
 *  1. **`buildAppointmentQueueRow` is a disclosure boundary.**
 *     `admissionApplications` is `allow read, write: if false`, so nothing in
 *     Firestore stops a staff page handing the whole document to a browser.
 *     The row carries a facilitator's private written assessment of the
 *     applicant (`evidence.facilitatorNotes`) and a rejection reason the
 *     decider may deliberately not have shared. So the tests below build a row
 *     with all of that on it, serialise the result the way the wire does, and
 *     assert the sentinel strings are NOWHERE in the JSON. A key-by-key check
 *     would pass the day somebody spreads a nested object.
 *
 *     The NAMES are pinned in the other direction, on purpose. This queue is
 *     not blind, that is a decision rather than an oversight, and a later
 *     change that quietly blinded it would leave a page whose own copy says
 *     the names are here beside a list with none.
 *
 *  2. **The idempotency rule.** The queue is worked through in one sitting on
 *     a deadline evening, on a phone, sometimes by two people at once. Both
 *     arms are executed: the same decision twice is a no-op, a different
 *     decision on a decided row is a refusal.
 *
 *  3. **The availability spans.** They are half-open and named by their real
 *     end time. An earlier shape named the last slot's START, so every span
 *     read fifteen minutes short on the one screen whose job is fitting people
 *     into session slots.
 *
 *  4. **The token contracts.** `TOKENS_BY_KIND` (server) and
 *     `ADMISSIONS_TOKENS_BY_TEMPLATE` (client mirror) are two copies of one
 *     rule, because the send helper is `server-only` and the editor is not.
 *     They are compared, and each template's seed copy is checked against its
 *     own kind's set, so copy using a token its trigger never supplies fails
 *     here rather than arriving as nine literal characters in an inbox.
 *
 * ## What is pinned against the source instead
 *
 * The decide route cannot run without a database. The pins find the
 * transaction's closing parenthesis and assert the send calls sit AFTER it,
 * and that `assertNotImpersonating()` is the first thing the handler does.
 * Same technique as the sibling admissions tests.
 *
 * ## Why the loader dance
 *
 * This repo's Node predates the v22.18 that strips TypeScript natively, so the
 * module graph is transpiled in memory with the `typescript` devDependency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. NOTHING BELOW IS REACHABLE FROM AN
 * ASSERTION IN THIS FILE: only the send path touches the email components, the
 * transport and the Admin SDK, and calling it would put real mail on the wire,
 * which is the one thing a unit test of a decision feature must never do.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  ["@/emails/AdmissionsSubmittedEmail", "export default function Stub() { return null; }"],
  ["@/emails/AdmissionsReinstatedEmail", "export default function Stub() { return null; }"],
  [
    "@/emails/AdmissionsDeadlineReminderEmail",
    "export default function Stub() { return null; }",
  ],
  [
    "@/emails/AdmissionsStageReleasedEmail",
    "export default function Stub() { return null; }",
  ],
  ["@/emails/AdmissionsAppointedEmail", "export default function Stub() { return null; }"],
  ["@/emails/AdmissionsDeclinedEmail", "export default function Stub() { return null; }"],
  ["@/lib/firebase/admin", "export function getAdminDb() { return null; }"],
  ["@/lib/firestore/suppression", "export async function isSuppressed() { return false; }"],
  ["./send", "export async function sendEmail() {}"],
]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const queue = await loadTs("lib/admissions/appointmentQueue.ts");
const availability = await loadTs("lib/admissions/availability.ts");
const applications = await loadTs("lib/firestore/admissionApplications.ts");
const emails = await loadTs("lib/firestore/courseEmails.ts");
const samples = await loadTs("features/admin/emailDesigns/courseEmailSamples.ts");
const blurbs = await loadTs("features/admissions/applicationStatus.ts");
const sendHelper = await loadTs("lib/email/admissionEmails.ts");

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

const DECIDE_ROUTE = "src/app/api/admissions/rounds/[roundId]/decide/route.ts";
const QUEUE_LOADER = "src/lib/admissions/appointmentQueueData.ts";
const QUEUE_PAGE = "src/app/(app)/admin/admissions/[roundId]/appointments/page.tsx";
const QUEUE_UI = "src/features/admissions/AppointmentsQueue.tsx";

/**
 * The span of a handler's `db.runTransaction(...)` call, found by matching the
 * parenthesis it opens with.
 *
 * Quoted strings AND COMMENTS are both skipped. The sibling admissions tests
 * skip only strings, which is enough until a comment inside the transaction
 * contains an apostrophe: the scanner then reads it as an opening quote and
 * swallows the rest of the file, and the pin fails with "unbalanced
 * parentheses" on a route that is perfectly balanced. Prose is the one thing
 * guaranteed to be inside a well-commented transaction, so this copy handles
 * it.
 */
function transactionSpan(handlerSource) {
  const at = handlerSource.indexOf("db.runTransaction(");
  assert.ok(at !== -1, "this handler runs no transaction at all");
  const open = handlerSource.indexOf("(", at);
  let depth = 0;
  let quote = "";
  for (let i = open; i < handlerSource.length; i += 1) {
    const ch = handlerSource[i];
    const next = handlerSource[i + 1];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = handlerSource.indexOf("\n", i);
      i = end === -1 ? handlerSource.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = handlerSource.indexOf("*/", i + 2);
      i = end === -1 ? handlerSource.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  throw new Error("unbalanced parentheses after db.runTransaction(");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRID = { version: 1, startMinute: 9 * 60, endMinute: 18 * 60, slotMinutes: 15 };

/** Seven all-zero day columns at the default geometry (36 slots, 9 hex chars). */
function emptyDays() {
  return ["000000000", "000000000", "000000000", "000000000", "000000000", "000000000", "000000000"];
}

function maskWith(overrides) {
  const days = emptyDays();
  for (const [day, hex] of Object.entries(overrides)) days[Number(day)] = hex;
  return { ...GRID, days };
}

/** Sentinels: strings that must never appear on the queue's wire. */
const FACILITATOR_NOTE = "FACILITATOR_NOTE_SENTINEL_do_not_disclose";
const UNSHARED_REASON = "UNSHARED_REASON_SENTINEL_do_not_disclose";
const ACCESS_ANSWER = "ACCESS_REQUIREMENTS_SENTINEL_do_not_disclose";

const STAGES = [
  {
    id: "s1",
    roundId: "facilitators-2026__abc",
    label: "About you",
    intro: "",
    releaseAt: null,
    releaseTimeLocal: "09:00",
    locksOnSubmit: true,
    order: 0,
    questions: [
      { id: "q1", label: "Why do you want to facilitate?", required: true, type: "longText" },
      { id: "q2", label: "Have you facilitated before?", required: false, type: "shortText" },
    ],
    manualReleasedAt: null,
    closesAt: null,
  },
];

function applicationFixture(overrides = {}) {
  return {
    id: "facilitators-2026__abc__uid-sam",
    roundId: "facilitators-2026__abc",
    uid: "uid-sam",
    email: "sam@example.com",
    displayName: "Sam Okonkwo",
    stageAnswers: {
      s1: { q1: "I ran a reading group last year.", q2: "Yes, twice." },
    },
    stageSubmittedAt: { s1: new Date("2026-10-04T20:00:00Z") },
    availability: maskWith({ 1: "f00000000" }),
    availabilityConfigVersion: 1,
    programmePreference: {
      streamId: null,
      rankedFellowshipIds: [],
      openToFellowship: false,
    },
    // The row a real one carries: private notes and, below, an UNSHARED reason.
    evidence: {
      runs: [],
      facilitatorNotes: FACILITATOR_NOTE,
      computedAt: new Date("2026-10-04T21:00:00Z"),
    },
    membershipAtApply: true,
    reapplyCount: 0,
    status: "submitted",
    submittedAt: new Date("2026-10-04T20:00:00Z"),
    withdrawnAt: null,
    outcome: {
      decision: null,
      targetRunId: null,
      streamId: null,
      decidedByUid: null,
      decidedAt: null,
      reason: UNSHARED_REASON,
      reasonShared: false,
    },
    seatApplicationId: null,
    createdAt: new Date("2026-09-21T09:00:00Z"),
    updatedAt: new Date("2026-10-04T20:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("the appointment queue projection", () => {
  test("a facilitator's private notes are nowhere on the wire", () => {
    const row = queue.buildAppointmentQueueRow(applicationFixture(), STAGES, GRID, {
      preferredName: "Sam",
      universityEmail: "sam@nottingham.ac.uk",
    });
    const wire = JSON.stringify(row);
    assert.ok(
      !wire.includes(FACILITATOR_NOTE),
      "the facilitator's private assessment of this applicant reached the queue's wire",
    );
    assert.equal(row.evidence, undefined);
  });

  test("an UNSHARED decision reason is nowhere on the wire", () => {
    const row = queue.buildAppointmentQueueRow(
      applicationFixture({
        status: "rejected",
        outcome: {
          decision: "decline",
          targetRunId: null,
          streamId: null,
          decidedByUid: "uid-zach",
          decidedAt: new Date("2026-10-04T22:00:00Z"),
          reason: UNSHARED_REASON,
          reasonShared: false,
        },
      }),
      STAGES,
      GRID,
      null,
    );
    assert.ok(!JSON.stringify(row).includes(UNSHARED_REASON));
    assert.equal(row.outcome.sharedReason, "");
    assert.equal(row.outcome.decision, "decline");
  });

  test("a SHARED reason does reach the wire, because that is what the tick means", () => {
    const row = queue.buildAppointmentQueueRow(
      applicationFixture({
        status: "rejected",
        outcome: {
          decision: "decline",
          targetRunId: null,
          streamId: null,
          decidedByUid: "uid-zach",
          decidedAt: new Date("2026-10-04T22:00:00Z"),
          reason: "More applicants than groups this term.",
          reasonShared: true,
        },
      }),
      STAGES,
      GRID,
      null,
    );
    assert.equal(row.outcome.sharedReason, "More applicants than groups this term.");
  });

  test("a sentinel access-requirements answer cannot reach the wire from anywhere", () => {
    // The answer lives in `admissionApplicationPrivate`, so it is not even a
    // field on the document the projection is handed. This plants it on the
    // input anyway, as an unknown key, and asserts the field-by-field build
    // drops it: a spread would have carried it out.
    const application = applicationFixture();
    application.accessRequirements = ACCESS_ANSWER;
    application.privateAnswers = { accessRequirements: ACCESS_ANSWER };
    const row = queue.buildAppointmentQueueRow(application, STAGES, GRID, null);
    assert.ok(!JSON.stringify(row).includes(ACCESS_ANSWER));
  });

  test("the names ARE on the wire, deliberately: this queue is not blind", () => {
    const row = queue.buildAppointmentQueueRow(applicationFixture(), STAGES, GRID, {
      preferredName: "Sam",
      universityEmail: "sam@nottingham.ac.uk",
    });
    assert.equal(row.displayName, "Sam Okonkwo");
    assert.equal(row.preferredName, "Sam");
    assert.equal(row.email, "sam@example.com");
    assert.equal(row.universityEmail, "sam@nottingham.ac.uk");
    assert.equal(row.membershipAtApply, true);
  });

  test("answers come from the stage's questions, so a removed question stops appearing", () => {
    const application = applicationFixture();
    application.stageAnswers.s1.qGone = "an answer to a question nobody asks any more";
    const row = queue.buildAppointmentQueueRow(application, STAGES, GRID, null);
    assert.deepEqual(
      row.stages[0].answers.map((a) => a.questionId),
      ["q1", "q2"],
    );
    assert.ok(!JSON.stringify(row).includes("nobody asks any more"));
  });

  test("an unanswered question is present and empty, not missing", () => {
    const application = applicationFixture();
    delete application.stageAnswers.s1.q2;
    const row = queue.buildAppointmentQueueRow(application, STAGES, GRID, null);
    assert.equal(row.stages[0].answers[1].questionId, "q2");
    assert.equal(row.stages[0].answers[1].text, "");
  });

  test("undecided rows sort above decided ones, with a total tie-break", () => {
    const undecided = queue.buildAppointmentQueueRow(
      applicationFixture(),
      STAGES,
      GRID,
      null,
    );
    const decided = queue.buildAppointmentQueueRow(
      applicationFixture({
        id: "facilitators-2026__abc__uid-ana",
        uid: "uid-ana",
        status: "appointed",
        submittedAt: new Date("2026-10-04T23:00:00Z"),
        outcome: {
          decision: "appoint",
          targetRunId: "asf-autumn-2026",
          streamId: null,
          decidedByUid: "uid-zach",
          decidedAt: new Date("2026-10-04T23:30:00Z"),
          reason: "",
          reasonShared: true,
        },
      }),
      STAGES,
      GRID,
      null,
    );
    const first = queue.sortAppointmentRows([decided, undecided]);
    const second = queue.sortAppointmentRows([undecided, decided]);
    assert.deepEqual(
      first.map((r) => r.uid),
      ["uid-sam", "uid-ana"],
    );
    assert.deepEqual(
      first.map((r) => r.uid),
      second.map((r) => r.uid),
    );
  });
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe("the availability summary", () => {
  test("a span is named by its real END time, not by its last slot's start", () => {
    // 0xf is the first four 15-minute slots of the day: 09:00 to 10:00.
    const days = queue.availabilityDaySummaries(maskWith({ 1: "f00000000" }), GRID);
    assert.deepEqual(days, [{ weekday: 1, label: "Monday", spans: ["09:00-10:00"] }]);
  });

  test("the last slot of the day ends at the grid's own end", () => {
    // Slot 35 only: hex char 8, bit weight 8 >> 3 = 1.
    const days = queue.availabilityDaySummaries(maskWith({ 2: "000000001" }), GRID);
    assert.deepEqual(days, [{ weekday: 2, label: "Tuesday", spans: ["17:45-18:00"] }]);
  });

  test("two runs on one day are two spans, not one", () => {
    // 0xf then a gap then 0xf: 09:00-10:00 and 11:00-12:00.
    const days = queue.availabilityDaySummaries(maskWith({ 0: "f0f000000" }), GRID);
    assert.deepEqual(days[0].spans, ["09:00-10:00", "11:00-12:00"]);
    assert.equal(days[0].label, "Sunday");
  });

  test("a day with nothing marked is omitted rather than listed as empty", () => {
    const days = queue.availabilityDaySummaries(maskWith({ 5: "f00000000" }), GRID);
    assert.equal(days.length, 1);
    assert.equal(days[0].label, "Friday");
  });

  test("an untouched grid summarises to nothing at all", () => {
    assert.deepEqual(queue.availabilityDaySummaries(maskWith({}), GRID), []);
    assert.equal(availability.markedSlotCount(maskWith({}), GRID), 0);
  });

  test("the marked total counts slots across every day", () => {
    // `markedSlotCount` is the codec's own counter, and the queue calls it
    // rather than carrying a second copy: two implementations of "how many
    // slots did they mark" is how one of them starts disagreeing about the
    // legacy geometry fallback.
    assert.equal(
      availability.markedSlotCount(maskWith({ 1: "f00000000", 3: "f00000000" }), GRID),
      8,
    );
    assert.equal(queue.markedSlotTotal, undefined, "the duplicate counter is back");
    const row = queue.buildAppointmentQueueRow(
      applicationFixture({ availability: maskWith({ 1: "f00000000", 3: "f00000000" }) }),
      STAGES,
      GRID,
      null,
    );
    assert.equal(row.availability.markedSlots, 8);
  });

  test("an answer with no geometry of its own falls back to the round's grid", () => {
    // The pre-geometry legacy row. Counted against the round's current grid,
    // or the queue tells the decider they drew nothing when they drew plenty.
    const legacy = { days: ["", "f00000000", "", "", "", "", ""] };
    assert.equal(availability.markedSlotCount(legacy, GRID), 4);
    assert.equal(availability.markedSlotCount(legacy), 0, "no fallback, no count");
  });

  test("the answer is decoded against the geometry it was DRAWN on", () => {
    // An answer drawn on an 08:00 grid, read while the round now advertises
    // 09:00. The stored geometry wins, or every span shifts an hour.
    const drawnAt8 = {
      version: 1,
      startMinute: 8 * 60,
      endMinute: 18 * 60,
      slotMinutes: 15,
      // 08:00 to 18:00 in 15-minute slots is 40 slots, so 10 hex characters.
      days: ["", "f000000000", "", "", "", "", ""],
    };
    const days = queue.availabilityDaySummaries(drawnAt8, GRID);
    assert.deepEqual(days[0].spans, ["08:00-09:00"]);
  });
});

// ---------------------------------------------------------------------------
// The eligible-run filter
// ---------------------------------------------------------------------------

describe("which runs an appointment may target", () => {
  const run = (over) => ({
    id: "r",
    label: "Autumn 2026",
    courseTitle: "AI Safety Fundamentals",
    startDate: "2026-10-26",
    status: "draft",
    archived: false,
    ...over,
  });

  test("a draft run is eligible: that is the case this route exists for", () => {
    assert.equal(queue.isAppointableRun(run({ status: "draft" })), true);
  });

  test("running and applications-open runs are eligible", () => {
    for (const status of ["applications-open", "applications-closed", "running"]) {
      assert.equal(queue.isAppointableRun(run({ status })), true, status);
    }
  });

  test("finished, called-off and archived runs are not", () => {
    assert.equal(queue.isAppointableRun(run({ status: "completed" })), false);
    assert.equal(queue.isAppointableRun(run({ status: "cancelled" })), false);
    assert.equal(queue.isAppointableRun(run({ archived: true })), false);
  });

  test("the status list and the predicate say the same thing", () => {
    // The list is what the loader hands Firestore as a `where ... in`, and the
    // predicate is what the route and the Select apply to what comes back. A
    // status on one and not the other is a run the queue offers and the route
    // refuses, or the other way about.
    for (const status of ["draft", "applications-open", "applications-closed", "running"]) {
      assert.ok(
        queue.APPOINTABLE_RUN_STATUSES.includes(status),
        `${status} is appointable but not in the query filter`,
      );
      assert.equal(queue.isAppointableRun(run({ status })), true, status);
    }
    for (const status of ["completed", "cancelled"]) {
      assert.ok(!queue.APPOINTABLE_RUN_STATUSES.includes(status), status);
      assert.equal(queue.isAppointableRun(run({ status })), false, status);
    }
    // `archived` is NOT in the query: `createRun` never writes it, and a
    // Firestore equality filter drops every document missing the field.
    assert.match(
      source(QUEUE_LOADER),
      /\.where\("status", "in", \[\.\.\.APPOINTABLE_RUN_STATUSES\]\)/,
    );
    assert.ok(
      !/where\("archived"/.test(source(QUEUE_LOADER)),
      "the runs query filters on a field createRun does not write, so every run made by the editor disappears from the Select",
    );
  });

  test("the option list filters and sorts by course then run", () => {
    const options = queue.eligibleAppointmentRuns([
      run({ id: "b", courseTitle: "Governance", label: "Autumn 2026" }),
      run({ id: "dead", status: "cancelled" }),
      run({ id: "a", courseTitle: "AI Safety Fundamentals", label: "Autumn 2026" }),
      run({ id: "gone", archived: true }),
    ]);
    assert.deepEqual(
      options.map((o) => o.id),
      ["a", "b"],
    );
    assert.equal(options[0].startDate, "2026-10-26");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("deciding the same row twice", () => {
  const at = (status, decision) => ({ status, decision });

  test("a submitted, undecided row proceeds", () => {
    assert.deepEqual(queue.appointmentDecideDisposition(at("submitted", null), "appoint"), {
      kind: "proceed",
    });
  });

  test("the SAME decision again is a no-op, not a second email", () => {
    const again = queue.appointmentDecideDisposition(at("appointed", "appoint"), "appoint");
    assert.equal(again.kind, "already-decided");
  });

  test("a DIFFERENT decision on a decided row is a refusal, not an overwrite", () => {
    const clash = queue.appointmentDecideDisposition(at("appointed", "appoint"), "decline");
    assert.equal(clash.kind, "conflict");
    assert.match(clash.reason, /already been decided/i);
  });

  test("a draft and a withdrawal each get their own refusal", () => {
    const draft = queue.appointmentDecideDisposition(at("draft", null), "appoint");
    const withdrawn = queue.appointmentDecideDisposition(at("withdrawn", null), "appoint");
    assert.equal(draft.kind, "conflict");
    assert.equal(withdrawn.kind, "conflict");
    assert.match(draft.reason, /still a draft/i);
    assert.match(withdrawn.reason, /withdrew/i);
    assert.notEqual(draft.reason, withdrawn.reason);
  });

  test("an enrolment decision recorded on this row is a conflict, never a match", () => {
    const clash = queue.appointmentDecideDisposition(at("accepted", "accept"), "appoint");
    assert.equal(clash.kind, "conflict");
  });
});

// ---------------------------------------------------------------------------
// The status enum and the decision map
// ---------------------------------------------------------------------------

describe("the appointment decisions", () => {
  test("appoint lands on its own status; decline reuses rejected", () => {
    assert.equal(applications.DECISION_STATUS.appoint, "appointed");
    assert.equal(applications.DECISION_STATUS.decline, "rejected");
  });

  test("every decision has a status and every status has a label", () => {
    for (const decision of applications.ADMISSION_DECISIONS) {
      assert.ok(applications.DECISION_STATUS[decision], decision);
    }
    for (const status of applications.ADMISSION_APPLICATION_STATUSES) {
      assert.ok(
        applications.ADMISSION_APPLICATION_STATUS_LABEL[status],
        `${status} has no label`,
      );
    }
  });

  test("the appointment whitelist admits only the two", () => {
    assert.equal(applications.isAppointmentDecision("appoint"), true);
    assert.equal(applications.isAppointmentDecision("decline"), true);
    assert.equal(applications.isAppointmentDecision("accept"), false);
    assert.equal(applications.isAppointmentDecision("reject"), false);
    assert.equal(applications.isAppointmentDecision(""), false);
    assert.equal(applications.isAppointmentDecision(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// The hub sentences
// ---------------------------------------------------------------------------

describe("what the applicant reads on the hub", () => {
  test("an appointed facilitator is told they are on the team, not that they have a place", () => {
    const sentence = blurbs.applicationStatusBlurb("appointed", "closed", "appointment");
    assert.match(sentence, /facilitator team/i);
    assert.ok(!/place on/i.test(sentence));
  });

  test("a declined facilitator is not told that cohorts are small", () => {
    const appointment = blurbs.applicationStatusBlurb("rejected", "closed", "appointment");
    const enrolment = blurbs.applicationStatusBlurb("rejected", "closed", "enrolment");
    assert.notEqual(appointment, enrolment);
    assert.match(appointment, /facilitator/i);
    assert.match(enrolment, /Cohorts are small/);
  });

  test("the enrolment sentences are unchanged when no kind is passed", () => {
    for (const status of [
      "draft",
      "submitted",
      "accepted",
      "fellowship-offered",
      "waitlisted",
      "rejected",
      "withdrawn",
      "appointed",
    ]) {
      assert.equal(
        blurbs.applicationStatusBlurb(status, "closed"),
        blurbs.applicationStatusBlurb(status, "closed", "enrolment"),
        status,
      );
    }
  });

  test("every status has a sentence on both kinds of round", () => {
    for (const status of applications.ADMISSION_APPLICATION_STATUSES) {
      for (const kind of ["enrolment", "appointment"]) {
        assert.ok(
          blurbs.applicationStatusBlurb(status, "closed", kind).length > 0,
          `${status} on an ${kind} round has no sentence`,
        );
      }
    }
  });

  test("the chip has a tone for every status", () => {
    for (const status of applications.ADMISSION_APPLICATION_STATUSES) {
      assert.ok(blurbs.APPLICATION_STATUS_TONE[status], `${status} has no tone`);
    }
  });
});

// ---------------------------------------------------------------------------
// The two new templates
// ---------------------------------------------------------------------------

const TOKEN = /\{([a-zA-Z]+)\}/g;

function tokensIn(template) {
  const found = new Set();
  for (const [, name] of template.subject.matchAll(TOKEN)) found.add(name);
  for (const block of template.blocks) {
    const text = `${block.text ?? ""}${block.html ?? ""}`;
    for (const [, name] of text.matchAll(TOKEN)) found.add(name);
  }
  return found;
}

describe("the appointment templates", () => {
  test("both ids exist with a trigger, a label and seed copy", () => {
    for (const id of ["admissions-appointed", "admissions-declined"]) {
      assert.ok(emails.COURSE_TEMPLATE_IDS.includes(id), `${id} is not a template id`);
      assert.equal(emails.COURSE_TEMPLATE_TRIGGER[id], id);
      assert.ok(emails.COURSE_DEFAULT_LABELS[id], `${id} has no label`);
      const seed = emails.courseTemplateDefaults[id];
      assert.ok(seed.subject.length > 0, `${id} has no subject`);
      assert.ok(seed.blocks.length > 0, `${id} has no body`);
    }
  });

  test("each send kind has a template and each template has a token set", () => {
    for (const [kind, templateId] of Object.entries(sendHelper.TEMPLATE_FOR_KIND)) {
      assert.ok(emails.COURSE_TEMPLATE_IDS.includes(templateId), templateId);
      assert.ok(
        Array.isArray(sendHelper.TOKENS_BY_KIND[kind]),
        `${kind} supplies no token list`,
      );
    }
    assert.equal(sendHelper.TEMPLATE_FOR_KIND.appointed, "admissions-appointed");
    assert.equal(sendHelper.TEMPLATE_FOR_KIND.declined, "admissions-declined");
  });

  test("the client mirror agrees with the send path, template for template", () => {
    for (const [kind, templateId] of Object.entries(sendHelper.TEMPLATE_FOR_KIND)) {
      assert.deepEqual(
        [...samples.admissionsTokensFor(templateId)].sort(),
        [...sendHelper.TOKENS_BY_KIND[kind]].sort(),
        `${templateId} resolves a different token set in the editor than at send time`,
      );
    }
  });

  test("every admissions template is on the editor's admissions list", () => {
    for (const templateId of Object.values(sendHelper.TEMPLATE_FOR_KIND)) {
      assert.ok(
        samples.courseTemplateUsesAdmissionsTokens(templateId),
        `${templateId} sends through sendAdmissionEmail but the editor previews it as a course email`,
      );
    }
  });

  test("no seed copy uses a token its own trigger does not supply", () => {
    for (const [kind, templateId] of Object.entries(sendHelper.TEMPLATE_FOR_KIND)) {
      const supplied = new Set(sendHelper.TOKENS_BY_KIND[kind]);
      for (const token of tokensIn(emails.courseTemplateDefaults[templateId])) {
        assert.ok(
          supplied.has(token),
          `${templateId} uses {${token}}, which its trigger never supplies: it would arrive literal in an inbox`,
        );
      }
    }
  });

  test("the appointment is the ONE admissions send that resolves the course tokens", () => {
    for (const token of ["courseTitle", "runLabel", "startDate"]) {
      assert.ok(sendHelper.TOKENS_BY_KIND.appointed.includes(token), token);
      for (const kind of ["submitted", "reinstated", "declined"]) {
        assert.ok(
          !sendHelper.TOKENS_BY_KIND[kind].includes(token),
          `${kind} resolves {${token}}, but a round is not a run`,
        );
      }
    }
  });

  test("the refusal offers no {reason} token, because the component owns that paragraph", () => {
    // `AdmissionsDeclinedEmail` renders the decider's shared note itself. A
    // `{reason}` token as well would print the same sentence twice, so the
    // trigger supplies none and the seed copy cannot use one.
    const seed = emails.courseTemplateDefaults["admissions-declined"];
    assert.ok(!tokensIn(seed).has("reason"));
    assert.ok(
      !sendHelper.TOKENS_BY_KIND.declined.includes("reason"),
      "the declined trigger resolves {reason} again: the shared note would be printed twice",
    );
    for (const set of Object.values(sendHelper.TOKENS_BY_KIND)) {
      assert.ok(!set.includes("reason"), "an admissions trigger resolves {reason}");
    }
    // The prop is the one path the note has to the email, and the send path
    // hands it to nothing else.
    const src = source("src/lib/email/admissionEmails.ts");
    assert.match(src, /sharedReason: opts\.sharedReason \?\? ""/);
    assert.ok(
      !/reason: opts\.sharedReason/.test(src),
      "the send path feeds the shared note to the token map as well as to the component",
    );
  });

  test("buildCourseTokens omits an absent reason rather than blanking it", () => {
    const withNone = emails.buildCourseTokens({
      user: { displayName: "Sam" },
      courseTitle: "",
      runLabel: "",
      startDate: "",
    });
    assert.equal("reason" in withNone, false);
    const withOne = emails.buildCourseTokens({
      user: { displayName: "Sam" },
      courseTitle: "",
      runLabel: "",
      startDate: "",
      reason: "More applicants than groups.",
    });
    assert.equal(withOne.reason, "More applicants than groups.");
  });

  test("a run with no start date is refused, rather than mailed a hollow sentence", () => {
    // `buildCourseTokens` returns the three run tokens unconditionally, blank
    // included, and the appointment kind is the one that resolves them. The
    // seed copy says "which starts {startDate}" and the subject names the
    // course, so a run with no date would have sent "which starts ." to
    // somebody who had just been asked to run it.
    //
    // That used to be handled by dropping empty run tokens at send time, which
    // left the token literal in the email. The refusal moved to the decide
    // route instead: the appointment is not made at all, and the fix is a date
    // on the run.
    const built = emails.buildCourseTokens({
      user: { displayName: "Sam" },
      courseTitle: "",
      runLabel: "",
      startDate: "",
    });
    assert.equal(built.startDate, "", "the builder no longer blanks, so re-read the route");
    const send = source("src/lib/email/admissionEmails.ts");
    assert.ok(
      !/RUN_TOKENS/.test(send),
      "the send path drops empty run tokens again: the refusal below is then unreachable and the token would arrive literal",
    );
    assert.match(
      source(DECIDE_ROUTE),
      /if \(!run\.startDate\) \{/,
      "the decide route no longer refuses a run with no start date",
    );
    assert.match(source(DECIDE_ROUTE), /no start date yet/);
    assert.match(
      emails.courseTemplateDefaults["admissions-appointed"].blocks[1].html,
      /\{startDate\}/,
      "the seed copy stopped depending on {startDate}: the refusal above may be droppable",
    );
    // And the queue must not offer one either, or the refusal is a 400 the
    // decider walks into.
    const ui = source(QUEUE_UI);
    assert.match(ui, /disabled=\{run\.startDate === ""\}/);
    assert.match(ui, /no start date yet/);
  });

  test("the editor's sample for each admissions template is exactly its own token set", () => {
    for (const templateId of ["admissions-appointed", "admissions-declined"]) {
      const sample = samples.courseSampleTokens(templateId, "Sam Okonkwo");
      assert.deepEqual(
        Object.keys(sample).sort(),
        [...samples.admissionsTokensFor(templateId)].sort(),
        `${templateId}'s preview resolves a different set from its send path`,
      );
      for (const value of Object.values(sample)) {
        assert.ok(String(value).length > 0, `${templateId} previews an empty token`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Source pins: the route cannot run without a database
// ---------------------------------------------------------------------------

describe("the decide route's ordering", () => {
  const src = source(DECIDE_ROUTE);

  test("the view-as guard is the first thing the handler does", () => {
    const at = src.indexOf("export async function POST(");
    assert.ok(at !== -1, "no POST handler");
    const window = src.slice(at, at + 400);
    assert.match(
      window,
      /assertNotImpersonating\(\)/,
      "the decide handler does not refuse a view-as session at the top",
    );
    // Nothing may be read or written before it: an admin viewing as somebody
    // else must not be able to move a counter or mail an appointment.
    const guardAt = src.indexOf("assertNotImpersonating()", at);
    const dbAt = src.indexOf("getAdminDb()", at);
    assert.ok(guardAt < dbAt, "the route reaches the database before the guard");
  });

  test("both sends sit AFTER the transaction closes", () => {
    const span = transactionSpan(src);
    let count = 0;
    for (const match of src.matchAll(/sendAdmissionEmail\(/g)) {
      count += 1;
      assert.ok(
        match.index > span.end,
        "an appointment email is sent inside the transaction, so a retry would send it twice",
      );
    }
    assert.equal(count, 2, "expected exactly two send call sites, appoint and decline");
  });

  test("the run write, the counters and the audit row are all INSIDE the transaction", () => {
    const span = transactionSpan(src);
    const body = src.slice(span.start, span.end);
    assert.match(body, /runFacilitatorUids: FieldValue\.arrayUnion/);
    assert.match(body, /applicationCounts\.submitted/);
    assert.match(body, /facilitator-appointed/);
  });

  test("the alreadyDecided answer is returned before any send", () => {
    const decidedAt = src.indexOf("alreadyDecided: true");
    const sendAt = src.indexOf("sendAdmissionEmail(");
    assert.ok(decidedAt !== -1 && sendAt !== -1);
    assert.ok(
      decidedAt < sendAt,
      "a repeat decide falls through to the send: it would mail somebody twice",
    );
  });

  test("an enrolment round is refused rather than half-decided", () => {
    assert.match(src, /round\.kind !== "appointment"/);
  });
});

describe("whether the ROUND can be decided at all", () => {
  const round = (over) => ({ status: "open", archived: false, ...over });

  test("an open round is decidable", () => {
    assert.equal(queue.appointmentDecideBlock(round()), null);
    assert.equal(queue.appointmentDecideBlock(round({ status: "closed" })), null);
  });

  test("archived, draft and cancelled each get their own refusal", () => {
    const archived = queue.appointmentDecideBlock(round({ archived: true }));
    const draft = queue.appointmentDecideBlock(round({ status: "draft" }));
    const cancelled = queue.appointmentDecideBlock(round({ status: "cancelled" }));
    for (const [name, sentence] of Object.entries({ archived, draft, cancelled })) {
      assert.ok(sentence && sentence.length > 0, `${name} is decidable`);
    }
    assert.equal(new Set([archived, draft, cancelled]).size, 3, "one sentence for three states");
    assert.match(archived, /archive/i);
    assert.match(draft, /not open yet/i);
    assert.match(cancelled, /cancelled/i);
  });

  test("a cancelled round refuses the DECIDE ROUTE, not just the buttons", () => {
    // The route is the boundary. A queue whose buttons are hidden is a
    // courtesy; a POST from a stale tab, or from anything else, is the case
    // this has to cover.
    const src = source(DECIDE_ROUTE);
    assert.match(src, /appointmentDecideBlock\(round\)/);
    assert.match(src, /roundBlock \}, \{ status: 409 \}/);
    const guardAt = src.indexOf("appointmentDecideBlock(round)");
    const txAt = src.indexOf("db.runTransaction(");
    assert.ok(guardAt < txAt, "the round-state guard runs after the transaction opens");
  });

  test("the queue hides the buttons on those rounds and says why", () => {
    const ui = source(QUEUE_UI);
    assert.match(ui, /const deciding = canDecide && !decideBlock/);
    assert.match(ui, /canDecide && decideBlock && <p className=\{styles\.notice\}>\{decideBlock\}<\/p>/);
    // The console's link says the same thing before anybody follows it.
    const link = source("src/features/admissions/AppointmentsLink.tsx");
    assert.match(link, /read only/i);
    assert.match(
      source("src/features/admissions/RoundEditor.tsx"),
      /appointmentDecideBlock\(round\) !== null/,
    );
  });
});

describe("an unreleased part of the form", () => {
  test("is named rather than rendered as a column of Not answered", () => {
    const row = queue.buildAppointmentQueueRow(
      applicationFixture({ stageAnswers: {} }),
      STAGES,
      GRID,
      null,
      new Set(),
    );
    assert.equal(row.stages.length, 1, "the stage itself is still listed");
    assert.equal(row.stages[0].released, false);
    assert.deepEqual(row.stages[0].answers, [], "an unanswered question was projected anyway");
  });

  test("keeps whatever was actually answered, so a cancelled round hides nothing", () => {
    // `isStageReleased` also goes false when a round is cancelled or put back
    // in draft. A round changing state must not swallow sentences somebody
    // already wrote.
    const row = queue.buildAppointmentQueueRow(
      applicationFixture(),
      STAGES,
      GRID,
      null,
      new Set(["nothing-matches"]),
    );
    assert.deepEqual(
      row.stages[0].answers.map((a) => a.questionId),
      ["q1", "q2"],
      "the answers this person really wrote were dropped with the stage",
    );
  });

  test("a released stage is unchanged, and the default is released", () => {
    const released = queue.buildAppointmentQueueRow(
      applicationFixture(),
      STAGES,
      GRID,
      null,
      new Set(["s1"]),
    );
    assert.equal(released.stages[0].released, true);
    assert.equal(released.stages[0].answers.length, 2);
    const omitted = queue.buildAppointmentQueueRow(applicationFixture(), STAGES, GRID, null);
    assert.equal(omitted.stages[0].released, true);
  });

  test("the loader is the one asking, with one clock reading", () => {
    const src = source(QUEUE_LOADER);
    assert.match(src, /isStageReleased\(stage, round, now\)/);
    assert.match(src, /now: Date = new Date\(\)/);
    const ui = source(QUEUE_UI);
    assert.match(ui, /has not been released yet/);
  });
});

describe("what the queue reads, and in what order", () => {
  test("the gate is applied before the applicants and their profiles are read", () => {
    // The join reads every applicant's user document, which is member PII.
    // Reading it and then deciding the reader may not have it is the wrong
    // order to do those two things in.
    const page = source(QUEUE_PAGE);
    const roundAt = page.indexOf("loadAppointmentRound(");
    const gateAt = page.indexOf("canViewAppointmentQueue(");
    const queueAt = page.indexOf("loadAppointmentQueue(");
    assert.ok(roundAt !== -1 && gateAt !== -1 && queueAt !== -1);
    assert.ok(roundAt < gateAt, "the round is read after the gate is applied to it");
    assert.ok(gateAt < queueAt, "the queue is read before the gate is applied");
    // And the loader cannot be called with an id, so no caller can skip the
    // round read and the gate that hangs off it.
    assert.match(
      source(QUEUE_LOADER),
      /export async function loadAppointmentQueue\(\s*db: Firestore,\s*round: AdmissionRoundDoc,/,
    );
  });

  test("a capped read says what it left out", () => {
    const src = source(QUEUE_LOADER);
    assert.match(src, /countIfCapped\(applicationQuery, appsSnap\.size, MAX_ROWS\)/);
    assert.match(src, /countIfCapped\(runQuery, runsSnap\.size, MAX_RUNS\)/);
    // The count only runs when the cap was reached, so an ordinary queue of a
    // dozen pays nothing for a line it will never show.
    assert.match(src, /if \(shown < cap\) return null/);
    const ui = source(QUEUE_UI);
    assert.match(ui, /Only the first \{rowsTruncated\.shown\} of \{rowsTruncated\.total\}/);
    assert.match(ui, /Only the first \{runsTruncated\.shown\} of \{runsTruncated\.total\}/);
  });
});

describe("neither decision happens on one press", () => {
  const ui = source(QUEUE_UI);

  test("both buttons open a confirm step instead of posting", () => {
    // Both are irreversible from this page: the route refuses to overwrite a
    // decision once its email has gone out.
    assert.match(ui, /setConfirm\("appoint"\)/);
    assert.match(ui, /setConfirm\("decline"\)/);
    assert.ok(
      !/onClick=\{\(\) => decide\("appoint"\)\}/.test(ui),
      "Appoint posts on the first press again",
    );
    assert.ok(
      !/onClick=\{\(\) => decide\("decline"\)\}/.test(ui),
      "Decline posts on the first press again",
    );
    assert.match(ui, /onClick=\{\(\) => decide\(confirm\)\}/);
  });

  test("the confirm names the person, the run, and what the note does", () => {
    assert.match(ui, /Appoint this person and email them now\?/);
    assert.match(ui, /Tell this person we cannot take them on\?/);
    assert.match(ui, /className=\{styles\.confirmName\}/);
    assert.match(ui, /chosen\.courseTitle\} \$\{chosen\.label\}/);
    assert.match(ui, /Your note is sent to them with it/);
    assert.match(ui, /it is not sent to them/);
  });
});

describe("the queue reads nothing it does not log", () => {
  test("neither the loader nor the page can reach the private collection", () => {
    for (const file of [QUEUE_LOADER, QUEUE_PAGE, DECIDE_ROUTE]) {
      const src = source(file);
      assert.ok(
        !/admissionApplicationPrivate|privateRef/.test(src),
        `${file} reaches the access-requirements collection. The privacy policy ` +
          "promises every read of that answer is recorded, and this surface records " +
          "nothing.",
      );
    }
  });

  test("none of them imports the apply context", () => {
    // `applyContext.ts` exports the helpers that address
    // `admissionApplicationPrivate`, and the privacy scan treats importing it
    // as being able to reach that collection. The collection NAME lives on the
    // firestore leaf module for exactly this reason.
    for (const file of [QUEUE_LOADER, QUEUE_PAGE, DECIDE_ROUTE]) {
      assert.ok(
        !/applyContext/.test(source(file)),
        `${file} imports the apply context, which can address the private collection`,
      );
    }
  });

  test("the queue page states in its own copy that it is not blind", () => {
    const ui = source(QUEUE_UI);
    assert.match(ui, /not name-blind/i);
    assert.match(ui, /Access requirements are not/i);
  });

  test("every applicant string on the queue renders through MemberText", () => {
    const ui = source(QUEUE_UI);
    assert.match(ui, /import MemberText from "@\/components\/ui\/MemberText"/);
    assert.ok(
      !/dangerouslySetInnerHTML/.test(ui),
      "the appointment queue renders HTML from somewhere",
    );

    // The import and the absence of a raw-HTML renderer are necessary and not
    // sufficient: the question is whether the applicant-typed strings go
    // through the component or around it. So each one is checked twice, once
    // for a MemberText that renders it and once for the absence of any other
    // place it is turned into output.
    //
    // A `{expr && (` guard renders nothing itself and is allowed. What is not
    // allowed is `{expr}` as a child or as an attribute value, which is how a
    // name ends up in a `title=` or in a confirmation sentence.
    const sensitive = [
      "row.displayName",
      "row.preferredName",
      "answer.text",
      "decided.sharedReason",
    ];
    const memberTexts = ui.match(/<MemberText\b[^>]*\/>/g) ?? [];
    assert.ok(memberTexts.length >= 4, "the queue renders fewer MemberTexts than it used to");
    const outside = ui.replace(/<MemberText\b[^>]*\/>/g, "<MemberText/>");
    for (const expr of sensitive) {
      const escaped = expr.replace(/\./g, "\\.");
      assert.ok(
        memberTexts.some((tag) => new RegExp(`text=\\{[^}]*${escaped}`).test(tag)),
        `${expr} is not rendered through MemberText at all`,
      );
      assert.ok(
        !new RegExp(`\\{\\s*${escaped}\\s*(\\}|\\|\\||\\?\\?)`).test(outside),
        `${expr} is rendered outside MemberText, so applicant-typed text reaches the page unescorted`,
      );
    }
  });
});
