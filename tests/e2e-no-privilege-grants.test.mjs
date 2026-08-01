/**
 * Offline guard on the e2e harness (runs under `npm test` — no network, no
 * credentials, no dev project involved).
 *
 * The harness authenticates against the dev project, which holds real people's
 * data. Two properties must therefore stay true no matter who edits it next,
 * and a comment saying so is not enforcement:
 *
 *   1. It never grants a privilege. No role, no permissions map, no
 *      `suRecognised`. The accounts it creates are bare Auth users with no
 *      Firestore document, which means no role at all — not even `pending`.
 *   2. It never writes to Firestore. Not `users/`, not anything. Read-only
 *      against the database; the only mutation it performs anywhere is
 *      creating and deleting its own namespaced Auth accounts.
 *
 * If a future phase genuinely needs a seeded `member` (the design brief caps
 * the fixture ladder there), this test is the deliberate speed bump: loosening
 * it has to be an explicit, reviewable diff that says which privilege is being
 * granted and why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(REPO_ROOT, "scripts", "e2e");

/** Privilege-granting shapes. Matched on assignment, so prose is unaffected. */
const FORBIDDEN_PRIVILEGE = [
  /\brole\s*:\s*["'`]/,
  /\bsuRecognised\s*:/,
  /\bpermissions\s*:\s*\{/,
  /\bdraftNewsletter\b/,
  /\bapproveNewsletter\b/,
  /\bdraftEvent\b/,
  /\bapproveEvent\b/,
];

/** Firestore mutation calls. The harness must not write to the database. */
const FORBIDDEN_WRITES = [
  /\.collection\([^)]*\)\s*\.doc\([^)]*\)\s*\.set\(/,
  /\.collection\([^)]*\)\s*\.add\(/,
  /\bbatch\(\)/,
  /\.update\(\s*\{/,
  /\bsetDoc\(/,
  /\baddDoc\(/,
  /\bupdateDoc\(/,
  /\bdeleteDoc\(/,
  /\bFieldValue\./,
];

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

test("the e2e harness never writes to Firestore", () => {
  for (const file of sourceFiles(E2E_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_WRITES) {
      assert.ok(
        !pattern.test(source),
        `${relative(REPO_ROOT, file)} matches ${pattern} — the harness runs against the ` +
          "dev project, which holds real member data. It may read, and may create/delete " +
          "its own namespaced Auth accounts, but must not write documents.",
      );
    }
  }
});

test("the e2e harness pins the dev project and refuses production origins", () => {
  const env = readFileSync(join(E2E_DIR, "lib", "env.mjs"), "utf8");
  assert.match(
    env,
    /naisi-website-dev/,
    "env.mjs must hard-code the dev project id as a tripwire.",
  );
  assert.match(
    env,
    /PRODUCTION_ORIGINS/,
    "env.mjs must name production origins explicitly so aiming at them fails loudly.",
  );
  assert.ok(
    !/["'`]https:\/\/naisi\.uk["'`]\s*,?\s*\n?\s*(\]|["'`]https:\/\/dev)/.test(
      env.replace(/PRODUCTION_ORIGINS[\s\S]*?\];/, ""),
    ),
    "the production origin must not appear in the ALLOWED_ORIGINS list.",
  );
});
