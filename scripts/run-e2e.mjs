/**
 * `npm run e2e:browser` - the browser end-to-end suite in one command.
 *
 *   discover the spec modules -> seed each throwaway world -> drive them in
 *   Chromium -> tear every one down -> prove each manifest reads zero
 *
 *   node scripts/run-e2e.mjs                       every spec, against dev
 *   node scripts/run-e2e.mjs --local               against a server it starts
 *   node scripts/run-e2e.mjs --local --skip-build  reuse the previous build
 *   node scripts/run-e2e.mjs --spec applicant-funnel,events-rsvp
 *   node scripts/run-e2e.mjs --list                what it can run
 *
 *   E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec x
 *     against a loopback server ALREADY RUNNING (one somebody else started
 *     with --local, or by hand). Nothing is built or started, and the
 *     reCAPTCHA stub still arms because the origin is loopback.
 *
 * ## The spec modules are the source of truth, not a list in here
 *
 * Every `.mjs` under `scripts/e2e-fixtures/` except `core.mjs` exports one
 * `SPEC` object: its name, its spec file, its ordered step names, the subset
 * of those that cannot run against a deployed target, whether it needs the
 * owner's admin account, what it covers, and seed / countRows / teardown.
 * This file walks the directory and validates the shape, so a new spec is
 * covered by adding a file rather than by remembering to edit a runner.
 *
 * ## Teardown is unconditional, and the manifest is the proof
 *
 * Every fixture lives on a shared dev project, so a run that leaves rows
 * behind is a run that has polluted a real environment: a live-looking
 * admission round on the catalogue, a pre-course nobody scheduled, accounts in
 * the admin members list. Teardown therefore runs in a `finally`, on a
 * failure, and the exit code carries BOTH verdicts: a green suite whose
 * teardown left rows behind still exits non-zero, because the second fact is
 * as much a defect as the first.
 *
 * ## A run that drove no browser is a failure
 *
 * Everything a spec can do short of running exits `node --test` at 0: a
 * missing Playwright, a missing fixture, a skip. Three separate ways to get a
 * green command that opened nothing. So each spec writes a completion marker
 * naming the steps it finished, this file deletes those markers before the
 * run, and success requires each one back naming every step in its own
 * `SPEC.steps` (minus the reCAPTCHA-dependent set, and only against a deployed
 * target).
 *
 * ## What it deliberately does not do
 *
 * It does not install Playwright, and it does not add it to `package.json`.
 * The root manifest is what App Hosting runs `npm ci` against on the critical
 * path of every production deploy, and a browser automation library plus a
 * downloaded Chromium has no business on that path (the same argument that
 * put `scripts/rules-tests` in its own package). So the runner CHECKS for
 * Playwright and REFUSES to run without it, printing the one-line install.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HARNESS_LOCAL_ORIGIN,
  RECAPTCHA_SKIP_REASON,
  assertFixtureTarget,
  clearState,
  markerPath,
  readState,
  mailIsCaught,
  runId,
  stateDir,
  writeState,
} from "./e2e-fixtures/core.mjs";
import { REPO_ROOT, assertTarget, isLoopbackOrigin, loadSecrets } from "./e2e/lib/env.mjs";

const FIXTURES_DIR = join(REPO_ROOT, "scripts", "e2e-fixtures");
/** The origin `scripts/e2e/run.mjs` binds, stated once in `core.mjs`. */
const LOCAL_ORIGIN = HARNESS_LOCAL_ORIGIN;
const DEFAULT_TARGET = "https://dev.naisi.uk";
const SECRETS_FILE = ".env.e2e.secrets.local";

const log = (msg) => console.log(`[e2e:browser] ${msg}`);

