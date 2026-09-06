/**
 * The register push fixture: one course, one running run three weeks in, one
 * group with nobody staffing it, and three members sitting in it.
 *
 * The journey it exists for is the ADMIN's, and the admin is the owner's own
 * account read from `.env.e2e.secrets.local` (`needs.admin: true`): this
 * harness may not mint a privileged identity, and it may not name a
 * facilitator either. `facilitatorUids` is EMPTY on purpose. An admin passes
 * `gateGroupRegister` on the admin branch, so every door onto the register
 * (GET, POST, PATCH, push, participant notes) opens for them without anybody
 * being appointed to anything.
 *
 * ## What the seed has to be true for the routes to do anything
 *
 * Four facts, each one load-bearing, each learned by reading the routes rather
 * than by guessing:
 *
 *  1. THE SESSIONS MUST HAVE HAPPENED. `columnsFor` only offers columns up to
 *     the cohort's current week, so a run starting today has one column and
 *     nothing to push. The run therefore starts 22 days ago on a four-week
 *     plan: the cohort is in week 4, four sessions have started, and the
 *     group's weekday is the start date's own weekday so every session falls
 *     on its slot's first day and every one of them is in the past.
 *  2. THE MEMBERS MUST HAVE JOINED IN WEEK 1. `joinedWeekNumber` scopes the
 *     grid: a cell before a member's joining week is inert and the routes
 *     refuse to write it. The enrol route stamps the CURRENT week, which for
 *     a run this far in would make weeks 1 to 3 unmarkable, so the enrolments
 *     are seeded rather than driven through the course page.
 *  3. THE NEXT WEEK MUST BE PUBLISHED. The push mails the group about the
 *     session AFTER the one being pushed, and refuses to send at all when
 *     that week's document is missing or unpublished ("Publish it and use the
 *     run's catch-up send"). So `courseRuns/{runId}/weeks/w02` is seeded
 *     published: it is the only week any part of this journey reads.
 *  4. THE MEMBERS MUST BE ON THE COHORT CHANNEL. `resolveCohortAudience`
 *     starts from `subscriptions` rows for `cohort:<runId>` and INTERSECTS
 *     them with active enrolments; an enrolment alone is not an audience.
 *     The enrol route writes that row, and this fixture writes it for the
 *     same reason it writes the enrolment.
 *
 * ## Mail
 *
 * Against a deployed target every fixture address is suppressed before
 * anything is seeded, and the push's audience derivation drops suppressed
 * addresses (`dropSuppressed` -> `filterSuppressed`) BEFORE it claims the send
 * marker, so nothing is mailed and nothing is claimed. Against the harness's
 * own server the mail is caught by Mailpit, the sends really happen, and the
 * `emailSends` rows they leave are what the spec reads to prove the push
 * mailed the group. Both answers are asserted; `state.suppress` is what the
 * spec branches on, and it is the runner's answer, never this module's.
 *
 * ## The one row that is addressed by somebody else's uid
 *
 * `reserveSendSlot` writes a throttle document at
 * `courseNudges/emailrate__push__{groupId}__{actorUid}` on every press of
 * push, and its only fields are the throttle's own bookkeeping: no runId, no
 * groupId, nothing this fixture can query on. So the seed resolves the admin
 * account's uid ONCE, by the address in the secrets file, and keeps the
 * document id in its ledger. That is a READ of an account this harness did not
 * create and must never touch: the uid is used to address one document under a
 * fixture group id and for nothing else, and no teardown here goes anywhere
 * near the account itself.
 */
