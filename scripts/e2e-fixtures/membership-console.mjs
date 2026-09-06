/**
 * The membership console's fixture: one throwaway account for an admin to
 * record a membership against, and a snapshot of the one document on the dev
 * project this spec is allowed to move.
 *
 * The period itself is NOT seeded. Creating it is the first thing the journey
 * does, through the console, because "an admin can create a membership period"
 * is one of the two things this spec is here to prove. So the period is a
 * ROUTE-CREATED row that the manifest below counts and teardown sweeps, keyed
 * on a label this fixture chose.
 *
 * ## The dangerous part, said plainly
 *
 * "Make current" rewrites `config/membership`, and that pointer is what every
 * membership badge on the dev site reads: the console's own Current chip, the
 * chips on the admin Members rows, and `GET /api/membership/me`. It is real
 * configuration on a project other people are using while this runs.
 *
 * So the fixture treats it as borrowed rather than as its own:
 *
 *  - `seed()` SNAPSHOTS the document before anything is written, through
 *    `membershipConfigDoc()`, which is the only way into the `config`
 *    collection this harness has (`fixtureDoc` refuses every other id there,
 *    and `fixtureQuery("config")` refuses outright).
 *  - The snapshot goes in the state file, so the process that tears down is
 *    never a different process with a different idea of what was there.
 *    Firestore values do not survive JSON on their own, so they are encoded
 *    field by field and decoded back; a value this fixture cannot encode makes
 *    seeding REFUSE rather than promise a restore it cannot perform.
 *  - `teardown()` puts it back with a full `set()` (never a merge, which would
 *    leave this run's `updatedAt` and `updatedByUid` behind), or DELETES the
 *    document when there was none before.
 *  - `countRows()` counts 1 while the live pointer differs from the snapshot,
 *    so a run that moved the pointer and failed to move it back cannot report
 *    a manifest of zero. That is the number the runner's exit code is built
 *    on, and a pointer left on a fixture period is exactly the kind of damage
 *    a manifest reading zero must never hide.
 *
 * ## The period id is a YEAR, so it cannot carry the run id
 *
 * `POST /api/admin/membership/periods` derives the document id from the
 * academic year (`2094/95` becomes `2094-95`) and writes with `create()`, so
 * the id is not this fixture's to namespace. It uses a year far enough out
 * that no real period can collide with it, and the LABEL carries the run id,
 * which is what teardown sweeps on. A document already sitting at that id is
 * dealt with before anything is written: cleared when its label says a
 * previous run of this fixture made it, refused loudly when it does not.
 *
 * ## Nothing here sends mail
 *
 * `POST /api/admin/membership/grant` writes a row, a cache entry and two
 * counters, and sends nothing; neither does the periods route or the current
 * route. The `emailSends` sweep below is therefore expected to find nothing,
 * and it runs anyway: a route that grows a notification email later should
 * show up in this manifest rather than as rows nobody counted.
 *
 * The manifest alone would not be enough to SAY that, though. Teardown sweeps
 * `emailSends` for the fixture address before the runner takes its only
 * enforced count, so a notification added to the grant route later would be
 * created and swept with a manifest still reading zero. The spec therefore
 * asserts the absence itself, in both suppression modes, as its last step: a
 * membership recorded by an admin is not news to the member, and the day that
 * changes it should be a decision somebody made rather than a send nobody
 * noticed.
 */
import { Timestamp } from "firebase-admin/firestore";
import {
  assertFixtureTarget,
  countAccounts,
  createFixtureUser,
  deleteQuery,
  fixtureDoc,
  fixtureQuery,
  membershipConfigDoc,
} from "./core.mjs";
import {
  deleteHarnessUser,
  deleteHarnessUserDoc,
  isHarnessAccount,
} from "../e2e/lib/admin.mjs";

const log = (msg) => console.log(`[membership-seed] ${msg}`);

/**
 * Every step the spec must complete, in order.
 *
 * Shared rather than restated on both sides: the spec records what it
 * finished, the runner checks that record against this list, and a guard test
 * pins the two together, so a step renamed in one place fails loudly instead
 * of quietly shrinking what a green run means.
 */
export const MEMBERSHIP_STEPS = [
  "the admin signs in and opens the membership console",
  "creating a period puts it on the list",
  "making it current moves the pointer",
  "the switcher shows the new period as the current one",
  "the table lists the seeded account with nothing recorded",
  "recording a tier badges the member and moves the period's count",
  "the membership row and the cached year are in Firestore",
  "taking the membership away clears the badge and the count",
  "the revoke removed the row and the cached year",
  "the pointer goes back where it came from",
  "nothing on the journey emailed the member",
];

