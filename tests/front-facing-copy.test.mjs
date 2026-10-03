/**
 * Three decisions about what the site says, held in place.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * 1. THE SITE DOES NOT PROMISE HOW OFTEN IT EMAILS. Both sign-up forms and the
 *    profile's notification grid described the newsletter and the event
 *    announcements as low frequency. Event announcements go out whenever an
 *    event is published, which in freshers' week is often, so the promise was
 *    one the society did not keep and had no way to. The phrase had been
 *    pasted into five places, which is how it would come back. Copy says what
 *    an email IS; it does not say how many there will be.
 *
 * 2. /resources IS HIDDEN FOR NOW. The page is being rewritten and the owner
 *    would rather nothing showed than what is there. A temporary redirect in
 *    next.config.ts takes over from the page without touching it, and nothing
 *    on the site links to it. TO BRING IT BACK: delete the /resources entry in
 *    next.config.ts, restore the three links commented out in PublicHeader,
 *    PublicFooter and src/content/links.ts, and delete the second part of
 *    this file.
 *
 * 3. COPY A MEMBER READS NEVER NAMES THE OPERATOR'S TOOLS. When production's
 *    Email/Password provider was switched off, the sign-in page told every
 *    person who hit it to "Enable Email/Password in the Firebase console": an
 *    instruction for the one person who runs the project, shown to everyone
 *    who does not. A fault on our side is reported to a member as a fault on
 *    our side and nothing else. Admin screens are the exception, and the whole
 *    of it: an admin IS the operator, and "edit the document in the Firebase
 *    console" is the right thing to tell one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (file) => relative(REPO_ROOT, file).split("\\").join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** Code with its comments gone and its strings kept: copy lives in strings. */
const copyOf = (file) => stripSource(readFileSync(file, "utf8"), { keepStrings: true });

describe("the site does not promise how often it emails", () => {
  // The published legal texts are frozen archives with their own guard, and
  // they make no such promise anyway.
  const FROZEN = "src/content/legal/";
  const PROMISE = /low[- ]?frequency|low[- ]?volume|infrequent(ly)? (email|update|message)|only (email|message) (you )?occasionally/i;

  test("no string or JSX text under src makes the promise", () => {
    const offenders = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const path = posix(file);
      if (path.startsWith(FROZEN)) continue;
      const hit = copyOf(file).match(PROMISE);
      if (hit) offenders.push(`${path}: "${hit[0]}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "Say what the email is, not how many there will be. Event announcements go out " +
        "whenever an event is published, so a promise of low volume is one nobody can keep.",
    );
  });

  test("the detector sees the phrase in copy and ignores it in a comment", () => {
    assert.match(stripSource('const d = "A round-up. Low frequency.";', { keepStrings: true }), PROMISE);
    assert.doesNotMatch(stripSource("// Low-volume use case; the race is benign\nconst x = 1;", { keepStrings: true }), PROMISE);
  });
});

describe("/resources is hidden for now", () => {
  test("a temporary redirect takes over from the page", () => {
    const config = stripSource(readFileSync(join(REPO_ROOT, "next.config.ts"), "utf8"), { keepStrings: true });
    assert.match(
      config,
      /source: "\/resources",\s*destination: "\/",\s*permanent: false/,
      "the redirect is missing, or is permanent. A 308 is cached by browsers for good, and this is meant to be undone.",
    );
  });

  test("the page it hides is still there to bring back", () => {
    assert.doesNotThrow(() => statSync(join(REPO_ROOT, "src/app/(public)/resources/page.tsx")));
  });

  test("nothing on the site links to it", () => {
    // A link to a page that redirects home bounces somebody back to where
    // they started. Comments are stripped, so the three links commented out
    // for the restore do not count.
    const offenders = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const path = posix(file);
      if (path.startsWith("src/app/(public)/resources/")) continue;
      if (/["'`]\/resources["'`#?]/.test(copyOf(file))) offenders.push(path);
    }
    assert.deepEqual(offenders, []);
  });
});

