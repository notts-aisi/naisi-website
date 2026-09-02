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
 * Playwright and prints the one-line install when it is missing, and the spec
 * skips rather than failing.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  DEFAULT_APPLICANTS,
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
 * sentence rather than a stack trace. Not fatal: the spec's own skip is the
 * authority, and a run that seeds, skips and tears down cleanly still proves
 * the fixture half of this harness works.
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
    },
  );
}

/** Dev mode runs the spec directly: the server is already deployed. */
function runAgainstTarget(origin) {
  return spawnP(process.execPath, ["--test", "--test-concurrency=1", SPEC], {
    ...process.env,
    E2E_TARGET: origin,
    E2E_FUNNEL_STATE: STATE_PATH,
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
  log(`Project ${target.projectId}${target.emulator ? " (emulator)" : ""}.`);

  if (!playwrightPresent()) {
    log(
      "Playwright is not installed, so the browser steps will SKIP. To run them:\n" +
        "  npm install --no-save playwright && npx playwright install chromium\n" +
        "(--no-save on purpose: the root package.json is on the production deploy's " +
        "npm ci path and must not grow a browser.)",
    );
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

  try {
    state = await seedFunnelFixtures({ applicants: argv.applicants });
    testCode = argv.local
      ? await runLocal()
      : await runAgainstTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
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
