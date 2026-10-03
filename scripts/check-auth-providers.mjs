#!/usr/bin/env node
/**
 * Sign-in provider guard: does each Firebase project have switched on exactly
 * the sign-in providers the shipped code calls?
 *
 * WHY THIS EXISTS. The email registration route sets a password and then signs
 * the person in with it. On production the Email/Password provider was switched
 * off, so that sign-in was refused for every email sign-up: nobody reached the
 * profile form and nothing reached Approvals. Dev had the switch on, so every
 * check that ran against dev passed, and nothing compared the two projects.
 * A switch the code depends on lived only in a console.
 *
 * That is the same drift class `check-api-key-restrictions.mjs` closes for API
 * keys, and the fix has the same shape: the expectation is written down HERE,
 * next to the code that depends on it, and every project is held to it.
 *
 * TWO LAYERS, and a guard for each seam between them.
 *
 *  1. Code against this file. `tests/auth-providers.test.mjs` (offline, in
 *     `npm test`) reads every import from `firebase/auth` under `src` and
 *     requires each one to be classified below, in both directions: a new
 *     sign-in call with no provider named fails, and a provider no call needs
 *     any more fails too, because an unused provider is a door left open.
 *  2. This file against each project. That is what running this script does.
 *
 * HOW IT LOOKS, WITHOUT CREDENTIALS. The default mode asks the project the
 * question a browser asks: it attempts a sign-in that cannot succeed and reads
 * the refusal. A provider that is on refuses the CREDENTIAL
 * (`INVALID_LOGIN_CREDENTIALS`, `INVALID_IDP_RESPONSE`); a provider that is off
 * refuses the OPERATION (`PASSWORD_LOGIN_DISABLED`, `OPERATION_NOT_ALLOWED`).
 * It needs only the project's public web key, which it fetches from the
 * project's own hosting endpoint at run time, so no key is written in this
 * repository and nothing has to hold a credential on production. That is the
 * point: it runs daily from `.github/workflows/cloud-config.yml` against every
 * project, production included, and it goes on working while a project's CI
 * identity is being replaced.
 *
 * What the public mode cannot see is a provider with no credential to refuse:
 * anonymous sign-in (probing it would CREATE an account when it is on) and
 * phone. `--admin` reads the project's configuration instead and checks those
 * too. It needs `firebaseauth.configs.get`, so it is run by hand, or by the
 * posture probe as the read-only account:
 *
 *   node scripts/check-auth-providers.mjs --admin --project naisi-website
 *
 * with Application Default Credentials, or with a token in
 * `GOOGLE_OAUTH_ACCESS_TOKEN`.
 *
 * A FAILED LOOK IS A FAILURE. A network error, a missing web key or an answer
 * this file does not recognise exits 2. A guard that passes when it could not
 * look reports an all-clear it did not earn.
 *
 * USAGE
 *   node scripts/check-auth-providers.mjs                 # every project, public mode
 *   node scripts/check-auth-providers.mjs --project naisi-uk-dev
 *   node scripts/check-auth-providers.mjs --admin --project naisi-website
 */

import { pathToFileURL } from "node:url";

/**
 * The providers the code needs, and the `firebase/auth` entry points that need
 * each one. `calls` is what the offline guard matches against the tree.
 */
export const REQUIRED_PROVIDERS = {
  password: {
    label: "Email/Password",
    calls: ["signInWithEmailAndPassword", "createUserWithEmailAndPassword", "sendPasswordResetEmail"],
    why:
      "The email registration route sets a password server-side and then signs in with it " +
      "(src/app/verify-email/[tokenId]/LoginEmailVerified.tsx); collaborators and email-route " +
      "members sign in with it afterwards (src/auth/signInWithEmailPassword.ts). With this " +
      "off, every email sign-up strands after its password. The end-to-end harness signs its " +
      "fixtures in the same way (scripts/e2e/lib/identity.mjs).",
  },
  "google.com": {
    label: "Google",
    calls: ["GoogleAuthProvider", "signInWithCredential"],
    why:
      "Members sign in with Google: the Google Identity Services button hands back an ID " +
      "token and src/auth/signInWithGoogle.ts exchanges it. With this off, nobody who " +
      "registered with Google can sign in.",
  },
};