import {
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
  adminAuth,
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";
import { loadSecrets } from "../e2e/lib/env.mjs";

const log = (msg) => console.log(`[register-seed] ${msg}`);

/**
 * Every step the spec must complete, in order. Shared rather than restated on
 * both sides: the spec records what it finished and the runner checks the
 * record against this list.
 */
export const REGISTER_STEPS = [
  "the admin opens the group page and sees the roster and the register",
  "the register takes all five attendance states",
  "a session flipped to not held says so in its header",
  "a participant note saves and survives a reload",
  "pushing the first session locks it and says who is emailed",
  "a second press answers that the register was already pushed",
  "an admin edit of a pushed mark changes it and logs an audit row",
  "the admin resend reports what it did",
  "the push mailed the group and closed nothing it should not have",
];

/**
 * NOTHING HERE IS reCAPTCHA-GATED, which is why this list is empty.
 *
 * The gate sits on `/api/register` and the three admissions apply routes. This
 * journey signs in with a password (Firebase Auth plus `/api/auth/session`,
 * neither of which takes a token) and then drives the register routes, so
 * every step runs in both modes and a skip here would be a step nobody drove.
 * The wiring in the spec file is the funnel's, unchanged, so that a control
 * that grows a gate later is one line away from being declared.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/** Members in the group. Three: enough for five states to be spread over. */
export const MEMBER_COUNT = 3;

/** Taught weeks in the plan. Four, so the cohort is inside it at 22 days. */
export const WEEK_COUNT = 4;

/**
 * How far back the run starts, in whole days.
 *
 * 22 rather than 21 so the CURRENT slot began yesterday: with the group
 * meeting on the start date's weekday, week 4's session is yesterday's rather
 * than today's, and no session of this fixture is still to come. `elapsed=22`
 * puts `currentWeekFor` at plan index 3, which is week 4 of 4.
 */
const START_DAYS_AGO = 22;

/** The session the spec pushes, and the one its reminder is therefore about. */
export const PUSH_WEEK = 1;
export const NEXT_WEEK = 2;
/** The session flipped to "did not happen", and the one the note lands on. */
export const NOT_HELD_WEEK = 3;
export const NOTE_WEEK = 2;

/** `weekDocId` from src/lib/firestore/courses.ts, restated for plain Node. */
export function weekDocId(weekNumber) {
  return `w${String(weekNumber).padStart(2, "0")}`;
}

/** The weeks subcollection under a run. Subcollections need their own name. */
const WEEKS = "weeks";

/**
 * `courseEnrolments.role`, whose two values are "learner" and "facilitator".
 *
 * Deliberately the LOWER one, and deliberately spelled out: a fixture that
 * omitted the field would be relying on `normalizeCourseEnrolment` defaulting
 * it, which stops testing the shape a real enrolment is stored in. This is not
 * the governance role on `users` (that is written by the auth harness's own
 * seeder and is always "pending"), and nothing here may ever write the
 * facilitator value: the register's whole gate is facilitator-or-admin, and a
 * harness that could appoint a facilitator would be minting the permission it
 * is supposed to be testing around.
 *
 * A NAMED CONSTANT rather than a quoted literal at the use site, and that is
 * the point rather than a style: the privilege fence in
 * tests/funnel-harness-guards.test.mjs refuses `role: "<anything but pending>"`
 * everywhere in this tree, and it should stay that narrow. Spending an
 * exception in a live fence to admit a value that grants nothing would blunt
 * it for every future fixture.
 */
const LEARNER = "learner";

// ---------------------------------------------------------------------------
// Civil dates, restated for plain Node
// ---------------------------------------------------------------------------

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
 * `addDaysToKey` from src/lib/courses/weekPlan.ts, restated: civil-date
 * arithmetic at UTC midnight, never elapsed milliseconds, so a clock change
 * inside the window cannot move the answer by a day.
 */
function shiftDateKey(key, days) {
  const at = new Date(`${key}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The weekday of a civil date key, `Date.getDay()` numbering (0 = Sunday). */
function weekdayOf(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

/**
 * The course. Published, because the run under it has to look like a real one
 * to every helper that resolves a title for an email.
 */
function courseDoc({ title, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    title,
    tagline: "Throwaway fixture for the register-push end-to-end run.",
    summaryBlocks: [
      {
        id: "b1",
        type: "richText",
        html: "<p>This course exists only while an automated register run is in flight.</p>",
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
 * The run: RUNNING, started 22 days ago, four taught weeks.
 *
 * `cohort`, `templateId` and `templateLabel` are ABSENT rather than null,
 * matching what the authoring routes store (see the funnel fixture's note:
 * firestore.rules pins all three with a `.get()` default and a stored null
 * compares unequal to it).
 */
function runDoc({ runIdValue, courseIdValue, courseTitle, label, startDate, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    courseId: courseIdValue,
    courseTitle,
    label,
    academicYear: "2026/27",
    status: "running",
    enrolMode: "open",
    streams: [],
    enrolledCount: MEMBER_COUNT,
    startDate,
    // `weekId` is NOT optional: `isValidWeekPlanEntry` requires it on a week
    // entry and `sanitizeWeekPlan` DROPS the ones that lack it, silently. A
    // plan whose entries were all dropped resolves to no sessions at all, and
    // the register then says the run has no taught weeks yet, which is what
    // this fixture's first run showed.
    weekPlan: Array.from({ length: WEEK_COUNT }, (_, i) => ({
      kind: "week",
      weekNumber: i + 1,
      weekId: weekDocId(i + 1),
    })),
    startHereBlocks: [],
    applicationForm: [],
    applicationsOpenAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    applicationsCloseAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    applicationCap: null,
    // Empty, and it must stay empty: naming anybody here would be granting
    // reviewer or facilitator authority, which this harness may not do. The
    // admin reaches the register on the admin branch of the gate instead.
    admissionsReviewerUids: [],
    runFacilitatorUids: [],
    trackLeadUids: [],
    applicationCounts: { pending: 0, accepted: 0, waitlisted: 0, rejected: 0, withdrawn: 0 },
    groupCount: 1,
    channel: cohortChannel(runIdValue),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The one group. NOBODY FACILITATES IT, by design (see the module header), and
 * it meets on the start date's own weekday so each session falls on the first
 * day of its slot.
 */
function groupDoc({ runIdValue, courseIdValue, name, weekday, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    runId: runIdValue,
    courseId: courseIdValue,
    name,
    facilitatorUids: [],
    facilitatorAppointments: {},
    streamId: null,
    capacity: 6,
    memberCount: MEMBER_COUNT,
    session: {
      weekday,
      startTimeLocal: "18:00",
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

/**
 * The next session's week, PUBLISHED.
 *
 * The push resolves this document before it claims the send marker and
 * declines to mail the group at all when it is missing or unpublished. It is
 * the only week document this journey reads: the register's own columns come
 * from the run's week PLAN, and a column whose week document is absent simply
 * carries no title.
 */
function weekDoc({ weekNumber, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    weekNumber,
    title: `Register fixture week ${weekNumber}`,
    summary: "Seeded so the push has a published week to write a reminder about.",
    guideBlocks: [],
    materials: [],
    exercises: [],
    checklist: [],
    estimatedMinutes: null,
    published: true,
    updatedAt: now,
    updatedByUid: null,
  };
}

/** One member's place in the group, as the allocation routes store it. */
function enrolmentDoc({ runIdValue, courseIdValue, uid, groupIdValue, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    runId: runIdValue,
    courseId: courseIdValue,
    uid,
    groupId: groupIdValue,
    status: "active",
    role: LEARNER,
    streamId: null,
    // The empty rollup, which the push then rebuilds in full. Written rather
    // than left absent so the spec's "before" is a real zero.
    attendance: {
      sessionsHeld: 0,
      attendedInFull: 0,
      late: 0,
      leftEarly: 0,
      absent: 0,
      excused: 0,
      lastPushedSessionKey: null,
      lastComputedAt: null,
    },
    submissionDone: false,
    droppedOutAt: null,
    dropOutReason: null,
    selfEnrolled: false,
    applicationId: null,
    // WEEK 1, which is what makes every column markable. See the header.
    joinedWeekNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The cohort-channel row the enrol route writes, restated.
 *
 * `confirmed` and `subscribed` both true: `findRecipientsForChannel` filters
 * on exactly that pair, and a member placed by allocation is minted confirmed
 * (their address is the one they signed in with).
 */
function subscriptionDoc({ email, channel, uid, now, registerRunId }) {
  return {
    e2eRegisterRunId: registerRunId,
    email,
    channel,
    audience: "user",
    audienceId: uid,
    name: "E2E",
    confirmed: true,
    confirmedAt: now,
    subscribed: true,
    subscribedAt: now,
    source: "e2e-register-fixture",
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// The admin's uid
// ---------------------------------------------------------------------------

/**
 * The uid behind the address in `.env.e2e.secrets.local`, resolved once so
 * teardown can address the throttle document the push writes under it.
 *
 * READ ONLY, and the address is never printed: it is the owner's own account,
 * this harness did not create it, and nothing here writes to it or deletes it.
 */
async function adminUidFromSecrets() {
  const { adminEmail } = loadSecrets();
  if (!adminEmail) {
    throw new Error(
      "register-push needs the owner's admin account: E2E_ADMIN_EMAIL is not set. " +
        "Put it in .env.e2e.secrets.local at the repo root, or export it. This " +
        "harness cannot create an admin, by design.",
    );
  }
  try {
    const record = await adminAuth().getUserByEmail(adminEmail);
    return record.uid;
  } catch (err) {
    throw new Error(
      "Could not resolve the account named by E2E_ADMIN_EMAIL on the dev project. " +
        "The push writes a send-throttle document keyed on the pressing account's " +
        `uid, and teardown has to be able to address it. ${err.message}`,
    );
  }
}

/** `reserveSendSlot`'s document id for a push, restated from that helper. */
function pushThrottleId(groupIdValue, uid) {
  return `emailrate__push__${groupIdValue}__${uid}`;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: registerRunId, suppress = true, options = {}, onState } = {}) {
  const target = assertFixtureTarget();
  void options;
  const now = new Date();

  const todayKey = londonDateKey(now);
  const startDate = shiftDateKey(todayKey, -START_DAYS_AGO);
  const weekday = weekdayOf(startDate);

  const courseTitle = `E2E register course ${registerRunId}`;
  const courseIdValue = fixtureId("e2e-register-course", registerRunId);
  const runIdValue = fixtureId("e2e-register-run", registerRunId);
  const groupIdValue = fixtureId("e2e-register-group", registerRunId);
  const groupName = `Register group ${registerRunId}`;

  const state = {
    registerRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    /** The runner's answer, recorded so the spec branches on the same fact. */
    suppress,
    courseId: courseIdValue,
    courseTitle,
    runId: runIdValue,
    groupId: groupIdValue,
    groupName,
    startDate,
    weekday,
    weekCount: WEEK_COUNT,
    /** Week documents this fixture wrote under the run. */
    weekIds: [weekDocId(NEXT_WEEK)],
    channel: cohortChannel(runIdValue),
    /** Filled below, in the row order the register renders them in. */
    members: [],
    suppressed: [],
    /** Resolved from the secrets file; see `adminUidFromSecrets`. */
    adminUid: null,
    throttleId: null,
  };

  // Published BEFORE the first write and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created.
  onState?.(state);

  state.adminUid = await adminUidFromSecrets();
  state.throttleId = pushThrottleId(groupIdValue, state.adminUid);

  log(`Seeding fixture ${registerRunId} into ${target.projectId}.`);

  // Accounts first: everything else can be torn down without them, and an
  // account with no group to sit in is the harmless failure.
  const created = [];
  for (let i = 0; i < MEMBER_COUNT; i += 1) {
    const account = await createFixtureUser({
      runId: registerRunId,
      index: i,
      password: `E2eRegister!${registerRunId}${i}`,
      suppress,
    });
    if (account.suppressionId) state.suppressed.push(account.suppressionId);
    created.push(account);
  }
  // ROW ORDER, decided here rather than guessed at in the spec.
  // `loadRegisterMembers` sorts by display name and then by uid, and every
  // seeded account carries the same seeded display name, so the uid tie-break
  // is the whole order. The spec addresses rows by index and has to know which
  // member each one is.
  created.sort((a, b) => a.uid.localeCompare(b.uid));
  state.members = created.map((account, row) => ({
    row,
    uid: account.uid,
    email: account.email,
    password: account.password,
  }));

  await fixtureDoc("courses", courseIdValue).set(
    courseDoc({ title: courseTitle, now, registerRunId }),
  );
  await fixtureDoc("courseRuns", runIdValue).set(
    runDoc({
      runIdValue,
      courseIdValue,
      courseTitle,
      label: `Register ${registerRunId}`,
      startDate,
      now,
      registerRunId,
    }),
  );
  await fixtureSubcollection("courseRuns", runIdValue, WEEKS)
    .doc(weekDocId(NEXT_WEEK))
    .set(weekDoc({ weekNumber: NEXT_WEEK, now, registerRunId }));
  await fixtureDoc("courseGroups", groupIdValue).set(
    groupDoc({
      runIdValue,
      courseIdValue,
      name: groupName,
      weekday,
      now,
      registerRunId,
    }),
  );

  for (const member of state.members) {
    await fixtureDoc("courseEnrolments", enrolmentId(runIdValue, member.uid)).set(
      enrolmentDoc({
        runIdValue,
        courseIdValue,
        uid: member.uid,
        groupIdValue,
        now,
        registerRunId,
      }),
    );
    await fixtureDoc("subscriptions", subscriptionId(member.email, state.channel)).set(
      subscriptionDoc({
        email: member.email,
        channel: state.channel,
        uid: member.uid,
        now,
        registerRunId,
      }),
    );
  }

  log(
    `Seeded run ${runIdValue} (starts ${startDate}, ${WEEK_COUNT} weeks), group ` +
      `${groupIdValue} with ${state.members.length} member(s).`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/**
 * Every row this fixture owns, seeded or route-created, counted by a key it
 * controls. Teardown is only believed when this reads zero across the board.
 */
async function countRows(state) {
  const { runId: runIdValue, groupId: groupIdValue, channel } = state;
  const counts = {};

  const seededSingles = [
    ["courses", state.courseId],
    ["courseRuns", runIdValue],
    ["courseGroups", groupIdValue],
  ];
  for (const [collection, id] of seededSingles) {
    const snap = await fixtureDoc(collection, id).get();
    counts[collection] = snap.exists ? 1 : 0;
  }

  const weeks = await fixtureSubcollection("courseRuns", runIdValue, WEEKS).get();
  counts.courseRunWeeks = weeks.size;

  counts.courseEnrolments = (
    await fixtureQuery("courseEnrolments").where("runId", "==", runIdValue).get()
  ).size;
  // Every register the marking, the not-held flip, the note and the push
  // wrote. Keyed on the group, which is this fixture's own document.
  counts.courseAttendance = (
    await fixtureQuery("courseAttendance").where("groupId", "==", groupIdValue).get()
  ).size;
  counts.courseAudit = (
    await fixtureQuery("courseAudit").where("runId", "==", runIdValue).get()
  ).size;
  // The group's reminder marker. The push writes `groupId` on it, so the
  // marker is queryable; the throttle document beside it is not, and is
  // counted by address below.
  counts.courseNudges = (
    await fixtureQuery("courseNudges").where("groupId", "==", groupIdValue).get()
  ).size;
  counts.courseNudgeThrottle = state.throttleId
    ? (await fixtureDoc("courseNudges", state.throttleId).get()).exists
      ? 1
      : 0
    : 0;
  counts.subscriptions = (
    await fixtureQuery("subscriptions").where("channel", "==", channel).get()
  ).size;
  // The unmarked-register follow-up card, which the push archives if the
  // scheduler ever raised one. Nothing in this run raises one (no scheduler
  // tick runs), so this is a zero the manifest states rather than assumes.
  counts.tasks = (
    await fixtureQuery("tasks")
      .where("source", "==", "course-register")
      .where("sourceRef.groupId", "==", groupIdValue)
      .get()
  ).size;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  // The send log. Zero when the fixture addresses are suppressed; when mail is
  // caught the reminder really goes out and each message logs a row. Keyed on
  // the RECIPIENT, which is run-scoped by construction (a fixture address
  // embeds the run id). Nothing on this journey mails anybody else: the push
  // writes to the group's members and to nobody outside it.
  let sendRows = 0;
  for (const member of state.members ?? []) {
    sendRows += (
      await fixtureQuery("emailSends").where("to", "==", member.email).get()
    ).size;
  }
  counts.emailSends = sendRows;

  let eventRows = 0;
  for (const member of state.members ?? []) {
    const subId = subscriptionId(member.email, channel);
    eventRows += (
      await fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId).get()
    ).size;
  }
  counts.subscriptionEvents = eventRows;

  const accounts = await countAccounts((state.members ?? []).map((m) => m.uid));
  counts.users = accounts.users;
  counts.authAccounts = accounts.authAccounts;

  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.registerRunId = state.registerRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown(state) {
  assertFixtureTarget();
  const { runId: runIdValue, groupId: groupIdValue, channel } = state;
  log(`Tearing down fixture ${state.registerRunId}.`);
  /** Anything that refused or failed to delete, folded into the manifest. */
  const failures = [];

  // The namespace check comes FIRST, before a single delete: several sweeps
  // below are keyed on an ADDRESS out of this state file (the subscription
  // rows, their event lines, the send log), and a tampered or stale ledger
  // naming a real person would otherwise have those rows deleted and only
  // then reach the refusal that exists to stop exactly that.
  for (const member of state.members ?? []) {
    if (!isHarnessAccount(member.email)) {
      throw new Error(
        `REFUSING to tear down ${member.email}: not a harness account. The state ` +
          "file names an address this fixture could not have created.",
      );
    }
  }

  // Route-created leaves first.
  await deleteQuery(
    fixtureQuery("courseAttendance").where("groupId", "==", groupIdValue),
  );
  await deleteQuery(fixtureQuery("courseAudit").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseNudges").where("groupId", "==", groupIdValue));
  if (state.throttleId) await fixtureDoc("courseNudges", state.throttleId).delete();
  await deleteQuery(
    fixtureQuery("tasks")
      .where("source", "==", "course-register")
      .where("sourceRef.groupId", "==", groupIdValue),
  );

  for (const member of state.members ?? []) {
    const subId = subscriptionId(member.email, channel);
    await deleteQuery(
      fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId),
    );
    await fixtureDoc("subscriptions", subId).delete();
    await fixtureDoc("courseEnrolments", enrolmentId(runIdValue, member.uid)).delete();
  }

  // Anything the addressed deletes above could have missed, because a route
  // wrote a row for an account this state file does not list.
  await deleteQuery(fixtureQuery("subscriptions").where("channel", "==", channel));
  await deleteQuery(fixtureQuery("courseEnrolments").where("runId", "==", runIdValue));

  const weeks = await fixtureSubcollection("courseRuns", runIdValue, WEEKS).get();
  for (const doc of weeks.docs) await doc.ref.delete();

  await fixtureDoc("courseGroups", groupIdValue).delete();
  await fixtureDoc("courseRuns", runIdValue).delete();
  await fixtureDoc("courses", state.courseId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  // The send log LAST of the row sweeps: a send is logged a moment after the
  // message leaves, so the later this runs the smaller the window in which a
  // row lands behind it.
  for (const member of state.members ?? []) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", member.email));
  }

  for (const member of state.members ?? []) {
    // The users document first: an Auth account whose document outlives it is
    // a ghost row in the admin members list. Both deletes resolve the account
    // BY UID and re-check the namespace on the address Auth returns, rather
    // than trusting the address this state file sits next to.
    try {
      await deleteHarnessUserDoc(member.uid);
      await deleteHarnessUser(member.uid);
    } catch (err) {
      failures.push(`${member.uid}: ${err.message}`);
      log(`Could not tear down ${member.uid}: ${err.message}`);
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
  name: "register-push",
  specFile: "tests/e2e/register-push.spec.mjs",
  steps: REGISTER_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // The whole journey is the ADMIN's: marking, pushing, correcting a pushed
  // register and forcing a resend are admin or facilitator acts, and this
  // harness may not appoint a facilitator. The account is the owner's own.
  needs: { admin: true },
  covers: {
    routes: [
      "/api/auth/session",
      "/api/courses/groups/[groupId]/roster",
      "/api/courses/groups/[groupId]/attendance",
      "/api/courses/groups/[groupId]/attendance/push",
      "/api/courses/groups/[groupId]/participant-notes",
    ],
    pages: ["/(auth)/login", "/(app)/learn/[runId]/group/[groupId]"],
  },
  /**
   * VERIFIED on 2026-09-06 against the harness server on :3100, and again
   * after the review fixes (the server-side lock assertion, the draft-control
   * count with a before, the status list pinned to the product's own): all
   * nine steps ran, 29 rows existed before teardown (3 registers, 2 audit
   * rows, 1 nudge marker, 1 send throttle, 6 sends, 3 enrolments, 3
   * subscriptions, 3 accounts and their documents, the course, run, group and
   * week), and the manifest read zero afterwards.
   */
  status: "verified",
  seed,
  countRows,
  teardown,
};
