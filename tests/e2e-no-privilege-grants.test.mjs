/**
 * Offline guards on the e2e harness (run under `npm test` — no network, no
 * credentials, no dev project involved).
 *
 * The harness authenticates against the dev project, which holds real people's
 * data. Three properties must stay true no matter who edits it next, and a
 * comment saying so is not enforcement:
 *
 *   1. It can never be aimed at production.
 *   2. It never grants a privilege — no role, no permissions map, no
 *      `suRecognised`. Its accounts are bare Auth users with no Firestore
 *      document, so they hold no role at all.
 *   3. It never reaches Firestore at all — not to write, not to read.
 *
 * Property 1 is tested BEHAVIOURALLY, by calling the real `assertTarget()`.
 * An earlier version pattern-matched the source of the allowlist and was shown
 * by review to miss production inserted anywhere except first or last in the
 * array. Properties 2 and 3 are source greps, which are heuristic by nature:
 * they are a deliberate speed bump, not a proof. Anything that defeats them is
 * also, by construction, an obfuscated privilege grant — which is a reviewable
 * act, and that is the point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTarget } from "../scripts/e2e/lib/env.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(REPO_ROOT, "scripts", "e2e");

/**
 * Privilege-granting shapes, in both bare-identifier and quoted-key spellings
 * (a .mjs file building a JSON body naturally writes `"role": "admin"`), plus
 * assignment from a variable.
 */
const FORBIDDEN_PRIVILEGE = [
  // Any role literal other than "pending" — Phase 2 seeds a pending user doc
  // (the lowest role, which grants access to nothing) and nothing above it.
  /\brole["'`]?\s*:\s*["'`](?!pending)/,
  /["'`]?\bsuRecognised["'`]?\s*:/,
  /["'`]?\bpermissions["'`]?\s*:/,
  /\bdraftNewsletter\b/,
  /\bapproveNewsletter\b/,
  /\bdraftEvent\b/,
  /\bapproveEvent\b/,
  /\bsetCustomUserClaims\b/,
];

/**
 * Phase 1 asserted the harness never obtained a Firestore handle at all.
 * Phase 2 needs one: its headline assertion is that
 * `users/{uid}.profile.uniEmailVerifiedAt` really landed, and only an Admin-SDK
 * read proves that (the UI reads "verified" either way — which is precisely why
 * the two-phase stamp gap was invisible by hand and needed PR #216).
 *
 * So the invariant narrowed rather than vanished: Firestore is reachable, but
 * only these collections are. dev holds real member data, and a harness able
 * to address any collection is one bad edit away from touching it.
 *
 * `registrations` was added by Phase 3 (the local /api/register batteries):
 * the route mirrors each account it creates into a `registrations/{uid}`
 * tracker row, and deleting the Auth user while leaving its row would make the
 * admin signup tracker list registrations for accounts that no longer exist.
 * The harness only ever DELETES there, after re-reading the row and checking
 * its email sits inside the harness namespace — see deleteRegistrationRow in
 * scripts/e2e/lib/firestore.mjs.
 */
const ALLOWED_COLLECTIONS = ["users", "emailVerifications", "registrations"];

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(mjs|js|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("the e2e harness never grants a role, permission, or suRecognised", () => {
  const files = sourceFiles(E2E_DIR);
  assert.ok(files.length > 0, `expected harness sources under ${E2E_DIR}`);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_PRIVILEGE) {
      assert.ok(
        !pattern.test(source),
        `${relative(REPO_ROOT, file)} matches ${pattern} — the e2e harness must never ` +
          "construct a privileged identity. Its accounts are bare Auth users with no " +
          "Firestore doc, so they hold no role at all.",
      );
    }
  }
});

test("the e2e harness only ever addresses allowlisted Firestore collections", () => {
  for (const file of sourceFiles(E2E_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) {
      assert.ok(
        ALLOWED_COLLECTIONS.includes(match[1]),
        `${relative(REPO_ROOT, file)} addresses collection ${JSON.stringify(match[1])} — ` +
          `the harness may only reach ${ALLOWED_COLLECTIONS.join(", ")}. dev holds real ` +
          "member data.",
      );
    }
    // A non-literal collection name defeats the check above, so forbid it.
    for (const match of source.matchAll(/\.collection\(\s*([^"'`\s)])/g)) {
      assert.fail(
        `${relative(REPO_ROOT, file)} builds a collection name dynamically (` +
          `.collection(${match[1]}…) — use a string literal so the allowlist above ` +
          "can actually see it.",
      );
    }
  }
});

/**
 * `registrations` is on the allowlist for TEARDOWN ONLY — the harness deletes
 * tracker rows that /api/register created for its own accounts, and never
 * writes one. Collection-level allowlisting cannot express that, and a row
 * carries no `role` field, so a future `.set()` there would pass every other
 * guard in this file silently. The tracker is admin-facing data about real
 * people's registrations; writing it is not the harness's business.
 */
test("the e2e harness only ever DELETES from the registrations tracker", () => {
  for (const file of sourceFiles(E2E_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\.collection\(\s*["'`]registrations["'`][\s\S]{0,200}?\.(set|update|create|add)\(/g,
    )) {
      assert.fail(
        `${relative(REPO_ROOT, file)} calls .${match[1]}() on the registrations ` +
          "collection. The harness may only delete there — see " +
          "deleteRegistrationRow in scripts/e2e/lib/firestore.mjs.",
      );
    }
  }
});

test("assertTarget refuses production, however it is spelled", () => {
  const mustReject = [
    "https://naisi.uk",
    "https://naisi.uk/",
    "https://www.naisi.uk",
    "https://NAISI.UK",
    "https://naisi.uk/api/register",
    "https://naisi.uk:443",
    // userinfo trick: the origin is production even though it reads as dev
    "https://dev.naisi.uk@naisi.uk",
    // trailing-dot FQDN form
    "https://naisi.uk.",
    // a plausible future staging host nobody allowlisted
    "https://staging.naisi.uk",
    "not a url",
    "",
  ];
  for (const target of mustReject) {
    assert.throws(
      () => assertTarget(target),
      `assertTarget accepted ${JSON.stringify(target)}. Every origin outside the ` +
        "explicit allowlist must be refused — this is the only guard standing " +
        "between a typo and real registrations against production.",
    );
  }
});

test("assertTarget still accepts the dev origin and localhost", () => {
  for (const target of [
    "https://dev.naisi.uk",
    "https://dev.naisi.uk/api/verify-email/send",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    // The Phase 3 local server (run.mjs binds it to 127.0.0.1 explicitly).
    "http://127.0.0.1:3100",
  ]) {
    assert.doesNotThrow(
      () => assertTarget(target),
      `assertTarget rejected ${JSON.stringify(target)}, which the harness needs.`,
    );
  }
});
