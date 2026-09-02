/**
 * Seeds (and tears down) the throwaway world the applicant-funnel e2e run
 * drives against: a handful of fake applicants, one admission round, and one
 * open-enrolment pre-course with two capped groups.
 *
 * Run it directly, or let `scripts/run-applicant-funnel.mjs` (npm run
 * e2e:funnel) call it around the Playwright spec:
 *
 *   node scripts/seed-fake-applicants.mjs up --applicants 5
 *   node scripts/seed-fake-applicants.mjs status
 *   node scripts/seed-fake-applicants.mjs down
 *
 * ## Why this file is NOT under scripts/e2e/
 *
 * `tests/e2e-no-privilege-grants.test.mjs` holds the auth harness to three
 * Firestore collections (users, emailVerifications, registrations), because
 * that harness only ever needs to prove things about registration and dev
 * holds real members' data. A funnel fixture needs `admissionRounds`,
 * `courseRuns`, `courseGroups` and the rows the routes create underneath
 * them, so it cannot live inside that fence without tearing the fence down.
 *
 * It therefore sits outside and carries its OWN fence, of the same shape,
 * asserted at runtime here and offline by `tests/funnel-harness-guards.test.mjs`:
 *
 *   - Every collection it may address is a literal in `FIXTURE_COLLECTIONS`,
 *     checked by `assertFixtureCollection()` before any credential is obtained.
 *   - It creates no privileged identity. Accounts are the auth harness's own
 *     `createHarnessUser` plus its `seedPendingUserDoc`, whose role is the
 *     hard-coded literal "pending". There is no code path here that writes a
 *     role, a `permissions` map, `suRecognised`, or a custom claim.
 *   - It refuses any project that is not the dev project, through the auth
 *     harness's own `loadEnv()`. There is no emulator escape hatch: one that
 *     keyed off FIRESTORE_EMULATOR_HOST alone would have pointed the
 *     documents at a local database while creating the Auth accounts for real.
 *   - Every document it writes is ledgered, and `down` verifies the ledger
 *     drained to zero by counting the fixture's rows again afterwards.
 *
 * ## Nothing it seeds can send mail
 *
 * The drop-out leg of the funnel calls a route that emails the member
 * (`sendCourseDroppedOutEmail`). Fixture addresses are `.invalid` (RFC 2606),
 * so such a send cannot reach a person, but against the DEPLOYED dev backend
 * it would still be a real hand-off to Resend and a hard bounce logged against
 * the sending domain. So seeding writes a `suppressedEmails` row for every
 * fixture address FIRST.
 *
 * Be precise about what that buys, because the check is NOT universal:
 * `sendEmail()` in `src/lib/email/send.ts` does not consult the suppression
 * list at all. The helpers do. `sendCourseDroppedOutEmail()` in
 * `courseEnrolmentEmails.ts` (the one send this run can actually trigger)
 * returns early on `isSuppressed()` before it builds a message, and
 * `courseFacilitatorEmails.ts` drops suppressed addresses through
 * `filterSuppressed()`. So the property holds for the routes this run drives,
 * and `tests/funnel-harness-guards.test.mjs` keeps it holding: it reads the
 * email helpers those routes import and fails if one of them stops checking.
 * The rows are self-identifying, ledgered, and removed by teardown like
 * everything else.
 *
 * ## Ids are constructed, never parsed
 *
 * Every fixture id is `{slug}__{runId}`, the repo's `slugId` shape with the
 * random suffix replaced by this run's id so a crashed run is sweepable by
 * eye and by query. Nothing here ever splits an id back apart to recover the
 * run id: the ledger at `.e2e-funnel-state.json` is the record, and the
 * `e2eFunnelRunId` field on every document is the query key.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import {
  adminApp,
  adminAuth,
  createHarnessUser,
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "./e2e/lib/admin.mjs";
import { createLedger, seedPendingUserDoc } from "./e2e/lib/firestore.mjs";
import { REPO_ROOT, loadEnv, runId } from "./e2e/lib/env.mjs";

/**
 * Where the ledger lives: the repo root, gitignored by name.
 *
 * NOT `.next/`, which is where it started out. `next build` clears that
 * directory on every build (it keeps only cache, dev and lock), so a `--local`
 * run wrote its ledger and then had the build delete it out from under the
 * spec, which found no fixture and skipped. The ledger has to outlive a build,
 * so it sits beside the repo rather than inside its build output.
 */
export const STATE_PATH = join(REPO_ROOT, ".e2e-funnel-state.json");

