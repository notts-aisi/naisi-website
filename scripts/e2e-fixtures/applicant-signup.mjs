/**
 * The sign-up spec's fixture: ONE admission round, and nothing else.
 *
 * Every other browser fixture in this directory seeds the accounts its spec
 * signs in with. This one deliberately does not. The journey under test is a
 * person who has never had an account meeting NAISI for the first time on an
 * apply link, so the account has to be made BY THE PRODUCT: `/api/register`
 * creates the Auth user, the emailed magic link verifies it and mints the
 * session, `/api/register/password-set` gives it a credential, and the
 * register form's own client write creates `users/{uid}` at role `pending`.
 * A seeded account would skip all four and leave the spec proving that a form
 * renders rather than that somebody can join.
 *
 * The addresses ARE decided here, at seed time, and written to the ledger,
 * because teardown runs in the runner's process and has to be able to find
 * everything the routes created without the spec telling it anything. They are
 * the auth harness's own namespaces: `e2e-<id>@e2e.invalid` for the sign-in
 * address (RFC 2606, undeliverable everywhere) and
 * `e2e-<id>@nottingham.ac.uk` for the university address the eligibility check
 * demands, both keyed on this run's id so no other run and no person can own
 * one.
 *
 * ## Why there are no `suppressedEmails` rows here, and what stands in
 *
 * Every other fixture writes a suppression row per address before it seeds, so
 * a run against the deployed dev backend cannot hand a message to Resend. That
 * protection does NOT work on this journey and pretending otherwise would be
 * worse than not having it: `/api/register` and `/api/verify-email/send` call
 * `sendEmail()` in src/lib/email/send.ts DIRECTLY, and that function does not
 * consult the suppression list at all (only the per-feature helpers do). A
 * suppression row would therefore stop nothing while reading, to the next
 * person, like it stopped everything.
 *
 * What actually keeps this spec off a real sender is the shape of the run:
 *
 *  - Every step except the first is on `RECAPTCHA_DEPENDENT_STEPS`, so against
 *    a deployed target the whole registration leg is skipped and no route that
 *    sends is ever reached. The one step that does run is a page read.
 *  - The spec refuses to press the register button at all unless the runner
 *    said this run's mail is CAUGHT (`state.suppress === false`, which
 *    `mailIsCaught()` only answers for a server this harness started or the
 *    port reserved for one). Pointed at an ordinary `npm run dev` on :3000,
 *    which is on the target allowlist and carries the real Resend credentials,
 *    it fails loudly rather than sending.
 *  - Before the `@nottingham.ac.uk` address is typed anywhere, the spec proves
 *    a `.invalid` message really reached the local Mailpit, the same gate
 *    scripts/e2e/tests/uni-email-inbox.test.mjs applies for the same reason:
 *    a real domain must never be addressed by a server whose SMTP might be
 *    real.
 *
 * ## What it cannot drain, said out loud
 *
 * `signupMetrics` holds one shared daily counter document per date, which
 * `/api/register` increments. It is not on the fixture's collection list and
 * must not be: draining it would corrupt a real number that other runs and
 * real registrations contribute to on the same day. So a run of this spec
 * leaves the counters a fraction higher, exactly as a person clicking through
 * registration on dev does. Everything else it causes is counted below and
 * removed by teardown.
 */
