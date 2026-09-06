/**
 * The applicant-funnel fixture on its own, for when you want to click around
 * the seeded world by hand rather than watch a browser drive it.
 *
 *   node scripts/seed-fake-applicants.mjs up --applicants 5
 *   node scripts/seed-fake-applicants.mjs status
 *   node scripts/seed-fake-applicants.mjs down
 *
 * The fixture itself lives in `scripts/e2e-fixtures/applicant-funnel.mjs` (one
 * spec module among several) and the shared floor under it in
 * `scripts/e2e-fixtures/core.mjs`. This file is the command line over both,
 * kept at its original path because it is the name in the README, in the
 * interrupted-run message, and in a year of notes.
 *
 * `npm run e2e:funnel` no longer comes through here: it is
 * `node scripts/run-e2e.mjs --spec applicant-funnel`, which seeds, drives and
 * tears down every spec it is given.
 *
 * Everything below is a re-export of the fixture's own names, so the older
 * imports (the guard test, the spec) keep working unchanged.
 */
import {
  ARTIFACTS_DIR,
  FIXTURE_COLLECTIONS,
  applicationId,
  assertFixtureCollection,
  assertFixtureTarget,
  clearState as clearFixtureState,
  cohortChannel,
  emailDocId,
  enrolmentId,
  markerPath,
  readState as readFixtureState,
  runId,
  statePath,
  subscriptionId,
  writeState as writeFixtureState,
} from "./e2e-fixtures/core.mjs";
import {
  DEFAULT_APPLICANTS,
  FUNNEL_QUESTION_ID,
  FUNNEL_STEPS,
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  WITHDRAW_WORD,
} from "./e2e-fixtures/applicant-funnel.mjs";

export {
  ARTIFACTS_DIR,
  DEFAULT_APPLICANTS,
  FIXTURE_COLLECTIONS,
  FUNNEL_QUESTION_ID,
  FUNNEL_STEPS,
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  WITHDRAW_WORD,
  applicationId,
  assertFixtureCollection,
  assertFixtureTarget,
  cohortChannel,
  emailDocId,
  enrolmentId,
  subscriptionId,
};

/** This fixture's ledger and completion marker, under `.e2e-state/`. */
export const STATE_PATH = statePath(SPEC.name);
export const MARKER_PATH = markerPath(SPEC.name);

export const readState = () => readFixtureState(SPEC.name);
export const writeState = (state) => writeFixtureState(SPEC.name, state);
export const clearState = () => clearFixtureState(SPEC.name);

/** Seeds the fixture AND writes its ledger, which is what `up` means by hand. */
export async function seedFunnelFixtures({ applicants = DEFAULT_APPLICANTS } = {}) {
  /** Published by the fixture before its first write, and mutated in place
      after, so a seed that throws half way still leaves a ledger naming what
      it had already created. Without it those rows and accounts would be on a
      shared project with nothing to tear them down by. */
  let partial = null;
  try {
    const state = await SPEC.seed({
      runId: runId(),
      // Suppress every fixture address: a hand-driven seed has no idea which
      // server will be pointed at it, so it takes the answer that cannot cause
      // mail. The runner decides differently only when it knows this run's
      // mail is caught by the Mailpit it started.
      suppress: true,
      options: { applicants },
      onState: (published) => {
        partial = published;
      },
    });
    writeState(state);
    return state;
  } catch (err) {
    if (partial) {
      writeState(partial);
      log(
        `Seeding failed part way. Its ledger is at ${STATE_PATH}: run ` +
          "`node scripts/seed-fake-applicants.mjs down` to clear what it created.",
      );
    }
    throw err;
  }
}

export const countFunnelRows = (state) => SPEC.countRows(state);

/** Tears the fixture down, and clears the ledger once the manifest reads zero. */
export async function teardownFunnelFixtures(state) {
  const counts = await SPEC.teardown(state);
  // The state file is the only way back to a fixture that did not fully
  // drain, so it survives a failed teardown for `down` to retry against.
  if (counts.total === 0) clearState();
  return counts;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[funnel-seed] ${msg}`);

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
      // Said plainly rather than printed as an empty object: "no state" is a
      // complete answer to "what is seeded right now".
      log(`No state at ${STATE_PATH}. Nothing is seeded.`);
      return 0;
    }
    console.log(JSON.stringify(await countFunnelRows(state), null, 2));
    return 0;
  }
  log(`Unknown command ${JSON.stringify(command)}. Use up, down or status.`);
  return 1;
}

// Only when run directly: the runner imports the functions above.
if (process.argv[1] && process.argv[1].endsWith("seed-fake-applicants.mjs")) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
