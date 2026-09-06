/**
 * The member journey's fixture: one throwaway course with an open-enrolment
 * run, two capped session slots, two throwaway accounts, and the subscription
 * rows one of them starts out holding.
 *
 * The spec it feeds (`tests/e2e/member-journey.spec.mjs`) is the one that
 * crosses the approval boundary: the owner's own admin approves a waiting
 * applicant on the real Approvals page, and everything after that is driven as
 * the member who was just made one. See `applicant-funnel.mjs` for the worked
 * example of the SPEC contract; this file follows it exactly.
 *
 * ## Nothing here writes a role, and the member is made one through the page
 *
 * The fence forbids this harness creating anything above role `pending`, and
 * that includes the account this journey is about. So the fixture seeds two
 * ordinary pending accounts and the SPEC promotes the first of them by
 * pressing Approve as the admin, which is also the only way this suite covers
 * the Approvals page at all. Reading the role back afterwards is a read of
 * something the PRODUCT wrote, which is the whole point of the step.
 *
 * ## Why the second account is not seeded as an enrolment
 *
 * The one-place session has to be FULL before the member tries to move into
 * it, and the cheapest way to write that would be a `courseEnrolments` row and
 * a `memberCount` of 1. This fixture does not do that, for two reasons:
 *
 *  - `memberCount` without a row behind it is a lie in the data, and the
 *    picker's "Full" would then be reading a number nobody earned.
 *  - the enrol route admits a `pending` caller ON PURPOSE (its own module
 *    comment says so), so a second throwaway account can take that last seat
 *    through the real route, in a real browser, with no privilege at all.
 *
 * The counter therefore moves because somebody signed up, which is the same
 * reason it moves in production, and the "Full" the member meets is real.
 *
 * ## Mail, and why this fixture REFUSES a target whose mail is not caught
 *
 * Two sends sit on this journey: the application-approved email the Approvals
 * page fires, and the drop-out email the enrol route's DELETE fires.
 *
 *  - The drop-out send goes through `sendCourseDroppedOutEmail`, which returns
 *    early on `isSuppressed()`. Seeding a `suppressedEmails` row for every
 *    fixture address therefore really does stop it.
 *  - The approval send does NOT. `/api/admin/application-emails/send` calls
 *    `sendEmail()` from `src/lib/email/send.ts` directly, and that function
 *    never reads the suppression list (only the per-feature helpers do). So a
 *    run of this spec against a DEPLOYED target would hand a `.invalid`
 *    address to the real sender and log a hard bounce against the sending
 *    domain.
 *
 * The harness's central safety property is "suppress every fixture address
 * first, and then nothing this suite drives can post mail". This journey is
 * the first thing in the suite that property is not true of, and a comment
 * saying so is not a safeguard: `npm run e2e:browser` with no flags runs every
 * spec against the deployed dev site. So `seed()` REFUSES to create anything
 * at all when `suppress` is true, naming the route and the missing
 * `isSuppressed()` call, and it reads the product to decide that rather than
 * trusting this paragraph: see `assertApprovalMailCannotEscape` below, which
 * fails in the other direction too, so the refusal cannot outlive the gap.
 *
 * Both addresses' `emailSends` rows are counted and drained below either way,
 * so the manifest tells the truth about what this run caused.
 *
 * Nothing runs at import time: `core.mjs` obtains no credential until a
 * function is called, so the coverage guard can import this module offline.
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
  subscriptionId,
} from "./core.mjs";
import {
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = (msg) => console.log(`[journey-seed] ${msg}`);

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it
 * finished and the runner checks the record against this list, so a step
 * renamed in one place and not the other fails loudly instead of quietly
 * shrinking what a green run means.
 */
export const JOURNEY_STEPS = [
  "the admin finds the new applicant waiting for approval",
  "approving the applicant makes them a member",
  "another sign-up takes the last place in the one-place session",
  "the new member signs in and lands past the pending gate",
  "the profile grid shows the member their own subscriptions",
  "unticking a channel writes it through and survives a reload",
  "taking a place on the course confirms the session",
  "the full session cannot be chosen when changing session",
  "leaving the course needs the typed course title",
  "the approval and the drop-out reach the send log",
];