/**
 * None of it is reCAPTCHA-gated.
 *
 * Every route this spec drives is an admin route behind a session cookie:
 * `/api/admin/membership/{periods,current,grant,list}`. The sign-in form is
 * not gated either (the applicant funnel signs in outside its gated set for
 * the same reason). So this spec runs in full against a deployed target as
 * well as against a local server, and an empty list here says so.
 */
export const RECAPTCHA_DEPENDENT_STEPS = [];

/**
 * The academic year the console spec creates.
 *
 * Deliberately absurd. The document id is derived from it, so it is the one
 * id in this fixture that cannot carry the run id, and the only protection
 * against colliding with a period somebody really keeps is to be nowhere near
 * a real one. `ACADEMIC_YEAR_PATTERN` in src/lib/firestore/users.ts is
 * `\d{4}/\d{2}`, which this matches.
 */
export const FIXTURE_PERIOD_YEAR = "2094/95";

/** `periodIdForYear` from src/lib/firestore/memberships.ts, restated. */
export function periodIdForYear(year) {
  return year.replace("/", "-");
}

/**
 * The start of every label this fixture writes, and the thing that makes a
 * leftover period identifiable as ours before the run id is even read. The
 * full label adds the run id and is what teardown sweeps on.
 */
export const PERIOD_LABEL_PREFIX = "E2E membership console";

/** The tier the spec records and then takes away. */
export const FIXTURE_TIER = "paid";

/** `membershipId` from src/lib/firestore/memberships.ts, restated for Node. */
export function membershipRowId(uid, periodId) {
  return `${uid}__${periodId}`;
}

// ---------------------------------------------------------------------------
// The borrowed pointer document
// ---------------------------------------------------------------------------

/**
 * One Firestore value as something JSON can hold, and hand back unchanged.
 *
 * The state file is JSON and may be read by a different process from the one
 * that wrote it, so a `Timestamp` that went through `JSON.stringify` would
 * come back as `{_seconds, _nanoseconds}` and be RESTORED as a map. That is
 * not a restore: `config/membership.updatedAt` would stop being a timestamp
 * for every reader on the project.
 *
 * A value this cannot encode THROWS, and seeding stops before it has written
 * anything. Refusing to start is the honest answer to "I cannot promise to put
 * this document back the way I found it".
 */
function encodeStored(value, path) {
  if (value === null || value === undefined) return { t: "null" };
  if (typeof value === "string") return { t: "string", v: value };
  if (typeof value === "number") return { t: "number", v: value };
  if (typeof value === "boolean") return { t: "boolean", v: value };
  if (value instanceof Timestamp) {
    return { t: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof Date) return { t: "date", v: value.toISOString() };
  if (Array.isArray(value)) {
    return { t: "array", v: value.map((entry, i) => encodeStored(entry, `${path}[${i}]`)) };
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = encodeStored(entry, `${path}.${key}`);
    }
    return { t: "map", v: out };
  }
  throw new Error(
    `REFUSING to seed: config/membership carries a value at ${path} this fixture ` +
      "cannot encode, so it could not promise to put the document back byte for " +
      "byte after moving the current-period pointer. Extend encodeStored/decodeStored " +
      "in scripts/e2e-fixtures/membership-console.mjs for that type, deliberately.",
  );
}

/** The inverse, so what goes back is what came out. */
function decodeStored(encoded) {
  switch (encoded?.t) {
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
      return encoded.v;
    case "timestamp":
      return new Timestamp(encoded.seconds, encoded.nanoseconds);
    case "date":
      return new Date(encoded.v);
    case "array":
      return encoded.v.map((entry) => decodeStored(entry));
    case "map": {
      const out = {};
      for (const [key, entry] of Object.entries(encoded.v)) out[key] = decodeStored(entry);
      return out;
    }
    default:
      throw new Error(
        `Cannot decode a stored value of kind ${JSON.stringify(encoded?.t)} out of the ` +
          "state file. The ledger was written by a different version of this fixture.",
      );
  }
}

/** Encoded document, or null when there is no document at all. */
async function readPointer() {
  const snap = await membershipConfigDoc().get();
  if (!snap.exists) return null;
  return encodeStored(snap.data() ?? {}, "config/membership");
}