/**
 * `firebase/auth` entry points that need no provider switched on, each with
 * the reason. Listed so the offline guard can tell "needs nothing" from "nobody
 * classified this yet".
 */
export const NO_PROVIDER_NEEDED = {
  getAuth: "builds the client handle",
  onAuthStateChanged: "listens to the session the SDK already holds",
  signOut: "ends that session",
  signInWithCustomToken:
    "the token is minted by the Admin SDK (the magic-link landing, admin view-as), which no provider switch governs",
  sendEmailVerification: "asks Firebase to mail the signed-in account; no provider switch governs it",
};

/**
 * Identity providers that must stay OFF, each with the credential shape its
 * sign-in endpoint will look at. No code signs in through them, so one
 * switched on is a way into the project that nothing here reviews.
 *
 * Only providers the public mode can READ are listed. Each of these answers
 * `OPERATION_NOT_ALLOWED` to the shape beside it while it is off (tried
 * against both projects, October 2026). Microsoft and Yahoo reject every
 * made-up credential before they say whether they are configured, so they
 * cannot be told apart from here; `--admin` reads the whole provider list and
 * covers them, along with anonymous, phone and email-link sign-in.
 */
export const PROVIDERS_KEPT_OFF = {
  "apple.com": "id_token=not-a-token",
  "facebook.com": "access_token=not-a-token",
  "github.com": "access_token=not-a-token",
  "twitter.com": "access_token=not-a-token&oauth_token_secret=not-a-secret",
};

/** The credential shape Google's endpoint looks at. */
const GOOGLE_CREDENTIAL = "id_token=not-a-token";

/**
 * Every project the site runs on. A new project is one line here, and it is
 * held to the same expectation from its first day.
 */
export const PROJECTS = {
  "naisi-website": { serves: "production, naisi.uk" },
  "naisi-uk-dev": { serves: "staging, dev.naisi.uk" },
};

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com";

/** What a refusal says about the provider that issued it. */
export function readRefusal(message) {
  const code = String(message ?? "").split(":")[0].trim();
  // The credential was looked at and rejected, so the provider is on.
  if (["INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND", "INVALID_PASSWORD", "INVALID_IDP_RESPONSE"].includes(code)) {
    return "on";
  }
  // The operation itself was refused, so the provider is off (or was never
  // configured, which reads the same to somebody trying to sign in).
  if (["PASSWORD_LOGIN_DISABLED", "OPERATION_NOT_ALLOWED"].includes(code)) return "off";
  return "unknown";
}

async function webApiKey(project, fetchImpl) {
  // Firebase Hosting serves each project's public web configuration at a
  // reserved address on the project's default domain. The key in it is the one
  // every browser already receives.
  const url = `https://${project}.firebaseapp.com/__/firebase/init.json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`could not read the public web configuration (${url} answered ${res.status})`);
  const config = await res.json();
  if (config.projectId !== project) {
    throw new Error(`${url} describes project ${JSON.stringify(config.projectId)}, not ${project}`);
  }
  if (typeof config.apiKey !== "string" || config.apiKey === "") {
    throw new Error(`${url} carries no web API key`);
  }
  return config.apiKey;
}

async function refusalOf(method, key, body, fetchImpl) {
  const res = await fetchImpl(`${IDENTITY_TOOLKIT}/v1/accounts:${method}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await res.json().catch(() => ({}));
  if (res.ok) {
    // A sign-in with made-up credentials succeeded. Nothing sensible follows
    // from that, so it is reported rather than interpreted.
    return { state: "unknown", detail: "the sign-in attempt was ACCEPTED" };
  }
  const message = answer?.error?.message ?? `HTTP ${res.status} with no error message`;
  return { state: readRefusal(message), detail: message };
}

