/**
 * Environment loading + the tripwires that keep this harness off production.
 *
 * Every other module imports `loadEnv()` from here, and `loadEnv()` asserts
 * before it returns. There is deliberately no way to obtain config without
 * passing the checks.
 *
 * Why the tripwires are this loud: PR #209 shipped a uni-email verification
 * bypass to production, and the lesson recorded in that postmortem is that a
 * capability which is *convenient* in dev becomes a *vulnerability* the moment
 * it is pointed somewhere else. This harness mints magic-link tokens and
 * creates Auth users. Aimed at prod — by a typo'd --target, or a stray
 * `cp .env.prod .env.e2e.local` — it would be a production account factory.
 * Any future loosening of the checks below must read as a security diff.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_FILE = join(REPO_ROOT, ".env.e2e.local");

/** The ONLY Firebase project this harness may ever authenticate against. */
const REQUIRED_PROJECT_ID = "naisi-website-dev";

/**
 * The ONLY HTTP origins this harness may talk to. Exact origin match — never
 * a substring test, because "https://naisi.uk" is a substring of
 * "https://dev.naisi.uk" and the naive check passes the dangerous case.
 */
const ALLOWED_ORIGINS = [
  "https://dev.naisi.uk",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3100", // reserved for the Phase 3 local server
];

/** Origins that must produce a loud, specific failure rather than a generic one. */
const PRODUCTION_ORIGINS = ["https://naisi.uk", "https://www.naisi.uk"];

function parseEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Missing ${path}.\n` +
        `Copy .env.e2e.local.example to .env.e2e.local and fill in the DEV project's values.\n` +
        `It is git-ignored (.gitignore '.env*') and must never contain production credentials.`,
    );
  }
  const out = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Exact-origin allowlist. A --target typo pointing at production would
 * otherwise run real registrations against real users; every other guard here
 * constrains the Admin SDK, not the HTTP target.
 */
export function assertTarget(target) {
  let origin;
  try {
    origin = new URL(target).origin;
  } catch {
    throw new Error(`E2E_TARGET is not a valid URL: ${JSON.stringify(target)}`);
  }
  if (PRODUCTION_ORIGINS.includes(origin)) {
    throw new Error(
      `REFUSING TO RUN AGAINST PRODUCTION (${origin}).\n` +
        `This harness creates Auth users and mints signed tokens. It is dev-only, by design.`,
    );
  }
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new Error(
      `E2E_TARGET origin ${origin} is not in the allowlist.\n` +
        `Allowed: ${ALLOWED_ORIGINS.join(", ")}\n` +
        `Add an origin here only if you are certain it is not production.`,
    );
  }
  return origin;
}

/**
 * The Admin credential must belong to the dev project. Checked on both the
 * declared project id and the service-account email, because the two come
 * from different lines of the env file and a half-finished copy/paste can
 * leave them disagreeing.
 */
export function assertProject(env) {
  const projectId = env.FIREBASE_ADMIN_PROJECT_ID;
  if (projectId !== REQUIRED_PROJECT_ID) {
    throw new Error(
      `FIREBASE_ADMIN_PROJECT_ID is ${JSON.stringify(projectId)}, expected ` +
        `${JSON.stringify(REQUIRED_PROJECT_ID)}.\n` +
        `This is the id passed to initializeApp, so it decides which project every ` +
        `resource lands in — refusing to continue.`,
    );
  }
  // A private key here means someone reintroduced a downloaded service-account
  // key. The harness authenticates with Application Default Credentials
  // precisely so no permanent credential sits on disk; accepting one silently
  // would undo that.
  if (env.FIREBASE_ADMIN_PRIVATE_KEY) {
    throw new Error(
      "FIREBASE_ADMIN_PRIVATE_KEY is set in .env.e2e.local.\n" +
        "This harness uses Application Default Credentials (`gcloud auth " +
        "application-default login`) so that no permanent key sits in plaintext " +
        "on disk. Delete that line rather than adding the key back.",
    );
  }
}

let cached = null;

/**
 * Loads + validates config. Safe to call repeatedly; the assertions run on
 * the first call and the result is memoised for the rest of the process.
 */
export function loadEnv() {
  if (cached) return cached;
  const file = parseEnvFile(ENV_FILE);
  // process.env wins so a run can be pointed at a local server without editing
  // the file. Still passes through assertTarget() — the allowlist is the
  // guard, not the source of the value.
  const target = process.env.E2E_TARGET ?? file.E2E_TARGET ?? "https://dev.naisi.uk";

  assertProject(file);
  const origin = assertTarget(target);

  cached = {
    origin,
    projectId: file.FIREBASE_ADMIN_PROJECT_ID,
    webApiKey: file.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    // Fetched from Secret Manager on demand, never stored. Absent (not signed
    // in / no access) → the token batteries skip, so the #209 guard still runs.
    get tokenSecret() {
      return getTokenSecret();
    },
    // Opt-in switch for the reCAPTCHA-gated /api/register battery, which can
    // only run against a local server (see README).
    allowRegister: file.E2E_ALLOW_REGISTER === "1",
  };
  return cached;
}

let tokenSecret;

/**
 * The DEV backend's magic-link signing secret, read from Secret Manager at
 * RUNTIME and held in memory only — never written to disk. Returns "" when it
 * cannot be fetched (not signed in, no access), which makes the token
 * batteries skip rather than fail.
 *
 * Note this must be the secret the DEV BACKEND runs, which is NOT the value in
 * .env.local — they differ, so a locally-minted token would be rejected by
 * dev.naisi.uk. The positive control in token-negatives.test.mjs is what
 * catches that.
 */
export function getTokenSecret() {
  if (tokenSecret !== undefined) return tokenSecret;
  try {
    tokenSecret = execFileSync(
      "gcloud",
      [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=EVENTS_TOKEN_SECRET",
        `--project=${REQUIRED_PROJECT_ID}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    tokenSecret = "";
  }
  return tokenSecret;
}

/** Per-run id, used to namespace every account this harness creates. */
export function runId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
