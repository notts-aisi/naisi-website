/**
 * Phase 3: the local captcha-relaxed server, and the only supported way to run
 * the /api/register and Mailpit batteries.
 *
 *   npm run e2e:local             build, start, test, tear down
 *   npm run e2e:local -- --skip-build   reuse the previous local build
 *
 * What this script exists to guarantee, in order of importance:
 *
 * 1. The captcha-relaxed server is UNREACHABLE from anywhere but this machine.
 *    `next start` binds to every interface by default; a registration endpoint
 *    that accepts any reCAPTCHA token must never be LAN-visible, so the server
 *    is bound to 127.0.0.1 explicitly, and so is Mailpit.
 *
 * 2. The relaxation NEVER leaves this process. The always-pass secret and the
 *    Mailpit SMTP override are injected into the spawned server's environment
 *    only — no env file is written, so there is nothing a deployed backend
 *    could ever pick up. That is also why this script REFUSES a server that is
 *    already listening on the port: it constructs the server's environment
 *    itself rather than trusting whatever happens to be there.
 *
 * 3. The app under test is pointed at the DEV project. The assertion is on the
 *    EFFECTIVE environment, not just `.env.local`: Next resolves
 *    `process.env` > `.env.production.local` > `.env.local`, and the child
 *    inherits this shell, so a file-only check would be bypassed by exported
 *    production values. Mirrors the tripwires in lib/env.mjs.
 *
 * 4. No real mail can be attempted. SMTP_HOST/PORT are forced to the loopback
 *    Mailpit; the credentials in .env.local are shadowed, so even a template
 *    bug that addressed a real inbox would land in the catcher.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, parseEnvFile } from "./lib/env.mjs";
import { clearMailbox, mailpitAvailable } from "./lib/mailpit.mjs";

const HOST = "127.0.0.1";
const PORT = 3100;
const ORIGIN = `http://${HOST}:${PORT}`;
const MAILPIT_HTTP = "http://127.0.0.1:8025";
const MAILPIT_SMTP_PORT = "1025";
const DEV_PROJECT = "naisi-website-dev";

/**
 * Google's PUBLISHED reCAPTCHA test secret — the pair documented at
 * https://developers.google.com/recaptcha/docs/faq for automated testing.
 * siteverify answers success for ANY token under it, which is precisely what
 * lets the register batteries through the gate. It is not a credential and
 * hard-coding it here reveals nothing; the thing that must never happen is a
 * DEPLOYED backend carrying it, and nothing reads this file but this script,
 * which passes it only into the environment of a loopback-bound child process.
 */
const ALWAYS_PASS_RECAPTCHA_SECRET = "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe";

/** Marker recording what the current .next build baked in (NEXT_PUBLIC_* are
 *  inlined at build time, so a build made for another origin is unusable). */
const BUILD_MARKER = join(REPO_ROOT, ".next", "e2e-local-build.json");
const SERVER_LOG = join(REPO_ROOT, ".next", "e2e-local-server.log");

const log = (msg) => console.log(`[e2e:local] ${msg}`);

/**
 * Children this run spawned. `fail()` needs to reach them: an early exit that
 * left `next start` alive would leave :3100 occupied, and every later run
 * refuses a server it did not start — one timeout would poison the harness
 * until someone found the stray process by hand.
 */
const CHILDREN = [];
/** Set once teardown begins, so the expected exit is not reported as a death. */
let serverExitExpected = false;
const killChildren = () => {
  serverExitExpected = true;
  for (const { child } of [...CHILDREN].reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
};
const fail = (msg) => {
  console.error(`[e2e:local] ${msg}`);
  killChildren();
  process.exit(1);
};

/**
 * Is something LISTENING on this port?
 *
 * `-sTCP:LISTEN` matters and is not decoration: plain `lsof -i :N` selects any
 * socket whose local *or remote* port is N, in any state. Without it, a browser
 * tab holding a connection to someone else's :3000, or a lingering TIME_WAIT,
 * reads as "the port is occupied" — and this function gates two hard refusals,
 * so a false positive turns into "refusing to build" or "refusing to test a
 * server it did not start" for no reason.
 */
function portInUse(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    // lsof exits 1 when nothing matches — that IS "port free".
    return false;
  }
}