/**
 * Where the spec records the steps it actually completed.
 *
 * The ledger above only says a fixture exists; this says a browser really
 * drove it. Without it every way the spec can decline to run (no Playwright,
 * no fixture, a skip) reads to the runner exactly like a pass, because
 * `node --test` exits 0 over a skipped file. The runner deletes this before
 * the spec starts and refuses to report success unless it comes back naming
 * every step below.
 */
export const MARKER_PATH = join(REPO_ROOT, ".e2e-funnel-steps.json");

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it
 * finished and the runner checks the record against this list, so a step
 * renamed in one place and not the other fails loudly instead of quietly
 * shrinking what a green run means.
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
 * How many fake applicants `up` creates when none is asked for.
 *
 * Five, because that is the dress-rehearsal number the delivery plan names.
 * The spec drives applicant 1 through the whole journey; the rest exist so a
 * rehearsal can be clicked through by hand against a realistic queue, and so
 * the one-place group has somebody to be full for.
 */
export const DEFAULT_APPLICANTS = 5;

/**
 * Every collection this fixture may address, as string literals so the
 * offline guard can read the list off the source. Split by intent: the first
 * group is written by seeding, the second is only ever swept, because the
 * ROUTES under test create those rows and the fixture merely has to be able
 * to prove they are gone again.
 */
export const FIXTURE_COLLECTIONS = [
  // Seeded.
  "courses",
  "courseRuns",
  "courseGroups",
  "admissionRounds",
  "suppressedEmails",
  // Swept: created by the routes the funnel drives.
  "admissionApplications",
  "admissionApplicationPrivate",
  "courseEnrolments",
  "courseProgress",
  "courseAudit",
  "subscriptions",
  "subscriptionEvents",
  "tasks",
];

/** The stages subcollection under a round. Subcollections need their own name. */
const STAGES_SUBCOLLECTION = "stages";

/**
 * The one stage question the funnel answers, with a FIXED id so the spec can
 * address its control (`#q_funnel_why-input`, see FormRenderer's `fieldId`)
 * without reading the seed back. Deterministic by construction, which is the
 * same rule the doc ids follow.
 */
export const FUNNEL_QUESTION_ID = "q_funnel_why";

/** The confirmation word the withdraw box wants. Mirrors `WITHDRAW_WORD`. */
export const WITHDRAW_WORD = "WITHDRAW";

const log = (msg) => console.log(`[funnel-seed] ${msg}`);

let dbHandle = null;

function db() {
  if (!dbHandle) dbHandle = getFirestore(adminApp());
  return dbHandle;
}

/**
 * The allowlist check, as a function rather than a source grep.
 *
 * The auth harness proves its own fence by grepping for `.collection("literal")`
 * and refusing a dynamic name. That works there because it reaches three
 * collections; here it would mean thirteen near-identical branches, and a
 * thirteen-branch switch is a place a fourteenth gets added without anybody
 * noticing. So the ban moves from the spelling to the VALUE: one checked
 * chokepoint, called before any credential is obtained (note it throws before
 * `db()`), and `tests/funnel-harness-guards.test.mjs` calls THIS function with
 * live collection names rather than pattern-matching the source.
 */
export function assertFixtureCollection(collection) {
  if (!FIXTURE_COLLECTIONS.includes(collection)) {
    throw new Error(
      `REFUSING to touch collection ${JSON.stringify(collection)}. The funnel ` +
        `fixture may only reach ${FIXTURE_COLLECTIONS.join(", ")}.`,
    );
  }
  return collection;
}

/** The ONLY way this file addresses a fixture document. */
function fixtureDoc(collection, id) {
  assertFixtureCollection(collection);
  return db().collection(collection).doc(id);
}

/** The ONLY way this file queries a fixture collection. */
function fixtureQuery(collection) {
  assertFixtureCollection(collection);
  return db().collection(collection);
}

/**
 * Refuses every project that is not dev.
 *
 * `loadEnv()` already asserts `FIREBASE_ADMIN_PROJECT_ID === "naisi-website-dev"`
 * and refuses a downloaded service-account key, so calling it IS the check;
 * this wrapper exists to give the guard test one exported function to call.
 * Production is unreachable from here in the same way it is unreachable from
 * the auth harness, and for the same reason: the assertion runs before any
 * credential is obtained.
 */
