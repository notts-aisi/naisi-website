/**
 * The events RSVP smoke's fixture: one published public event, and one guest
 * address that has no account behind it.
 *
 * ## Why this spec exists
 *
 * The shared form renderer (`src/features/events/FormRenderer.tsx`) was
 * restructured in September 2026, and `docs/mobile-baseline-events.md` names
 * the public RSVP flow as the site's hard do-not-regress mobile surface while
 * also recording that the baseline is walked by hand and has an owed
 * re-verification outstanding. So this covers the two halves nobody has
 * re-checked together: a guest really can fill the form (custom question
 * included) and reach the confirmation page with a row and an email behind it,
 * and the same page really does fit a phone with its submit button reachable.
 *
 * ## No accounts at all
 *
 * The journey is a SIGNED-OUT one, which is the interesting one: an event is
 * public, a person who has never heard of NAISI opens it from a poster and
 * RSVPs. So this fixture creates no Auth user and no `users` document. What it
 * does create is an ADDRESS in the auth harness's namespace
 * (`harnessEmail()`), because everything downstream is keyed on that address:
 * the RSVP row, the confirmation email, the suppression row and every sweep in
 * teardown. An address inside the namespace is one `isHarnessAccount()` can
 * refuse to act on if a state file is ever stale or hand-edited, which is the
 * same protection the account-owning fixtures get.
 *
 * ## Suppression, and what it costs this spec
 *
 * `sendRsvpEmail()` checks the suppression list before it builds a message, so
 * a suppression row really does stop the send. Against a target whose server
 * can hand mail to Resend that is what we want: a `.invalid` address is a hard
 * bounce logged against the sending domain. Where the mail is CAUGHT (a server
 * the runner started, or the reserved harness port) suppression is off and the
 * `emailSends` row the route logs is the evidence the spec reads. The spec
 * asserts the row exists in the first case and asserts none exists in the
 * second, so neither mode is a mode where the email leg proves nothing.
 *
 * Nothing runs at import time: `core.mjs` obtains no credential until a
 * function is called, so the guard test can import this module offline.
 */
import {
  assertFixtureTarget,
  deleteQuery,
  emailDocId,
  fixtureDoc,
  fixtureId,
  fixtureQuery,
  subscriptionId,
} from "./core.mjs";
import { harnessEmail, isHarnessAccount } from "../e2e/lib/admin.mjs";

const log = (msg) => console.log(`[events-rsvp-seed] ${msg}`);

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it
 * finished and the runner checks the record against this list, so a step
 * renamed in one place and not the other fails loudly instead of quietly
 * shrinking what a green run means.
 */
export const RSVP_STEPS = [
  "the event page shows the title, the when, the where and the RSVP form",
  "a guest fills the form and lands on the confirmation page",
  "the RSVP row carries the guest's answer and the event's pending count moved",
  "the confirmation email is accounted for",
  "the event page fits a 375 by 667 phone with its submit button reachable",
  "the event page fits a 414 by 896 phone with its submit button reachable",
];

/**
 * None of them.
 *
 * Nothing on this journey presses a reCAPTCHA-gated control: the public event
 * page mounts no widget and `POST /api/events/[id]/rsvp` does not ask for a
 * token (it is rate-limited by the duplicate-RSVP refusal in its transaction
 * rather than by a captcha). So every step here runs against a deployed target
 * as well as a local one, and the list stays empty rather than being deleted:
 * the runner and the guard both read it, and the spec's skip wiring is the
 * same shape as every other spec so a future gated step is one entry away.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/**
 * The one custom question the guest answers, with a FIXED id so the spec can
 * address its control (`#q_rsvp_smoke-input`, see FormRenderer's `fieldId`)
 * without reading the seed back. Deterministic by construction, the same rule
 * the document ids follow.
 */
export const RSVP_QUESTION_ID = "q_rsvp_smoke";

/** What the question asks. Asserted on the page, so it lives in one place. */
export const RSVP_QUESTION_LABEL = "How did you hear about this event?";

/** The cap the seeded question carries, so the spec's answer can respect it. */
export const RSVP_ANSWER_MAX = 200;

/** The two mailing-list channels the RSVP form can opt somebody into. */
const OPT_IN_CHANNELS = ["events", "newsletter"];

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

/**
 * The event document. Mirrors what `normalizeEvent` expects field for field;
 * anything it would default is still written explicitly, because a fixture
 * that leans on a normaliser stops testing the shape the editor really stores.
 *
 * `status: "published"` plus `visibility: "public"` is what makes this
 * reachable signed out: `getPublishedEvent()` refuses anything that is not
 * published or cancelled, and `RsvpForm` puts a sign-in gate in front of a
 * members-only event. `capacity` is a real number with `waitlistEnabled` on so
 * the capacity fact and its waitlist note render; the counts start at zero so
 * the spec can assert the one the route moves.
 */
