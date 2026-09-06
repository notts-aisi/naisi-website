/**
 * The shared floor every browser end-to-end fixture stands on.
 *
 * One spec module per file beside this one, each exporting a single `SPEC`
 * object (see `applicant-funnel.mjs` for the worked example and
 * `scripts/run-e2e.mjs` for the runner that discovers them). This file holds
 * everything those modules have in common: the collection allowlist and its
 * chokepoint, the only two ways to reach Firestore, the id restatements, the
 * account helper, and where scratch files live.
 *
 * ## Why the fence lives here rather than in each module
 *
 * `tests/e2e-no-privilege-grants.test.mjs` holds the AUTH harness to three
 * Firestore collections, because that harness only ever proves things about
 * registration and the dev project holds real members' data. A browser fixture
 * needs admission rounds, course runs and the rows the routes create under
 * them, so it cannot live inside that fence without tearing the fence down.
 *
 * It therefore sits outside and carries its own fence, of the same shape,
 * asserted at runtime here and offline by `tests/funnel-harness-guards.test.mjs`:
 *
 *   - Every collection any fixture may address is a literal in
 *     `FIXTURE_COLLECTIONS`, checked by `assertFixtureCollection()` before any
 *     credential is obtained.
 *   - No fixture creates a privileged identity. Accounts are the auth
 *     harness's own `createHarnessUser` plus its `seedPendingUserDoc`, whose
 *     role is the hard-coded literal "pending". There is no code path in this
 *     tree that writes a role, a `permissions` map, `suRecognised`, or a
 *     custom claim.
 *   - Nothing here runs against a project that is not the dev project,
 *     through the auth harness's own `loadEnv()`. There is no emulator escape
 *     hatch: one keyed off FIRESTORE_EMULATOR_HOST alone would point the
 *     documents at a local database while creating the Auth accounts for real.
 *   - Every document a fixture writes is ledgered in its own state file, and
 *     teardown proves the ledger drained by counting the rows again.
 *
 * ## Nothing here runs at import time
 *
 * No `loadEnv()`, no Firestore handle, no file read. The coverage guard imports
 * every module in this directory offline, with no credentials and no env file,
 * to read its `SPEC`; a module that reached for a credential on import would
 * make that impossible and would move the project assertion out of the one
 * place it belongs.
 *
 * ## Ids are constructed, never parsed
 *
 * Every fixture id is `{slug}__{runId}`, the repo's `slugId` shape with the
 * random suffix replaced by this run's id, so a crashed run is sweepable by
 * eye and by query. Nothing here ever splits an id back apart to recover the
 * run id: the state file under `.e2e-state/` is the record, and the run id
 * field on every document is the query key.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { adminApp, adminAuth, createHarnessUser } from "../e2e/lib/admin.mjs";
import { createLedger, seedPendingUserDoc } from "../e2e/lib/firestore.mjs";
import { REPO_ROOT, loadEnv, runId } from "../e2e/lib/env.mjs";

/** Per-run id. Re-exported so a fixture module needs one import, not two. */
export { runId };

// ---------------------------------------------------------------------------
// Scratch paths
// ---------------------------------------------------------------------------

/**
 * Where every state file and completion marker lives: a directory at the repo
 * root, gitignored by name.
 *
 * NOT `.next/`, which is where the first version of this put them. `next build`
 * clears that directory (it keeps only cache, dev and lock), so a `--local` run
 * wrote its state and then had the build delete it out from under the spec,
 * which found no fixture and skipped its way to a green exit. Anything a run
 * needs to survive a build cannot live in the build output.
 */
export const STATE_DIR = join(REPO_ROOT, ".e2e-state");

/**
 * Where a spec leaves the page it was looking at when a step failed: a
 * screenshot and the page text, named after the step. Beside the state
 * directory, outside `.next/` for the same reason, and gitignored.
 */
export const ARTIFACTS_DIR = join(REPO_ROOT, ".e2e-artifacts");

