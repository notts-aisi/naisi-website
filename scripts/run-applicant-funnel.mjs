/**
 * `npm run e2e:funnel` - the whole applicant funnel in one command.
 *
 *   seed a throwaway world -> drive it in Chromium -> tear it down ->
 *   prove the fixture manifest reads zero
 *
 * Two modes, mirroring the auth harness exactly:
 *
 *   npm run e2e:funnel              against the DEPLOYED dev backend
 *   npm run e2e:funnel -- --local   against a server this run starts itself
 *
 * ## Teardown is unconditional, and the manifest is the proof
 *
 * The seed exists on a shared dev project, so a run that leaves rows behind is
 * a run that has polluted a real environment: a live-looking admission round
 * on the catalogue, a pre-course nobody scheduled, accounts in the admin
 * members list. Teardown therefore runs in a `finally`, on a failure, and on
 * SIGINT and SIGTERM, and the exit code carries BOTH verdicts: a green suite
 * whose teardown left rows behind still exits non-zero, because the second
 * fact is as much a defect as the first.
 *
 * ## What it deliberately does not do
 *
 * It does not install Playwright, and it does not add it to `package.json`.
 * The root manifest is what App Hosting runs `npm ci` against on the critical
 * path of every production deploy, and a browser automation library plus a
 * downloaded Chromium has no business on that path (the same argument that
 * put `scripts/rules-tests` in its own package). So the runner CHECKS for
 * Playwright and REFUSES to run without it, printing the one-line install.
 *
 * ## A run that drove no browser is a failure
 *
 * Everything the spec can do short of running exits `node --test` at 0: a
 * missing Playwright, a missing fixture, a skip. Three separate ways to get a
 * green command that opened nothing. So the spec writes a completion marker
 * naming the steps it finished, this file deletes that marker before the run,
 * and success requires it back with every step in `FUNNEL_STEPS` on it.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DEFAULT_APPLICANTS,
  FUNNEL_STEPS,
  MARKER_PATH,
  RECAPTCHA_DEPENDENT_STEPS,
  STATE_PATH,
  assertFixtureTarget,
  countFunnelRows,
  readState,
  seedFunnelFixtures,
  teardownFunnelFixtures,
} from "./seed-fake-applicants.mjs";
import { REPO_ROOT } from "./e2e/lib/env.mjs";

const SPEC = "tests/e2e/applicant-funnel.spec.mjs";
const LOCAL_ORIGIN = "http://127.0.0.1:3100";

const log = (msg) => console.log(`[e2e:funnel] ${msg}`);

function parseArgs(raw) {
  const at = raw.indexOf("--applicants");
  return {
    local: raw.includes("--local"),
    skipBuild: raw.includes("--skip-build"),
    applicants: at === -1 ? DEFAULT_APPLICANTS : Number(raw[at + 1]),
  };
}

const argv = parseArgs(process.argv.slice(2));

/**
 * Resolves Playwright without importing it, so a missing install is a printed
 * sentence rather than a stack trace. FATAL: a run that cannot open a browser
 * has nothing to say about the funnel, and seeding a throwaway world on a
 * shared project to prove that is not worth the rows.
 */