/**
 * The project/credential tripwires, applied to the environment the server will
 * ACTUALLY see — not just to `.env.local`.
 *
 * Checking only the file was a real hole. Next.js resolves configuration as
 * `process.env` > `.env.production.local` > `.env.local`, and `buildServerEnv()`
 * hands the child an inherited `process.env`. So a shell that had exported
 * production values (`set -a; source .env.prod` — this repo root has a history
 * of holding prod snapshots) would sail past a file-only assertion and aim the
 * captcha-relaxed server at production.
 */
function assertDevEnvLocal() {
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) {
    fail(
      ".env.local is missing. The local server needs the dev project's " +
        "NEXT_PUBLIC_FIREBASE_* values — see .env.example.",
    );
  }

  // Files Next.js loads at HIGHER precedence than .env.local when NODE_ENV is
  // production, which is what `next build` / `next start` run as. Rather than
  // parse and re-validate each, refuse outright: they have no legitimate role
  // in this flow, and "an unexpected env file exists" is exactly the shape the
  // prod-snapshot hazard takes.
  for (const name of [".env.production.local", ".env.production"]) {
    if (existsSync(join(REPO_ROOT, name))) {
      fail(
        `${name} exists, and Next.js loads it at higher precedence than .env.local ` +
          "in a production-mode build — so it, not the file this script validates, " +
          "would decide which project the server talks to. Move it aside and rerun.",
      );
    }
  }

  const file = parseEnvFile(path);
  // process.env wins, so validate the effective value.
  const effective = (key) => process.env[key] ?? file[key];

  for (const key of ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", "FIREBASE_ADMIN_PROJECT_ID"]) {
    const value = effective(key);
    if (value !== DEV_PROJECT) {
      const from = process.env[key] !== undefined ? "the shell environment" : ".env.local";
      fail(
        `${key} resolves to ${JSON.stringify(value)} (from ${from}), expected ` +
          `"${DEV_PROJECT}". The local server writes real Auth users and Firestore ` +
          "rows in whatever project this names — refusing to start it pointed " +
          "anywhere but dev.",
      );
    }
  }

  for (const key of ["FIREBASE_ADMIN_PRIVATE_KEY", "FIREBASE_ADMIN_CLIENT_EMAIL"]) {
    if (effective(key)) {
      const from = process.env[key] !== undefined ? "the shell environment" : ".env.local";
      fail(
        `${key} is set (in ${from}). This machine authenticates with ADC ` +
          "(`gcloud auth application-default login`) so that no permanent key sits " +
          "on disk; a service-account credential here silently replaces that. " +
          "Unset it rather than running.",
      );
    }
  }

  // run.mjs sets this itself (to the dev signing account). A value arriving
  // from anywhere else names whichever service account IAM will be asked to
  // sign custom tokens as, and nothing else validates it.
  const sa = effective("FIREBASE_ADMIN_SERVICE_ACCOUNT_ID");
  if (sa && !sa.endsWith(`@${DEV_PROJECT}.iam.gserviceaccount.com`)) {
    fail(
      `FIREBASE_ADMIN_SERVICE_ACCOUNT_ID is ${JSON.stringify(sa)}, which is not a ` +
        `${DEV_PROJECT} service account. This names the identity custom tokens are ` +
        "signed as — refusing.",
    );
  }
}

