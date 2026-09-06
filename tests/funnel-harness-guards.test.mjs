/**
 * Offline guards on the BROWSER end-to-end harness (run under `npm test` - no
 * network, no credentials, no dev project involved).
 *
 * `tests/e2e-no-privilege-grants.test.mjs` fences the AUTH harness into three
 * Firestore collections. A browser fixture cannot live inside that fence (it
 * seeds admission rounds, course runs, events and membership periods), so it
 * sits outside it with a fence of its own, and this file is that fence. The
 * properties are the same three the auth harness holds, because they are the
 * properties dev needs:
 *
 *   1. It can never be aimed at production.
 *   2. It never grants a privilege. Its accounts are role `pending`, the
 *      lowest role there is, written by the auth harness's own seeder.
 *   3. It only ever addresses collections on its own declared list.
 *
 * Property 1 is tested BEHAVIOURALLY, by calling the real `assertTarget()` and
 * the fixture's own `assertFixtureTarget()`. Properties 2 and 3 are source
 * greps, which are heuristic by nature: a speed bump, not a proof. Anything
 * that defeats them is by construction an obfuscated privilege grant, which is
 * a reviewable act, and that is the point.
 *
 * A fourth property is specific to this harness and is why the file exists at
 * all rather than the fixtures being bolted onto the older guard: a browser
 * SPEC drives a live target, so the file that decides which target must be the
 * allowlist rather than a raw string.
 *
 * ## It WALKS the harness rather than listing it
 *
 * Six specs land on this scaffold at once, and a hand-written file list is a
 * list that goes stale on the first of them. So every check below runs over a
 * walk of `scripts/e2e-fixtures/`, `scripts/run-e2e.mjs`,
 * `scripts/seed-fake-applicants.mjs` and `tests/e2e/`, and the walk itself is
 * asserted to have found the four files that must always be in it, so an empty
 * or mis-rooted walk cannot pass by covering nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTarget } from "../scripts/e2e/lib/env.mjs";
import {
  ARTIFACTS_DIR,
  FIXTURE_COLLECTIONS,
  FIXTURE_SUBCOLLECTIONS,
  HARNESS_LOCAL_ORIGIN,
  RECAPTCHA_SKIP_REASON,
  STATE_DIR,
  applicationId,
  assertFixtureCollection,
  assertFixtureSubcollection,
  cohortChannel,
  emailDocId,
  enrolmentId,
  fixtureDoc,
  fixtureQuery,
  mailIsCaught,
  markerPath,
  stateDir,
  statePath,
  subscriptionId,
} from "../scripts/e2e-fixtures/core.mjs";
import {
  MARKER_PATH,
  STATE_PATH,
  WITHDRAW_WORD,
} from "../scripts/seed-fake-applicants.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(REPO_ROOT, "scripts", "e2e-fixtures");
const SPECS_DIR = join(REPO_ROOT, "tests", "e2e");
const CORE = join(FIXTURES_DIR, "core.mjs");
const RUNNER = join(REPO_ROOT, "scripts", "run-e2e.mjs");

function walkMjs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkMjs(path, out);
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

/**
 * Every file that makes up the browser harness, found rather than listed.
 *
 * The two single files are named because they are single files: the runner and
 * the hand-driven fixture CLI. Everything else is a directory that grows.
 */
const HARNESS_FILES = [
  ...walkMjs(FIXTURES_DIR),
  join(REPO_ROOT, "scripts", "run-e2e.mjs"),
  join(REPO_ROOT, "scripts", "seed-fake-applicants.mjs"),
  ...walkMjs(SPECS_DIR),
].filter((path) => existsSync(path));

/** The fixture modules, which are the spec modules: everything but core. */
const FIXTURE_MODULES = walkMjs(FIXTURES_DIR).filter((path) => path !== CORE);

const rel = (path) => relative(REPO_ROOT, path).split("\\").join("/");

test("the harness walk finds the files it is supposed to cover", () => {
  // Without this, a walk rooted at a path that no longer exists would find
  // nothing and every grep below would pass over an empty list. The four names
  // here are the ones that cannot go away: the shared floor, the worked
  // example, the runner and its spec.
  for (const required of [
    "scripts/e2e-fixtures/core.mjs",
    "scripts/e2e-fixtures/applicant-funnel.mjs",
    "scripts/run-e2e.mjs",
    "tests/e2e/applicant-funnel.spec.mjs",
  ]) {
    assert.ok(
      HARNESS_FILES.some((path) => rel(path) === required),
      `the harness walk did not find ${required}. Every check in this file runs over ` +
        "that walk, so a walk that misses a file silently stops guarding it.",
    );
  }
  assert.ok(FIXTURE_MODULES.length > 0, "no spec module was found beside core.mjs");
});