import {
  assertFixtureTarget,
  countAccounts,
  deleteQuery,
  fixtureDoc,
  fixtureId,
  fixtureQuery,
  fixtureSubcollection,
  subscriptionId,
} from "./core.mjs";
import {
  deleteHarnessUser,
  deleteHarnessUserDoc,
  harnessUserByEmail,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";
import {
  deleteEmailVerificationsFor,
  deleteRegistrationRow,
} from "../e2e/lib/firestore.mjs";

const log = (msg) => console.log(`[signup-seed] ${msg}`);

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it finished
 * and the runner checks the record against this list, so a step renamed in one
 * place and not the other fails loudly instead of quietly shrinking what a
 * green run means.
 */
export const SIGNUP_STEPS = [
  "a signed-out visitor is offered sign-in and a way to join on the apply page",
  "the sign-in link leads to the login form carrying the round as its return address",
  "switching to Create account and giving an email sends the confirmation",
  "the emailed link confirms the address and asks for a password",
  "setting a password lands on the profile form already signed in",
  "the university email is verified through its own emailed link",
  "the completed profile submits and comes back to the apply page",
  "the apply page now offers the application instead of the sign-in gate",
  "the account exists at role pending and both addresses have send rows",
];

/**
 * Everything but the first step, and the reason is stronger here than on the
 * other specs.
 *
 * The obvious half is the gate itself: `/api/register` is reCAPTCHA-gated, and
 * against dev.naisi.uk Google's real widget answers headless Chromium with an
 * image challenge no spec may solve. The half that matters more is what would
 * happen if it could: this journey makes the server SEND, twice, and the
 * second send is to a `@nottingham.ac.uk` address. Against the deployed
 * backend that is a real hand-off to Resend against a real domain. So the
 * whole leg is local-mode only by construction, and the one step left running
 * against a deployed target is a page read that writes nothing.
 */
export const RECAPTCHA_DEPENDENT_STEPS = SIGNUP_STEPS.slice(1);

/**
 * The one stage question the round asks. FIXED, so the spec can address the
 * control (`#q_signup_why-input`, see FormRenderer's `fieldId`) without
 * reading the seed back. Deterministic by construction, like the doc ids.
 */
export const SIGNUP_QUESTION_ID = "q_signup_why";

/** The stages subcollection under a round. Subcollections need their own name. */
const STAGES = "stages";

/**
 * The subscription channels `/api/subscriptions/sync` writes a row per address
 * for. A RESTATEMENT of `SUBSCRIPTION_CATEGORIES` in
 * src/lib/firestore/notifications.ts, which is TypeScript and cannot be
 * imported from plain Node. `courses` is deliberately absent: it is an
 * account-level opt-out with no subscription row of its own, and the sync
 * route iterates these two only.
 */
const SUBSCRIPTION_CHANNELS = ["newsletter", "events"];

/**
 * Both fixture address namespaces, spelled out rather than prefix-matched.
 *
 * A bare `e2e-` check would also accept plausible REAL addresses
 * (`e2e-lab@gmail.com`, `e2e-society@nottingham.ac.uk`), and dev holds real
 * people's data. Mirrors `FIXTURE_ADDRESS_PATTERN` in
 * scripts/e2e/lib/firestore.mjs, which re-checks the same thing on the one
 * sweep that goes through it.
 */
const FIXTURE_ADDRESS = /^e2e-[a-z0-9]+@(e2e\.invalid|nottingham\.ac\.uk)$/;

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Civil date key "YYYY-MM-DD" in Europe/London, the shape the field wants. */
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
 * The round document, the same shape the applicant funnel seeds and for the
 * same reason: every field `normalizeAdmissionRound` would default is written
 * explicitly, because a fixture that leans on a normaliser stops testing the
 * shape the authoring route actually stores.
 *
 * Nobody staffs it. `reviewerUids` is empty and `finalDeciderUid` is null,
 * which is both the honest fixture for a round this spec never decides and the
 * shape the privilege fence requires: a harness that named a reviewer would be
 * minting a review permission.
 */
function roundDoc({ id, label, now, signupRunId }) {
  return {
    e2eSignupRunId: signupRunId,
    kind: "enrolment",
    label,
    slug: id,
    blurb:
      "A throwaway intake created by the applicant-signup end-to-end run. " +
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
function stageDoc({ roundIdValue, now, signupRunId }) {
  return {
    e2eSignupRunId: signupRunId,
    roundId: roundIdValue,
    label: "About you",
    intro: "One question, so the round has a form behind its start button.",
    questions: [
      {
        id: SIGNUP_QUESTION_ID,
        type: "longText",
        label: "Why do you want to take part?",
        required: true,
        maxLength: 500,
      },
    ],
    // Null releases with the round, which is what makes the round's start
    // button appear the moment the window opens rather than on a date.
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

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: signupRunId, suppress = true, options = {}, onState } = {}) {
  void options;
  const target = assertFixtureTarget();
  const now = new Date();

  const roundIdValue = fixtureId("e2e-signup-round", signupRunId);
  const roundLabel = `Signup intake ${signupRunId}`;

  const state = {
    signupRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    roundId: roundIdValue,
    roundLabel,
    stageId: "s1",
    questionId: SIGNUP_QUESTION_ID,
    /**
     * The two addresses the ROUTES will attach to an account that does not
     * exist yet. Written here rather than by the spec because teardown runs in
     * the runner's process and the ledger is the only thing it is handed.
     */
    loginEmail: `e2e-s${signupRunId}@e2e.invalid`,
    uniEmail: `e2e-s${signupRunId}@nottingham.ac.uk`,
    /** Chosen on the magic-link landing page. Deterministic, never logged. */
    password: `E2eSignup!${signupRunId}`,
    /**
     * The runner's answer to "would a send from this target reach a real
     * sender". FALSE means Mailpit catches it, which is the only mode this
     * spec may press its register button in; the spec asserts on it rather
     * than deciding for itself.
     */
    suppress,
  };

  // Published BEFORE the first write, and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created.
  onState?.(state);

  log(`Seeding fixture ${signupRunId} into ${target.projectId}.`);

  await fixtureDoc("admissionRounds", roundIdValue).set(
    roundDoc({ id: roundIdValue, label: roundLabel, now, signupRunId }),
  );
  await fixtureSubcollection("admissionRounds", roundIdValue, STAGES)
    .doc("s1")
    .set(stageDoc({ roundIdValue, now, signupRunId }));

  log(
    `Seeded round ${roundIdValue}. The account for ${state.loginEmail} is the ` +
      "product's to create.",
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/** Every subscription row id the sync route could mint for this run. */
function subscriptionIds(state) {
  const ids = [];
  for (const address of [state.loginEmail, state.uniEmail]) {
    for (const channel of SUBSCRIPTION_CHANNELS) {
      ids.push(subscriptionId(address, channel));
    }
  }
  return ids;
}

/**
 * Resolves the account `/api/register` created for this run's address, or null
 * before it has (and after teardown has removed it).
 *
 * `harnessUserByEmail` refuses any address outside the `.invalid` namespace,
 * so a hand-edited ledger cannot make this hand back a real person's uid.
 */
async function routeCreatedUid(state) {
  const account = await harnessUserByEmail(state.loginEmail).catch(() => null);
  return account?.uid ?? null;
}

/**
 * Counts every row this fixture owns, seeded or route-created. Teardown is
 * only believed when this reads zero across the board.
 *
 * The enumeration is deliberately of the ROUTES rather than of the seed, since
 * the seed writes two documents and the journey writes the rest: the register
 * route's Auth user, its `registrations` tracker row and its
 * `emailVerifications` token; the uni-email send's second token; the register
 * form's own `users` document; the subscriptions sync's rows and their event
 * lines; and one `emailSends` row per message. `signupMetrics` is the one
 * thing this cannot count back to zero, and the module comment says why.
 */
async function countRows(state) {
  const counts = {};
  const { roundId } = state;

  const roundSnap = await fixtureDoc("admissionRounds", roundId).get();
  counts.admissionRounds = roundSnap.exists ? 1 : 0;

  const stages = await fixtureSubcollection("admissionRounds", roundId, STAGES).get();
  counts.admissionRoundStages = stages.size;

  // Nothing on this journey presses Start, so this should always read zero.
  // Counted anyway: a manifest that only looks where it expects rows is a
  // manifest that reports zero for the one case worth catching, a stray press
  // that left an application on a round about to be deleted.
  counts.admissionApplications = (
    await fixtureQuery("admissionApplications").where("roundId", "==", roundId).get()
  ).size;

  let verifications = 0;
  for (const address of [state.loginEmail, state.uniEmail]) {
    verifications += (
      await fixtureQuery("emailVerifications").where("email", "==", address).get()
    ).size;
  }
  counts.emailVerifications = verifications;

  let subscriptions = 0;
  let subscriptionEvents = 0;
  for (const id of subscriptionIds(state)) {
    const snap = await fixtureDoc("subscriptions", id).get();
    if (snap.exists) subscriptions += 1;
    subscriptionEvents += (
      await fixtureQuery("subscriptionEvents").where("subscriptionId", "==", id).get()
    ).size;
  }
  counts.subscriptions = subscriptions;
  counts.subscriptionEvents = subscriptionEvents;

  // The send log. Keyed on the RECIPIENT, which is run-scoped by construction:
  // both addresses embed this run's id, so no other run and no person can own
  // one. Nothing on this journey mails anybody else; a step that added such a
  // send would have to count it here by that send's own key.
  let sends = 0;
  for (const address of [state.loginEmail, state.uniEmail]) {
    sends += (await fixtureQuery("emailSends").where("to", "==", address).get()).size;
  }
  counts.emailSends = sends;

  const uid = await routeCreatedUid(state);
  const registration = uid ? await fixtureDoc("registrations", uid).get() : null;
  counts.registrations = registration?.exists ? 1 : 0;

  const accounts = await countAccounts(uid ? [uid] : []);
  counts.users = accounts.users;
  counts.authAccounts = accounts.authAccounts;

  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.signupRunId = state.signupRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Removes everything, in the order that keeps a half-finished teardown
 * recoverable: route-created leaves first, then the seeded round, then the
 * account. An account deleted before its rows would leave rows nothing names,
 * because the `registrations` row and the `users` document are both addressed
 * by a uid this only knows through the Auth record.
 */
async function teardown(state) {
  assertFixtureTarget();
  log(`Tearing down fixture ${state.signupRunId}.`);
  /** Anything that refused or failed to delete, reported rather than logged
      and forgotten: a swallowed rejection here is an account or a document
      left on a shared project under a manifest that says everything went. */
  const failures = [];

  // The namespace check comes FIRST, before a single delete.
  //
  // Every sweep below is keyed on an ADDRESS out of this state file: the
  // subscription rows and their event lines, the verification tokens, the send
  // log, and the account itself. A tampered or stale ledger naming a real
  // person would otherwise have those rows deleted and only then reach the
  // refusal that exists to stop exactly that.
  if (!isHarnessAccount(state.loginEmail)) {
    throw new Error(
      `REFUSING to tear down ${state.loginEmail}: not a harness account. The state ` +
        "file names a sign-in address this fixture could not have caused.",
    );
  }
  if (!FIXTURE_ADDRESS.test(state.uniEmail ?? "")) {
    throw new Error(
      `REFUSING to tear down ${state.uniEmail}: not a fixture university address ` +
        "(e2e-<id>@nottingham.ac.uk). Real registrations keep their rows.",
    );
  }

  // Resolved before anything is removed, because both the tracker row and the
  // users document are addressed by it and `deleteHarnessUser` below takes it
  // away. Null when the register step never ran, which is the ordinary case
  // for a deployed run that skipped the whole leg.
  const uid = await routeCreatedUid(state);

  // Route-created leaves. Event lines before the subscription rows they
  // describe, since they are addressed through those rows' ids.
  for (const id of subscriptionIds(state)) {
    await deleteQuery(fixtureQuery("subscriptionEvents").where("subscriptionId", "==", id));
    await fixtureDoc("subscriptions", id).delete();
  }
  await deleteQuery(
    fixtureQuery("admissionApplications").where("roundId", "==", state.roundId),
  );
  for (const address of [state.loginEmail, state.uniEmail]) {
    // Through the auth harness's own sweeper, which re-checks the address
    // against the same two namespaces before it deletes anything.
    await deleteEmailVerificationsFor(address).catch((err) => {
      failures.push(`emailVerifications for ${address}: ${err.message}`);
    });
  }

  // The seeded objects.
  const stages = await fixtureSubcollection("admissionRounds", state.roundId, STAGES).get();
  for (const doc of stages.docs) await doc.ref.delete();
  await fixtureDoc("admissionRounds", state.roundId).delete();

  // The send log LAST of the row sweeps. Two of the three sends on this
  // journey are fire and forget from the browser's point of view (the profile
  // submit does not wait for them), so the later this runs the smaller the
  // window in which a row lands behind it.
  for (const address of [state.loginEmail, state.uniEmail]) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", address));
  }

  if (uid) {
    try {
      // The tracker row first: it is admin-facing, and its own helper re-reads
      // the row and refuses one whose email is not a harness address, so it
      // has to run while the Auth account it belongs to still exists.
      await deleteRegistrationRow(uid);
      // Then the users document, then the account. Both resolve the account BY
      // UID and re-check the namespace on the address that comes back, rather
      // than trusting the address this state file happens to sit next to.
      await deleteHarnessUserDoc(uid);
      await deleteHarnessUser(uid);
    } catch (err) {
      failures.push(`${uid}: ${err.message}`);
      log(`Could not tear down ${uid}: ${err.message}`);
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
  name: "applicant-signup",
  specFile: "tests/e2e/applicant-signup.spec.mjs",
  steps: SIGNUP_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // Nobody privileged appears in this journey: the account it creates ends at
  // role `pending`, which is where the story stops. Approving it is the
  // membership spec's business, not this one's.
  needs: { admin: false },
  /**
   * Verified: this spec ran end to end twice against the shared harness server
   * on 6 September 2026, nine of nine steps with nothing skipped, fifteen rows
   * before teardown and a manifest of zero after it.
   */
  status: "verified",
  /**
   * What a green run of this spec actually covers, as src/app keys.
   *
   * Two routes the journey really does reach are deliberately ABSENT:
   * `/api/subscriptions/sync` and `/api/admin/application-emails/send`.
   * `completeRegistration` calls both fire and forget and the page navigates
   * without reading either answer, so a 500 from one of them would leave every
   * assertion below green. The rows they write are still counted and drained
   * by the manifest, because a fixture has to remove what it causes whether or
   * not it asserts on it; claiming them as covered is the part that would be
   * untrue. Cover them when a spec reads their result on a page.
   */
  covers: {
    routes: [
      "/api/register",
      "/api/auth/session",
      "/api/register/password-set",
      "/api/register/profile-complete",
      "/api/verify-email/send",
      "/api/verify-email/reconcile",
    ],
    pages: [
      "/(public)/apply/[roundId]",
      "/(auth)/login",
      "/(auth)/register",
      "/verify-email/[tokenId]",
    ],
  },
  seed,
  countRows,
  teardown,
};