describe("copy a member reads never names the operator's tools", () => {
  // Consoles and control panels only the project's operator can open. A phrase
  // goes here when it would be an instruction nobody reading it can follow.
  const OPERATOR_TOOL =
    /firebase console|firestore console|google cloud console|cloud console|secret manager|app hosting (console|backend|settings)|cloudflare (dashboard|account)|resend dashboard/i;

  // The only places an operator instruction belongs, each a tree that an
  // admin-only gate stands in front of. tests/no-admin-gating.test.mjs holds
  // the gate; this list holds the reason.
  const OPERATOR_SCREENS = {
    "src/app/(app)/admin/": "the admin area, every page of which is role-gated",
    "src/features/admin/": "the components those pages render, and the mutations behind them",
  };
  // Lines written FOR the operator, in a place only the operator reads: the
  // server log, or the error a deployment raises while it is being set up.
  const OPERATOR_LOGS = {
    "src/app/api/scheduler/tick/route.ts":
      "a console.warn in the server log when the scheduler secret is not provisioned",
    "src/lib/recaptcha/server.ts":
      "a console.error at boot when a production backend has no reCAPTCHA secret",
    "src/lib/signedTokens.ts":
      "the error raised on a deployment that has no token secret, read by whoever is setting it up",
  };
  // Frozen archives with their own guard. A policy names its processors, which
  // is a different thing from telling the reader to go and operate one.
  const FROZEN = "src/content/legal/";

  test("no string or JSX text outside the admin area names one", () => {
    const offenders = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const path = posix(file);
      if (path.startsWith(FROZEN)) continue;
      if (Object.keys(OPERATOR_SCREENS).some((tree) => path.startsWith(tree))) continue;
      if (path in OPERATOR_LOGS) continue;
      const hit = copyOf(file).match(OPERATOR_TOOL);
      if (hit) offenders.push(`${path}: "${hit[0]}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "This copy can reach somebody who is not an admin. Say what has gone wrong for them " +
        "(\"isn't available right now\"), and put the instruction for the operator in a log line, " +
        "a guard, or an admin screen.",
    );
  });

  test("every exemption still exists and still holds copy that needs it", () => {
    // The other direction: an exemption nothing uses is one a later change
    // can hide behind.
    for (const tree of Object.keys(OPERATOR_SCREENS)) {
      const dir = join(REPO_ROOT, tree);
      assert.doesNotThrow(() => statSync(dir), `${tree} is exempt and no longer exists`);
      const uses = [...walk(dir)].some((file) => OPERATOR_TOOL.test(copyOf(file)));
      assert.ok(uses, `${tree} is exempt and nothing in it names an operator tool any more: remove the exemption`);
    }
    for (const path of Object.keys(OPERATOR_LOGS)) {
      const file = join(REPO_ROOT, path);
      assert.doesNotThrow(() => statSync(file), `${path} is exempt and no longer exists`);
      assert.match(copyOf(file), OPERATOR_TOOL, `${path} is exempt and no longer names an operator tool: remove the exemption`);
    }
  });

  test("an exempt log line is written to the log, not sent in a response", () => {
    // What makes each OPERATOR_LOGS entry safe is where the string goes. A
    // string handed to console or thrown is the operator's; one handed to a
    // response is the member's, whatever the file.
    for (const path of Object.keys(OPERATOR_LOGS)) {
      const code = copyOf(join(REPO_ROOT, path));
      for (const m of code.matchAll(new RegExp(OPERATOR_TOOL.source, "gi"))) {
        const before = code.slice(Math.max(0, m.index - 400), m.index);
        const opener = [...before.matchAll(/console\.(warn|error|info|log)\(|throw new Error\(|NextResponse\.json\(|new Response\(/g)].pop();
        assert.ok(opener, `${path}: could not tell where "${m[0]}" is sent`);
        assert.doesNotMatch(opener[0], /Response/, `${path}: "${m[0]}" is sent in a response`);
      }
    }
  });

  test("the detector sees the phrase in copy and ignores it in a comment", () => {
    assert.match(
      stripSource('const m = "Enable Email/Password in the Firebase console.";', { keepStrings: true }),
      OPERATOR_TOOL,
    );
    assert.doesNotMatch(
      stripSource("// so the Firebase Console stays scannable\nconst x = 1;", { keepStrings: true }),
      OPERATOR_TOOL,
    );
  });

  test("the sign-in error that started this says only that sign-in is unavailable", () => {
    const copy = copyOf(join(REPO_ROOT, "src/auth/signInWithEmailPassword.ts"));
    const message = copy.match(/"auth\/operation-not-allowed":\s*"([^"]+)"/);
    assert.ok(message, "the provider-disabled error is no longer mapped to friendly copy");
    assert.doesNotMatch(message[1], /enable|console|provider|firebase/i);
  });
});