/**
 * Where THIS process reads and writes its ledgers.
 *
 * The runner hands every child an `E2E_STATE_DIR`, and every helper below
 * defaults to this, so there is ONE answer to "where does a ledger live"
 * rather than one per function. An earlier draft let `statePath()` take a
 * directory while `writeState()` hard-coded `STATE_DIR`, which reads as
 * configurable and is not: a child told to use another directory would have
 * read a ledger the runner never wrote there.
 */
export function stateDir() {
  return process.env.E2E_STATE_DIR || STATE_DIR;
}

/** The ledger a spec's fixture was seeded into. One file per spec name. */
export function statePath(name, dir = stateDir()) {
  return join(dir, `${name}.state.json`);
}

/**
 * Where a spec records the steps it actually completed.
 *
 * The state file only says a fixture exists; this says a browser really drove
 * it. Without it every way a spec can decline to run (no Playwright, no
 * fixture, a skip) reads to the runner exactly like a pass, because
 * `node --test` exits 0 over a skipped file.
 */
export function markerPath(name, dir = stateDir()) {
  return join(dir, `${name}.steps.json`);
}

export function writeState(name, state, dir = stateDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(name, dir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function readState(name, dir = stateDir()) {
  try {
    return JSON.parse(readFileSync(statePath(name, dir), "utf8"));
  } catch {
    return null;
  }
}

export function clearState(name, dir = stateDir()) {
  try {
    rmSync(statePath(name, dir));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Whether this run's mail is caught
// ---------------------------------------------------------------------------

/**
 * The origin `scripts/e2e/run.mjs` binds a server it starts, and the only
 * origin whose SMTP this harness has pointed at Mailpit. Reserved for that
 * server by the target allowlist in `scripts/e2e/lib/env.mjs`.
 */
export const HARNESS_LOCAL_ORIGIN = "http://127.0.0.1:3100";

/**
 * Whether this run's mail is CAUGHT rather than sent. The fact that decides
 * whether a fixture suppresses its addresses before it seeds anything.
 *
 * A function, exported and tested behaviourally, because the shape of the
 * origin is NOT the answer and an earlier draft assumed it was. Loopback does
 * not mean caught: `http://127.0.0.1:3000` and `http://localhost:3000` are on
 * the harness target allowlist and are the ordinary `npm run dev` ports, whose
 * server reads the real Resend credentials out of `.env.local`. Mail is caught
 * only by a server this harness started (which forces the SMTP onto Mailpit),
 * or on the port reserved for one.
 *
 * Getting this wrong in the unsafe direction hands `.invalid` addresses to a
 * real sender and logs hard bounces against the sending domain, so the guard
 * test pins both answers.
 */
export function mailIsCaught({ startedByThisRun = false, origin = "" } = {}) {
  return startedByThisRun === true || origin === HARNESS_LOCAL_ORIGIN;
}

// ---------------------------------------------------------------------------
// The one skip a run may record
// ---------------------------------------------------------------------------

/**
 * The ONLY reason a spec may record for a step it declined to run, and the
 * only one the runner accepts.
 *
 * Shared rather than restated on both sides. The runner accepts a skip when
 * the step is on the spec's `recaptchaDependentSteps` AND the marker records
 * THIS reason: a step on that list skipped for some other reason (a fixture
 * the spec could not find, a locator it gave up on) is a step nobody drove,
 * and reading it as an accepted skip would let a run pass over work it never
 * did.
 */
export const RECAPTCHA_SKIP_REASON =
  "reCAPTCHA-dependent: against a deployed target Google's real widget answers headless " +
  "Chromium with an image challenge, which no spec may solve. This leg runs in --local " +
  "mode, where the widget is stubbed against the always-pass secret.";

// ---------------------------------------------------------------------------
// The collection allowlist
// ---------------------------------------------------------------------------

/**
 * Every collection any fixture in this directory may address, as string
 * literals so the offline guard can read the list off the source. Split by
 * intent: SEEDED is written by a fixture, SWEPT is only ever counted and
 * removed, because the ROUTES under test create those rows and a fixture
 * merely has to be able to prove they are gone again.
 *
 * Two collections are deliberately absent and must stay absent:
 * `signupMetrics` (shared daily counters, which cannot be drained without
 * corrupting a real number) and `users` (handled by the auth harness's guarded
 * seeder and deleter, which re-check the account namespace on every write and
 * delete, and counted by every manifest so a stranded document shows up).
 */
export const FIXTURE_COLLECTIONS = [
  // ── Seeded ────────────────────────────────────────────────────────────────
  // The course a fixture publishes so a public page exists to drive.
  "courses",
  // The run under it: enrolment window, cohort channel, week plan.
  "courseRuns",
  // Its session slots, capped small so "full" is reachable in one run.
  "courseGroups",
  // The intake an applicant applies to, with its stages subcollection.
  "admissionRounds",
  // One row per fixture address, written BEFORE anything can send, so a run
  // against the deployed dev backend cannot hand mail to Resend.
  "suppressedEmails",
  // The membership year a console spec operates on, and the rows under it.
  "membershipPeriods",
  "memberships",
  // The event an RSVP spec creates so a guest has something to book.
  "events",

  // ── Swept: created by the routes the specs drive ──────────────────────────
  "admissionApplications",
  "admissionApplicationPrivate",
  "courseEnrolments",
  "courseProgress",
  "courseAudit",
  "subscriptions",
  "subscriptionEvents",
  "tasks",
  // One document per (session, member) written by a register push.
  "courseAttendance",
  // The per-group nudge markers the push route claims before it sends. The
  // name is read off src/app/api/courses/groups/[groupId]/attendance/push/route.ts,
  // which claims `courseNudges/<groupNudgeMarkerId(...)>` with a `.create()`.
  "courseNudges",
  // The append-only send log. Previously left behind on purpose; that stance
  // is withdrawn deliberately. In local mode mail lands in Mailpit and a spec
  // asserts the rows, so the rows are the evidence, and evidence a fixture
  // creates is evidence a fixture counts back to zero.
  "emailSends",
  // Attendee rows the RSVP flow creates against a fixture event.
  "eventRsvps",
  // The magic-link tokens /api/register and /api/verify-email/send mint, and
  // the signup tracker row the register route mirrors each new account into.
  // COUNT-ONLY through this chokepoint: both are removed by the auth harness's
  // own deleteEmailVerificationsFor / deleteRegistrationRow, which re-check the
  // fixture address namespace on the row itself before deleting. They are on
  // this list because a manifest cannot report zero for a collection it has no
  // way to read.
  "emailVerifications",
  "registrations",
  // ONLY the `config/membership` document, and only through
  // `membershipConfigDoc()`. A membership spec has to move the current-period
  // pointer, so the fixture snapshots it before and restores it in teardown.
  // `fixtureDoc` refuses every other id in this collection: `config` also
  // holds the scheduler's cursors and the task email copy, and a fixture has
  // no business near either.
  "config",
];

/** The one document id any fixture may address in the `config` collection. */
export const MEMBERSHIP_CONFIG_DOC_ID = "membership";

/**
 * Subcollections a fixture may reach off a document the chokepoint produced.
 *
 * A subcollection is inside the fence rather than a way around it (the parent
 * document reference has already been checked), but the name still has to be
 * on a list, because "anything under a fixture document" would readmit every
 * collection through a path the allowlist cannot see.
 */
// "stages": the questions of an admission round. "weeks": a run's curriculum,
// which the register push reads before it will mail a group about the next
// session (it refuses to send when that week is missing or unpublished).
export const FIXTURE_SUBCOLLECTIONS = ["stages", "weeks"];

/**
 * The allowlist check, as a function rather than a source grep.
 *
 * The auth harness proves its own fence by grepping for `.collection("literal")`
 * and refusing a dynamic name. That works there because it reaches three
 * collections; here it would mean twenty near-identical branches, and a
 * twenty-branch switch is a place a twenty-first gets added without anybody
 * noticing. So the ban moves from the spelling to the VALUE: one checked
 * chokepoint, called before any credential is obtained (note it throws before
 * `db()`), and `tests/funnel-harness-guards.test.mjs` calls THIS function with
 * live collection names rather than pattern-matching the source.
 */
export function assertFixtureCollection(collection) {
  if (!FIXTURE_COLLECTIONS.includes(collection)) {
    throw new Error(
      `REFUSING to touch collection ${JSON.stringify(collection)}. An e2e fixture ` +
        `may only reach ${FIXTURE_COLLECTIONS.join(", ")}.`,
    );
  }
  return collection;
}

/** The same check, for a subcollection reached off a fixture document. */
export function assertFixtureSubcollection(collection) {
  if (!FIXTURE_SUBCOLLECTIONS.includes(collection)) {
    throw new Error(
      `REFUSING to touch subcollection ${JSON.stringify(collection)}. An e2e fixture ` +
        `may only reach ${FIXTURE_SUBCOLLECTIONS.join(", ")} under a fixture document.`,
    );
  }
  return collection;
}

let dbHandle = null;

function db() {
  if (!dbHandle) dbHandle = getFirestore(adminApp());
  return dbHandle;
}

/**
 * The ONLY way any fixture addresses a document.
 *
 * `config` is narrowed further: the collection is server-only runtime config
 * shared by the scheduler, the task emails and the membership console, and the
 * only document a fixture has business touching is the membership pointer it
 * has to put back. Everything else there is somebody's live configuration.
 */
export function fixtureDoc(collection, id) {
  assertFixtureCollection(collection);
  if (collection === "config" && id !== MEMBERSHIP_CONFIG_DOC_ID) {
    throw new Error(
      `REFUSING to address config/${String(id)}. The only config document an e2e ` +
        `fixture may reach is ${MEMBERSHIP_CONFIG_DOC_ID}, through membershipConfigDoc(), ` +
        "and only to snapshot it before a spec moves it and restore it afterwards.",
    );
  }
  return db().collection(collection).doc(id);
}

/** The ONLY way any fixture queries a collection. */
export function fixtureQuery(collection) {
  assertFixtureCollection(collection);
  if (collection === "config") {
    throw new Error(
      "REFUSING to query the config collection. A query would list every runtime " +
        `config document; a fixture may only address ${MEMBERSHIP_CONFIG_DOC_ID}, ` +
        "through membershipConfigDoc().",
    );
  }
  return db().collection(collection);
}

/** The ONLY way any fixture reaches a subcollection under a fixture document. */
export function fixtureSubcollection(parentCollection, parentId, collection) {
  assertFixtureSubcollection(collection);
  return fixtureDoc(parentCollection, parentId).collection(collection);
}

/**
 * The current-period pointer, and the only permitted way to address `config`.
 *
 * A membership spec has to point the console at the period it seeded, which
 * means writing this document. It is real configuration on a shared project,
 * so the fixture reads it first, keeps the value in its state file, and puts
 * it back in teardown.
 */
export function membershipConfigDoc() {
  return fixtureDoc("config", MEMBERSHIP_CONFIG_DOC_ID);
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

/** Deletes every document a query returns, and says how many that was. */
export async function deleteQuery(query) {
  const snap = await query.get();
  for (const doc of snap.docs) await doc.ref.delete();
  return snap.size;
}

// ---------------------------------------------------------------------------
// Ids: restatements of what the routes compute
// ---------------------------------------------------------------------------

/** `{slug}__{runId}`: the repo's slugId shape with a per-run suffix. */
export function fixtureId(slug, id) {
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
// Accounts
// ---------------------------------------------------------------------------

/**
 * One throwaway account: an Auth user in the harness namespace, the `users`
 * document the auth harness's guarded seeder writes at role `pending` (current
 * on the policy version unless `legacyConsent` is asked for), and (by default)
 * a suppression row for its address.
 *
 * `suppress` defaults to TRUE because that is the safe answer: a send to a
 * `.invalid` address is still a real hand-off to Resend and a hard bounce
 * logged against the sending domain, so seeding writes the suppression row
 * FIRST and nothing this run drives can post mail.
 *
 * The runner passes FALSE only when this run's mail is CAUGHT: a server it
 * started itself through `scripts/e2e/run.mjs`, which points the SMTP at
 * Mailpit on this machine. There the specs want the mail, because an
 * `emailSends` row is how a spec proves a route really sent and a suppressed
 * address produces no row to look at. `emailSends` is on the fixture's own
 * collection list precisely so those rows are counted back to zero afterwards.
 *
 * NOT "whenever the origin is loopback", which is what an earlier draft said.
 * `http://127.0.0.1:3000` and `http://localhost:3000` are on the harness
 * target allowlist and are the ordinary `npm run dev` ports, whose server
 * reads the REAL Resend credentials out of `.env.local`. A run pointed there
 * with suppression off would hand `.invalid` addresses to a real sender.
 */
export async function createFixtureUser({
  runId: fixtureRunId,
  index,
  password,
  suppress = true,
  legacyConsent = false,
}) {
  // The auth harness's ledger is in-memory and this process may not be the one
  // that tears down, so the ledger is not the record: teardown deletes each
  // document by address, under the namespace check on the account it belongs
  // to, and every manifest counts what is left. The ledger is required by
  // `seedPendingUserDoc`'s signature and is deliberately dropped here.
  const ledger = createLedger();
  // `harnessEmail` enforces the `e2e-<alnum>@e2e.invalid` namespace that every
  // teardown helper in the auth harness re-checks. The id is lowercase
  // alphanumeric by construction: a base36 run id plus an index.
  const account = await createHarnessUser(`f${fixtureRunId}${index}`, {
    emailVerified: true,
    // A real password, so a spec signs in through the REAL /login form rather
    // than being handed a cookie. That is the difference between proving a
    // journey works and proving the routes behind it do: the session cookie
    // alone leaves every client island in its signed-out branch.
    password,
  });
  // `legacyConsent` seeds the document WITHOUT a policy version, the shape
  // of a member from before the field existed, so the account meets the
  // re-consent gate on a production build. Off by default: only a spec that
  // means to drive the gate asks for it. See `seedPendingUserDoc`.
  await seedPendingUserDoc(ledger, {
    uid: account.uid,
    email: account.email,
    universityEmail: "",
    legacyConsent,
  });
  let suppressionId = null;
  if (suppress) {
    suppressionId = emailDocId(account.email);
    await fixtureDoc("suppressedEmails", suppressionId).set({
      e2eFixtureRunId: fixtureRunId,
      email: account.email.toLowerCase(),
      reason: "bounce",
      source: "manual",
      addedAt: new Date(),
    });
  }
  void ledger;
  return { uid: account.uid, email: account.email, password, suppressionId };
}

/**
 * The two rows a fixture account leaves behind that live OUTSIDE the fixture
 * collection list, and the two a teardown is most likely to strand: a `users`
 * document is a ghost member in the admin list, and a live Auth account can
 * still sign in. Counting only the declared collections meant a teardown that
 * failed to remove either still reported a clean total of zero, which is the
 * one number this whole harness asks anybody to trust.
 */
export async function countAccounts(uids) {
  let users = 0;
  for (const uid of uids) {
    const snap = await db().collection("users").doc(uid).get();
    if (snap.exists) users += 1;
  }
  let authAccounts = 0;
  for (const uid of uids) {
    try {
      await adminAuth().getUser(uid);
      authAccounts += 1;
    } catch {
      // Not found is the wanted state after teardown, and the only error the
      // Admin SDK raises for an id that is simply gone.
    }
  }
  return { users, authAccounts };
}