export function assertFixtureTarget() {
  // No emulator escape hatch. An earlier draft returned early on
  // FIRESTORE_EMULATOR_HOST, before `loadEnv()` and without ever requiring
  // FIREBASE_AUTH_EMULATOR_HOST, so a shell exporting only the Firestore host
  // would have run the whole fixture against a local database while creating
  // its Auth accounts for real in the dev project. Nothing here needs an
  // emulator, so the safe shape is not to offer one.
  const env = loadEnv();
  return { projectId: env.projectId };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** `{slug}__{runId}`: the repo's slugId shape with a per-run suffix. */
function fixtureId(slug, id) {
  return `${slug}__${id}`;
}

/** The deterministic application id the apply route uses. Construct-only. */
export function applicationId(roundIdValue, uid) {
  return `${roundIdValue}__${uid}`;
}

/** The deterministic enrolment id the enrol route uses. Construct-only. */
export function enrolmentId(runIdValue, uid) {
  return `${runIdValue}__${uid}`;
}

/** `emailDocId` from src/lib/firestore/emailDocId.ts, re-stated for plain Node. */
export function emailDocId(email) {
  return email.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, "_");
}

/** `courseRunChannel` from src/lib/firestore/courses.ts, re-stated. */
export function cohortChannel(runIdValue) {
  return `cohort:${runIdValue}`;
}

/** `subscriptionDocId` from src/lib/firestore/subscriptions.ts, re-stated. */
export function subscriptionId(email, channel) {
  return `sub_${emailDocId(email)}__${channel}`;
}

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
    weekPlan: [{ kind: "week", weekNumber: 1 }],
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
 * from. Writes the same state to `STATE_PATH` so `down` can find it after the
 * process that made it has gone.
 */