function eventDoc({ title, startAt, endAt, location, now, rsvpRunId }) {
  return {
    e2eRsvpRunId: rsvpRunId,
    title,
    blocks: [
      {
        id: "b1",
        // `richText` is a real BlockType and BlockView renders its html
        // directly; a type the sanitiser does not recognise is dropped, which
        // would leave the description card empty and the step asserting on it
        // failing for a reason that has nothing to do with the RSVP flow.
        type: "richText",
        html:
          "<p>This event exists only while an automated RSVP run is in flight. " +
          "If you are reading this on a live surface, a run crashed before its teardown.</p>",
      },
    ],
    startAt,
    endAt,
    location,
    // The location is shown in full: `locationHidden` would replace it with
    // `locationPublicText` on the page, and the spec asserts the where line.
    locationHidden: false,
    locationPublicText: null,
    visibility: "public",
    capacity: 20,
    waitlistEnabled: true,
    signupForm: [
      {
        id: RSVP_QUESTION_ID,
        type: "shortText",
        label: RSVP_QUESTION_LABEL,
        required: true,
        maxLength: RSVP_ANSWER_MAX,
        placeholder: "A poster, a friend, our newsletter",
      },
    ],
    foodProvenance: "none",
    foodProvenanceNote: null,
    foodText: null,
    dietaryTags: [],
    posterUrl: null,
    coverBranding: "none",
    coverLogoColor: "white",
    coverStripSize: 40,
    coverLogoPosition: "bottom",
    coverLogoScale: 100,
    coverLogoX: 90,
    coverLogoY: 86,
    coverLogoBackdrop: true,
    coverLogoShadow: true,
    archived: false,
    status: "published",
    // Nobody authored this and nobody may edit it: an empty author and no
    // collaborators is the honest fixture for an event a script created.
    authorUid: "",
    authorDisplayName: null,
    collaboratorUids: [],
    reviewerNotes: null,
    approvedBy: null,
    approvedAt: now,
    publishedAt: now,
    rsvpCountPending: 0,
    rsvpCountConfirmed: 0,
    rsvpCountWaitlisted: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: rsvpRunId, suppress = true, onState } = {}) {
  const target = assertFixtureTarget();
  const now = new Date();
  // Seconds and milliseconds zeroed so the ISO string the page renders into
  // `<time datetime>` is one the spec can construct from the state file and
  // match exactly. A Firestore Timestamp round-trips milliseconds fine; it is
  // the state file's JSON that has to agree with it, and a fixed instant is
  // one less thing to be nearly right about.
  const startAt = new Date(now.getTime() + 10 * DAY_MS);
  startAt.setSeconds(0, 0);
  const endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1000);

  const eventId = fixtureId("e2e-rsvp-event", rsvpRunId);
  const title = `E2E RSVP smoke event ${rsvpRunId}`;
  const location = "Highfield House, University Park";
  /**
   * The guest, as an address and nothing else.
   *
   * Through `harnessEmail()` so it lands inside the `e2e-<alnum>@e2e.invalid`
   * namespace every teardown helper re-checks, even though no Auth account
   * carries it: teardown sweeps the send log and the suppression row BY
   * ADDRESS, and an address outside the namespace is one `isHarnessAccount()`
   * would refuse to act on.
   */
  const guestEmail = harnessEmail(`${rsvpRunId}guest`);

  const state = {
    rsvpRunId,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    suppress,
    eventId,
    eventTitle: title,
    location,
    startAtIso: startAt.toISOString(),
    endAtIso: endAt.toISOString(),
    questionId: RSVP_QUESTION_ID,
    questionLabel: RSVP_QUESTION_LABEL,
    guestEmail,
    guestName: "E2E RSVP Guest",
    /** Written by seeding, deleted by teardown. Empty where mail is caught. */
    suppressed: [],
  };

  // Published BEFORE the first write, and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming what it
  // had created.
  onState?.(state);

  log(`Seeding fixture ${rsvpRunId} into ${target.projectId}.`);

  if (suppress) {
    // FIRST, before the event exists to RSVP to. `sendRsvpEmail()` returns
    // early on `isSuppressed()`, so this is what stops a run against a server
    // with real sender credentials handing a `.invalid` address to Resend.
    const suppressionId = emailDocId(guestEmail);
    await fixtureDoc("suppressedEmails", suppressionId).set({
      e2eRsvpRunId: rsvpRunId,
      email: guestEmail.toLowerCase(),
      reason: "bounce",
      source: "manual",
      addedAt: now,
    });
    state.suppressed.push(suppressionId);
  }

  await fixtureDoc("events", eventId).set(
    eventDoc({ title, startAt, endAt, location, now, rsvpRunId }),
  );

  log(`Seeded event ${eventId} for guest ${guestEmail}.`);
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

/**
 * Counts every row this fixture owns, seeded or route-created. Teardown is
 * only believed when this reads zero across the board.
 *
 * There are no accounts to count: this fixture creates no Auth user and no
 * `users` document, because the journey it drives is a signed-out one. The
 * guest is an address, and every row keyed on it is counted below.
 */