/**
 * NOTHING ON THIS JOURNEY IS reCAPTCHA-GATED, so the list is empty.
 *
 * The gate lives on `/api/register` and on the three admissions apply routes
 * (see the funnel's own list). This spec signs existing accounts in through
 * `/login`, presses Approve on an admin page, and drives the enrol route, and
 * not one of those sends a token. So every step here runs in both modes, and
 * an empty list is the honest declaration rather than an oversight.
 *
 * The spec still carries the shared skip wiring, unchanged, so a step that
 * later grows a gated press is handled the same way the funnel handles one.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/**
 * The channels the profile grid draws a row of checkboxes for, in the order
 * it draws them. A restatement of `SUBSCRIPTION_CATEGORIES` in
 * src/lib/firestore/notifications.ts, which is TypeScript and cannot be
 * imported from plain Node. `courses` is deliberately absent there and here:
 * it is an account-level opt-out with no subscription row of its own.
 *
 * PINNED, not merely commented: `assertGridChannelsMatchProduct()` below reads
 * that file on every seed and refuses a run where the two have drifted. A
 * third channel added to the product would otherwise leave the #261 step
 * seeding and reading two of the grid's three rows and still passing, which is
 * a regression net with a hole in it.
 */
export const GRID_CHANNELS = ["newsletter", "events"];

/**
 * What each of those rows is called on screen. A restatement of
 * `CATEGORY_LABELS` from the same file, and the string the spec's checkbox
 * locator is built from (the cells carry `aria-label="<label> to <address>"`).
 * Pinned by the same function, so renamed copy fails at the seed with the two
 * strings side by side rather than 40 seconds later at a locator.
 */
export const GRID_CHANNEL_LABELS = {
  newsletter: "Newsletter",
  events: "Event announcements",
};

/** The one the spec unticks. Named here so both sides agree on which. */
export const TOGGLED_CHANNEL = "newsletter";

// ---------------------------------------------------------------------------
// What this fixture asserts about the PRODUCT before it writes anything
// ---------------------------------------------------------------------------

/** The repo root, resolved off this file rather than a working directory. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The product file the grid's channel list is restated from. */
const NOTIFICATIONS_MODULE = "src/lib/firestore/notifications.ts";

/** The route the Approvals page fires from its Approve handler. */
const APPROVAL_SEND_ROUTE = "src/app/api/admin/application-emails/send/route.ts";

/**
 * Product source, read at seed time (never at import: the coverage guard
 * imports this module and must stay offline and side-effect free).
 *
 * A missing file is an error rather than a skipped check: these two functions
 * exist to fail, and a check that quietly stops checking when a file moves is
 * worse than no check, because the comment above it still claims coverage.
 */
function productSource(relPath) {
  try {
    return readFileSync(join(REPO_ROOT, relPath), "utf8");
  } catch (err) {
    throw new Error(
      `member-journey seeding could not read ${relPath}, which it checks before it ` +
        `writes anything: ${err.message}. The file moved or was renamed; re-read it and ` +
        "update this fixture rather than deleting the check.",
    );
  }
}

/**
 * Refuses a run whose grid list has drifted from the product's.
 *
 * Both directions: the order and the membership of `SUBSCRIPTION_CATEGORIES`,
 * and the on-screen label of every channel in it.
 */