/**
 * JSON with object keys in a fixed order, so "is the pointer back where it
 * was" is a question about VALUES. Firestore does not promise to hand a
 * document's fields back in the order they were written, and a comparison that
 * cared would report a document nobody touched as moved.
 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed({ runId: fixtureRunId, suppress = true, onState } = {}) {
  const target = assertFixtureTarget();
  const periodYear = FIXTURE_PERIOD_YEAR;
  const periodId = periodIdForYear(periodYear);
  const periodLabel = `${PERIOD_LABEL_PREFIX} ${fixtureRunId}`;

  // READS BEFORE WRITES, and before `onState` is even called: nothing below
  // this block has changed anything, so a refusal here leaves the project
  // exactly as it was found.
  const pointerBefore = await readPointer();
  const pointerNow = pointerBefore ? decodeStored(pointerBefore).currentPeriodId : null;
  if (pointerNow === periodId) {
    throw new Error(
      `REFUSING to seed: config/membership already points at ${periodId}, the period ` +
        "this fixture is about to create. That means an earlier run made it current " +
        "and crashed before putting the pointer back, and seeding on top would record " +
        "a fixture period as the state to restore. Make a real period current in the " +
        "console (or clear the pointer), then run this again.",
    );
  }

  // A leftover period at the same id, from a run that crashed and lost its
  // ledger. Cleared only when its LABEL says this fixture wrote it; a real
  // period at that id is a refusal, because the route creates with `create()`
  // and a run that deleted somebody's period to get past a 409 would be
  // exactly the kind of sweep this harness promises never to perform.
  const existing = await fixtureDoc("membershipPeriods", periodId).get();
  if (existing.exists) {
    const label = existing.data()?.label;
    if (typeof label !== "string" || !label.startsWith(PERIOD_LABEL_PREFIX)) {
      throw new Error(
        `REFUSING to seed: membershipPeriods/${periodId} already exists and its label ` +
          `(${JSON.stringify(label)}) is not one this fixture wrote. The console creates ` +
          "that document with create(), so this run would fail at its second step. It is " +
          "either somebody's real period at an absurd year, or one of this fixture's own " +
          `whose label never took (the route defaults to "Membership ${periodYear}" when ` +
          "the field arrives empty). Look at it by hand rather than having an automated " +
          "run delete it.",
      );
    }
    log(`Clearing a period left behind by an earlier run: ${periodId} (${label}).`);
    await deleteQuery(fixtureQuery("memberships").where("periodId", "==", periodId));
    await fixtureDoc("membershipPeriods", periodId).delete();
  }

  const state = {
    fixtureRunId,
    projectId: target.projectId,
    createdAt: new Date().toISOString(),
    /** Read from the runner, never decided here: false only when this run's
        mail is caught by Mailpit. Nothing on this spec's paths sends, so it
        changes what the manifest EXPECTS rather than what it counts. */
    suppress,
    periodYear,
    periodId,
    periodLabel,
    /**
     * The two reads above proved membershipPeriods/{periodId} holds nothing:
     * it was empty, or it was this fixture's own leftover and has just been
     * deleted. So a document sitting at that address when the run ends was
     * created by this run, whatever label it carries, and teardown may delete
     * it by address rather than only by the label it asked the console for.
     * That is the difference between sweeping the period and sweeping the
     * period THIS RUN MADE, and it is what makes a label that never took
     * (the route falls back to "Membership {year}") a counted row rather than
     * a document stranded under a manifest reading zero.
     */
    periodIdWasEmptyAtSeed: true,
    tier: FIXTURE_TIER,
    /** The pointer as found: an encoded document, or null when there was none. */
    pointerBefore,
    /** Where the pointer pointed when this run started, so the spec can offer
        it back through the console rather than only in teardown. */
    previousPeriodId: pointerNow,
    /** That period's label, read now so the spec can find its row on the page.
        Empty when there was no pointer or the period it named is gone. */
    previousPeriodLabel: "",
    member: null,
    /** Suppression rows written by seeding. Empty when mail is caught. */
    suppressed: [],
  };

  // Published BEFORE the first write and mutated in place from here on, so a
  // seed that throws half way still leaves the runner a ledger naming
  // everything it had created.
  onState?.(state);

  if (pointerNow) {
    const previous = await fixtureDoc("membershipPeriods", pointerNow).get();
    if (previous.exists) {
      const data = previous.data() ?? {};
      state.previousPeriodLabel =
        (typeof data.label === "string" && data.label) ||
        (typeof data.year === "string" ? data.year : "");
    }
  }

  log(`Seeding fixture ${fixtureRunId} into ${target.projectId}.`);

  const password = `E2eMembership!${fixtureRunId}0`;
  const account = await createFixtureUser({
    runId: fixtureRunId,
    index: 0,
    password,
    suppress,
  });
  if (account.suppressionId) state.suppressed.push(account.suppressionId);
  state.member = {
    uid: account.uid,
    email: account.email,
    password: account.password,
  };

  log(
    `Seeded one account for period ${periodId} (${periodLabel}). The pointer was ` +
      `${pointerNow ? `at ${pointerNow}` : "unset"} and will be put back there.`,
  );
  return state;
}