function playwrightPresent() {
  try {
    createRequire(import.meta.url).resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

function spawnP(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

/**
 * Local mode delegates the whole server bootstrap to `scripts/e2e/run.mjs`:
 * the loopback bind, the always-pass captcha secret, the Mailpit SMTP
 * override, the effective-environment dev assertion and the build marker.
 * `E2E_TEST_PATHS` is the one hook it needed, and it defaults to the auth
 * batteries so nothing about `npm run e2e:local` changed.
 */
function runLocal() {
  log(`Starting the local server on ${LOCAL_ORIGIN} through scripts/e2e/run.mjs.`);
  return spawnP(
    process.execPath,
    ["scripts/e2e/run.mjs", ...(argv.skipBuild ? ["--skip-build"] : [])],
    {
      ...process.env,
      E2E_TEST_PATHS: SPEC,
      E2E_FUNNEL_STATE: STATE_PATH,
      E2E_FUNNEL_MARKER: MARKER_PATH,
    },
  );
}

/**
 * Reads the marker the spec writes and says, in one sentence, why this run
 * cannot be called a pass. Null when every step this mode can run was
 * completed.
 *
 * The marker is the answer to "did a browser actually do anything": without
 * it, a spec that skipped and a spec that drove all thirteen steps are the
 * same exit code and the same silence.
 *
 * Against a DEPLOYED target the spec skips the reCAPTCHA-dependent leg (the
 * real widget challenges headless Chromium; see `RECAPTCHA_DEPENDENT_STEPS`)
 * and says so in the marker. That exact set, skipped for that stated reason,
 * is accepted here in dev mode and printed so nobody reads the run as
 * covering what it did not. Any other skip, and any skip at all in local
 * mode, is a shortfall.
 */
function markerShortfall({ local }) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
  } catch {
    return (
      "the spec wrote no completion marker, so it never ran: node --test exits 0 " +
      "over a skipped file, and this run drove no browser."
    );
  }
  const done = new Set(Array.isArray(marker.steps) ? marker.steps : []);
  const skipped = new Map(
    (Array.isArray(marker.skipped) ? marker.skipped : [])
      .filter((s) => s && typeof s.name === "string")
      .map((s) => [s.name, String(s.reason ?? "")]),
  );
  const acceptedSkips = new Set(local ? [] : RECAPTCHA_DEPENDENT_STEPS);
  const missing = FUNNEL_STEPS.filter(
    (name) => !done.has(name) && !(acceptedSkips.has(name) && skipped.has(name)),
  );
  if (skipped.size > 0) {
    log(
      `${skipped.size} of ${FUNNEL_STEPS.length} steps were SKIPPED, not run. This run ` +
        "proves nothing about them:",
    );
    // Grouped by reason: eight steps skipped for one reason is one paragraph
    // and eight names, not the same sentence eight times.
    const byReason = new Map();
    for (const [name, reason] of skipped) {
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(name);
    }
    for (const [reason, names] of byReason) {
      console.log(`  ${reason}`);
      for (const name of names) console.log(`    - ${name}`);
    }
  }
  return missing.length === 0
    ? null
    : `the spec completed ${done.size} of ${FUNNEL_STEPS.length} steps and stopped at ` +
        `"${missing[0]}".`;
}

/** Dev mode runs the spec directly: the server is already deployed. */
function runAgainstTarget(origin) {
  return spawnP(process.execPath, ["--test", "--test-concurrency=1", SPEC], {
    ...process.env,
    E2E_TARGET: origin,
    E2E_FUNNEL_STATE: STATE_PATH,
    E2E_FUNNEL_MARKER: MARKER_PATH,
  });
}

async function main() {
  let target;
  try {
    // Before anything else, and printed as a sentence rather than a stack: the
    // usual reason this fails is a missing .env.e2e.local, and an operator
    // reaching for a one-command dress rehearsal should read the fix, not a
    // trace through the module loader.
    target = assertFixtureTarget();
  } catch (err) {
    console.error(`[e2e:funnel] ${err.message}`);
    return 1;
  }
  log(`Project ${target.projectId}.`);

  if (!playwrightPresent()) {
    console.error(
      "[e2e:funnel] Playwright is not installed, so there is no browser to drive. " +
        "Install it and run this again:\n" +
        "  npm install --no-save playwright && npx playwright install chromium\n" +
        "(--no-save on purpose: the root package.json is on the production deploy's " +
        "npm ci path and must not grow a browser.)",
    );
    return 1;
  }

  let state = null;
  let testCode = 1;
  let teardownCode = 1;

  // A crashed previous run leaves its state file behind. Clearing it up front
  // rather than seeding on top means the manifest below is about THIS run.
  const stale = readState();
  if (stale) {
    log(`Found a fixture from an earlier run (${stale.funnelRunId}). Tearing it down first.`);
    try {
      const counts = await teardownFunnelFixtures(stale);
      if (counts.total !== 0) {
        console.error(JSON.stringify(counts, null, 2));
        log("Could not clear the earlier fixture. Refusing to seed on top of it.");
        return 1;
      }
    } catch (err) {
      console.error(err);
      log("Could not clear the earlier fixture. Refusing to seed on top of it.");
      return 1;
    }
  }

  // Teardown must survive an interrupt. It cannot be awaited from a signal
  // handler, so the handler says so loudly and leaves the state file in place:
  // the next run (or `node scripts/seed-fake-applicants.mjs down`) clears it.
  const onSignal = (name) => () => {
    console.error(
      `[e2e:funnel] ${name} received. The fixture is STILL SEEDED on ` +
        `${target.projectId}. Clear it with: node scripts/seed-fake-applicants.mjs down`,
    );
    process.exit(130);
  };
  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));

  // A marker left by an earlier run would answer for this one, so it goes
  // before the spec starts rather than after it finishes.
  try {
    rmSync(MARKER_PATH);
  } catch {
    /* nothing to clear */
  }

  try {
    state = await seedFunnelFixtures({ applicants: argv.applicants });
    testCode = argv.local
      ? await runLocal()
      : await runAgainstTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
    const shortfall = markerShortfall({ local: argv.local });
    if (shortfall) {
      console.error(`[e2e:funnel] NOT A PASS: ${shortfall}`);
      testCode = 1;
    }
  } catch (err) {
    console.error(err);
    testCode = 1;
  } finally {
    const toTearDown = state ?? readState();
    if (!toTearDown) {
      log("Nothing was seeded, so there is nothing to tear down.");
      teardownCode = 0;
    } else {
      try {
        // The BEFORE picture, printed because a manifest that reads zero
        // afterwards proves nothing on its own: a teardown that ran against
        // the wrong ids would also read zero. Seeing eleven rows go to none is
        // the evidence; seeing none go to none is a warning that the run never
        // reached the routes it was meant to drive.
        const before = await countFunnelRows(toTearDown);
        console.log(`[e2e:funnel] before teardown: ${JSON.stringify(before)}`);
        const counts = await teardownFunnelFixtures(toTearDown);
        console.log(JSON.stringify(counts, null, 2));
        teardownCode = counts.total === 0 ? 0 : 1;
        log(
          counts.total === 0
            ? "Teardown complete: the fixture manifest reads zero."
            : `TEARDOWN LEFT ${counts.total} ROW(S) BEHIND on ${target.projectId}.`,
        );
      } catch (err) {
        console.error(err);
        log(
          `Teardown FAILED. The fixture is still on ${target.projectId}. ` +
            "Clear it with: node scripts/seed-fake-applicants.mjs down",
        );
        teardownCode = 1;
      }
    }
  }

  return testCode === 0 && teardownCode === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