export function assertGridChannelsMatchProduct() {
  const source = productSource(NOTIFICATIONS_MODULE);

  const list = source.match(/export const SUBSCRIPTION_CATEGORIES[^=]*=\s*\[([^\]]*)\]/);
  if (!list) {
    throw new Error(
      `SUBSCRIPTION_CATEGORIES could not be read out of ${NOTIFICATIONS_MODULE}. The ` +
        "profile grid draws one row per entry and this fixture seeds one row per entry, " +
        "so the two lists have to be compared: re-read that file and fix this reader.",
    );
  }
  const categories = [...list[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const sameList =
    categories.length === GRID_CHANNELS.length &&
    categories.every((name, i) => name === GRID_CHANNELS[i]);
  if (!sameList) {
    throw new Error(
      `the profile grid's channels have moved. ${NOTIFICATIONS_MODULE} now says ` +
        `${JSON.stringify(categories)} and this fixture says ` +
        `${JSON.stringify(GRID_CHANNELS)}. The #261 regression step reads a box per ` +
        "channel, so a channel this fixture does not seed is a row that step would " +
        "neither fill nor check while still passing. Update GRID_CHANNELS and " +
        "GRID_CHANNEL_LABELS together.",
    );
  }

  const labels = source.match(/export const CATEGORY_LABELS[^=]*=\s*\{([^}]*)\}/);
  if (!labels) {
    throw new Error(
      `CATEGORY_LABELS could not be read out of ${NOTIFICATIONS_MODULE}, so the spec's ` +
        "checkbox labels cannot be checked against the ones the page renders.",
    );
  }
  for (const channel of GRID_CHANNELS) {
    const found = labels[1].match(new RegExp(`\\b${channel}\\s*:\\s*["']([^"']+)["']`));
    if (!found) {
      throw new Error(
        `${NOTIFICATIONS_MODULE} has no CATEGORY_LABELS entry for ${channel}, which the ` +
          "spec locates its checkbox by.",
      );
    }
    if (found[1] !== GRID_CHANNEL_LABELS[channel]) {
      throw new Error(
        `the ${channel} checkbox is labelled ${JSON.stringify(found[1])} on the page and ` +
          `${JSON.stringify(GRID_CHANNEL_LABELS[channel])} here. The spec finds each cell ` +
          "by that label, so this is a locator that would time out in 30 seconds instead " +
          "of a sentence now.",
      );
    }
  }
}

/**
 * Every `@/lib/email` helper the approval send goes through that never
 * consults the suppression list.
 *
 * Read off the route rather than assumed, so a send moved behind a different
 * helper is noticed rather than silently trusted. An empty import list is an
 * error: it means the send was refactored and this fixture can no longer tell
 * whether the address it seeds is safe.
 */