// ---------------------------------------------------------------------------
// Counting: the manifest that must read zero
// ---------------------------------------------------------------------------

async function countRows(state) {
  const counts = {};
  const uids = state.member ? [state.member.uid] : [];

  // The period the CONSOLE created, counted twice over.
  //
  // First by the label this fixture chose, which is the key teardown sweeps on
  // and the only one that would find a period the console wrote at an id this
  // fixture did not predict.
  //
  // Then by ADDRESS, because the label is not this fixture's to guarantee: it
  // is typed into a form by a browser, and a fill that did not take leaves the
  // route's own "Membership {year}" default on the document instead. A sweep
  // keyed only on the label walks straight past that, and the manifest reads
  // zero over a period nobody deleted. The addressed read is safe to count
  // because seeding proved the address was empty first (see
  // `periodIdWasEmptyAtSeed`), so anything there now is this run's.
  const byLabel = await fixtureQuery("membershipPeriods")
    .where("label", "==", state.periodLabel)
    .get();
  const addressed = await fixtureDoc("membershipPeriods", state.periodId).get();
  const addressedLabel = addressed.exists ? addressed.data()?.label : null;
  counts.membershipPeriods =
    byLabel.size + (addressed.exists && addressedLabel !== state.periodLabel ? 1 : 0);

  // Every membership row against that period. There can only be one (the
  // fixture account's), and the query rather than the addressed read is
  // deliberate: a grant the spec made against a row it did not expect would
  // show up here rather than being left behind.
  counts.memberships = (
    await fixtureQuery("memberships").where("periodId", "==", state.periodId).get()
  ).size;

  // THE BORROWED POINTER. One while the live document differs from the
  // snapshot in the ledger, which is the whole reason this fixture is allowed
  // near the `config` collection at all. During the run it reads 1, on purpose:
  // that is the evidence the console really moved it.
  const pointerNow = await readPointer();
  counts.membershipPointer =
    stableJson(pointerNow) === stableJson(state.pointerBefore ?? null) ? 0 : 1;

  let suppressionRows = 0;
  for (const id of state.suppressed ?? []) {
    const snap = await fixtureDoc("suppressedEmails", id).get();
    if (snap.exists) suppressionRows += 1;
  }
  counts.suppressedEmails = suppressionRows;

  // Nothing on this spec's paths sends mail (the grant, periods and current
  // routes import no email helper). Counted anyway: a send added to one of
  // them later belongs in this manifest rather than in rows nobody sweeps.
  let sendRows = 0;
  if (state.member) {
    sendRows += (
      await fixtureQuery("emailSends").where("to", "==", state.member.email).get()
    ).size;
  }
  counts.emailSends = sendRows;

  const accounts = await countAccounts(uids);
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
  // sweep below is keyed on an ADDRESS out of this state file, so a tampered
  // or stale ledger naming a real person would otherwise have rows deleted
  // before reaching the refusal that exists to stop exactly that.
  for (const account of [state.member].filter(Boolean)) {
    if (!isHarnessAccount(account.email)) {
      throw new Error(
        `REFUSING to tear down ${account.email}: not a harness account. The state file ` +
          "names an address this fixture could not have created.",
      );
    }
  }

  log(`Tearing down fixture ${state.fixtureRunId}.`);

  // THE POINTER GOES BACK FIRST, while the period it may be naming still
  // exists. A pointer left at a deleted document reads as "no current period"
  // to every badge on the site, which is a worse state than the one this run
  // borrowed, and it would be the state dev sat in for however long the rest
  // of this teardown took.
  try {
    if (state.pointerBefore) {
      // A full set(), never a merge: the console's write added `updatedAt` and
      // `updatedByUid`, and merging the snapshot over the top would leave this
      // run's fingerprints on a document it only borrowed.
      await membershipConfigDoc().set(decodeStored(state.pointerBefore));
    } else {
      // There was no document before this run. The console created it, so it
      // goes, rather than being left holding a pointer at a period that is
      // about to be deleted.
      await membershipConfigDoc().delete();
    }
  } catch (err) {
    failures.push(`config/membership: ${err.message}`);
    log(`Could not restore the current-period pointer: ${err.message}`);
  }

  // Route-created leaves first: the membership rows the grant wrote, then the
  // period they hang off. The rows go by `periodId`, which no browser typed,
  // so they are swept whatever the period's label ended up saying.
  await deleteQuery(fixtureQuery("memberships").where("periodId", "==", state.periodId));
  await deleteQuery(
    fixtureQuery("membershipPeriods").where("label", "==", state.periodLabel),
  );

  // Then the period at the ADDRESS, for the run where the label never took.
  // Deleted on the strength of the seed's own check: it proved that address
  // was empty before the first write, so a document there now is this run's.
  // A state file that cannot make that claim (an older ledger, a hand-edited
  // one) falls back to the label prefix, and refuses out loud rather than
  // deleting a period it cannot show it created.
  const strayPeriod = await fixtureDoc("membershipPeriods", state.periodId).get();
  if (strayPeriod.exists) {
    const strayLabel = strayPeriod.data()?.label;
    const isOurs =
      state.periodIdWasEmptyAtSeed === true ||
      (typeof strayLabel === "string" && strayLabel.startsWith(PERIOD_LABEL_PREFIX));
    if (isOurs) {
      log(
        `Deleting membershipPeriods/${state.periodId} by address: its label ` +
          `(${JSON.stringify(strayLabel)}) is not the one this run asked for.`,
      );
      await fixtureDoc("membershipPeriods", state.periodId).delete();
    } else {
      failures.push(
        `membershipPeriods/${state.periodId}: left in place. Its label ` +
          `(${JSON.stringify(strayLabel)}) is not one this fixture wrote and this state ` +
          "file cannot show the address was empty when the run started, so deleting it " +
          "would be a sweep of somebody else's period. Look at it by hand.",
      );
      log(`Refusing to delete membershipPeriods/${state.periodId}: not provably this run's.`);
    }
  }

  if (state.member) {
    await deleteQuery(fixtureQuery("emailSends").where("to", "==", state.member.email));
  }
  for (const id of state.suppressed ?? []) {
    await fixtureDoc("suppressedEmails", id).delete();
  }

  for (const account of [state.member].filter(Boolean)) {
    // The users document first: an Auth account whose document outlives it is
    // a ghost row in the admin members list. Both deletes resolve the account
    // BY UID and re-check the namespace on the address Auth hands back, rather
    // than trusting the address this state file happens to sit next to.
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
    counts.teardownFailures = failures;
    counts.total += failures.length;
  }
  return counts;
}

