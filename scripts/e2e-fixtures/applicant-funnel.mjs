/**
 * The applicant funnel's fixture: a handful of fake applicants, one admission
 * round, and one open-enrolment pre-course with two capped groups.
 *
 * This is the worked example of a SPEC MODULE. Every file in this directory
 * except `core.mjs` exports one object named `SPEC` with the same shape, and
 * `scripts/run-e2e.mjs` discovers them by walking the directory:
 *
 *   name                    unique; the state and marker file stem
 *   specFile                the Playwright spec this fixture is for
 *   steps                   ordered step names, the spec's step() calls in order
 *   recaptchaDependentSteps the subset skipped against a deployed target
 *   needs                   { admin: boolean }
 *   covers                  { routes: [...], pages: [...] } the spec exercises
 *   seed({ runId, suppress, options, onState })  creates everything, returns
 *                           the state. It calls `onState(state)` BEFORE its
 *                           first write, so a seed that throws half way still
 *                           leaves the runner a ledger to tear down.
 *   countRows(state)        every kind of row and account, plus counts.total
 *   teardown(state)         removes everything, then returns countRows(state)
 *
 * Nothing runs at import time: `core.mjs` obtains no credential until a
 * function is called, so the coverage guard can import this module offline.
 *
 * ## Nothing it seeds can send mail against a deployed target
 *
 * The drop-out leg calls a route that emails the member
 * (`sendCourseDroppedOutEmail`). Fixture addresses are `.invalid` (RFC 2606),
 * so such a send cannot reach a person, but against the DEPLOYED dev backend
 * it would still be a real hand-off to Resend and a hard bounce logged against
 * the sending domain. So seeding writes a `suppressedEmails` row for every
 * fixture address FIRST, unless the runner says this run's mail is caught by
 * Mailpit.
 *
 * The check is universal since the September fix: `sendEmail()` in
 * `src/lib/email/send.ts` consults the suppression list for every send and
 * holds a suppressed recipient (tests/email-suppression-chokepoint.test.mjs).
 * The per-feature helpers still check too: `sendCourseDroppedOutEmail()` in
 * `courseEnrolmentEmails.ts` returns early on `isSuppressed()` before it builds
 * a message, and `courseFacilitatorEmails.ts` drops suppressed addresses
 * through `filterSuppressed()`, and `tests/funnel-harness-guards.test.mjs`
 * keeps that second layer: it reads the email helpers the funnel's routes
 * import and fails if one of them stops
 * checking. The rows are self-identifying, ledgered, and removed by teardown
 * like everything else.
 *
 * The runner passes `suppress: false` only when it started the server itself
 * (or is driving the harness port), because only that server has had its SMTP
 * pointed at Mailpit on this machine. There the `emailSends` rows the sends
 * leave are what a spec reads to prove a route really sent, and those rows are
 * counted and drained by the manifest below like every other row this fixture
 * causes. Every other target, loopback or not, gets the suppression rows.
 */