/** Is this provider on? Asked the way a browser would ask. */
export async function probeProvider(provider, key, fetchImpl = fetch) {
  if (provider === "password") {
    return refusalOf(
      "signInWithPassword",
      key,
      // An address on a reserved top-level domain, so it can never be an account.
      { email: "sign-in-provider-check@naisi.invalid", password: "not-a-real-password", returnSecureToken: true },
      fetchImpl,
    );
  }
  const credential = provider === "google.com" ? GOOGLE_CREDENTIAL : PROVIDERS_KEPT_OFF[provider];
  if (!credential) throw new Error(`no credential shape is recorded for ${provider}, so it cannot be probed`);
  return refusalOf(
    "signInWithIdp",
    key,
    {
      postBody: `${credential}&providerId=${encodeURIComponent(provider)}`,
      requestUri: "http://localhost",
      returnSecureToken: true,
    },
    fetchImpl,
  );
}

/**
 * The public look at one project. Returns `{ failures, unknowns, lines }`:
 * failures are drift, unknowns are looks that could not be completed.
 */
export async function checkProjectPublicly(project, fetchImpl = fetch) {
  const lines = [];
  const failures = [];
  const unknowns = [];
  const key = await webApiKey(project, fetchImpl);

  for (const [provider, { label, why }] of Object.entries(REQUIRED_PROVIDERS)) {
    const { state, detail } = await probeProvider(provider, key, fetchImpl);
    if (state === "on") lines.push(`PASS  ${project}: ${label} sign-in is on`);
    else if (state === "off") {
      failures.push(
        `${project}: ${label} sign-in is OFF, and the code needs it.\n` +
          `  ${why}\n` +
          `  Fix: Firebase console, Authentication, Sign-in method, enable ${label}. Then re-run this check.`,
      );
    } else unknowns.push(`${project}: could not tell whether ${label} sign-in is on (${detail})`);
  }

  for (const provider of Object.keys(PROVIDERS_KEPT_OFF)) {
    const { state, detail } = await probeProvider(provider, key, fetchImpl);
    if (state === "off") lines.push(`PASS  ${project}: ${provider} sign-in is off`);
    else if (state === "on") {
      failures.push(
        `${project}: ${provider} sign-in is ON, and no code signs in through it.\n` +
          `  A provider nothing uses is a way into the project that nothing reviews. Switch it\n` +
          `  off, or add it to REQUIRED_PROVIDERS in this file with the code that calls it.`,
      );
    } else unknowns.push(`${project}: could not tell whether ${provider} sign-in is off (${detail})`);
  }
  return { failures, unknowns, lines };
}

/** What `--admin` requires of a project's configuration, both directions. */
export function checkAdminConfig(project, config, idps) {
  const failures = [];
  const lines = [];
  const signIn = config?.signIn ?? {};

  if (signIn.email?.enabled === true) lines.push(`PASS  ${project}: Email/Password sign-in is on`);
  else failures.push(`${project}: Email/Password sign-in is OFF, and the code needs it.\n  ${REQUIRED_PROVIDERS.password.why}`);
  if (signIn.email?.enabled === true && signIn.email?.passwordRequired !== true) {
    failures.push(
      `${project}: email link (passwordless) sign-in is ON. No code uses it, and it lets an inbox\n` +
        `  stand in for the password the registration route makes people set.`,
    );
  }
  if (signIn.anonymous?.enabled === true) {
    failures.push(`${project}: anonymous sign-in is ON. No code uses it, and it mints accounts for anybody.`);
  } else lines.push(`PASS  ${project}: anonymous sign-in is off`);
  if (signIn.phoneNumber?.enabled === true) {
    failures.push(`${project}: phone sign-in is ON. No code uses it.`);
  } else lines.push(`PASS  ${project}: phone sign-in is off`);

  const enabledIdps = (idps ?? [])
    .filter((idp) => idp.enabled === true)
    .map((idp) => String(idp.name ?? "").split("/").pop());
  const wantedIdps = Object.keys(REQUIRED_PROVIDERS).filter((p) => p !== "password");
  for (const idp of wantedIdps) {
    if (enabledIdps.includes(idp)) lines.push(`PASS  ${project}: ${idp} sign-in is on`);
    else failures.push(`${project}: ${idp} sign-in is OFF, and the code needs it.\n  ${REQUIRED_PROVIDERS[idp].why}`);
  }
  for (const idp of enabledIdps) {
    if (!wantedIdps.includes(idp)) {
      failures.push(`${project}: ${idp} sign-in is ON, and no code signs in through it.`);
    }
  }

  if (config?.emailPrivacyConfig?.enableImprovedEmailPrivacy === true) {
    lines.push(`PASS  ${project}: email enumeration protection is on`);
  } else {
    failures.push(
      `${project}: email enumeration protection is OFF, so a sign-in attempt tells a stranger\n` +
        `  whether an address has an account.`,
    );
  }
  return { failures, lines };
}