function parseArgs(raw) {
  const applicantsAt = raw.indexOf("--applicants");
  const specAt = raw.indexOf("--spec");
  return {
    local: raw.includes("--local"),
    skipBuild: raw.includes("--skip-build"),
    list: raw.includes("--list"),
    // Undefined when the flag is absent, so each spec's own default applies
    // rather than this file holding a second opinion about one spec's shape.
    applicants: applicantsAt === -1 ? undefined : Number(raw[applicantsAt + 1]),
    only:
      specAt === -1
        ? null
        : String(raw[specAt + 1] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
  };
}

const argv = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The SPEC contract, checked here at run time and again offline by
 * `tests/funnel-harness-guards.test.mjs`. Both, because this one is the one
 * that stops a malformed module seeding rows nobody can count, and that one is
 * the one that runs without credentials on every pull request.
 */
function validateSpec(spec, rel) {
  const bad = (why) => {
    throw new Error(`${rel} does not export a usable SPEC: ${why}`);
  };
  if (!spec || typeof spec !== "object") bad("no exported SPEC object");
  if (typeof spec.name !== "string" || spec.name === "") bad("SPEC.name must be a non-empty string");
  if (typeof spec.specFile !== "string" || !existsSync(join(REPO_ROOT, spec.specFile))) {
    bad(`SPEC.specFile ${JSON.stringify(spec.specFile)} is not a file in this repo`);
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) bad("SPEC.steps must be a non-empty array");
  if (!Array.isArray(spec.recaptchaDependentSteps)) bad("SPEC.recaptchaDependentSteps must be an array");
  for (const name of spec.recaptchaDependentSteps) {
    if (!spec.steps.includes(name)) {
      bad(`recaptchaDependentSteps names ${JSON.stringify(name)}, which is not a step`);
    }
  }
  if (spec.recaptchaDependentSteps.length >= spec.steps.length) {
    bad("every step is reCAPTCHA-dependent, so a run against a deployed target would prove nothing");
  }
  if (!spec.needs || typeof spec.needs.admin !== "boolean") bad("SPEC.needs.admin must be a boolean");
  if (!spec.covers || !Array.isArray(spec.covers.routes) || !Array.isArray(spec.covers.pages)) {
    bad("SPEC.covers must be { routes: [...], pages: [...] }");
  }
  for (const fn of ["seed", "countRows", "teardown"]) {
    if (typeof spec[fn] !== "function") bad(`SPEC.${fn} must be a function`);
  }
  return spec;
}

/** Every spec module beside core.mjs, imported and validated. */
export async function discoverSpecs() {
  const found = [];
  const seen = new Set();
  for (const entry of readdirSync(FIXTURES_DIR).sort()) {
    if (!entry.endsWith(".mjs") || entry === "core.mjs") continue;
    const rel = `scripts/e2e-fixtures/${entry}`;
    const mod = await import(pathToFileURL(join(FIXTURES_DIR, entry)).href);
    const spec = validateSpec(mod.SPEC, rel);
    if (seen.has(spec.name)) {
      throw new Error(
        `${rel} declares SPEC.name ${JSON.stringify(spec.name)}, which another module ` +
          "already uses. The name is the state and marker file stem, so two specs " +
          "sharing one would overwrite each other's ledger.",
      );
    }
    seen.add(spec.name);
    found.push({ rel, spec });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/**
 * Resolves Playwright without importing it, so a missing install is a printed
 * sentence rather than a stack trace. FATAL: a run that cannot open a browser
 * has nothing to say, and seeding a throwaway world on a shared project to
 * prove that is not worth the rows.
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
function runLocal(specFiles) {
  log(`Starting the local server on ${LOCAL_ORIGIN} through scripts/e2e/run.mjs.`);
  return spawnP(
    process.execPath,
    ["scripts/e2e/run.mjs", ...(argv.skipBuild ? ["--skip-build"] : [])],
    {
      ...process.env,
      E2E_TEST_PATHS: specFiles.join(","),
      E2E_STATE_DIR: stateDir(),
    },
  );
}

/** Target mode runs the specs directly: the server is already there. */
function runAgainstTarget(origin, specFiles) {
  return spawnP(process.execPath, ["--test", "--test-concurrency=1", ...specFiles], {
    ...process.env,
    E2E_TARGET: origin,
    E2E_STATE_DIR: stateDir(),
  });
}

// ---------------------------------------------------------------------------
// The completion markers
// ---------------------------------------------------------------------------

/**
 * Reads one spec's marker and says, in one sentence, why this run cannot be
 * called a pass. Null when every step this mode can run was completed.
 *
 * The marker is the answer to "did a browser actually do anything": without
 * it, a spec that skipped and a spec that drove every step are the same exit
 * code and the same silence.
 *
 * Against a DEPLOYED target a spec skips its reCAPTCHA-dependent leg (the real
 * widget challenges headless Chromium) and says so in the marker. That exact
 * set, skipped for that stated reason, is accepted here and printed so nobody
 * reads the run as covering what it did not. Any other skip, and any skip at
 * all against a loopback server, is a shortfall.
 *
 * The REASON is checked, not just the name. A step on the reCAPTCHA list that
 * was skipped for some other reason (a fixture the spec could not find, a
 * locator it gave up on) is a step nobody drove, and accepting it because its
 * name happens to be on a list would let a run pass over work it never did.
 * Hence one shared constant, `RECAPTCHA_SKIP_REASON`, which the spec records
 * and this compares against.
 */
function markerShortfall(spec, { acceptRecaptchaSkips }) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath(spec.name), "utf8"));
  } catch {
    return (
      `${spec.name}: the spec wrote no completion marker, so it never ran: node --test ` +
      "exits 0 over a skipped file, and this run drove no browser."
    );
  }
  const done = new Set(Array.isArray(marker.steps) ? marker.steps : []);
  const skipped = new Map(
    (Array.isArray(marker.skipped) ? marker.skipped : [])
      .filter((s) => s && typeof s.name === "string")
      .map((s) => [s.name, String(s.reason ?? "")]),
  );
  const acceptedSkips = new Set(acceptRecaptchaSkips ? spec.recaptchaDependentSteps : []);
  /** Gated steps that were skipped, but not for the one accepted reason. */
  const wrongReason = [];
  const missing = spec.steps.filter((name) => {
    if (done.has(name)) return false;
    if (!acceptedSkips.has(name) || !skipped.has(name)) return true;
    if (skipped.get(name) !== RECAPTCHA_SKIP_REASON) {
      wrongReason.push(name);
      return true;
    }
    return false;
  });
  if (skipped.size > 0) {
    log(
      `${spec.name}: ${skipped.size} of ${spec.steps.length} steps were SKIPPED, not run. ` +
        "This run proves nothing about them:",
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
  if (wrongReason.length > 0) {
    return (
      `${spec.name}: "${wrongReason[0]}" is reCAPTCHA-dependent, but the marker records ` +
      `it skipped for a different reason (${JSON.stringify(skipped.get(wrongReason[0]))}). ` +
      "Only the declared reCAPTCHA reason is an accepted skip; anything else means " +
      "nothing drove that step."
    );
  }
  return missing.length === 0
    ? null
    : `${spec.name}: completed ${done.size} of ${spec.steps.length} steps and stopped at ` +
        `"${missing[0]}".`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let specs;
  try {
    specs = await discoverSpecs();
  } catch (err) {
    console.error(`[e2e:browser] ${err.message}`);
    return 1;
  }

  if (argv.list) {
    for (const { rel, spec } of specs) {
      console.log(
        `${spec.name}\t${spec.steps.length} step(s)\tadmin: ${spec.needs.admin ? "yes" : "no"}\t${rel}`,
      );
    }
    return 0;
  }

  let selected = specs;
  if (argv.only) {
    const known = new Set(specs.map((s) => s.spec.name));
    const unknown = argv.only.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      console.error(
        `[e2e:browser] no such spec: ${unknown.join(", ")}. Known: ${[...known].join(", ")}.`,
      );
      return 1;
    }
    selected = specs.filter((s) => argv.only.includes(s.spec.name));
  }
  if (selected.length === 0) {
    console.error("[e2e:browser] nothing to run.");
    return 1;
  }

  const origin = argv.local
    ? LOCAL_ORIGIN
    : assertTarget(process.env.E2E_TARGET ?? DEFAULT_TARGET);
  const deployed = !isLoopbackOrigin(origin);

  /**
   * Whether this run's mail is CAUGHT rather than sent, which is what decides
   * suppression. A fact about the server, not the shape of the origin.
   *
   * Only `scripts/e2e/run.mjs` points a server's SMTP at Mailpit, and only
   * `:3100` is reserved for a server it started (see ALLOWED_ORIGINS in
   * scripts/e2e/lib/env.mjs). `http://127.0.0.1:3000` and
   * `http://localhost:3000` are on that same allowlist and are the ordinary
   * `npm run dev` ports, whose server reads the REAL Resend credentials out of
   * `.env.local`: an earlier draft keyed this off `isLoopbackOrigin` and would
   * have handed `.invalid` addresses to a real sender there. Every other
   * target, deployed or loopback, gets the suppression rows written first.
   */
  const mailCaught = mailIsCaught({ startedByThisRun: argv.local, origin });

  let target;
  try {
    // Before anything else, and printed as a sentence rather than a stack: the
    // usual reason this fails is a missing .env.e2e.local, and an operator
    // reaching for a one-command dress rehearsal should read the fix, not a
    // trace through the module loader.
    target = assertFixtureTarget();
  } catch (err) {
    console.error(`[e2e:browser] ${err.message}`);
    return 1;
  }
  log(`Project ${target.projectId}, target ${origin} (${deployed ? "deployed" : "loopback"}).`);
  /**
   * Whether the reCAPTCHA-dependent steps may be skipped on this run. Only
   * against a deployed target with NO bypass secret: there the real widget
   * challenges headless Chromium. With E2E_RECAPTCHA_BYPASS_SECRET in the
   * secrets file (and the same value on the dev backend), the specs arm the
   * bypass header (see armRecaptcha in scripts/e2e/lib/browser.mjs) and every
   * step must run; a skip is then a shortfall like any other. On loopback the
   * stub answers, and nothing is ever skipped.
   */
  const recaptchaBypass = deployed && Boolean(loadSecrets().recaptchaBypassSecret);
  const acceptRecaptchaSkips = deployed && !recaptchaBypass;
  log(
    deployed
      ? recaptchaBypass
        ? "reCAPTCHA: the dev-backend bypass is armed (E2E_RECAPTCHA_BYPASS_SECRET is set), " +
          "so the reCAPTCHA-dependent steps run and may not be skipped."
        : "reCAPTCHA: no bypass secret, so the real widget runs and the reCAPTCHA-dependent " +
          "steps will be SKIPPED and reported. Set E2E_RECAPTCHA_BYPASS_SECRET to drive them."
      : "reCAPTCHA: stubbed against the loopback server; every step runs.",
  );
  log(
    mailCaught
      ? "Mailpit catches this run's mail, so fixture addresses are NOT suppressed and " +
          "the emailSends rows a route leaves are evidence a spec can read."
      : "Fixture addresses are suppressed before anything is seeded: this target's " +
          "server can hand a message to a real sender.",
  );
  log(`Running: ${selected.map((s) => s.spec.name).join(", ")}.`);

  if (!playwrightPresent()) {
    console.error(
      "[e2e:browser] Playwright is not installed, so there is no browser to drive. " +
        "Install it and run this again:\n" +
        "  npm install --no-save playwright && npx playwright install chromium\n" +
        "(--no-save on purpose: the root package.json is on the production deploy's " +
        "npm ci path and must not grow a browser.)",
    );
    return 1;
  }

  // The admin account is the owner's own, never one this harness could make:
  // the fence forbids creating anything above role `pending`. So a spec that
  // signs in as an admin needs credentials from a file, and a missing one is
  // named precisely rather than surfacing later as a login timeout.
  const needsAdmin = selected.filter((s) => s.spec.needs.admin);
  if (needsAdmin.length > 0) {
    let secrets;
    try {
      secrets = loadSecrets();
    } catch (err) {
      console.error(`[e2e:browser] ${err.message}`);
      return 1;
    }
    const missing = [
      ...(secrets.adminEmail ? [] : ["E2E_ADMIN_EMAIL"]),
      ...(secrets.adminPassword ? [] : ["E2E_ADMIN_PASSWORD"]),
    ];
    if (missing.length > 0) {
      console.error(
        `[e2e:browser] ${needsAdmin.map((s) => s.spec.name).join(", ")} sign(s) in as an ` +
          `admin, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
          `Put ${missing.length === 1 ? "it" : "them"} in ${SECRETS_FILE} at the repo root ` +
          "(git-ignored by the .env* rule), one KEY=value per line, or export " +
          `${missing.length === 1 ? "it" : "them"} in the shell.`,
      );
      return 1;
    }
  }

  let testCode = 1;
  let teardownCode = 1;
  /** Specs that really got seeded, so the finally tears down exactly those. */
  const seeded = [];

  // A crashed previous run leaves its state file behind. Clearing it up front
  // rather than seeding on top means every manifest below is about THIS run.
  for (const { spec } of selected) {
    const stale = readState(spec.name);
    if (!stale) continue;
    log(`Found a ${spec.name} fixture from an earlier run. Tearing it down first.`);
    try {
      const counts = await spec.teardown(stale);
      if (counts.total !== 0) {
        console.error(JSON.stringify(counts, null, 2));
        log(`Could not clear the earlier ${spec.name} fixture. Refusing to seed on top of it.`);
        return 1;
      }
      clearState(spec.name);
    } catch (err) {
      console.error(err);
      log(`Could not clear the earlier ${spec.name} fixture. Refusing to seed on top of it.`);
      return 1;
    }
  }

  // Teardown must survive an interrupt. It cannot be awaited from a signal
  // handler, so the handler says so loudly and leaves the state files in
  // place: the next run of the same spec clears them before it seeds.
  const onSignal = (name) => () => {
    console.error(
      `[e2e:browser] ${name} received. Any fixture is STILL SEEDED on ` +
        `${target.projectId}, with its ledger under ${stateDir()}. Re-running the same ` +
        "spec tears a stale fixture down before it seeds; for the applicant funnel, " +
        "`node scripts/seed-fake-applicants.mjs down` clears it on its own.",
    );
    process.exit(130);
  };
  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));

  // A marker left by an earlier run would answer for this one, so they go
  // before the specs start rather than after they finish.
  for (const { spec } of selected) {
    try {
      rmSync(markerPath(spec.name));
    } catch {
      /* nothing to clear */
    }
  }

  try {
    for (const { spec } of selected) {
      // A seed that throws HALF WAY is the expensive case: an account created,
      // then a document write refused, and no returned state, so nothing is
      // ledgered and the `finally` below reports there was nothing to tear
      // down while the accounts and documents stay on a shared project. So the
      // fixture publishes its state object as soon as it has one, BEFORE its
      // first write, and this holds the reference: the object is mutated in
      // place as the fixture fills it, so whatever was created by the time it
      // threw is in the ledger that gets torn down.
      let partial = null;
      try {
        const state = await spec.seed({
          runId: runId(),
          suppress: !mailCaught,
          options: { applicants: argv.applicants },
          onState: (published) => {
            partial = published;
          },
        });
        writeState(spec.name, state);
        seeded.push({ spec, state });
      } catch (err) {
        if (partial) {
          writeState(spec.name, partial);
          seeded.push({ spec, state: partial });
          log(
            `${spec.name}: seeding failed part way. Its ledger is written, and teardown ` +
              "below removes whatever it had created.",
          );
        }
        throw err;
      }
    }

    const specFiles = selected.map((s) => s.spec.specFile);
    testCode = argv.local
      ? await runLocal(specFiles)
      : await runAgainstTarget(origin, specFiles);

    const shortfalls = selected
      .map(({ spec }) => markerShortfall(spec, { acceptRecaptchaSkips }))
      .filter(Boolean);
    if (shortfalls.length > 0) {
      for (const line of shortfalls) console.error(`[e2e:browser] NOT A PASS: ${line}`);
      testCode = 1;
    }
  } catch (err) {
    console.error(err);
    testCode = 1;
  } finally {
    // Anything seeded, plus anything a crash left a ledger for.
    const pending = selected
      .map(({ spec }) => ({
        spec,
        state: seeded.find((s) => s.spec.name === spec.name)?.state ?? readState(spec.name),
      }))
      .filter((entry) => entry.state);
    if (pending.length === 0) {
      log("Nothing was seeded, so there is nothing to tear down.");
      teardownCode = 0;
    } else {
      let remaining = 0;
      for (const { spec, state } of pending) {
        try {
          // The BEFORE picture, printed because a manifest that reads zero
          // afterwards proves nothing on its own: a teardown that ran against
          // the wrong ids would also read zero. Seeing eleven rows go to none
          // is the evidence; seeing none go to none is a warning that the run
          // never reached the routes it was meant to drive.
          const before = await spec.countRows(state);
          console.log(`[e2e:browser] ${spec.name} before teardown: ${JSON.stringify(before)}`);
          const counts = await spec.teardown(state);
          console.log(`[e2e:browser] ${spec.name} after teardown:`);
          console.log(JSON.stringify(counts, null, 2));
          if (counts.total === 0) clearState(spec.name);
          remaining += counts.total;
          log(
            counts.total === 0
              ? `${spec.name}: teardown complete, the fixture manifest reads zero.`
              : `${spec.name}: TEARDOWN LEFT ${counts.total} ROW(S) BEHIND on ${target.projectId}.`,
          );
        } catch (err) {
          console.error(err);
          remaining += 1;
          log(
            `${spec.name}: teardown FAILED. The fixture is still on ${target.projectId}. ` +
              `Its ledger is at ${stateDir()}.`,
          );
        }
      }
      teardownCode = remaining === 0 ? 0 : 1;
      log(`Total rows left behind across every fixture: ${remaining}.`);
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