import {
  applicationId,
  assertFixtureTarget,
  cohortChannel,
  countAccounts,
  createFixtureUser,
  deleteQuery,
  enrolmentId,
  fixtureDoc,
  fixtureId,
  fixtureQuery,
  fixtureSubcollection,
  subscriptionId,
} from "./core.mjs";
import {
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";

const log = (msg) => console.log(`[funnel-seed] ${msg}`);

/**
 * `weekDocId` from src/lib/firestore/courses.ts, restated for plain Node the
 * same way scripts/e2e-fixtures/register-push.mjs restates it. Restated rather
 * than imported from that module: every fixture here stands on its own, and a
 * cross-fixture import would make one spec's seed depend on another's file.
 */
function weekDocId(weekNumber) {
  return `w${String(weekNumber).padStart(2, "0")}`;
}

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it finished
 * and the runner checks the record against this list, so a step renamed in one
 * place and not the other fails loudly instead of quietly shrinking what a
 * green run means.
 */
export const FUNNEL_STEPS = [
  "the public course page shows the seeded session slots",
  "a signed-out visitor gets the sign-in gate on the apply page",
  "applicant 1 signs in",
  "starting an application opens an editable draft",
  "the draft saves",
  "the draft survives a reload",
  "the availability grid paints and the marks persist",
  "submitting moves the application to view-only",
  "withdrawing needs the typed word and then takes it back",
  "picking it back up restores the answers and submits again",
  "the applicant status hub lists the round",
  "taking a pre-course seat",
  "leaving the course needs the typed course title",
];

/**
 * The steps that cannot run against a DEPLOYED target, and why.
 *
 * Start, Submit and Pick it back up each send a reCAPTCHA token, and against
 * dev.naisi.uk the real widget answers headless Chromium with an image
 * challenge ("Select all images with crosswalks", 6 September 2026). No spec
 * may solve one: the gate being closed to automation is the property the
 * `recaptcha-gate` battery exists to assert. The other steps here are not
 * gated themselves but need the draft or the submission a gated press creates.
 * In `--local` mode the widget is stubbed against the always-pass secret
 * (`scripts/e2e/lib/browser.mjs`) and every one of these runs.
 *
 * So the spec SKIPS these against a deployed target, records each skip with
 * this reason in the completion marker, and the runner accepts exactly this
 * set as skipped in dev mode and nothing else. The same shape as the register
 * batteries, which are local-mode only for the same gate.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [
  "starting an application opens an editable draft",
  "the draft saves",
  "the draft survives a reload",
  "the availability grid paints and the marks persist",
  "submitting moves the application to view-only",
  "withdrawing needs the typed word and then takes it back",
  "picking it back up restores the answers and submits again",
  "the applicant status hub lists the round",
];

/**
 * How many fake applicants a seed creates when none is asked for.
 *
 * Five, because that is the dress-rehearsal number the delivery plan names.
 * The spec drives applicant 1 through the whole journey; the rest exist so a
 * rehearsal can be clicked through by hand against a realistic queue, and so
 * the one-place group has somebody to be full for.
 */
export const DEFAULT_APPLICANTS = 5;

/**
 * The one stage question the funnel answers, with a FIXED id so the spec can
 * address its control (`#q_funnel_why-input`, see FormRenderer's `fieldId`)
 * without reading the seed back. Deterministic by construction, which is the
 * same rule the doc ids follow.
 */
export const FUNNEL_QUESTION_ID = "q_funnel_why";

/** The confirmation word the withdraw box wants. Mirrors `WITHDRAW_WORD`. */
export const WITHDRAW_WORD = "WITHDRAW";

/** The stages subcollection under a round. Subcollections need their own name. */
const STAGES = "stages";

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Civil date key "YYYY-MM-DD" in Europe/London, the shape `startDate` wants. */
function londonDateKey(at) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The round document. Mirrors `normalizeAdmissionRound`'s expectations field
 * for field; anything it would default is still written explicitly, because a
 * fixture that leans on a normaliser stops testing the shape the authoring
 * route actually stores.
 *
 * `outcomeRunIds` is deliberately EMPTY. A round that named the pre-course run
 * would make `roundOwnsDates()` consider taking over the course page's dates,
 * and the funnel wants the two objects independent: the round is what you
 * apply to, the run is what you click into, and this run drives both without
 * either standing in for the other.
 */
function roundDoc({ id, label, now, funnelRunId }) {
  return {
    e2eFunnelRunId: funnelRunId,
    kind: "enrolment",
    label,
    slug: id,
    blurb:
      "A throwaway intake created by the applicant-funnel end-to-end run. " +
      "If you are reading this on a live surface, a run crashed before its teardown.",
    academicYear: "2026/27",
    status: "open",
    opensAt: new Date(now.getTime() - DAY_MS),
    closesAt: new Date(now.getTime() + 14 * DAY_MS),
    decisionsByDate: londonDateKey(new Date(now.getTime() + 21 * DAY_MS)),
    stageIds: ["s1"],
    programmePreference: {
      enabled: false,
      streams: [],
      fellowships: [],
      maxRankedFellowships: 2,
      offerFellowshipFallback: false,
    },
    // DEFAULT_AVAILABILITY_GRID: 09:00 to 18:00 in quarter hours.
    availabilityGrid: { version: 1, startMinute: 540, endMinute: 1080, slotMinutes: 15 },
    accessRequirementsPrompt:
      "Is there anything we should know so you can take part fully?",
    criteria: [
      { id: "c1", label: "Motivation", guidance: "Why this, why now." },
      { id: "c2", label: "Follow through", guidance: "Evidence of finishing things." },
    ],
    scoreScale: { min: 1, max: 5 },
    reviewersPerApplication: 2,
    // No reviewers and no decider: the funnel drives the APPLICANT side only,
    // and an empty array is the honest fixture for a round nobody staffs.
    reviewerUids: [],
    finalDeciderUid: null,
    blind: { hideNames: true, hideMembership: true },
    evidenceRunIds: [],
    reminderOffsets: [],
    outcomeRunIds: [],
    applicationCounts: {
      draft: 0,
      submitted: 0,
      accepted: 0,
      "fellowship-offered": 0,
      waitlisted: 0,
      rejected: 0,
      withdrawn: 0,
    },
    archived: false,
    clonedFromRoundId: null,
    authorUid: "",
    createdAt: now,
    updatedAt: now,
  };
}

/** The single released stage, with one required long-text question. */
function stageDoc({ roundIdValue, now, funnelRunId }) {
  return {
    e2eFunnelRunId: funnelRunId,
    roundId: roundIdValue,
    label: "About you",
    intro: "One question, so the harness has something to type into.",
    questions: [
      {
        id: FUNNEL_QUESTION_ID,
        type: "longText",
        label: "Why do you want to take part?",
        required: true,
        maxLength: 500,
      },
    ],
    // Null releases with the round, which is what makes this stage visible the
    // moment the window opens rather than on a date the spec would have to wait for.
    releaseAt: null,
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function courseDoc({ title, now, funnelRunId }) {
  return {
    e2eFunnelRunId: funnelRunId,
    title,
    tagline: "Throwaway fixture for the applicant-funnel end-to-end run.",
    summaryBlocks: [
      {
        id: "b1",
        // `richText` is a real BlockType; "paragraph" is not, and sanitizeBlocks
        // drops what it does not recognise, so the seeded page rendered nothing.
        type: "richText",
        // The public course page renders this. Saying what it is beats a lorem
        // ipsum somebody has to go and identify.
        html: "<p>This course exists only while an automated funnel run is in flight.</p>",
      },
    ],
    track: "technical",
    level: "No prior experience needed",
    estimatedWeeklyHours: 2,
    status: "published",
    showcaseRunId: null,
    authorUid: "",
    collaboratorUids: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The open-enrolment pre-course run.
 *
 * `status: "running"` plus a window that is open on both sides is what
 * `isEnrolOpen()` wants, and `enrolMode: "open"` is what puts the session
 * picker on the public course page instead of an apply link.
 */
function runDoc({ runIdValue, courseIdValue, courseTitle, label, now, funnelRunId }) {
  return {
    e2eFunnelRunId: funnelRunId,
    courseId: courseIdValue,
    courseTitle,
    label,
    academicYear: "2026/27",
    status: "running",
    enrolMode: "open",
    streams: [],
    enrolledCount: 0,
    startDate: londonDateKey(now),
    // `weekId` is NOT optional: `isValidWeekPlanEntry` in
    // src/lib/firestore/courses.ts requires it on a week entry and
    // `sanitizeWeekPlan` DROPS the entries that lack it, silently. A plan whose
    // entries were all dropped resolves to no sessions at all, and the run then
    // reads as having no taught weeks. Same shape as register-push's fixture,
    // which found this first.
    weekPlan: [{ kind: "week", weekNumber: 1, weekId: weekDocId(1) }],
    // `cohort`, `templateId` and `templateLabel` are ABSENT rather than null,
    // matching what the authoring routes store and what normalizeCourseRun
    // round-trips. firestore.rules pins all three with a `.get()` default, and
    // a stored null compares unequal to that default, which would wedge every
    // later non-admin edit of the seeded run in RunEditor. `applicationCap` is
    // null on purpose: RunEditor writes null for "no cap" and no rule pins it.
    startHereBlocks: [],
    applicationForm: [],
    applicationsOpenAt: new Date(now.getTime() - DAY_MS),
    applicationsCloseAt: new Date(now.getTime() + 14 * DAY_MS),
    applicationCap: null,
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: { pending: 0, accepted: 0, waitlisted: 0, rejected: 0, withdrawn: 0 },
    groupCount: 2,
    // Always derived, never typed: every consumer of the cohort channel
    // computes `cohort:<runId>` and a stored value that disagreed would make
    // one run's teardown sweep another list's subscription rows.
    channel: cohortChannel(runIdValue),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * One capped session slot.
 *
 * Capacities are small ON PURPOSE (2 and 1): a funnel that only ever takes
 * the first seat never exercises the full-group branch, and a group with one
 * place is the cheapest way to have "full" be reachable in a single run.
 */
function groupDoc({ runIdValue, courseIdValue, name, weekday, startTimeLocal, capacity, now, funnelRunId }) {
  return {
    e2eFunnelRunId: funnelRunId,
    runId: runIdValue,
    courseId: courseIdValue,
    name,
    facilitatorUids: [],
    facilitatorAppointments: {},
    streamId: null,
    capacity,
    memberCount: 0,
    session: {
      weekday,
      startTimeLocal,
      durationMinutes: 90,
      location: "Throwaway fixture, no room booked",
      meetingUrl: null,
      notes: "",
    },
    sessionOverrides: {},
    sessionModes: {},
    paceStartDate: null,
    paceWeekPlan: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Creates the whole throwaway world and returns the state the spec drives it
 * from. The RUNNER persists that state; a hand-driven `node
 * scripts/seed-fake-applicants.mjs up` writes it through the same helper.
 */
async function seed({ runId: funnelRunId, suppress = true, options = {}, onState } = {}) {
  const applicants = options.applicants ?? DEFAULT_APPLICANTS;
  const target = assertFixtureTarget();
  if (!Number.isInteger(applicants) || applicants < 1 || applicants > 10) {
    throw new Error(`--applicants must be a whole number from 1 to 10, got ${applicants}`);
  }
  const now = new Date();

  const courseTitle = `E2E funnel pre-course ${funnelRunId}`;
  const courseIdValue = fixtureId("e2e-funnel-pre-course", funnelRunId);
  const runIdValue = fixtureId("e2e-funnel-run", funnelRunId);
  const roundIdValue = fixtureId("e2e-funnel-round", funnelRunId);
  const groupA = fixtureId("e2e-funnel-group-a", funnelRunId);
  const groupB = fixtureId("e2e-funnel-group-b", funnelRunId);

  const state = {
    funnelRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    courseId: courseIdValue,
    courseTitle,
    runId: runIdValue,
    roundId: roundIdValue,
    stageId: "s1",
    questionId: FUNNEL_QUESTION_ID,
    groupIds: [groupA, groupB],
    channel: cohortChannel(runIdValue),
    applicants: [],
    /** Written by seeding, deleted by teardown. Recorded so a later process
        can find them without re-deriving the address list. Empty on loopback,
        where suppression is deliberately off. */
    suppressed: [],
  };

  // Published BEFORE the first write, and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created. Everything below either fills a field of this object or
  // writes a document whose id is already in it.
  onState?.(state);

  log(`Seeding fixture ${funnelRunId} into ${target.projectId}.`);

  // Accounts first: everything else can be torn down without them, but an
  // account with no fixture to apply to is the harmless failure and a fixture
  // with no accounts is not.
  for (let i = 0; i < applicants; i += 1) {
    const password = `E2eFunnel!${funnelRunId}${i}`;
    const account = await createFixtureUser({
      runId: funnelRunId,
      index: i,
      password,
      suppress,
    });
    if (account.suppressionId) state.suppressed.push(account.suppressionId);
    state.applicants.push({
      index: i,
      uid: account.uid,
      email: account.email,
      password: account.password,
    });
  }

  await fixtureDoc("courses", courseIdValue).set(
    courseDoc({ title: courseTitle, now, funnelRunId }),
  );
  await fixtureDoc("courseRuns", runIdValue).set(
    runDoc({
      runIdValue,
      courseIdValue,
      courseTitle,
      label: `Funnel ${funnelRunId}`,
      now,
      funnelRunId,
    }),
  );
  await fixtureDoc("courseGroups", groupA).set(
    groupDoc({
      runIdValue,
      courseIdValue,
      name: "Funnel session A",
      weekday: 2,
      startTimeLocal: "18:00",
      capacity: 2,
      now,
      funnelRunId,
    }),
  );
  await fixtureDoc("courseGroups", groupB).set(
    groupDoc({
      runIdValue,
      courseIdValue,
      name: "Funnel session B",
      weekday: 4,
      startTimeLocal: "13:00",
      capacity: 1,
      now,
      funnelRunId,
    }),
  );

  await fixtureDoc("admissionRounds", roundIdValue).set(
    roundDoc({ id: roundIdValue, label: `Funnel intake ${funnelRunId}`, now, funnelRunId }),
  );
  await fixtureSubcollection("admissionRounds", roundIdValue, STAGES)
    .doc("s1")
    .set(stageDoc({ roundIdValue, now, funnelRunId }));

  log(
    `Seeded round ${roundIdValue}, run ${runIdValue}, ` +
      `${state.applicants.length} applicant(s).`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/**
 * Counts every row this fixture owns, seeded or route-created. Teardown is
 * only believed when this reads zero across the board.
 *
 * Deliberately a COUNT of documents rather than a boolean: "some rows remain"
 * is not an actionable sentence, and the collection that failed to drain is
 * the whole diagnosis.
 */
async function countRows(state) {
  const { funnelRunId, roundId, runId: runIdValue, channel } = state;
  const counts = {};

  const seededSingles = [
    ["courses", state.courseId],
    ["courseRuns", runIdValue],
    ["admissionRounds", roundId],
  ];
  for (const [collection, id] of seededSingles) {
    const snap = await fixtureDoc(collection, id).get();
    counts[collection] = snap.exists ? 1 : 0;
  }

  const stages = await fixtureSubcollection("admissionRounds", roundId, STAGES).get();
  counts.admissionRoundStages = stages.size;

  counts.courseGroups = (
    await fixtureQuery("courseGroups").where("runId", "==", runIdValue).get()
  ).size;
  counts.admissionApplications = (
    await fixtureQuery("admissionApplications").where("roundId", "==", roundId).get()
  ).size;
  counts.courseEnrolments = (
    await fixtureQuery("courseEnrolments").where("runId", "==", runIdValue).get()
  ).size;
  counts.courseProgress = (
    await fixtureQuery("courseProgress").where("runId", "==", runIdValue).get()
  ).size;
  counts.courseAudit = (
    await fixtureQuery("courseAudit").where("runId", "==", runIdValue).get()
  ).size;
  counts.subscriptions = (
    await fixtureQuery("subscriptions").where("channel", "==", channel).get()
  ).size;
  counts.tasks = (
    await fixtureQuery("tasks").where("sourceRef.cohortId", "==", runIdValue).get()
  ).size;

  // `admissionApplicationPrivate` carries no roundId to query on: its id IS
  // the application's, so it is counted by address, one per applicant.
  let privateRows = 0;
  for (const applicant of state.applicants ?? []) {
    const snap = await fixtureDoc(
      "admissionApplicationPrivate",
      applicationId(roundId, applicant.uid),
    ).get();
    if (snap.exists) privateRows += 1;
  }
  counts.admissionApplicationPrivate = privateRows;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  // The send log. Zero when the fixture addresses are suppressed; when mail is
  // caught the sends really happen (into Mailpit) and each one logs a row.
  //
  // Keyed on the RECIPIENT, which is run-scoped by construction: a fixture
  // address is `e2e-f<runId><index>@e2e.invalid`, so no other run and no
  // person can own one. What that key cannot see is a send this fixture caused
  // to somebody ELSE (a facilitator, an admin, a group notice): such a row
  // would outlive teardown under a manifest that still read zero. Nothing on
  // the funnel's paths sends anywhere but the applicant, and a spec that adds
  // one must count it here, by whatever key that send is addressed with.
  let sendRows = 0;
  for (const applicant of state.applicants ?? []) {
    sendRows += (
      await fixtureQuery("emailSends").where("to", "==", applicant.email).get()
    ).size;
  }
  counts.emailSends = sendRows;

  const accounts = await countAccounts((state.applicants ?? []).map((a) => a.uid));
  counts.users = accounts.users;
  counts.authAccounts = accounts.authAccounts;

  // Event-log lines are addressed through the subscription rows they describe,
  // which is why they are counted after them and swept before them.
  let eventRows = 0;
  for (const applicant of state.applicants ?? []) {
    const subId = subscriptionId(applicant.email, channel);
    eventRows += (
      await fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId).get()
    ).size;
  }
  counts.subscriptionEvents = eventRows;

  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.funnelRunId = funnelRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Removes everything, in the order that keeps a half-finished teardown
 * recoverable: route-created leaves first, then the fixture objects, then the
 * accounts. An account deleted before its rows would leave rows nothing names.
 *
 * Every Auth deletion goes through `deleteHarnessUser`, which re-resolves the
 * account and refuses any address outside the harness namespace. A tampered
 * or stale state file therefore cannot make this delete a real person.
 */
async function teardown(state) {
  assertFixtureTarget();
  const { roundId, runId: runIdValue, channel } = state;
  log(`Tearing down fixture ${state.funnelRunId}.`);
  /** Anything that refused or failed to delete, reported rather than logged
      and forgotten: a swallowed rejection here is an account or a document
      left on a shared project under a manifest that says everything went. */
  const failures = [];

  // The namespace check comes FIRST, before a single delete.
  //
  // Several sweeps below are keyed on an ADDRESS out of this state file: the
  // subscription row and its event lines, and the send log. A tampered or
  // stale ledger naming a real person would have had those rows deleted and
  // only then reached the refusal that exists to stop exactly that. So the
  // whole applicant list is checked up front, and the account deletions later
  // re-check what Auth says each uid's address actually is.
  for (const applicant of state.applicants ?? []) {
    if (!isHarnessAccount(applicant.email)) {
      throw new Error(
        `REFUSING to tear down ${applicant.email}: not a harness account. The ` +
          "state file names an address this fixture could not have created.",
      );
    }
  }

  for (const applicant of state.applicants ?? []) {
    const subId = subscriptionId(applicant.email, channel);
    await deleteQuery(
      fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId),
    );
    await fixtureDoc("subscriptions", subId).delete();
    await fixtureDoc(
      "admissionApplicationPrivate",
      applicationId(roundId, applicant.uid),
    ).delete();
    await fixtureDoc("admissionApplications", applicationId(roundId, applicant.uid)).delete();
    await fixtureDoc("courseEnrolments", enrolmentId(runIdValue, applicant.uid)).delete();
  }

  // Anything the addressed deletes above could have missed, because a route
  // wrote a row for an account this state file does not list (a hand-driven
  // repeat of a step, a run that crashed between seeding and its ledger write).
  await deleteQuery(fixtureQuery("admissionApplications").where("roundId", "==", roundId));
  await deleteQuery(fixtureQuery("courseEnrolments").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseProgress").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseAudit").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("subscriptions").where("channel", "==", channel));
  await deleteQuery(fixtureQuery("tasks").where("sourceRef.cohortId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseGroups").where("runId", "==", runIdValue));

  const stages = await fixtureSubcollection("admissionRounds", roundId, STAGES).get();
  for (const doc of stages.docs) await doc.ref.delete();
  await fixtureDoc("admissionRounds", roundId).delete();
  await fixtureDoc("courseRuns", runIdValue).delete();
  await fixtureDoc("courses", state.courseId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  // The send log LAST of the row sweeps, because the drop-out mail is fire and
  // forget: the route answers the browser and logs its row a moment later, so
  // the later this runs the smaller the window in which a row lands behind it.
  for (const applicant of state.applicants ?? []) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", applicant.email));
  }

  for (const applicant of state.applicants ?? []) {
    // The users document first: an Auth account whose document outlives it is
    // a ghost row in the admin members list.
    //
    // Both deletes resolve the account BY UID and re-check the namespace on
    // the address that comes back, rather than trusting the address this
    // state file happens to sit next to. The check at the top is on the state
    // file's own pairing, which a hand-edited or stale file can get wrong;
    // these two are on what Auth actually says the uid is.
    try {
      await deleteHarnessUserDoc(applicant.uid);
      await deleteHarnessUser(applicant.uid);
    } catch (err) {
      failures.push(`${applicant.uid}: ${err.message}`);
      log(`Could not tear down ${applicant.uid}: ${err.message}`);
    }
  }

  const counts = await countRows(state);
  if (failures.length > 0) {
    // Folded into the manifest so the exit code carries it: a refusal that
    // only printed would let a green-looking run end on a live account.
    counts.teardownFailures = failures;
    counts.total += failures.length;
  }
  return counts;
}

export const SPEC = {
  name: "applicant-funnel",
  specFile: "tests/e2e/applicant-funnel.spec.mjs",
  steps: FUNNEL_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // The funnel drives the APPLICANT side only. Nobody signs in above role
  // `pending`, so it needs no owner-provided admin account.
  needs: { admin: false },
  /**
   * What a green run of this spec actually covers, as src/app keys. The
   * coverage guard checks each one resolves to a real route or page, so a
   * moved file fails here instead of quietly shrinking the map.
   */
  covers: {
    routes: [
      "/api/auth/session",
      "/api/admissions/rounds/[roundId]/apply",
      "/api/admissions/rounds/[roundId]/apply/submit",
      "/api/courses/runs/[runId]/enrol",
    ],
    pages: [
      "/(public)/courses/[courseId]",
      "/(public)/apply/[roundId]",
      "/(auth)/login",
      "/(public)/applications",
    ],
  },
  /**
   * "verified": this spec has passed end to end, with a teardown manifest of
   * zero, in both modes.
   *
   * THE EVIDENCE. 13 of 13 steps completed and the manifest totalled zero,
   * through `scripts/run-e2e.mjs` on 6 September 2026: in `--local` mode
   * against a production build, and against the shared Next DEV server on
   * http://127.0.0.1:3100 while six other browser specs drove the same server.
   * Both runs wrote the completion marker the runner insists on, so the record
   * is the marker rather than this sentence.
   *
   * WHAT HAD BEEN STOPPING IT. Four earlier runs on the same day stopped at
   * "applicant 1 signs in", with the browser still on /login and no error on
   * the form. The cause was in the SHARED helper rather than in this spec or
   * in the product: `signInWithPassword` filled the two boxes and pressed as
   * soon as `#auth-email` was in the DOM, which on a dev server is before
   * React has hydrated the controlled inputs and while AuthEntry's card is
   * still sliding in from off screen. Five specs had each written their own
   * copy of the wait; the helper now does it once (hydration marker, the card
   * landing, then a read-back of both fields before the press), and the copies
   * are gone. This spec's sign-in step is unchanged: it calls the shared
   * helper, which is now the one that waits.
   *
   * ONE MORE RACE OF THE SAME FAMILY, found by the first run that got past the
   * sign-in. The availability grid step drags a pointer across a grid the step
   * before it had just reloaded, and a drag on markup React has not attached
   * to yet paints nothing and says nothing about why. The step now waits for
   * that grid to be hydrated first, through `waitForHydration` in
   * scripts/e2e/lib/browser.mjs. Nothing it asserts changed.
   */
  status: "verified",
  seed,
  countRows,
  teardown,
};
