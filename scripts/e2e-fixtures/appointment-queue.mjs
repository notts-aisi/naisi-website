/**
 * The appointment queue's fixture: one facilitator round with two submitted
 * applications on it, and one run somebody can be appointed onto.
 *
 * ## Why the applications are seeded rather than driven
 *
 * The applicant funnel drives the apply leg for real, and that leg is
 * reCAPTCHA-gated: it only runs against a local server with the always-pass
 * secret. This spec is about the DECIDER's screen, so it seeds the two
 * submitted applications with the Admin SDK, exactly in the shape the apply
 * and submit routes leave behind (`tx.create` in
 * `/api/admissions/rounds/[roundId]/apply` plus the `tx.update` in
 * `.../apply/submit`), and drives everything from `/admin/admissions/[roundId]/
 * appointments` onwards through the browser. That is what lets it run against
 * a deployed target as well as a local one.
 *
 * ## The round names nobody
 *
 * `reviewerUids` is empty and `finalDeciderUid` is null, exactly as the
 * funnel's round is, because this harness may never mint round authority.
 * `canDecideAppointments` admits an admin regardless of either field, so the
 * owner's own admin account decides, which is also the shape a real facilitator
 * round takes on the evening it closes.
 *
 * ## What the decide route writes, and what this therefore counts
 *
 * Reading `/api/admissions/rounds/[roundId]/decide` end to end, one appointment
 * writes: the application's status and outcome; the round's two counters; the
 * uid onto the run's facilitator list; one `courseAudit` row; and, after the
 * commit, one `admissions` send to the applicant. A decline writes the first
 * two and the send. The push mirror writes nothing without VAPID configuration,
 * which no harness server has. Every one of those is either a document this
 * fixture deletes outright (the round, the run, the applications) or a row the
 * manifest below counts and sweeps (`courseAudit`, `emailSends`).
 *
 * ## Mail
 *
 * Both decisions email the applicant, so seeding writes a `suppressedEmails`
 * row for every fixture address FIRST unless the runner says this run's mail
 * is caught by Mailpit. `sendAdmissionEmail` returns early on `isSuppressed()`
 * before it builds a message, which is what makes that a no-mail promise
 * rather than a hope. Where the mail IS caught, the `emailSends` rows the two
 * sends leave are what the spec reads to prove the route really sent, and they
 * are counted back to zero like everything else.
 */
