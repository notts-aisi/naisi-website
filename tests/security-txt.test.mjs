/**
 * The two files that tell a stranger how to report a security problem (run
 * via `npm test`, Node's built-in test runner, no dependencies).
 *
 * `public/.well-known/security.txt` is the address a researcher's tooling
 * looks at (RFC 9116), and `SECURITY.md` is the page GitHub shows beside the
 * "Report a vulnerability" button. Both are easy to write once and forget,
 * and a stale one is worse than none: RFC 9116 makes `Expires` mandatory and
 * tells readers to distrust the file after that date, so a lapsed file says
 * "nobody maintains this" at the moment somebody is deciding whether to
 * report privately or post publicly.
 *
 * So this fails thirty days BEFORE the file expires, on whatever pull request
 * happens to be open, with the one-line fix in the message. It also holds the
 * two files to each other: the route the text file advertises must be a route
 * the policy describes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECURITY_TXT = join(REPO_ROOT, "public", ".well-known", "security.txt");
const SECURITY_MD = join(REPO_ROOT, "SECURITY.md");

const DAY = 24 * 60 * 60 * 1000;

/** Field name (lower case) to every value it carries, comments and blanks dropped. */
function fields(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    assert.ok(at > 0, `security.txt has a line that is neither a comment nor "Field: value": "${line}"`);
    const name = line.slice(0, at).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(at + 1).trim()]);
  }
  return out;
}

test("security.txt exists, is current, and says where to report", () => {
  assert.ok(existsSync(SECURITY_TXT), "public/.well-known/security.txt is missing");
  const f = fields(readFileSync(SECURITY_TXT, "utf8"));

  const contacts = f.get("contact") ?? [];
  assert.ok(contacts.length > 0, "security.txt needs at least one Contact");
  for (const c of contacts) {
    assert.ok(/^(https:\/\/|mailto:)/.test(c), `Contact "${c}" must be an https: or mailto: address`);
  }

  const expires = f.get("expires") ?? [];
  assert.equal(expires.length, 1, "security.txt must carry exactly one Expires");
  const when = Date.parse(expires[0]);
  assert.ok(!Number.isNaN(when), `Expires "${expires[0]}" is not a date`);
  const daysLeft = Math.floor((when - Date.now()) / DAY);
  assert.ok(
    daysLeft >= 30,
    `security.txt expires in ${daysLeft} days (${expires[0]}). Move Expires in ` +
      "public/.well-known/security.txt to a date just under a year from today and commit.",
  );
  assert.ok(
    daysLeft <= 366,
    `security.txt expires ${daysLeft} days from now. RFC 9116 asks for less than a year, ` +
      "so that the file is looked at once a year.",
  );

  assert.deepEqual(
    f.get("canonical"),
    ["https://naisi.uk/.well-known/security.txt"],
    "Canonical must name the production address the file is served from",
  );
});

test("SECURITY.md exists and describes every route security.txt advertises", () => {
  assert.ok(existsSync(SECURITY_MD), "SECURITY.md is missing from the repository root");
  const policy = readFileSync(SECURITY_MD, "utf8");
  const f = fields(readFileSync(SECURITY_TXT, "utf8"));

  for (const c of f.get("contact") ?? []) {
    const shown = c.replace(/^mailto:/, "");
    assert.ok(policy.includes(shown), `security.txt advertises "${c}" but SECURITY.md never mentions it`);
  }
  const [policyUrl] = f.get("policy") ?? [];
  assert.ok(policyUrl?.endsWith("/SECURITY.md"), "security.txt's Policy must point at SECURITY.md");
});