export async function seedFunnelFixtures({ applicants = DEFAULT_APPLICANTS } = {}) {
  const target = assertFixtureTarget();
  if (!Number.isInteger(applicants) || applicants < 1 || applicants > 10) {
    throw new Error(`--applicants must be a whole number from 1 to 10, got ${applicants}`);
  }
  const funnelRunId = runId();
  const now = new Date();
  const ledger = createLedger();

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
    /** Written by seeding, deleted by teardown. Recorded so `down` can find
        them without re-deriving the address list. */
    suppressed: [],
  };

  log(`Seeding fixture ${funnelRunId} into ${target.projectId}.`);

  // Accounts first: everything else can be torn down without them, but an
  // account with no fixture to apply to is the harmless failure and a fixture
  // with no accounts is not.
  for (let i = 0; i < applicants; i += 1) {
    // `harnessEmail` enforces the `e2e-<alnum>@e2e.invalid` namespace that
    // every teardown helper in the auth harness re-checks. The id is
    // lowercase alphanumeric by construction: base36 run id plus an index.
    const account = await createHarnessUser(`f${funnelRunId}${i}`, {
      emailVerified: true,
      // A real password, so the spec signs in through the REAL /login form
      // rather than being handed a cookie. That is the difference between
      // proving the funnel works and proving the routes behind it do: the
      // session cookie alone leaves every client island (the session picker,
      // the drop-out card) in its signed-out branch.
      password: `E2eFunnel!${funnelRunId}${i}`,
    });
    await seedPendingUserDoc(ledger, {
      uid: account.uid,
      email: account.email,
      universityEmail: "",
    });
    // Suppression BEFORE anything can send: see the module comment.
    const suppressionId = emailDocId(account.email);
    await fixtureDoc("suppressedEmails", suppressionId).set({
      e2eFunnelRunId: funnelRunId,
      email: account.email.toLowerCase(),
      reason: "bounce",
      source: "manual",
      addedAt: now,
    });
    state.suppressed.push(suppressionId);
    state.applicants.push({
      index: i,
      uid: account.uid,
      email: account.email,
      password: `E2eFunnel!${funnelRunId}${i}`,
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
  await fixtureDoc("admissionRounds", roundIdValue)
    .collection(STAGES_SUBCOLLECTION)
    .doc("s1")
    .set(stageDoc({ roundIdValue, now, funnelRunId }));

  // The `users` documents were recorded in the auth harness's own ledger,
  // which teardown deliberately does NOT drive: it deletes each document by
  // address, under the namespace check on the account it belongs to, so a
  // teardown run in a later process (the ledger is in-memory) still works.
  void ledger;

  writeState(state);
  log(
    `Seeded round ${roundIdValue}, run ${runIdValue}, ` +
      `${state.applicants.length} applicant(s). State at ${STATE_PATH}.`,
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
export async function countFunnelRows(state) {
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

  const stages = await fixtureDoc("admissionRounds", roundId)
    .collection(STAGES_SUBCOLLECTION)
    .get();
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

  // The two rows a fixture account leaves behind that live OUTSIDE the fixture
  // collection list, and the two a teardown is most likely to strand: a users
  // document is a ghost member in the admin list, and a live Auth account can
  // still sign in. Counting only the thirteen collections meant a teardown
  // that failed to remove either still reported a clean total of zero, which
  // is the one number this whole harness asks anybody to trust.
  let userDocs = 0;
  for (const applicant of state.applicants ?? []) {
    const snap = await db().collection("users").doc(applicant.uid).get();
    if (snap.exists) userDocs += 1;
  }
  counts.users = userDocs;

  let authAccounts = 0;
  for (const applicant of state.applicants ?? []) {
    try {
      await adminAuth().getUser(applicant.uid);
      authAccounts += 1;
    } catch {
      // Not found is the wanted state after teardown, and the only error the
      // Admin SDK raises for an id that is simply gone.
    }
  }
  counts.authAccounts = authAccounts;

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

async function deleteQuery(query) {
  const snap = await query.get();
  for (const doc of snap.docs) await doc.ref.delete();
  return snap.size;
}

/**
 * Removes everything, in the order that keeps a half-finished teardown
 * recoverable: route-created leaves first, then the fixture objects, then the
 * accounts. An account deleted before its rows would leave rows nothing names.
 *
 * Every Auth deletion goes through `deleteHarnessUser`, which re-resolves the
 * account and refuses any address outside the harness namespace. A tampered
 * or stale state file therefore cannot make this delete a real person.
 */
export async function teardownFunnelFixtures(state) {
  assertFixtureTarget();
  const { roundId, runId: runIdValue, channel } = state;
  log(`Tearing down fixture ${state.funnelRunId}.`);
  /** Anything that refused or failed to delete, reported rather than logged
      and forgotten: a swallowed rejection here is an account or a document
      left on a shared project under a manifest that says everything went. */
  const failures = [];

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

  const stages = await fixtureDoc("admissionRounds", roundId)
    .collection(STAGES_SUBCOLLECTION)
    .get();
  for (const doc of stages.docs) await doc.ref.delete();
  await fixtureDoc("admissionRounds", roundId).delete();
  await fixtureDoc("courseRuns", runIdValue).delete();
  await fixtureDoc("courses", state.courseId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  for (const applicant of state.applicants ?? []) {
    if (!isHarnessAccount(applicant.email)) {
      throw new Error(
        `REFUSING to tear down ${applicant.email}: not a harness account. The ` +
          "state file names an address this fixture could not have created.",
      );
    }
    // The users document first: an Auth account whose document outlives it is
    // a ghost row in the admin members list.
    //
    // Both deletes resolve the account BY UID and re-check the namespace on
    // the address that comes back, rather than trusting the address this
    // state file happens to sit next to. The check above is on the state
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

  const counts = await countFunnelRows(state);
  if (failures.length > 0) {
    // Folded into the manifest so the exit code carries it: a refusal that
    // only printed would let a green-looking run end on a live account.
    counts.teardownFailures = failures;
    counts.total += failures.length;
  }
  // The state file is the only way back to a fixture that did not fully
  // drain, so it survives a failed teardown for `down` to retry against.
  if (counts.total === 0) clearState();
  return counts;
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export function writeState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function clearState() {
  try {
    rmSync(STATE_PATH);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv.find((a) => !a.startsWith("-")) ?? "up";
  const at = argv.indexOf("--applicants");
  const applicants = at === -1 ? DEFAULT_APPLICANTS : Number(argv[at + 1]);
  return { command, applicants };
}

async function main() {
  const { command, applicants } = parseArgs(process.argv.slice(2));
  if (command === "up") {
    const state = await seedFunnelFixtures({ applicants });
    console.log(JSON.stringify({ ok: true, state: STATE_PATH, funnelRunId: state.funnelRunId }));
    return 0;
  }
  if (command === "down") {
    const state = readState();
    if (!state) {
      log(`No state at ${STATE_PATH}. Nothing to tear down.`);
      return 0;
    }
    const counts = await teardownFunnelFixtures(state);
    console.log(JSON.stringify(counts, null, 2));
    if (counts.total !== 0) {
      log(`TEARDOWN LEFT ${counts.total} ROW(S) BEHIND. See the counts above.`);
      return 1;
    }
    log("Teardown complete: the fixture manifest reads zero.");
    return 0;
  }
  if (command === "status") {
    const state = readState();
    if (!state) {
      log(`No state at ${STATE_PATH}.`);
      return 0;
    }
    console.log(JSON.stringify(await countFunnelRows(state), null, 2));
    return 0;
  }
  log(`Unknown command ${JSON.stringify(command)}. Use up, down or status.`);
  return 1;
}

// Only when run directly: the funnel runner imports the functions above.
if (process.argv[1] && process.argv[1].endsWith("seed-fake-applicants.mjs")) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
