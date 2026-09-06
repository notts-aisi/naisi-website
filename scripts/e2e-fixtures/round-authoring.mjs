/**
 * Round authoring: the admin makes an admission round from nothing, fills it
 * until the readiness panel is green, opens it, and the public apply page
 * shows it.
 *
 * ## What this fixture seeds, and what the PRODUCT creates
 *
 * Almost nothing is seeded, on purpose. The round, its first stage, its dates,
 * its question, its reviewers and its status are all created by the admin
 * pressing the console's own controls, which is the whole point of the
 * journey: a fixture that wrote a finished round and then checked the panel
 * agreed would be testing the panel against a document this file invented,
 * not against the authoring routes.
 *
 * One thing cannot be authored from inside the round, so it is seeded: an
 * enrolment round's readiness bar includes "there is somewhere to place the
 * people you accept", which is satisfied by naming an OUTCOME RUN, and a
 * course run is a different object with its own editor. So the seed writes one
 * throwaway course and one throwaway run under it, in the applicant funnel's
 * shapes, and the spec picks that run in the outcomes section the way an admin
 * would. Everything else on the round is the product's work.
 *
 * ## Teardown sweeps the round by its LABEL
 *
 * The round's id is `slugId(label)`, so the harness cannot know it before the
 * browser has pressed Create, and the spec runs in a different process from
 * the teardown. The label is therefore the key: the seed decides it, writes it
 * into the ledger, the spec types exactly that string into the New round form,
 * and teardown sweeps `admissionRounds` by `label ==` it. It carries the run
 * id, so it cannot collide with another run or with a real round, and the
 * query is a single equality, which needs no index.
 *
 * ## The one write this manifest cannot count, said out loud
 *
 * `PUT /api/admissions/rounds/[roundId]/roles` also stamps
 * `users.admissionsReviewer = true` on everybody it appoints, and clears it on
 * everybody it un-appoints who is not still named on another round. That is a
 * field on a REAL person's user document: the harness may not create an
 * eligible reviewer (it may not write any role above `pending`), so the only
 * people the picker can offer are real accounts on the dev project.
 *
 * Three things follow, and all three are deliberate:
 *
 *  1. The spec appoints an ADMIN and nobody else. It reads the picker's own
 *     role hint and refuses to appoint an SU-recognised committee member,
 *     because that would hand a real capability (reading applications) to
 *     somebody who did not have it. An admin already holds every power the
 *     appointment grants, so appointing one grants nothing new.
 *  2. The spec takes them back off again through the same picker, as its last
 *     step, which is what makes the route clear the flag. That is asserted
 *     rather than assumed: the readiness panel going back to "at least one
 *     reviewer is appointed: still to do" is the console agreeing that
 *     `reviewerUids` is empty, and the flag is cleared in the same batch.
 *  3. `users` is outside this fixture's fence by design, so the manifest below
 *     cannot count that field, and does not pretend to. If the spec fails
 *     between the appointment and the un-appointment, the flag is left true on
 *     an admin's document. The route's own note says what that costs: the flag
 *     is a nav hint, every admissions route re-checks the round's arrays, so a
 *     stale `true` grants nothing and costs a sidebar link until the next run
 *     of this spec, or any other roles save, clears it.
 *
 * ## Nothing here can send mail
 *
 * No route this spec drives sends anything: creating, patching, staging,
 * appointing and opening a round are all silent. The one control on the page
 * that does send, `Send due reminders now`, is deliberately NOT pressed: it
 * writes the scheduler's bookkeeping to `config/scheduler`, which is live
 * shared configuration that this fixture may not address and could not put
 * back. The spec reads that button's disabled state instead, which is a real
 * assertion (the manual reminder lane is shut on a draft round) and no write.
 *
 * So `suppress` changes nothing here. It is still recorded in the ledger,
 * because the runner decides it and a fixture that quietly dropped the answer
 * would be the wrong place to discover that a later step had started sending.
 */
import {
  assertFixtureTarget,
  cohortChannel,
  deleteQuery,
  fixtureDoc,
  fixtureId,
  fixtureQuery,
  fixtureSubcollection,
} from "./core.mjs";

const log = (msg) => console.log(`[round-authoring-seed] ${msg}`);

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it
 * finished and the runner checks the record against this list, so a step
 * renamed in one place and not the other fails loudly instead of quietly
 * shrinking what a green run means.
 */
export const AUTHORING_STEPS = [
  "the admin signs in and the admissions console lists its rounds",
  "a new round opens its own editor with six things still to do",
  "the standfirst saves on the details section",
  "setting the deadline and the decision date ticks off both window checks",
  "a required long-text question ticks off the first stage",
  "naming an outcome run gives the round somewhere to place people",
  "appointing a reviewer and a final decider turns the panel green",
  "opening the round shows it open in the editor and on the list",
  "the public apply page shows the round and gates a signed-out visitor",
  "closing the round closes the public form",
  "taking the reviewer and the decider off again leaves the round unstaffed",
];

