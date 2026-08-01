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
  /["'`]?\brole["'`]?\s*:\s*/,
  /["'`]?\bsuRecognised["'`]?\s*:/,
  /["'`]?\bpermissions["'`]?\s*:/,
  /\bdraftNewsletter\b/,
  /\bapproveNewsletter\b/,
  /\bdraftEvent\b/,
  /\bapproveEvent\b/,
  /\bsetCustomUserClaims\b/,
];

/**
 * Firestore reachability. Rather than enumerate write verbs — which cannot be
 * done cleanly, since `.update(` is also a crypto method and a narrower call
 * chain is trivially evaded by a line break — this asserts the harness never
 * obtains a Firestore handle at all. No handle, no writes and no reads: a
 * strictly stronger property, and one that cannot false-positive on
 * `createHmac().update()`.
 */
const FORBIDDEN_FIRESTORE = [
  /firebase-admin\/firestore/,
  /\bgetFirestore\b/,
  /\.firestore\(/,
  /\bcollection\(/,
  /\bsetDoc\b/,
  /\baddDoc\b/,
  /\bupdateDoc\b/,
  /\bdeleteDoc\b/,
  /\bFieldValue\b/,
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

test("the e2e harness never reaches Firestore at all", () => {
  for (const file of sourceFiles(E2E_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_FIRESTORE) {
      assert.ok(
        !pattern.test(source),
        `${relative(REPO_ROOT, file)} matches ${pattern} — the harness runs against the ` +
          "dev project, which holds real member data. Its only mutations anywhere are " +
          "creating and deleting its own namespaced Auth accounts; it must not obtain a " +
          "Firestore handle, for reading or writing.",
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
  ]) {
    assert.doesNotThrow(
      () => assertTarget(target),
      `assertTarget rejected ${JSON.stringify(target)}, which the harness needs.`,
    );
  }
});