import {
  assertFixtureTarget,
  countAccounts,
  createFixtureUser,
  deleteQuery,
  fixtureDoc,
  fixtureId,
  fixtureQuery,
  fixtureSubcollection,
} from "./core.mjs";
import {
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";

const log = (msg) => console.log(`[appointment-seed] ${msg}`);

export const APPOINTMENT_STEPS = [
  "the admin signs in and opens the appointment queue",
  "the queue lists both applicants, their answers and when they can be in a room",
  "appointing the first applicant asks for the run and a confirmation",
  "the appointed card names the run and says the email has gone",
  "declining the second applicant takes a confirmation too",
  "Firestore carries both decisions, the facilitator and the audit line",
  "the two decision emails are logged",
];

/**
 * None of it is reCAPTCHA-gated: the queue is an admin page behind a session
 * cookie and the decide route is a plain POST. The applications the queue
 * lists are seeded rather than applied for, which is what keeps this spec off
 * the gated apply routes. An empty list here says the whole journey runs
 * against a deployed target as well as a local server.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/** The stage subcollection under a round. Subcollections need their own name. */
const STAGES = "stages";

/** The one stage, and the one question the fixture answers on it. */
export const APPOINTMENT_STAGE_ID = "s1";
export const APPOINTMENT_QUESTION_ID = "q_appoint_why";

/** `admissionApplicationId` from src/lib/firestore/admissionApplications.ts. */
export function applicationDocId(roundId, uid) {
  return `${roundId}__${uid}`;
}

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
 * The grid the round is drawn on: 09:00 to 18:00 in quarter hours, which is
 * `DEFAULT_AVAILABILITY_GRID`. 36 slots a day, four to a hex character, so
 * nine characters per day column.
 */
const GRID = { version: 1, startMinute: 540, endMinute: 1080, slotMinutes: 15 };

/**
 * One day column with 17:00 to 18:00 marked, as `encodeDay` in
 * src/lib/admissions/availability.ts spells it.
 *
 * The last four slots of the day are 32 to 35, which is the ninth hex
 * character (four slots each), all four bits set: `f`. Written as a literal
 * rather than computed, and PINNED BY THE SPEC, which asserts the queue renders
 * it as "17:00-18:00": if the encoding ever changes, that assertion fails with
 * the sentence a person can act on rather than this quietly meaning something
 * else.
 */
const EVENING_COLUMN = "00000000f";
const EMPTY_COLUMN = "000000000";

/** Seven columns with one evening marked on `weekday` (0 = Sunday). */
function availabilityMask(weekday) {
  const days = [];
  for (let day = 0; day < 7; day += 1) {
    days.push(day === weekday ? EVENING_COLUMN : EMPTY_COLUMN);
  }
  return { ...GRID, days };
}

/**
 * The round. `kind: "appointment"` is what puts the appointments page on it at
 * all: the page 404s on an enrolment round and the decide route answers 400.
 *
 * `outcomeRunIds` is empty because an appointment round feeds no seat rows, by
 * contract and by the apply route's own refusal. The run below is the
 * appointment TARGET, which is a different relationship: it is offered because
 * `isAppointableRun` likes its status, not because the round names it.
 */
function roundDoc({ id, label, now, fixtureRunId }) {
  return {
    e2eFixtureRunId: fixtureRunId,
    kind: "appointment",
    label,
    slug: id,
    blurb:
      "A throwaway facilitator intake created by the appointment-queue end-to-end " +
      "run. If you are reading this on a live surface, a run crashed before its teardown.",
    academicYear: "2026/27",
    status: "open",
    opensAt: new Date(now.getTime() - DAY_MS),
    closesAt: new Date(now.getTime() + 14 * DAY_MS),
    decisionsByDate: londonDateKey(new Date(now.getTime() + 21 * DAY_MS)),
    stageIds: [APPOINTMENT_STAGE_ID],
    programmePreference: {
      enabled: false,
      streams: [],
      fellowships: [],
      maxRankedFellowships: 2,
      offerFellowshipFallback: false,
    },
    availabilityGrid: { ...GRID },
    accessRequirementsPrompt:
      "Is there anything we should know so you can facilitate comfortably?",
    criteria: [{ id: "c1", label: "Facilitation", guidance: "Have they held a room." }],
    scoreScale: { min: 1, max: 5 },
    reviewersPerApplication: 2,
    // Nobody is named. An admin decides by role, which is what
    // `canDecideAppointments` admits and what this harness is allowed to rely
    // on: it may never write round authority onto anybody.
    reviewerUids: [],
    finalDeciderUid: null,
    blind: { hideNames: true, hideMembership: true },
    evidenceRunIds: [],
    reminderOffsets: [],
    outcomeRunIds: [],
    // Two submitted, because that is what the seed creates. The decide route
    // moves `submitted` down and the outcome status up, so a fixture that
    // started at zero would drive a counter negative on a round somebody might
    // look at before teardown.
    applicationCounts: {
      draft: 0,
      submitted: 2,
      accepted: 0,
      appointed: 0,
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

/** The single released stage: `releaseAt: null` releases with the round. */
function stageDoc({ roundId, now, fixtureRunId }) {
  return {
    e2eFixtureRunId: fixtureRunId,
    roundId,
    label: "About your facilitating",
    intro: "One question, so the queue has an answer to show the decider.",
    questions: [
      {
        id: APPOINTMENT_QUESTION_ID,
        type: "longText",
        label: "What would you want a group of yours to feel like?",
        required: true,
        maxLength: 500,
      },
    ],
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

function courseDoc({ title, now, fixtureRunId }) {
  return {
    e2eFixtureRunId: fixtureRunId,
    title,
    tagline: "Throwaway fixture for the appointment-queue end-to-end run.",
    summaryBlocks: [
      {
        id: "b1",
        type: "richText",
        html: "<p>This course exists only while an automated appointment run is in flight.</p>",
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
 * The run an appointment may be made onto.
 *
 * `isAppointableRun` wants a status in `APPOINTABLE_RUN_STATUSES` and
 * `archived` false; the decide route additionally REFUSES a run with no
 * `startDate`, because the appointment email names the first day. So the run
 * carries one. `runFacilitatorUids` starts empty and the appointment is what
 * puts a uid on it: this harness never writes authority onto anybody, and the
 * whole point of the step is that the product does it.
 */
function runDoc({ runId, courseId, courseTitle, label, now, fixtureRunId }) {
  return {
    e2eFixtureRunId: fixtureRunId,
    courseId,
    courseTitle,
    label,
    academicYear: "2026/27",
    status: "applications-closed",
    enrolMode: "application",
    streams: [],
    enrolledCount: 0,
    startDate: londonDateKey(new Date(now.getTime() + 14 * DAY_MS)),
    weekPlan: [{ kind: "week", weekNumber: 1 }],
    startHereBlocks: [],
    applicationForm: [],
    applicationsOpenAt: new Date(now.getTime() - 14 * DAY_MS),
    applicationsCloseAt: new Date(now.getTime() - DAY_MS),
    applicationCap: null,
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: { pending: 0, accepted: 0, waitlisted: 0, rejected: 0, withdrawn: 0 },
    groupCount: 0,
    channel: `cohort:${runId}`,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * One SUBMITTED application, in the shape the apply route creates and the
 * submit route then updates. Field for field rather than "whatever the
 * normaliser would default", because a fixture that leans on a normaliser
 * stops testing the shape the real routes store.
 */
function applicationDoc({ roundId, uid, email, displayName, weekday, now, fixtureRunId }) {
  return {
    e2eFixtureRunId: fixtureRunId,
    roundId,
    uid,
    email,
    displayName,
    stageAnswers: {
      [APPOINTMENT_STAGE_ID]: {
        [APPOINTMENT_QUESTION_ID]: `${displayName} wrote this answer for an automated run.`,
      },
    },
    stageSubmittedAt: { [APPOINTMENT_STAGE_ID]: now },
    availability: availabilityMask(weekday),
    availabilityConfigVersion: GRID.version,
    programmePreference: {
      streamId: null,
      rankedFellowshipIds: [],
      openToFellowship: false,
    },
    evidence: null,
    // A snapshot of a badge, never a gate, and false is the honest value for an
    // account this harness created: it has no membership row anywhere.
    membershipAtApply: false,
    reapplyCount: 0,
    status: "submitted",
    submittedAt: now,
    withdrawnAt: null,
    outcome: {
      decision: null,
      targetRunId: null,
      streamId: null,
      decidedByUid: null,
      decidedAt: null,
      reason: "",
      reasonShared: false,
    },
    seatApplicationId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: fixtureRunId, suppress = true, onState } = {}) {
  const target = assertFixtureTarget();
  const now = new Date();

  const courseTitle = `E2E appointment course ${fixtureRunId}`;
  const courseId = fixtureId("e2e-appointment-course", fixtureRunId);
  const runId = fixtureId("e2e-appointment-run", fixtureRunId);
  const roundId = fixtureId("e2e-appointment-round", fixtureRunId);
  const runLabel = `Appointments ${fixtureRunId}`;

  const state = {
    fixtureRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    /** Read from the runner, never decided here. False only when this run's
        mail is caught by Mailpit, and then the two decision emails leave rows
        this spec asserts on. */
    suppress,
    courseId,
    courseTitle,
    runId,
    runLabel,
    roundId,
    roundLabel: `Facilitator intake ${fixtureRunId}`,
    stageId: APPOINTMENT_STAGE_ID,
    questionId: APPOINTMENT_QUESTION_ID,
    applicants: [],
    suppressed: [],
  };

  // Published BEFORE the first write and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming
  // everything it had created.
  onState?.(state);

  log(`Seeding fixture ${fixtureRunId} into ${target.projectId}.`);

  // Accounts first: everything else can be torn down without them, but an
  // account with no round to apply to is the harmless failure and a round with
  // applications from accounts nothing names is not.
  //
  // The two are told apart by their applicant NAME, which is what the queue
  // renders and what the spec scopes each card by. "one" and "two" rather than
  // an index, so neither name is a prefix of the other.
  const names = ["one", "two"];
  for (let i = 0; i < names.length; i += 1) {
    const password = `E2eAppoint!${fixtureRunId}${i}`;
    const account = await createFixtureUser({
      runId: fixtureRunId,
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
      displayName: `E2E appointee ${names[i]} ${fixtureRunId}`,
      /** Tuesday for the first, Thursday for the second, so the queue's "can
          be in a room" summary says something different about each. */
      weekday: i === 0 ? 2 : 4,
    });
  }

  await fixtureDoc("courses", courseId).set(courseDoc({ title: courseTitle, now, fixtureRunId }));
  await fixtureDoc("courseRuns", runId).set(
    runDoc({ runId, courseId, courseTitle, label: runLabel, now, fixtureRunId }),
  );

  await fixtureDoc("admissionRounds", roundId).set(
    roundDoc({ id: roundId, label: state.roundLabel, now, fixtureRunId }),
  );
  await fixtureSubcollection("admissionRounds", roundId, STAGES)
    .doc(APPOINTMENT_STAGE_ID)
    .set(stageDoc({ roundId, now, fixtureRunId }));

  for (const applicant of state.applicants) {
    const id = applicationDocId(roundId, applicant.uid);
    await fixtureDoc("admissionApplications", id).set(
      applicationDoc({
        roundId,
        uid: applicant.uid,
        email: applicant.email,
        displayName: applicant.displayName,
        weekday: applicant.weekday,
        now,
        fixtureRunId,
      }),
    );
    // The access-requirements answer lives in its own collection so that no
    // reader can leak it by forgetting to strip a field. The queue never joins
    // it, which is the property; the row exists so this fixture proves it
    // removes one, at the id the application shares.
    await fixtureDoc("admissionApplicationPrivate", id).set({
      accessRequirements: "Nothing: this row belongs to an automated run.",
    });
  }

  log(
    `Seeded round ${roundId} (kind appointment), run ${runId}, ` +
      `${state.applicants.length} submitted application(s).`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

async function countRows(state) {
  const counts = {};

  for (const [collection, id] of [
    ["courses", state.courseId],
    ["courseRuns", state.runId],
    ["admissionRounds", state.roundId],
  ]) {
    const snap = await fixtureDoc(collection, id).get();
    counts[collection] = snap.exists ? 1 : 0;
  }

  const stages = await fixtureSubcollection("admissionRounds", state.roundId, STAGES).get();
  counts.admissionRoundStages = stages.size;

  counts.admissionApplications = (
    await fixtureQuery("admissionApplications").where("roundId", "==", state.roundId).get()
  ).size;

  // The private sibling carries no `roundId` to query on: its id IS the
  // application's, so it is counted by address, one per applicant.
  let privateRows = 0;
  for (const applicant of state.applicants ?? []) {
    const snap = await fixtureDoc(
      "admissionApplicationPrivate",
      applicationDocId(state.roundId, applicant.uid),
    ).get();
    if (snap.exists) privateRows += 1;
  }
  counts.admissionApplicationPrivate = privateRows;

  // One row per appointment, written inside the decide transaction.
  counts.courseAudit = (
    await fixtureQuery("courseAudit").where("runId", "==", state.runId).get()
  ).size;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  // The send log. Zero when the fixture addresses are suppressed; when mail is
  // caught the two decisions really send (into Mailpit) and each logs a row.
  //
  // Keyed on the RECIPIENT, which is run-scoped by construction: a fixture
  // address is `e2e-f<runId><index>@e2e.invalid`, so no other run and no person
  // can own one. Both sends on this spec's path go to the applicant; a send
  // this fixture caused to somebody else would outlive teardown under a
  // manifest still reading zero, so a step that adds one must count it here by
  // whatever key that send is addressed with.
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

  counts.total = Object.values(counts).reduce(
    (a, b) => (typeof b === "number" ? a + b : a),
    0,
  );
  counts.fixtureRunId = state.fixtureRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown(state) {
  assertFixtureTarget();
  const failures = [];

  // THE NAMESPACE CHECK COMES FIRST, before a single delete. The `emailSends`
  // sweep below is keyed on an ADDRESS out of this state file, so a tampered or
  // stale ledger naming a real person would otherwise have rows deleted before
  // reaching the refusal that exists to stop exactly that.
  for (const applicant of state.applicants ?? []) {
    if (!isHarnessAccount(applicant.email)) {
      throw new Error(
        `REFUSING to tear down ${applicant.email}: not a harness account. The state ` +
          "file names an address this fixture could not have created.",
      );
    }
  }

  log(`Tearing down fixture ${state.fixtureRunId}.`);

  // Route-created leaves and the addressed rows first.
  await deleteQuery(fixtureQuery("courseAudit").where("runId", "==", state.runId));
  for (const applicant of state.applicants ?? []) {
    const id = applicationDocId(state.roundId, applicant.uid);
    await fixtureDoc("admissionApplicationPrivate", id).delete();
    await fixtureDoc("admissionApplications", id).delete();
  }
  // Anything the addressed deletes missed, because a row exists for an account
  // this ledger does not list (a hand-driven repeat, a run that crashed between
  // seeding an application and writing its ledger).
  await deleteQuery(
    fixtureQuery("admissionApplications").where("roundId", "==", state.roundId),
  );

  const stages = await fixtureSubcollection("admissionRounds", state.roundId, STAGES).get();
  for (const doc of stages.docs) await doc.ref.delete();
  await fixtureDoc("admissionRounds", state.roundId).delete();
  await fixtureDoc("courseRuns", state.runId).delete();
  await fixtureDoc("courses", state.courseId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  // The send log LAST of the row sweeps, because both decision emails are fire
  // and forget: the route answers the browser and logs its row a moment later,
  // so the later this runs the smaller the window in which a row lands behind
  // it.
  for (const applicant of state.applicants ?? []) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", applicant.email));
  }

  for (const applicant of state.applicants ?? []) {
    // The users document first: an Auth account whose document outlives it is a
    // ghost row in the admin members list. Both deletes resolve the account BY
    // UID and re-check the namespace on the address Auth hands back, rather
    // than trusting the address this state file happens to sit next to.
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
    counts.teardownFailures = failures;
    counts.total += failures.length;
  }
  return counts;
}

export const SPEC = {
  name: "appointment-queue",
  specFile: "tests/e2e/appointment-queue.spec.mjs",
  steps: APPOINTMENT_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // The queue is admissions-gated and the decide route admits the round's
  // final decider or an admin. This harness may never write either onto an
  // account it made, so the decider is the owner's own admin account, read
  // from .env.e2e.secrets.local.
  needs: { admin: true },
  // Verified: run on 6 September 2026 against the shared harness server on
  // http://127.0.0.1:3100 (project naisi-website-dev), seven of seven steps,
  // fifteen rows before teardown and a manifest of zero after it.
  status: "verified",
  covers: {
    routes: ["/api/auth/session", "/api/admissions/rounds/[roundId]/decide"],
    pages: ["/(auth)/login", "/(app)/admin/admissions/[roundId]/appointments"],
  },
  seed,
  countRows,
  teardown,
};