/**
 * EMPTY, and that is a statement rather than an omission.
 *
 * `recaptchaDependentSteps` names the steps that cannot run against a deployed
 * target because they press a control that sends a reCAPTCHA token, which
 * Google's real widget will not hand headless Chromium. Nothing on this
 * journey does. The gate sits on `/api/register` and on the three admissions
 * APPLY routes; sign-in with a password sends no token (`AuthEntry` executes
 * the widget only in register mode), and every authoring route this spec
 * drives is gated on the session and the role instead. So a run against
 * dev.naisi.uk drives all eleven steps, and a skip here would be a shortfall.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/** The readiness checks this round is held to, in the panel's own words. */
export const READINESS_LABELS = {
  stageQuestions: "The first stage has at least one question",
  closesAt: "The deadline is set and still ahead",
  decisionsBy: "Applicants are told when decisions land",
  outcomeRuns: "There is somewhere to place the people you accept",
  reviewers: "At least one reviewer is appointed",
  finalDecider: "A final decider is named",
};

/** The stages subcollection under a round. Subcollections need their own name. */
const STAGES = "stages";

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
 * The course the outcome run hangs off. Mirrors the applicant funnel's shape
 * field for field.
 *
 * `status: "draft"` rather than "published": nothing in this journey visits a
 * public course page, and a published course is a row on the live catalogue
 * for as long as the run takes. A draft one is invisible to everybody except
 * the staff surfaces, and the outcome picker lists runs regardless of what
 * their course's status is.
 */