/**
 * Privilege-granting shapes, in both bare-identifier and quoted-key spellings,
 * matching the auth harness's list. The `role` pattern admits ONE value,
 * `"pending"`, the governance role on `users` that `seedPendingUserDoc`
 * hard-codes and the only one this harness may ever write. Every other
 * spelling is refused.
 *
 * A fixture that has to store a non-governance role (`courseEnrolments.role`
 * is "learner" or "facilitator") writes it through a named constant rather
 * than a quoted literal, so this pattern never has to be widened: widening it
 * would spend a live fence on a case that never needed one. The register
 * fixture is the worked example (`const LEARNER = "learner"` in
 * scripts/e2e-fixtures/register-push.mjs).
 *
 * The negative control below keeps that narrowness honest.
 */
const FORBIDDEN_PRIVILEGE = [
  /\brole["'`]?\s*:\s*["'`](?!pending)/,
  /["'`]?\bsuRecognised["'`]?\s*:/,
  /["'`]?\bpermissions["'`]?\s*:/,
  /\bdraftNewsletter\b/,
  /\bapproveNewsletter\b/,
  /\bdraftEvent\b/,
  /\bapproveEvent\b/,
  /\bdraftCourse\b/,
  /\bapproveCourse\b/,
  /\bpaidMembershipYears\b/,
  /\bsetCustomUserClaims\b/,
  // Round-level authority. A fixture that named a reviewer or a decider would
  // be minting a review permission, which is exactly the shape rule 2 bans.
  // The `null` lookaheads sit immediately after the colon rather than after
  // `\s*`, because `\s*` can match zero characters and hand the lookahead the
  // space instead of the value, which passes every `: null` in the file.
  /\breviewerUids["'`]?\s*:\s*\[\s*[^\]\s]/,
  /\bfinalDeciderUid["'`]?\s*:(?!\s*null\b)/,
  /\brunFacilitatorUids["'`]?\s*:\s*\[\s*[^\]\s]/,
  /\badmissionsReviewerUids["'`]?\s*:\s*\[\s*[^\]\s]/,
  /\bfacilitatorUids["'`]?\s*:\s*\[\s*[^\]\s]/,
];

function sourceOf(file) {
  return readFileSync(file, "utf8");
}

/**
 * Source with comments removed.
 *
 * Every grep below is looking for CODE, and these files explain themselves at
 * length: the collection-allowlist prose quotes `.collection("...")` and the
 * privilege prose names the fields it promises never to write. Grepping raw
 * source makes a file fail its own documentation, which teaches the next
 * editor to delete the comment rather than to keep the property.
 *
 * Block comments and whole-line `//` comments only. A trailing `//` is left
 * alone so a `https://` inside a string is never truncated.
 */
function codeOf(file) {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("the browser harness never grants a role, permission, or round authority", () => {
  for (const file of HARNESS_FILES) {
    const source = codeOf(file);
    for (const pattern of FORBIDDEN_PRIVILEGE) {
      assert.ok(
        !pattern.test(source),
        `${rel(file)} matches ${pattern}. A browser fixture creates role-\`pending\` ` +
          "accounts and nothing above them; a privileged identity on the dev project " +
          "is not its to make. An admin a spec needs is the owner's own account, read " +
          "from .env.e2e.secrets.local, never one this harness can mint.",
      );
    }
  }
});

test("the role pattern still bites on every spelling it is meant to refuse", () => {
  // The negative control for the single value the pattern admits. A guard
  // widened by an exception is a guard whose remaining teeth nobody has
  // checked since, so the refusals are asserted here in every quoting style
  // and `"facilitator"` leads the list: it is the value of the same field a
  // course fixture may store, and it is exactly the appointment the
  // register's gate turns on.
  const [rolePattern] = FORBIDDEN_PRIVILEGE;
  for (const spelling of [
    'role: "facilitator"',
    'role: "learner"',
    'role: "admin"',
    'role: "committee"',
    'role: "member"',
    "role: 'admin'",
    'role: `admin`',
    '"role": "admin"',
  ]) {
    assert.ok(
      rolePattern.test(spelling),
      `the role pattern no longer refuses ${JSON.stringify(spelling)}. It admits ` +
        'the governance role "pending" as a literal and nothing else. A fixture ' +
        "that must store another value writes it through a named constant.",
    );
  }
  assert.ok(
    !rolePattern.test('role: "pending"'),
    'the role pattern refuses role: "pending", which seedPendingUserDoc has to be ' +
      "able to write.",
  );
});

test("assertFixtureCollection refuses everything off the fixture's list", () => {
  // BEHAVIOURAL, not a grep: the harness reaches its collections through one
  // checked chokepoint rather than twenty literal branches, so the thing worth
  // testing is the check itself. It must throw BEFORE any credential is
  // obtained, which is also why this test can run offline at all.
  for (const collection of FIXTURE_COLLECTIONS) {
    assert.doesNotThrow(
      () => assertFixtureCollection(collection),
      `assertFixtureCollection rejected ${collection}, which the fixture declares.`,
    );
  }
  for (const collection of [
    // Real member data, money, and the audit trails a fixture must never edit.
    "users",
    "impersonations",
    "newsletterDrafts",
    "admissionReviews",
    // Shared daily counters. A fixture cannot drain them without corrupting a
    // real number, so it may not create rows there either.
    "signupMetrics",
    // The committee credentials store and the scheduler's own bookkeeping.
    "credentials",
    "schedulerMarkers",
    // Near misses: a trailing space and the empty string must both fail, since
    // an allowlist that trims or coerces is an allowlist with a way round it.
    "suppressedEmails ",
    "",
  ]) {
    assert.throws(
      () => assertFixtureCollection(collection),
      `assertFixtureCollection accepted ${JSON.stringify(collection)}. dev holds ` +
        "real member data; the fixture's list is the whole fence.",
    );
  }
});

test("only the membership document is reachable in the config collection", () => {
  // `config` holds the scheduler cursors, the courses config and the task
  // email copy as well as the membership pointer. A membership spec has to
  // move the pointer and put it back; nothing here has any business near the
  // rest, and collection-level allowlisting cannot say so.
  //
  // Only the REFUSALS are asserted behaviourally: the accepting path builds a
  // Firestore handle, which needs credentials this suite deliberately does not
  // have. Both refusals throw before `db()` is ever called.
  for (const id of ["scheduler", "courses", "taskEmails", "membership-2", ""]) {
    assert.throws(
      () => fixtureDoc("config", id),
      `fixtureDoc accepted config/${JSON.stringify(id)}. membershipConfigDoc() is the ` +
        "only permitted way into that collection.",
    );
  }
  assert.throws(
    () => fixtureQuery("config"),
    "fixtureQuery accepted the config collection. A query there would list every " +
      "runtime config document.",
  );
  for (const sub of ["users", "reviews", "", "stages "]) {
    assert.throws(
      () => assertFixtureSubcollection(sub),
      `assertFixtureSubcollection accepted ${JSON.stringify(sub)}. "anything under a ` +
        'fixture document" would readmit every collection through a path the allowlist ' +
        "cannot see.",
    );
  }
});

test("the browser harness routes every collection access through the chokepoint", () => {
  // The grep half of the same fence, tightened since the funnel was the only
  // fixture: Firestore is now reachable from ONE file. `core.mjs` may call
  // `.collection(collection)`, the identifier both chokepoints have already
  // run through `assertFixtureCollection` (or, for a subcollection,
  // `assertFixtureSubcollection`), and `.collection("users")`, the document
  // each fixture account owns, which is written through the auth harness's own
  // guarded seeder and deleted by address under the namespace check on the
  // account it belongs to. Every other file in the harness must not call
  // `.collection(` at all, so a spec module cannot grow a second way in.
  const ALLOWED_IN_CORE = ['"users"', "collection"];
  for (const file of HARNESS_FILES) {
    const source = codeOf(file);
    for (const match of source.matchAll(/\.collection\(\s*([^)]*)\)/g)) {
      const arg = match[1].trim();
      assert.equal(
        file,
        CORE,
        `${rel(file)} calls .collection(${arg}). Firestore is reachable from ` +
          "scripts/e2e-fixtures/core.mjs and nowhere else in this harness: use " +
          "fixtureDoc, fixtureQuery, fixtureSubcollection or membershipConfigDoc.",
      );
      assert.ok(
        ALLOWED_IN_CORE.includes(arg),
        `core.mjs calls .collection(${arg}). Only the checked \`collection\` parameter ` +
          'of the chokepoints, or the literal "users", may reach Firestore.',
      );
    }
  }
  assert.match(
    sourceOf(CORE),
    /export function assertFixtureCollection\(/,
    "the chokepoint the grep above defers to must exist and be exported, so the " +
      "behavioural test can call it.",
  );
  assert.match(
    codeOf(CORE),
    /export const FIXTURE_SUBCOLLECTIONS = \["stages", "weeks"\];/,
    "FIXTURE_SUBCOLLECTIONS must stay a literal list: the grep above trusts " +
      "fixtureSubcollection because it can read the values here.",
  );
  assert.deepEqual(
    FIXTURE_SUBCOLLECTIONS,
    ["stages", "weeks"],
    "a subcollection joined the list. Add it to the pin above in the same change, " +
      "so the value stays readable off the source.",
  );
});

test("the funnel fixture declares every collection its teardown must drain", () => {
  // The house rule is that a PR adding a collection also adds it to the
  // destroy manifest in the same PR. The manifest is FIXTURE_COLLECTIONS, and
  // the failure mode it guards against is a step that creates rows somewhere
  // the counter never looks: teardown would then report zero and be wrong. So
  // the routes the specs drive are listed here by hand, and this test fails
  // when one is missing from the fixture. New specs extend this list.
  for (const required of [
    "admissionApplications",
    "admissionApplicationPrivate",
    "courseEnrolments",
    "courseAudit",
    "subscriptions",
    "subscriptionEvents",
    "tasks",
    "courseProgress",
    // The send log. Left behind on purpose until September 2026; that stance
    // is withdrawn, because on loopback the rows are the evidence a spec reads
    // and evidence a fixture creates is evidence it counts back to zero.
    "emailSends",
    // A register push writes one attendance document per session and member,
    // and claims a per-group nudge marker before it sends.
    "courseAttendance",
    "courseNudges",
    // The RSVP smoke: a fixture event and the attendee rows a guest creates.
    "events",
    "eventRsvps",
    // The membership console: the year, the rows under it, and the pointer at
    // config/membership that says which year is current.
    "membershipPeriods",
    "memberships",
    "config",
    // The sign-up spec: /api/register and /api/verify-email/send mint a
    // magic-link token each, and the register route mirrors the new account
    // into a signup tracker row. Both are deleted through the auth harness's
    // namespace-checking helpers and counted through the fixture chokepoint,
    // which is why they have to be reachable from it at all.
    "emailVerifications",
    "registrations",
  ]) {
    assert.ok(
      FIXTURE_COLLECTIONS.includes(required),
      `${required} is written by a route a spec drives but is not in ` +
        "FIXTURE_COLLECTIONS, so teardown would neither sweep it nor count it.",
    );
  }
});

test("every fixture checks the account namespace before it deletes anything", () => {
  // Teardown sweeps rows keyed on an ADDRESS out of the state file (a
  // subscription row, its event lines, the send log). The refusal that stops a
  // tampered or stale ledger deleting a real person's data is only a refusal
  // while it runs BEFORE those sweeps: the funnel had it inside the
  // account-deletion loop at the end, which is after every address-keyed
  // delete has already happened.
  for (const file of FIXTURE_MODULES) {
    const source = codeOf(file);
    // Creating an account is not the only way to own one. The sign-up fixture
    // seeds NO accounts at all: it decides the addresses and lets /api/register
    // create the account, then tears it down by address like everything else.
    // A fixture that reaches deleteHarnessUser is a fixture holding an address
    // out of a state file, which is exactly the hazard below, so the condition
    // is "creates OR removes", not "creates".
    const ownsAccounts =
      source.includes("createFixtureUser") || source.includes("deleteHarnessUser");
    if (!ownsAccounts) continue; // no accounts, no addresses
    const at = source.search(/async function teardown|teardown\s*=\s*async/);
    assert.ok(
      at !== -1,
      `${rel(file)}: creates accounts but no teardown could be found to check. Name it ` +
        "`teardown` so this guard can read it, rather than leaving the check unasserted.",
    );
    const body = source.slice(at);
    const check = body.indexOf("isHarnessAccount");
    assert.ok(
      check !== -1,
      `${rel(file)}: teardown removes rows for accounts this fixture created without ` +
        "ever calling isHarnessAccount. A hand-edited or stale state file naming a real " +
        "address would have its rows deleted.",
    );
    const deletes = [body.indexOf("deleteQuery("), body.indexOf(".delete(")].filter((i) => i !== -1);
    assert.ok(
      check < Math.min(...deletes),
      `${rel(file)}: teardown deletes something before it checks isHarnessAccount. The ` +
        "check has to come first, because the deletes below it are keyed on an address " +
        "out of the state file.",
    );
  }
});

test("every browser spec resolves its target through the allowlist, not a literal", () => {
  for (const file of walkMjs(SPECS_DIR)) {
    assert.match(
      sourceOf(file),
      /assertTarget\(/,
      `${rel(file)} must resolve its base URL through assertTarget(): a spec signs ` +
        "accounts in and writes through real routes, and a raw origin string is one " +
        "typo from doing that against production.",
    );
  }
  // Production must not appear as a literal anywhere in the harness, not even
  // in a comment that a later edit could uncomment into a default.
  for (const file of HARNESS_FILES) {
    assert.ok(
      !/["'`]https:\/\/(www\.)?naisi\.uk/.test(sourceOf(file)),
      `${rel(file)} contains the production origin as a string literal.`,
    );
  }
});

test("assertTarget still refuses production for the harness's default", () => {
  // The default target is the dev origin; the negative control is that the
  // same function still refuses production spellings, so a future "just point
  // it at prod for one run" edit cannot pass quietly.
  assert.doesNotThrow(() => assertTarget("https://dev.naisi.uk"));
  assert.doesNotThrow(() => assertTarget("http://127.0.0.1:3100"));
  for (const bad of ["https://naisi.uk", "https://www.naisi.uk", "https://dev.naisi.uk@naisi.uk"]) {
    assert.throws(
      () => assertTarget(bad),
      `assertTarget accepted ${JSON.stringify(bad)}. A browser run creates accounts and ` +
        "applications; production must stay unreachable.",
    );
  }
});

test("the harness sends the same bypass header the gate reads", () => {
  // Two literals, one on each side of the HTTP request. The harness cannot
  // import the TypeScript, so both are read off the source and compared; a
  // rename on either side fails here rather than as a silent skip in dev mode.
  const helper = readFileSync(join(REPO_ROOT, "scripts", "e2e", "lib", "browser.mjs"), "utf8");
  const gate = readFileSync(join(REPO_ROOT, "src", "lib", "recaptcha", "bypass.ts"), "utf8");
  const helperHeader = /export const RECAPTCHA_BYPASS_HEADER = "([^"]+)";/.exec(helper)?.[1];
  const gateHeader = /export const RECAPTCHA_BYPASS_HEADER = "([^"]+)";/.exec(gate)?.[1];
  assert.ok(helperHeader, "scripts/e2e/lib/browser.mjs no longer pins RECAPTCHA_BYPASS_HEADER as a literal");
  assert.ok(gateHeader, "src/lib/recaptcha/bypass.ts no longer pins RECAPTCHA_BYPASS_HEADER as a literal");
  assert.equal(
    helperHeader,
    gateHeader,
    "the harness and the gate disagree on the bypass header name, so every dev-mode " +
      "run would be refused and reported as a reCAPTCHA failure.",
  );
});

test("the fixture's restated production constants are pinned to literals", () => {
  // Every one of these is a copy of a rule that lives in src/. The fixture
  // cannot import them (they are TypeScript, and `emailDocId` is
  // `server-only`), so it restates them, and a restatement that drifts is
  // worse than no teardown at all: it deletes ids that do not exist and then
  // reports a clean manifest over live rows.
  //
  // Pinned to LITERALS rather than compared against the source, because a
  // comparison would drift in lockstep. The literals are what the routes
  // compute today; changing one here should be a deliberate, reviewable act.
  //
  //   applicationId   -> admissionApplicationId
  //   enrolmentId     -> courseEnrolmentId
  //   WITHDRAW_WORD   -> src/features/admissions/applyClient.ts
  //   emailDocId      -> src/lib/firestore/emailDocId.ts
  //   cohortChannel   -> courseRunChannel, src/lib/firestore/courses.ts
  //   subscriptionId  -> subscriptionDocId, src/lib/firestore/subscriptions.ts
  assert.equal(applicationId("round__abc", "uid1"), "round__abc__uid1");
  assert.equal(enrolmentId("run__abc", "uid1"), "run__abc__uid1");
  assert.equal(WITHDRAW_WORD, "WITHDRAW");
  assert.equal(emailDocId("  E2E-Ab@E2E.Invalid  "), "e2e-ab@e2e.invalid");
  // The sanitiser's whole job: anything outside the safe set becomes "_".
  assert.equal(emailDocId("a b!c@x.test"), "a_b_c@x.test");
  assert.equal(cohortChannel("e2e-funnel-run__abc"), "cohort:e2e-funnel-run__abc");
  assert.equal(
    subscriptionId("E2E-Ab@e2e.invalid", "cohort:run__abc"),
    "sub_e2e-ab@e2e.invalid__cohort:run__abc",
  );
});

test("the seeded policy version is the one the re-consent gate wants", () => {
  // A seeded account carries `policyVersion`, restated in
  // scripts/e2e/lib/firestore.mjs because that file is plain Node and
  // src/lib/legal/policies.ts is TypeScript. Every DEPLOYED build redirects a
  // signed-in account whose version is not the current one to /re-consent
  // ((app)/layout.tsx), so a drifted restatement does not fail here, it
  // strands every spec that signs a fixture account in on a consent page.
  //
  // Computed from the policy file rather than pinned, so a policy bump fails
  // with the line to update instead of at 2am in a browser.
  const policies = sourceOf(join(REPO_ROOT, "src", "lib", "legal", "policies.ts"));
  const first = (key) => {
    const match = new RegExp(`${key}:\\s*\\{[\\s\\S]*?versions:\\s*\\[\\s*\\{\\s*version:\\s*(\\d+)`).exec(
      policies,
    );
    assert.ok(match, `could not read the current ${key} version out of policies.ts`);
    return match[1];
  };
  const wanted = `terms.${first("terms")}+privacy.${first("privacy")}`;
  const harness = sourceOf(join(REPO_ROOT, "scripts", "e2e", "lib", "firestore.mjs"));
  assert.ok(
    harness.includes(`const ACCEPTED_POLICY_VERSION = ${JSON.stringify(wanted)};`),
    `scripts/e2e/lib/firestore.mjs must seed policyVersion ${JSON.stringify(wanted)}, the ` +
      "value CURRENT_POLICY_VERSION computes today. Update that line: until it matches, " +
      "every seeded account is bounced to /re-consent on any deployed build and no " +
      "browser spec can get past its sign-in step.",
  );
});

test("the harness's scratch files live outside the build output", () => {
  // The regression this pins: the ledger used to sit in `.next/`, and
  // `next build` clears that directory, so `--local` wrote the fixture ids and
  // then had the build delete them before the spec looked. The spec found no
  // fixture, skipped, and the command exited 0 having opened no browser.
  for (const [name, path] of [
    ["STATE_DIR", STATE_DIR],
    ["stateDir()", stateDir()],
    ["ARTIFACTS_DIR", ARTIFACTS_DIR],
    ["statePath(name)", statePath("any-spec")],
    ["markerPath(name)", markerPath("any-spec")],
    ["STATE_PATH", STATE_PATH],
    ["MARKER_PATH", MARKER_PATH],
  ]) {
    assert.ok(
      !path.split(/[\\/]/).includes(".next"),
      `${name} is ${path}, inside the build output. next build clears that ` +
        "directory, so anything a run needs to survive a build cannot live there.",
    );
  }
});

/* -------------------------------------------------------------------------
 * The SPEC contract
 * ---------------------------------------------------------------------- */

/**
 * Every route and page in the app, keyed the way a SPEC's `covers` names them:
 * the path under `src/app` with the trailing `/route.ts` or `/page.tsx`
 * removed. Route groups are kept verbatim, because they are what the file tree
 * says and a key that guessed at them would be ambiguous.
 */
function appKeys(kind) {
  const root = join(REPO_ROOT, "src", "app");
  const file = kind === "routes" ? "route.ts" : "page.tsx";
  const keys = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === file) {
        const key = `/${relative(root, dirname(path)).split("\\").join("/")}`;
        keys.add(key === "/." ? "/" : key);
      }
    }
  };
  walk(root);
  return keys;
}

test("every spec module exports a SPEC the runner can use", async () => {
  const names = new Set();
  const routeKeys = appKeys("routes");
  const pageKeys = appKeys("pages");
  assert.ok(routeKeys.size > 50 && pageKeys.size > 20, "the src/app walk found almost nothing");

  for (const file of FIXTURE_MODULES) {
    const where = rel(file);
    const mod = await import(pathToFileURL(file).href);
    const spec = mod.SPEC;
    assert.ok(spec && typeof spec === "object", `${where} exports no SPEC object.`);

    assert.equal(typeof spec.name, "string", `${where}: SPEC.name must be a string.`);
    assert.ok(spec.name.length > 0, `${where}: SPEC.name must not be empty.`);
    assert.ok(
      !names.has(spec.name),
      `${where}: SPEC.name ${JSON.stringify(spec.name)} is already taken. The name is the ` +
        "state and marker file stem, so two specs sharing one overwrite each other's ledger.",
    );
    names.add(spec.name);

    assert.ok(
      existsSync(join(REPO_ROOT, spec.specFile)),
      `${where}: SPEC.specFile ${JSON.stringify(spec.specFile)} is not a file in this repo.`,
    );

    assert.ok(Array.isArray(spec.steps) && spec.steps.length > 0, `${where}: SPEC.steps is empty.`);
    assert.ok(
      Array.isArray(spec.recaptchaDependentSteps),
      `${where}: SPEC.recaptchaDependentSteps must be an array.`,
    );
    for (const name of spec.recaptchaDependentSteps) {
      assert.ok(
        spec.steps.includes(name),
        `${where}: recaptchaDependentSteps names ${JSON.stringify(name)}, which is not a ` +
          "step. The runner would accept a skip nothing can record.",
      );
    }
    assert.ok(
      spec.recaptchaDependentSteps.length < spec.steps.length,
      `${where}: every step is reCAPTCHA-dependent, so a run against a deployed target ` +
        "would prove nothing and still pass.",
    );

    assert.equal(typeof spec.needs?.admin, "boolean", `${where}: SPEC.needs.admin must be a boolean.`);
    for (const fn of ["seed", "countRows", "teardown"]) {
      assert.equal(typeof spec[fn], "function", `${where}: SPEC.${fn} must be a function.`);
    }

    // The steps the spec file actually runs, in order. The marker is what
    // turns "node --test exited 0" into "a browser drove every step", and it
    // only means that while the names the spec records are the names the
    // runner checks for.
    const source = codeOf(join(REPO_ROOT, spec.specFile));
    const recorded = [...source.matchAll(/\bstep\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      recorded,
      spec.steps,
      `${where}: SPEC.steps and the step() calls in ${spec.specFile} have diverged. A step ` +
        "the list does not name is a step the runner would let a run skip silently.",
    );
    assert.match(
      source,
      /RECAPTCHA_DEPENDENT_STEPS|recaptchaDependentSteps/,
      `${spec.specFile} must decide its skips from the fixture's own list, not a private one.`,
    );
    assert.match(
      source,
      /RECAPTCHA_SKIP_REASON/,
      `${spec.specFile} must record the shared RECAPTCHA_SKIP_REASON for a step it ` +
        "skips. The runner accepts a skip only for that exact reason, so a spec with " +
        "wording of its own would have every gated step read as a shortfall.",
    );

    // A seed that throws half way is the expensive failure: rows and accounts
    // on a shared project with no ledger naming them, and a runner that then
    // says there was nothing to tear down. Every fixture therefore publishes
    // its state object before its first write.
    const fixtureSource = codeOf(file);
    assert.match(
      fixtureSource,
      /onState/,
      `${where}: seed() must take an \`onState\` callback and call it with the state ` +
        "object BEFORE its first write. Without it a seed that fails part way leaves " +
        "accounts and documents on the dev project that nothing can find again.",
    );

    // Coverage: every claim resolves to a real file. An unresolvable key is
    // printed rather than skipped, which is the whole point of the map.
    for (const key of spec.covers.routes) {
      assert.ok(
        routeKeys.has(key),
        `${where}: covers.routes names ${JSON.stringify(key)}, which is not a route in ` +
          "src/app. Keys are the src/app path with /route.ts removed, route groups kept.",
      );
    }
    for (const key of spec.covers.pages) {
      assert.ok(
        pageKeys.has(key),
        `${where}: covers.pages names ${JSON.stringify(key)}, which is not a page in ` +
          "src/app. Keys are the src/app path with /page.tsx removed, route groups kept.",
      );
    }
    assert.ok(
      spec.covers.routes.length + spec.covers.pages.length > 0,
      `${where}: covers is empty, so this spec claims to cover nothing and the coverage ` +
        "map would silently lose it.",
    );
  }
});

test("the runner reads the completion markers, and accepts only the declared skips", () => {
  const runner = codeOf(RUNNER);
  assert.match(
    runner,
    /markerShortfall/,
    "the runner must check the completion markers: without them a skipped spec and a " +
      "passing one are the same exit code.",
  );
  // Both sides of the skip decision, because a runner with a private list is a
  // runner that can quietly accept a gap no spec declared. The spec half is
  // asserted per module in the SPEC contract test below.
  assert.match(
    runner,
    /spec\.recaptchaDependentSteps/,
    "the runner must take its accepted skips from the spec's own " +
      "recaptchaDependentSteps. A list of its own would let a step be skipped that " +
      "no fixture ever declared could not run.",
  );
  assert.match(
    runner,
    /RECAPTCHA_SKIP_REASON/,
    "the runner must check the REASON a step was skipped, not only its name: a gated " +
      "step skipped because a locator timed out is a step nobody drove.",
  );
  // And the sentence itself lives in ONE place. A spec that copied the wording
  // would still pass the grep above and then drift from the runner's
  // comparison the first time either side was edited, which fails as a
  // shortfall on a step that really was gated.
  const wording = RECAPTCHA_SKIP_REASON.slice(0, 60);
  assert.ok(wording.length === 60, "RECAPTCHA_SKIP_REASON must be a real sentence.");
  for (const file of HARNESS_FILES) {
    if (file === CORE) continue;
    assert.ok(
      !codeOf(file).includes(wording),
      `${rel(file)} restates the reCAPTCHA skip reason as a literal. Import ` +
        "RECAPTCHA_SKIP_REASON from core.mjs instead: the runner matches on that exact " +
        "string, so two copies is one edit away from a false shortfall.",
    );
  }
});

test("suppression is decided by a fact about the server, not the shape of the origin", () => {
  // The dangerous case, stated first so the test cannot pass by the premise
  // going away: the ordinary `npm run dev` ports are ON the harness target
  // allowlist, and that server reads the real Resend credentials from
  // .env.local. A run pointed there with suppression off would hand .invalid
  // addresses to a real sender and log hard bounces against the sending domain.
  for (const devPort of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
    assert.doesNotThrow(
      () => assertTarget(devPort),
      `${devPort} is no longer an allowed target, so the case below is moot; keep the ` +
        "check anyway or remove both together, deliberately.",
    );
    assert.equal(
      mailIsCaught({ startedByThisRun: false, origin: devPort }),
      false,
      `mailIsCaught said a server on ${devPort} catches its mail. It does not: only a ` +
        "server this harness started has had its SMTP pointed at Mailpit, and that one " +
        "is the ordinary dev server with real credentials.",
    );
  }
  assert.equal(
    mailIsCaught({ startedByThisRun: false, origin: "https://dev.naisi.uk" }),
    false,
    "the deployed dev backend sends real mail.",
  );
  // The two ways mail really is caught: a server this run started, and the
  // port reserved for one somebody else started the same way.
  assert.equal(mailIsCaught({ startedByThisRun: true, origin: HARNESS_LOCAL_ORIGIN }), true);
  assert.equal(mailIsCaught({ startedByThisRun: false, origin: HARNESS_LOCAL_ORIGIN }), true);
  assert.equal(mailIsCaught({}), false, "the default answer must be the safe one.");
  assert.doesNotThrow(
    () => assertTarget(HARNESS_LOCAL_ORIGIN),
    "the harness origin must be an allowed target.",
  );

  const runner = codeOf(RUNNER);
  assert.match(
    runner,
    /mailIsCaught\(/,
    "the runner must ask mailIsCaught() rather than deciding suppression itself.",
  );
  assert.ok(
    !/suppress:\s*(deployed|!isLoopbackOrigin|!?\s*loopback)/.test(runner),
    "the runner is deciding suppression from the shape of the origin again. Loopback " +
      "does not mean the mail is caught: see mailIsCaught() in core.mjs.",
  );
});

/**
 * Routes the funnel drives that could hand mail to Resend, and the promise the
 * fixture makes about them.
 *
 * Seeding suppresses every fixture address before anything runs against a
 * DEPLOYED target, which only means "this run cannot cause mail" while the
 * send path consults the suppression list. `sendEmail()` in
 * src/lib/email/send.ts does NOT: the per-feature helpers do, individually. So
 * the check is on the helpers these routes actually import, and it arms itself
 * for new ones automatically.
 *
 * On loopback the suppression is deliberately off, because the SMTP is a
 * catcher on this machine and the `emailSends` rows are what a spec reads.
 */
const FUNNEL_ROUTES = [
  "src/app/api/admissions/rounds/[roundId]/apply/route.ts",
  "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
  "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts",
  "src/app/api/courses/runs/[runId]/enrol/route.ts",
];

test("every email helper the funnel's routes import consults the suppression list", () => {
  let checked = 0;
  for (const route of FUNNEL_ROUTES) {
    const path = join(REPO_ROOT, route);
    assert.ok(
      existsSync(path),
      `${route} is gone or moved. This list is the fixture's no-mail promise; a ` +
        "route renamed out of it silently stops being covered.",
    );
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/from\s+["']@\/lib\/email\/([A-Za-z0-9_]+)["']/g)) {
      const helper = join(REPO_ROOT, "src", "lib", "email", `${match[1]}.ts`);
      assert.ok(existsSync(helper), `${route} imports a missing helper: ${match[1]}`);
      const helperSource = readFileSync(helper, "utf8");
      assert.match(
        helperSource,
        // Singular for one address, plural for a batch. Both read the same
        // suppression list; neither is optional on a path a fixture drives.
        /\b(isSuppressed|filterSuppressed)\(/,
        `src/lib/email/${match[1]}.ts is imported by ${route}, which the funnel ` +
          "drives, but it never checks the suppression list. Seeding suppresses " +
          "every fixture address before it runs against a deployed target, and that " +
          "is only a no-mail guarantee while the helper looks.",
      );
      checked += 1;
    }
  }
  assert.ok(
    checked > 0,
    "no @/lib/email import was found in any funnel route, so this test asserted " +
      "nothing. Either the routes moved or the send was refactored behind another " +
      "module, and the fixture's no-mail promise needs re-checking by hand.",
  );
});

// `statSync` is imported for the walk's own sanity: a path that is not a file
// is not a harness file, and a silently-skipped entry is the failure mode this
// whole file exists to remove.
test("every walked harness path is a readable file", () => {
  for (const file of HARNESS_FILES) {
    assert.ok(statSync(file).isFile(), `${rel(file)} is not a file.`);
  }
});