async function countRows(state) {
  const { eventId, guestEmail } = state;
  const counts = {};

  const eventSnap = await fixtureDoc("events", eventId).get();
  counts.events = eventSnap.exists ? 1 : 0;

  counts.eventRsvps = (
    await fixtureQuery("eventRsvps").where("eventId", "==", eventId).get()
  ).size;

  // The send log, keyed on the RECIPIENT, which is run-scoped by construction:
  // the guest address embeds the run id, so no other run and no person can own
  // one. Zero when the address is suppressed; one row per real send otherwise.
  // Nothing on this journey mails anybody but the guest, so this key sees
  // every send the run caused; a step that mailed an organiser would have to
  // be counted here by that send's own key.
  counts.emailSends = (
    await fixtureQuery("emailSends").where("to", "==", guestEmail).get()
  ).size;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  /**
   * The mailing-list opt-ins.
   *
   * The spec deliberately leaves both tick boxes alone, so these read zero on
   * every run today: `RsvpForm` only posts to `/api/subscriptions` when one is
   * ticked. They are counted anyway because the manifest's whole claim is that
   * it looked everywhere the driven routes can write, and "the checkbox
   * defaults to off" is a product decision one commit away from changing. A
   * count that only looks where rows are expected is a count that reports zero
   * by not looking.
   */
  let subscriptionRows = 0;
  let subscriptionEventRows = 0;
  for (const channel of OPT_IN_CHANNELS) {
    const subId = subscriptionId(guestEmail, channel);
    const snap = await fixtureDoc("subscriptions", subId).get();
    if (snap.exists) subscriptionRows += 1;
    subscriptionEventRows += (
      await fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId).get()
    ).size;
  }
  counts.subscriptions = subscriptionRows;
  counts.subscriptionEvents = subscriptionEventRows;

  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.rsvpRunId = state.rsvpRunId;
  return counts;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Removes everything, in the order that keeps a half-finished teardown
 * recoverable: route-created leaves first, then the fixture's own objects.
 */
async function teardown(state) {
  assertFixtureTarget();
  const { eventId, guestEmail } = state;

  // The namespace check comes FIRST, before a single delete.
  //
  // Two sweeps below are keyed on an ADDRESS out of this state file: the send
  // log and the suppression row. A tampered or stale ledger naming a real
  // person would have those rows deleted and only then reach the refusal that
  // exists to stop exactly that.
  if (!isHarnessAccount(guestEmail)) {
    throw new Error(
      `REFUSING to tear down ${guestEmail}: not a harness address. The state file names ` +
        "an address this fixture could not have created.",
    );
  }

  log(`Tearing down fixture ${state.rsvpRunId}.`);

  // Attendee rows first: they name the event, so they have to go before it.
  // Swept by `eventId` rather than by the deterministic document id, so a
  // second RSVP from a hand-driven repeat is caught as well as the spec's own.
  await deleteQuery(fixtureQuery("eventRsvps").where("eventId", "==", eventId));

  for (const channel of OPT_IN_CHANNELS) {
    const subId = subscriptionId(guestEmail, channel);
    // The event lines are addressed through the subscription row they
    // describe, so they go before it.
    await deleteQuery(
      fixtureQuery("subscriptionEvents").where("subscriptionId", "==", subId),
    );
    await fixtureDoc("subscriptions", subId).delete();
  }

  await fixtureDoc("events", eventId).delete();

  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  // The send log LAST, because the confirmation mail is fire and forget: the
  // route answers the browser and logs its row a moment later, so the later
  // this runs the smaller the window in which a row lands behind it.
  await deleteQuery(fixtureQuery("emailSends").where("to", "==", guestEmail));

  return countRows(state);
}

export const SPEC = {
  name: "events-rsvp",
  specFile: "tests/e2e/events-rsvp.spec.mjs",
  steps: RSVP_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // Nobody signs in at all, let alone as an admin: the whole point is the
  // signed-out guest path.
  needs: { admin: false },
  /**
   * What a green run of this spec actually covers, as src/app keys. The
   * coverage guard checks each one resolves to a real route or page, so a
   * moved file fails here instead of quietly shrinking the map.
   *
   * `/api/events/[id]/rsvp` is the only route the browser calls: the event
   * page and the confirmation page are both server components that read
   * Firestore through `getPublishedEvent()` rather than fetching, and the one
   * client subscription on the page (the maintenance notice) is a Firestore
   * listener, not an HTTP route.
   */
  covers: {
    routes: ["/api/events/[id]/rsvp"],
    pages: ["/(public)/events/[id]", "/(public)/events/[id]/rsvp/submitted"],
  },
  // Verified: run against the shared harness server on 6 September 2026, all
  // six steps completed, three rows before teardown and a zero manifest after.
  status: "verified",
  seed,
  countRows,
  teardown,
};