function courseDoc({ title, now, authoringRunId }) {
  return {
    e2eRoundAuthoringRunId: authoringRunId,
    title,
    tagline: "Throwaway fixture for the round-authoring end-to-end run.",
    summaryBlocks: [],
    track: "technical",
    level: "No prior experience needed",
    estimatedWeeklyHours: 2,
    status: "draft",
    showcaseRunId: null,
    authorUid: "",
    collaboratorUids: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The run the round names as its outcome.
 *
 * `cohort`, `templateId` and `templateLabel` are ABSENT rather than null, for
 * the reason the funnel records: firestore.rules pins all three with a `.get()`
 * default, and a stored null compares unequal to that default, which wedges
 * every later non-admin edit of the run in RunEditor.
 *
 * No facilitators, no reviewers, no trackleads: this run is a name in a
 * checklist and nothing else, and a fixture that staffed it would be minting
 * exactly the authority the harness is forbidden from minting.
 */
function runDoc({ runIdValue, courseIdValue, courseTitle, label, now, authoringRunId }) {
  return {
    e2eRoundAuthoringRunId: authoringRunId,
    courseId: courseIdValue,
    courseTitle,
    label,
    academicYear: "2026/27",
    status: "draft",
    enrolMode: "admissions",
    streams: [],
    enrolledCount: 0,
    startDate: londonDateKey(new Date(now.getTime() + 30 * DAY_MS)),
    weekPlan: [{ kind: "week", weekNumber: 1 }],
    startHereBlocks: [],
    applicationForm: [],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: { pending: 0, accepted: 0, waitlisted: 0, rejected: 0, withdrawn: 0 },
    groupCount: 0,
    // Always derived, never typed: every consumer computes `cohort:<runId>`,
    // and a stored value that disagreed would make one run's teardown sweep
    // another list's subscription rows.
    channel: cohortChannel(runIdValue),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: authoringRunId, suppress = true, options = {}, onState } = {}) {
  const target = assertFixtureTarget();
  const now = new Date();
  void options;

  const courseIdValue = fixtureId("e2e-authoring-course", authoringRunId);
  const runIdValue = fixtureId("e2e-authoring-run", authoringRunId);
  const courseTitle = `E2E authoring course ${authoringRunId}`;

  const state = {
    authoringRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    /** The runner's answer, recorded rather than re-derived. See the header. */
    suppress,
    courseId: courseIdValue,
    courseTitle,
    runId: runIdValue,
    /** What the outcome picker shows, and what the spec ticks. */
    runLabel: `Authoring outcome ${authoringRunId}`,
    /**
     * The name the spec types into the New round form, and the key teardown
     * sweeps on. Nothing derives the round id from it: `slugId` appends eight
     * random characters, so only the browser knows the id and only the label
     * crosses back.
     */
    roundLabel: `Round authoring ${authoringRunId}`,
    /** The standfirst the spec writes, and reads back off the public page. */
    blurb:
      "A throwaway intake written by an automated round-authoring run. " +
      "If you are reading this on a live surface, a run crashed before its teardown.",
  };

  // Published BEFORE the first write, and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created.
  onState?.(state);

  log(`Seeding fixture ${authoringRunId} into ${target.projectId}.`);

  await fixtureDoc("courses", courseIdValue).set(
    courseDoc({ title: courseTitle, now, authoringRunId }),
  );
  await fixtureDoc("courseRuns", runIdValue).set(
    runDoc({
      runIdValue,
      courseIdValue,
      courseTitle,
      label: state.runLabel,
      now,
      authoringRunId,
    }),
  );

  log(`Seeded outcome run ${runIdValue}. The round itself is the browser's job.`);
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/**
 * Every row this fixture owns, seeded or authored by the routes the spec
 * drives, counted by document rather than reported as a boolean: "some rows
 * remain" is not an actionable sentence, and the collection that failed to
 * drain is the whole diagnosis.
 */
async function countRows(state) {
  const counts = {};

  for (const [collection, id] of [
    ["courses", state.courseId],
    ["courseRuns", state.runId],
  ]) {
    const snap = await fixtureDoc(collection, id).get();
    counts[collection] = snap.exists ? 1 : 0;
  }

  // The round is the PRODUCT's document, so it is counted the only way the
  // harness can name it: by the label the spec typed. Equality only, no
  // orderBy, so no index is owed.
  const rounds = await fixtureQuery("admissionRounds")
    .where("label", "==", state.roundLabel)
    .get();
  counts.admissionRounds = rounds.size;

  // The create route writes a first stage in the same batch as the round, and
  // a subcollection does not go when its parent document does: a round deleted
  // with its stages left behind is an orphan nothing lists and nothing tidies.
  let stageRows = 0;
  for (const round of rounds.docs) {
    const stages = await fixtureSubcollection("admissionRounds", round.id, STAGES).get();
    stageRows += stages.size;
  }
  counts.admissionRoundStages = stageRows;

  // No accounts. This spec signs in as the OWNER's admin, which the harness
  // can never create and must never delete, so there is no account row to
  // count and no namespace check to make before deleting one.
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.authoringRunId = state.authoringRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Removes everything, leaves first: the stages under each round, then the
 * round, then the seeded run and course. A parent deleted before its children
 * leaves rows nothing names.
 */
async function teardown(state) {
  assertFixtureTarget();
  log(`Tearing down fixture ${state.authoringRunId}.`);
  const failures = [];

  if (typeof state.roundLabel !== "string" || !state.roundLabel.includes(state.authoringRunId)) {
    // The label is the only thing standing between this sweep and a real
    // round. It is built from the run id, so a ledger whose label has lost it
    // is a ledger this fixture did not write, and the safe answer is to refuse
    // rather than to run a `label ==` delete against whatever it does say.
    throw new Error(
      `REFUSING to sweep admissionRounds by label ${JSON.stringify(state.roundLabel)}: it ` +
        `does not carry this run's id (${state.authoringRunId}). The state file names a ` +
        "round this fixture could not have created.",
    );
  }

  const rounds = await fixtureQuery("admissionRounds")
    .where("label", "==", state.roundLabel)
    .get();
  for (const round of rounds.docs) {
    try {
      await deleteQuery(fixtureSubcollection("admissionRounds", round.id, STAGES));
      await round.ref.delete();
    } catch (err) {
      failures.push(`${round.id}: ${err.message}`);
      log(`Could not tear down round ${round.id}: ${err.message}`);
    }
  }

  await fixtureDoc("courseRuns", state.runId).delete();
  await fixtureDoc("courses", state.courseId).delete();

  const counts = await countRows(state);
  if (failures.length > 0) {
    // Folded into the manifest so the exit code carries it: a refusal that
    // only printed would let a green-looking run end on a live round.
    counts.teardownFailures = failures;
    counts.total += failures.length;
  }
  return counts;
}

export const SPEC = {
  name: "round-authoring",
  specFile: "tests/e2e/round-authoring.spec.mjs",
  steps: AUTHORING_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // The whole journey is an admin's. `/admin/admissions` is gated on
  // `requireAdmissionsPage()`, appointing reviewers is admin-only at the
  // route, and this harness may not create an account above role `pending`.
  needs: { admin: true },
  /** Verified: a real run against the shared harness server on 6 September
      2026 drove all eleven steps, with four rows before teardown (the seeded
      course and run, and the round and stage the console authored) and a
      manifest of zero after it. */
  status: "verified",
  covers: {
    routes: [
      "/api/auth/session",
      "/api/admissions/rounds",
      "/api/admissions/rounds/[roundId]",
      "/api/admissions/rounds/[roundId]/stages/[stageId]",
      "/api/admissions/rounds/[roundId]/roles",
      "/api/admissions/rounds/[roundId]/status",
    ],
    pages: [
      "/(auth)/login",
      "/(app)/admin/admissions",
      "/(app)/admin/admissions/[roundId]",
      "/(public)/apply/[roundId]",
    ],
  },
  seed,
  countRows,
  teardown,
};