export const SPEC = {
  name: "membership-console",
  specFile: "tests/e2e/membership-console.spec.mjs",
  steps: MEMBERSHIP_STEPS,
  recaptchaDependentSteps: RECAPTCHA_DEPENDENT_STEPS,
  // Every surface here is admin-only, and this harness may never create an
  // admin: the account is the owner's own, out of .env.e2e.secrets.local.
  needs: { admin: true },
  // Verified: run on 6 September 2026 against the shared harness server on
  // http://127.0.0.1:3100 (project naisi-website-dev), eleven of eleven steps,
  // four rows before teardown and a manifest of zero after it. The address-keyed
  // half of the period sweep was proved separately, by making the label fill
  // fail on purpose: the console wrote its own "Membership 2094/95" default,
  // the manifest counted the period anyway and teardown deleted it by address.
  status: "verified",
  /**
   * Every route this spec presses, and the one it only brushes.
   *
   * NOT claimed, deliberately: `GET /api/admin/membership/import`. The console
   * renders `ImportPanel` under whichever period is being viewed, and that
   * panel asks on mount for the imports still open on it, so this spec does
   * cause that request. It is not covered by it. Nothing here uploads a file,
   * commits a batch or reads what came back: the panel treats a list that will
   * not load as "nothing to resume" and carries on. The risk in that route is
   * the column matching against a real Students' Union export, which is
   * exactly what the NOT_COVERED entry in tests/e2e-coverage-map.test.mjs says
   * is unexercised, and claiming the key here would trade a written-down gap
   * for a green tick nobody earned.
   */
  covers: {
    routes: [
      "/api/auth/session",
      "/api/admin/membership/periods",
      "/api/admin/membership/current",
      "/api/admin/membership/list",
      "/api/admin/membership/grant",
    ],
    pages: ["/(auth)/login", "/(app)/admin/membership"],
  },
  seed,
  countRows,
  teardown,
};