function buildServerEnv() {
  return {
    ...process.env,
    // The relaxation. Environment-only — see the header comment.
    RECAPTCHA_SECRET: ALWAYS_PASS_RECAPTCHA_SECRET,
    // Fresh per run, shared with the test child below. Deliberately random so
    // a stale value in .env.local can never mask a mint/verify mismatch.
    EVENTS_TOKEN_SECRET: randomBytes(32).toString("base64url"),
    // All mail into the loopback catcher. Every SMTP_* value is overridden so
    // nothing can fall through to the real credentials in .env.local.
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: MAILPIT_SMTP_PORT,
    SMTP_USER: "e2e",
    SMTP_PASSWORD: "e2e",
    SMTP_FROM_NAME: "NAISI (e2e)",
    SMTP_FROM_EMAIL: "e2e-sender@e2e.invalid",
    EMAIL_DEFAULT_REPLY_TO: "e2e-reply@e2e.invalid",
    // Links in captured emails must point back at THIS server so the batteries
    // can drive them. Inlined at build time, hence the build marker.
    NEXT_PUBLIC_APP_URL: ORIGIN,
    // Both project ids forced, not merely asserted: assertDevEnvLocal has
    // already refused anything else, and pinning them here means an exported
    // shell value cannot reach the child even if a future edit relaxes a check.
    FIREBASE_ADMIN_PROJECT_ID: DEV_PROJECT,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: DEV_PROJECT,
    // Lets the app's createCustomToken (login magic-link confirm) sign via IAM
    // under user ADC — see src/lib/firebase/admin.ts. Needs the same
    // serviceAccountTokenCreator grant the harness itself already uses.
    FIREBASE_ADMIN_SERVICE_ACCOUNT_ID: `firebase-adminsdk-fbsvc@${DEV_PROJECT}.iam.gserviceaccount.com`,
    // This machine keeps a real dev-bypass impl behind skip-worktree; the
    // batteries assert 401s, so the bypass must be provably inert.
    NEXT_PUBLIC_DEV_BYPASS_AUTH: "false",
    NEXT_PUBLIC_DEBUG_MONITOR: "false",
  };
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function ensureBuild(serverEnv, skipBuild) {
  const wanted = { appUrl: ORIGIN, project: DEV_PROJECT };
  if (skipBuild) {
    try {
      const marker = JSON.parse(readFileSync(BUILD_MARKER, "utf8"));
      if (marker.appUrl === wanted.appUrl && marker.project === wanted.project) {
        log("--skip-build: reusing the existing local e2e build.");
        return;
      }
      log("--skip-build requested but the existing build was made for different values — rebuilding.");
    } catch {
      log("--skip-build requested but no local e2e build marker found — rebuilding.");
    }
  }
  if (portInUse(3000)) {
    fail(
      "Something is listening on :3000 (probably `npm run dev`). `next build` " +
        "clobbers the .next directory that dev server is running from — stop it " +
        "first, then rerun.",
    );
  }
  // Same hazard, own port: a second e2e:local started while one is in flight
  // would rebuild .next out from under the running server. The :3100 refusal in
  // startServer happens AFTER the build, which is too late to help.
  if (portInUse(PORT)) {
    fail(
      `Something is listening on :${PORT} — another e2e:local run is probably in ` +
        "flight. Building now would clobber the .next it is serving from.",
    );
  }
  log("Building the app for the local server (next build)…");
  await run(join(REPO_ROOT, "node_modules", ".bin", "next"), ["build"], {
    cwd: REPO_ROOT,
    env: serverEnv,
    stdio: "inherit",
  });
  writeFileSync(BUILD_MARKER, JSON.stringify({ ...wanted, builtAt: new Date().toISOString() }, null, 2));
}

/**
 * True only if Mailpit answers, twice, either side of a short gap.
 *
 * A single probe is not enough, and this was a real flake rather than a
 * theoretical one: back-to-back runs would see the PREVIOUS run's Mailpit
 * still answering HTTP while it shut down, decide to reuse it, and then hit
 * ECONNREFUSED once it finished dying. An instance that answers twice across a
 * gap is one that is running, not one that is leaving.
 */
async function mailpitSettled() {
  if (!(await mailpitAvailable())) return false;
  await new Promise((r) => setTimeout(r, 400));
  return mailpitAvailable();
}

async function ensureMailpit() {
  if (await mailpitSettled()) {
    log(`Reusing the Mailpit already running at ${MAILPIT_HTTP}.`);
    return;
  }
  // Whatever was there is gone or going. Wait for the port to be genuinely
  // free before binding, so the spawn cannot lose a race with a dying
  // listener and exit "address already in use".
  const portFree = Date.now() + 10_000;
  while (portInUse(8025)) {
    if (Date.now() > portFree) {
      fail("Port 8025 is held by something that is not answering Mailpit's API.");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  log("Starting Mailpit on loopback…");
  const child = spawn(
    "mailpit",
    [
      "--listen", "127.0.0.1:8025",
      "--smtp", `127.0.0.1:${MAILPIT_SMTP_PORT}`,
      // nodemailer always authenticates (send.ts requires credentials), so the
      // catcher must accept an AUTH handshake — any credentials, plaintext ok:
      // both sockets are loopback-only.
      "--smtp-auth-accept-any",
      "--smtp-auth-allow-insecure",
    ],
    { stdio: "ignore" },
  );
  child.on("error", () => {});
  CHILDREN.push({ name: "mailpit", child });
  const deadline = Date.now() + 10_000;
  while (!(await mailpitAvailable())) {
    if (Date.now() > deadline || child.exitCode !== null) {
      fail("Mailpit did not come up on 127.0.0.1:8025 — is it installed (`brew install mailpit`)?");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Wipes the mailbox, re-establishing Mailpit if it has vanished since the
 * check. The pairing matters: this is the first thing that touches Mailpit for
 * real, so it is where a stale-instance decision surfaces.
 */
async function clearMailboxOrRestart() {
  try {
    await clearMailbox();
    return;
  } catch {
    log("Mailpit stopped answering before the mailbox could be cleared — restarting it.");
  }
  await ensureMailpit();
  await clearMailbox();
}

/**
 * Kills a spawned child and waits for it to ACTUALLY exit — the 'exit' event,
 * never a timer.
 *
 * The escalation path resolves only on 'exit' too. SIGKILL is asynchronous:
 * resolving in the same tick it is sent would return while the process still
 * holds its listening socket, which is the precise failure this function
 * exists to prevent (a back-to-back run then refuses on :3100). If a process
 * survives even SIGKILL it is unkillable — uninterruptible I/O — and hanging
 * is a truer answer than reporting a teardown that did not happen.
 */
function killAndWait(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const escalate = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startServer(serverEnv) {
  if (portInUse(PORT)) {
    fail(
      `Something is already listening on :${PORT}. This runner refuses to test a ` +
        "server it did not start — it cannot know what environment that process " +
        "carries. Stop it and rerun.",
    );
  }
  log(`Starting next start -H ${HOST} -p ${PORT} (log: ${SERVER_LOG})…`);
  const logFd = openSync(SERVER_LOG, "w");
  const child = spawn(
    join(REPO_ROOT, "node_modules", ".bin", "next"),
    ["start", "-H", HOST, "-p", String(PORT)],
    { cwd: REPO_ROOT, env: serverEnv, stdio: ["ignore", logFd, logFd] },
  );
  child.on("error", () => {});
  // A server that dies MID-RUN is otherwise silent: every subsequent request
  // fails with a bare "fetch failed" and the suite reports a wall of assertion
  // failures that look like product bugs. Say plainly what happened and how it
  // died — `signal` is the tell. SIGKILL with no crash in the server log means
  // something outside this process killed it, and on a laptop that is almost
  // always the OS reclaiming memory, not a defect in the code under test.
  child.on("exit", (code, signal) => {
    if (!serverExitExpected) {
      console.error(
        `[e2e:local] THE SERVER DIED MID-RUN (code=${code}, signal=${signal}). ` +
          `Every failure after this point is that, not the code under test. ` +
          `Check ${SERVER_LOG} for a crash; if it just stops, the process was ` +
          `killed from outside — check free memory (\`vm_stat\`, \`sysctl vm.swapusage\`).`,
      );
    }
  });
  CHILDREN.push({ name: "next-server", child });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) {
      fail(`The server exited before becoming ready — see ${SERVER_LOG}.`);
    }
    try {
      await fetch(`${ORIGIN}/login`, { redirect: "manual" });
      break;
    } catch {
      if (Date.now() > deadline) fail(`Server never became reachable on ${ORIGIN} — see ${SERVER_LOG}.`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  log("Server is up.");
}

/**
 * Removes harness accounts a CRASHED run left behind. Every battery cleans up
 * in its own `after()` hook, but a run killed between a register POST and that
 * hook (laptop asleep, SIGKILL, a hard abort) strands the Auth account in the
 * dev project indefinitely — so the README's cleanup promise needed something
 * that runs even when the previous process never got the chance.
 *
 * One hour old, so it can never touch a concurrent run's fixtures, and it only
 * ever sees the `e2e-…@e2e.invalid` namespace (enforced inside sweepHarnessUsers).
 */
async function sweepStaleHarnessAccounts() {
  try {
    const { sweepHarnessUsers } = await import("./lib/admin.mjs");
    const removed = await sweepHarnessUsers({ olderThanMs: 60 * 60 * 1000 });
    if (removed > 0) log(`Swept ${removed} harness account(s) left by an earlier run.`);
  } catch (err) {
    // Never fail a run over opportunistic cleanup.
    log(`Could not sweep stale harness accounts (${err.message}) — continuing.`);
  }
}

function runTests(serverEnv) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      // Serial file execution: the batteries share one server and one mail
      // catcher, and the two flakes the emulator suite taught us both came
      // from cross-file concurrency.
      ["--test", "--test-concurrency=1", "scripts/e2e/tests/"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_TARGET: ORIGIN,
          E2E_ALLOW_REGISTER: "1",
          E2E_LOCAL_TOKEN_SECRET: serverEnv.EVENTS_TOKEN_SECRET,
          MAILPIT_URL: MAILPIT_HTTP,
        },
      },
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const skipBuild = process.argv.includes("--skip-build");
  /**
   * The normal path: kill each child and WAIT for it to go. Returning while a
   * spawned Mailpit is still holding :8025 is what made an immediately
   * following run reuse a dying instance. (`killChildren` is the synchronous
   * best-effort version, for the signal and `fail()` paths that cannot await.)
   */
  const teardownAndWait = async () => {
    serverExitExpected = true;
    for (const { child } of [...CHILDREN].reverse()) {
      await killAndWait(child);
    }
  };
  // Say so LOUDLY when a run is interrupted. Tearing down kills the server out
  // from under whatever test is mid-request, so an interrupted run reports a
  // "fetch failed" hook error that reads exactly like a real defect. Naming the
  // signal is the difference between ten minutes of diagnosis and none.
  const onSignal = (name, code) => () => {
    console.error(
      `[e2e:local] ${name} received — shutting the local server down. Any test ` +
        "failure printed after this line is a consequence of the interruption, " +
        "NOT a result. Rerun to get a verdict.",
    );
    killChildren();
    process.exit(code);
  };
  process.on("SIGINT", onSignal("SIGINT", 130));
  process.on("SIGTERM", onSignal("SIGTERM", 143));

  try {
    assertDevEnvLocal();
    mkdirSync(join(REPO_ROOT, ".next"), { recursive: true });
    const serverEnv = buildServerEnv();
    await ensureMailpit();
    await ensureBuild(serverEnv, skipBuild);
    await ensureMailpit(); // re-check: the build can take minutes
    await startServer(serverEnv);
    // One global wipe so a previous run's mail can't satisfy anything; from
    // here on every assertion is per-recipient (addresses embed the run id).
    process.env.MAILPIT_URL = MAILPIT_HTTP;
    await clearMailboxOrRestart();
    await sweepStaleHarnessAccounts();
    const code = await runTests(serverEnv);
    await teardownAndWait();
    process.exit(code);
  } catch (err) {
    console.error(err);
    await teardownAndWait();
    process.exit(1);
  }
}

await main();