function approvalSendHelpersBlindToSuppression() {
  const route = productSource(APPROVAL_SEND_ROUTE);
  const helpers = [
    ...route.matchAll(/from\s+["']@\/lib\/email\/([A-Za-z0-9_]+)["']/g),
  ].map((m) => m[1]);
  if (helpers.length === 0) {
    throw new Error(
      `${APPROVAL_SEND_ROUTE} no longer imports a send helper from @/lib/email, so this ` +
        "fixture can no longer tell whether the approval email consults the suppression " +
        "list. Read the route and rewrite this check rather than removing it.",
    );
  }
  return helpers.filter(
    (name) =>
      !/\b(isSuppressed|filterSuppressed)\(/.test(productSource(`src/lib/email/${name}.ts`)),
  );
}

/**
 * REFUSES to seed this journey where the approval email could really be sent.
 *
 * The harness's no-mail promise for a target that can reach a real sender is
 * "every fixture address is on the suppression list before anything runs".
 * That promise only holds while the send helpers look at the list, and the one
 * behind the Approvals page does not. So:
 *
 *  - mail NOT caught, and the gap open: refuse, before a single write, naming
 *    the route and the helper. Nothing is created, so there is nothing to tear
 *    down and no address to bounce.
 *  - the gap CLOSED: refuse too, in the mode that actually runs, because this
 *    whole block is then dead code claiming to protect against something that
 *    has been fixed. A pin that silently stops applying is how a stale
 *    workaround outlives the defect it was written for.
 */
function assertApprovalMailCannotEscape({ suppress }) {
  const blind = approvalSendHelpersBlindToSuppression();
  if (blind.length === 0) {
    throw new Error(
      `${APPROVAL_SEND_ROUTE} now sends through a helper that consults the suppression ` +
        "list, so the gap this fixture refuses to run into has been closed. DELETE " +
        "assertApprovalMailCannotEscape and its call in seed(), and the paragraph about " +
        "it in this file's header and in the spec's mail step, so the suite can run " +
        "against a deployed target again.",
    );
  }
  if (suppress) {
    throw new Error(
      "REFUSING to seed the member journey against a target whose mail is not caught.\n" +
        `  This journey presses Approve on the Approvals page, which fires ${APPROVAL_SEND_ROUTE},\n` +
        `  and that route sends through src/lib/email/${blind.join(".ts, src/lib/email/")}.ts,\n` +
        "  which never calls isSuppressed(). The suppressedEmails rows this fixture writes\n" +
        "  first therefore cannot stop that send: it would hand an @e2e.invalid fixture\n" +
        "  address to the real sender and log a hard bounce against the sending domain.\n" +
        "  Run this spec against the harness server, whose mail goes to Mailpit:\n" +
        "    npm run e2e:browser -- --spec member-journey --local\n" +
        "  and delete this refusal once that send consults the suppression list.",
    );
  }
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

function courseDoc({ title, now, journeyRunId }) {
  return {
    e2eJourneyRunId: journeyRunId,
    title,
    tagline: "Throwaway fixture for the member-journey end-to-end run.",
    summaryBlocks: [
      {
        id: "b1",
        // `richText` is a real BlockType; "paragraph" is not, and
        // sanitizeBlocks drops what it does not recognise.
        type: "richText",
        html: "<p>This course exists only while an automated member-journey run is in flight.</p>",
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
 * The open-enrolment run. `status: "running"` plus a window open on both
 * sides is what `isEnrolOpen()` wants, and `enrolMode: "open"` is what puts
 * the session picker on the public course page instead of an apply link.
 *
 * `cohort`, `templateId` and `templateLabel` are ABSENT rather than null,
 * matching what the authoring routes store: firestore.rules pins all three
 * with a `.get()` default, and a stored null compares unequal to that default.
 */
function runDoc({ runIdValue, courseIdValue, courseTitle, label, now, journeyRunId }) {
  return {
    e2eJourneyRunId: journeyRunId,
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
    // Always derived, never typed: every consumer computes `cohort:<runId>`,
    // and a stored value that disagreed would make one run's teardown sweep
    // another list's subscription rows.
    channel: cohortChannel(runIdValue),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * One capped session slot, `memberCount` at zero.
 *
 * Capacities are 2 and 1 on purpose. The member takes one of the two places
 * in the first; the second holds exactly one seat, the other account takes it
 * through the real route, and "Full" is then something the member meets
 * rather than something the fixture asserted into the data.
 */
function groupDoc({
  runIdValue,
  courseIdValue,
  name,
  weekday,
  startTimeLocal,
  capacity,
  now,
  journeyRunId,
}) {
  return {
    e2eJourneyRunId: journeyRunId,
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

/**
 * One subscription row for the member, on a channel the profile grid draws.
 *
 * Written CONFIRMED and SUBSCRIBED, which is the state a real member reaches
 * by ticking the box on their own profile: `/api/subscriptions/sync` mints
 * rows for a member's own verified addresses with `inboxProven`, so there is
 * no pending click in that path. The grid reads only `subscribed`, but the
 * row is written whole, because a fixture that stores half a shape stops
 * testing the shape the route actually writes.
 */
function subscriptionDoc({ email, channel, uid, now, journeyRunId }) {
  return {
    e2eJourneyRunId: journeyRunId,
    email,
    channel,
    audience: "user",
    audienceId: uid,
    name: "E2E",
    confirmed: true,
    confirmedAt: now,
    subscribed: true,
    subscribedAt: now,
    source: "e2e-member-journey",
    createdAt: now,
    lastAttemptAt: now,
    attemptCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Creates the whole throwaway world and returns the state the spec drives it
 * from. The RUNNER persists that state.
 */
async function seed({ runId: journeyRunId, suppress = true, onState } = {}) {
  const target = assertFixtureTarget();
  // Both refusals come BEFORE the first write and before `onState`, so a run
  // this fixture will not stand behind creates nothing at all: no account, no
  // ledger, nothing to tear down. `suppress` defaults to true above, so a
  // caller that forgets to pass it gets the refusal rather than the risk.
  assertApprovalMailCannotEscape({ suppress });
  assertGridChannelsMatchProduct();
  const now = new Date();

  const courseTitle = `E2E member journey course ${journeyRunId}`;
  const courseIdValue = fixtureId("e2e-journey-course", journeyRunId);
  const runIdValue = fixtureId("e2e-journey-run", journeyRunId);
  const roomyGroupId = fixtureId("e2e-journey-group-roomy", journeyRunId);
  const lastSeatGroupId = fixtureId("e2e-journey-group-last-seat", journeyRunId);

  const state = {
    journeyRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    /** Recorded so the spec and countRows can branch on it, never re-derived. */
    suppress,
    courseId: courseIdValue,
    courseTitle,
    runId: runIdValue,
    /** The two-place slot the member takes, and its name in the confirmation. */
    roomyGroupId,
    roomyGroupName: "Journey session A",
    /** The one-place slot the other account fills, so the member meets "Full". */
    lastSeatGroupId,
    lastSeatGroupName: "Journey session B",
    channel: cohortChannel(runIdValue),
    /** The account the admin approves, and the whole journey is about. */
    member: null,
    /** The account that takes the last seat. Never approved: see the header. */
    other: null,
    /** The grid rows seeded for the member, by document id. */
    subscriptionIds: [],
    /** Written by seeding, deleted by teardown. Empty when mail is caught. */
    suppressed: [],
  };

  // Published BEFORE the first write, and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created.
  onState?.(state);

  log(`Seeding fixture ${journeyRunId} into ${target.projectId}.`);

  // Accounts first: everything else can be torn down without them, but an
  // account with no fixture to use is the harmless failure and a fixture with
  // no accounts is not.
  for (const [index, key] of [
    [0, "member"],
    [1, "other"],
  ]) {
    const account = await createFixtureUser({
      runId: journeyRunId,
      index,
      password: `E2eJourney!${journeyRunId}${index}`,
      suppress,
    });
    if (account.suppressionId) state.suppressed.push(account.suppressionId);
    state[key] = {
      index,
      uid: account.uid,
      email: account.email,
      password: account.password,
    };
  }

  await fixtureDoc("courses", courseIdValue).set(
    courseDoc({ title: courseTitle, now, journeyRunId }),
  );
  await fixtureDoc("courseRuns", runIdValue).set(
    runDoc({
      runIdValue,
      courseIdValue,
      courseTitle,
      label: `Journey ${journeyRunId}`,
      now,
      journeyRunId,
    }),
  );
  await fixtureDoc("courseGroups", roomyGroupId).set(
    groupDoc({
      runIdValue,
      courseIdValue,
      name: state.roomyGroupName,
      weekday: 2,
      startTimeLocal: "18:00",
      capacity: 2,
      now,
      journeyRunId,
    }),
  );
  await fixtureDoc("courseGroups", lastSeatGroupId).set(
    groupDoc({
      runIdValue,
      courseIdValue,
      name: state.lastSeatGroupName,
      weekday: 4,
      startTimeLocal: "13:00",
      capacity: 1,
      now,
      journeyRunId,
    }),
  );

  // The rows the profile grid renders. Without them the grid draws two
  // unticked boxes, which is exactly what the #261 bug looked like, and the
  // regression this journey exists to catch would be invisible.
  for (const channel of GRID_CHANNELS) {
    const id = subscriptionId(state.member.email, channel);
    await fixtureDoc("subscriptions", id).set(
      subscriptionDoc({
        email: state.member.email,
        channel,
        uid: state.member.uid,
        now,
        journeyRunId,
      }),
    );
    state.subscriptionIds.push(id);
  }

  log(
    `Seeded course ${courseIdValue}, run ${runIdValue}, ` +
      `${state.subscriptionIds.length} subscription row(s), 2 account(s).`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/** The two accounts, in one list, skipping any the seed never reached. */
function accountsOf(state) {
  return [state.member, state.other].filter(Boolean);
}

/**
 * Every subscription id this run can be responsible for, constructed rather
 * than discovered.
 *
 * Discovery is no good AFTER teardown: the rows are gone, so a query cannot
 * name the ids whose event lines might have outlived them. Both grid channels
 * for the member, and the run's cohort channel for each account, is the whole
 * set the seeded rows and the enrol route between them can produce.
 */
function subscriptionIdsOf(state) {
  const ids = new Set(state.subscriptionIds ?? []);
  for (const account of accountsOf(state)) {
    ids.add(subscriptionId(account.email, state.channel));
  }
  return [...ids];
}

/**
 * Counts every row this fixture owns, seeded or route-created. Teardown is
 * only believed when this reads zero across the board.
 */
async function countRows(state) {
  const { journeyRunId, runId: runIdValue, channel } = state;
  const counts = {};
  const accounts = accountsOf(state);

  for (const [collection, id] of [
    ["courses", state.courseId],
    ["courseRuns", runIdValue],
  ]) {
    const snap = await fixtureDoc(collection, id).get();
    counts[collection] = snap.exists ? 1 : 0;
  }

  counts.courseGroups = (
    await fixtureQuery("courseGroups").where("runId", "==", runIdValue).get()
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
  counts.tasks = (
    await fixtureQuery("tasks").where("sourceRef.cohortId", "==", runIdValue).get()
  ).size;

  // Subscription rows come from TWO keys that overlap: the cohort row the
  // enrol route writes carries this run's channel AND the member's uid, so
  // adding the two query sizes would count it twice and report a manifest
  // that never reaches zero. Union by document id instead.
  const subIds = new Set();
  for (const account of accounts) {
    const snap = await fixtureQuery("subscriptions")
      .where("audienceId", "==", account.uid)
      .get();
    for (const doc of snap.docs) subIds.add(doc.id);
  }
  const cohortRows = await fixtureQuery("subscriptions")
    .where("channel", "==", channel)
    .get();
  for (const doc of cohortRows.docs) subIds.add(doc.id);
  counts.subscriptions = subIds.size;

  // Event-log lines are addressed through the subscription rows they
  // describe, which is why they are counted after them and swept before them.
  let eventRows = 0;
  for (const id of subscriptionIdsOf(state)) {
    eventRows += (
      await fixtureQuery("subscriptionEvents").where("subscriptionId", "==", id).get()
    ).size;
  }
  counts.subscriptionEvents = eventRows;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  // The send log, keyed on the RECIPIENT, which is run-scoped by
  // construction: a fixture address is `e2e-f<runId><index>@e2e.invalid`, so
  // no other run and no person can own one. What that key cannot see is a
  // send this journey caused to somebody ELSE. Nothing on these paths mails
  // anybody but the two fixture accounts (the approval mails the applicant,
  // the drop-out mails the member), and a step that adds one must count it
  // here by whatever key that send is addressed with.
  let sendRows = 0;
  for (const account of accounts) {
    sendRows += (
      await fixtureQuery("emailSends").where("to", "==", account.email).get()
    ).size;
  }
  counts.emailSends = sendRows;

  const accountCounts = await countAccounts(accounts.map((a) => a.uid));
  counts.users = accountCounts.users;
  counts.authAccounts = accountCounts.authAccounts;

  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.journeyRunId = journeyRunId;
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
 * account and refuses any address outside the harness namespace, so a
 * tampered or stale state file cannot make this delete a real person.
 */
async function teardown(state) {
  assertFixtureTarget();
  const { runId: runIdValue, channel } = state;
  log(`Tearing down fixture ${state.journeyRunId}.`);
  /** Anything that refused or failed, reported rather than logged and
      forgotten: a swallowed rejection here is an account or a document left
      on a shared project under a manifest that says everything went. */
  const failures = [];
  const accounts = accountsOf(state);

  // The namespace check comes FIRST, before a single delete.
  //
  // Several sweeps below are keyed on an ADDRESS out of this state file: the
  // subscription rows and their event lines, and the send log. A tampered or
  // stale ledger naming a real person would have had those rows deleted and
  // only then reached the refusal that exists to stop exactly that. So both
  // addresses are checked up front, and the account deletions later re-check
  // what Auth says each uid's address actually is.
  for (const account of accounts) {
    if (!isHarnessAccount(account.email)) {
      throw new Error(
        `REFUSING to tear down ${account.email}: not a harness account. The state ` +
          "file names an address this fixture could not have created.",
      );
    }
  }

  // Subscription rows and their events. The ids are constructed (both grid
  // channels plus each account's cohort row), and the two live queries catch
  // anything a hand-driven repeat left at an id this state file cannot name.
  const subIds = new Set(subscriptionIdsOf(state));
  for (const account of accounts) {
    const snap = await fixtureQuery("subscriptions")
      .where("audienceId", "==", account.uid)
      .get();
    for (const doc of snap.docs) subIds.add(doc.id);
  }
  const cohortRows = await fixtureQuery("subscriptions")
    .where("channel", "==", channel)
    .get();
  for (const doc of cohortRows.docs) subIds.add(doc.id);
  for (const id of subIds) {
    await deleteQuery(
      fixtureQuery("subscriptionEvents").where("subscriptionId", "==", id),
    );
    await fixtureDoc("subscriptions", id).delete();
  }

  // The enrolment rows, addressed first (the deterministic id is the one the
  // route uses) and then swept, because a hand-driven repeat can leave a row
  // for an account this state file does not list.
  for (const account of accounts) {
    await fixtureDoc("courseEnrolments", enrolmentId(runIdValue, account.uid)).delete();
  }
  await deleteQuery(fixtureQuery("courseEnrolments").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseProgress").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseAudit").where("runId", "==", runIdValue));
  await deleteQuery(fixtureQuery("tasks").where("sourceRef.cohortId", "==", runIdValue));
  await deleteQuery(fixtureQuery("courseGroups").where("runId", "==", runIdValue));

  await fixtureDoc("courseRuns", runIdValue).delete();
  await fixtureDoc("courses", state.courseId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  // The send log LAST of the row sweeps, because both sends on this journey
  // are fire and forget: the route answers the browser and logs its row a
  // moment later, so the later this runs the smaller the window in which a
  // row lands behind it.
  for (const account of accounts) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", account.email));
  }

  for (const account of accounts) {
    // The users document first: an Auth account whose document outlives it is
    // a ghost row in the admin members list. Both deletes resolve the account
    // BY UID and re-check the namespace on the address that comes back,
    // rather than trusting the address this state file sits next to.
    //
    // The member's document now says role `member`, because the Approvals
    // page put it there. That changes nothing here: the delete is by uid
    // under the namespace check, and it never reads the role.
    try {
      await deleteHarnessUserDoc(account.uid);
      await deleteHarnessUser(account.uid);
    } catch (err) {
      failures.push(`${account.uid}: ${err.message}`);
      log(`Could not tear down ${account.uid}: ${err.message}`);
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
  name: "member-journey",
  specFile: "tests/e2e/member-journey.spec.mjs",
  steps: JOURNEY_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  /**
   * VERIFIED: every step of this spec has been driven end to end against the
   * shared loopback server (6 September 2026), with the fixture manifest
   * reading zero afterwards.
   *
   * What that run does NOT cover, stated so the word is not read too widely:
   * it was a caught-mail run, and that is now the ONLY run this fixture will
   * seed. `seed()` refuses a target whose mail could really be sent, because
   * the approval email does not consult the suppression list (see this file's
   * header), so the suppressed branch of the spec's mail step is unreachable
   * until that product gap closes.
   */
  status: "verified",
  // The Approvals page is the first thing this spec drives, and only the
  // owner's own account can reach it. This harness can never make one.
  needs: { admin: true },
  /**
   * What a green run of this spec actually covers, as src/app keys. The
   * coverage guard checks each one resolves to a real route or page, so a
   * moved file fails here instead of quietly shrinking the map.
   *
   * `/api/admin/application-emails/send` and `/api/membership/me` are on the
   * list because the pages this spec drives call them without being asked to:
   * the Approvals page fires the first from its Approve handler, and the
   * profile page's membership badge fetches the second on mount.
   */
  covers: {
    routes: [
      "/api/auth/session",
      "/api/admin/application-emails/send",
      "/api/membership/me",
      "/api/subscriptions/sync",
      "/api/courses/runs/[runId]/enrol",
    ],
    pages: [
      "/(auth)/login",
      "/(app)/admin/(admin-only)",
      "/(app)/profile",
      "/(public)/courses/[courseId]",
    ],
  },
  seed,
  countRows,
  teardown,
};