async function accessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("no access token: run `gcloud auth application-default login`");
  return token;
}

async function checkProjectAsAdmin(project) {
  const token = await accessToken();
  // A user credential needs to say which project's quota the call is billed
  // to, or these endpoints answer 403 and read as empty.
  const headers = { authorization: `Bearer ${token}`, "x-goog-user-project": project };
  const read = async (path) => {
    const res = await fetch(`${IDENTITY_TOOLKIT}/admin/v2/projects/${project}/${path}`, { headers });
    if (!res.ok) {
      const hint = res.status === 403 ? " (the caller needs firebaseauth.configs.get on the project)" : "";
      throw new Error(`could not read ${path} on ${project}: HTTP ${res.status}${hint}`);
    }
    return res.json();
  };
  const config = await read("config");
  const idps = (await read("defaultSupportedIdpConfigs")).defaultSupportedIdpConfigs ?? [];
  return { ...checkAdminConfig(project, config, idps), unknowns: [] };
}

function parseArgs(argv) {
  let admin = false;
  let projects = Object.keys(PROJECTS);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--admin") admin = true;
    else if (argv[i] === "--project") {
      const project = argv[i + 1];
      i += 1;
      if (!(project in PROJECTS)) {
        throw new Error(`Unknown project "${project}". Expected one of: ${Object.keys(PROJECTS).join(", ")}.`);
      }
      projects = [project];
    } else throw new Error(`Unknown argument "${argv[i]}".`);
  }
  return { admin, projects };
}

async function main() {
  const { admin, projects } = parseArgs(process.argv.slice(2));
  const failures = [];
  const unknowns = [];

  for (const project of projects) {
    try {
      const result = admin ? await checkProjectAsAdmin(project) : await checkProjectPublicly(project);
      for (const line of result.lines) console.log(line);
      failures.push(...result.failures);
      unknowns.push(...result.unknowns);
    } catch (err) {
      unknowns.push(`${project}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.error(`\nSign-in provider guard: ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`FAIL  ${f}\n`);
  }
  if (unknowns.length) {
    console.error(`\nSign-in provider guard: ${unknowns.length} look(s) could not be completed\n`);
    for (const u of unknowns) console.error(`FAIL  ${u}\n`);
  }
  if (failures.length) process.exit(1);
  if (unknowns.length) process.exit(2);

  const needed = Object.values(REQUIRED_PROVIDERS).map((p) => p.label).join(" and ");
  console.log(
    admin
      ? `\nSign-in providers OK on ${projects.join(" and ")} (configuration read): ${needed} on, nothing else.`
      : `\nSign-in providers OK on ${projects.join(" and ")} (public look): ${needed} on; ` +
          `${Object.keys(PROVIDERS_KEPT_OFF).join(", ")} off. Anonymous, phone, email-link, Microsoft ` +
          `and Yahoo sign-in are visible only to --admin.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(2);
  });
}
