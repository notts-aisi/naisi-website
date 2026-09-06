/**
 * Offline guards on the applicant-funnel harness (run under `npm test` - no
 * network, no credentials, no dev project involved).
 *
 * `tests/e2e-no-privilege-grants.test.mjs` fences the AUTH harness into three
 * Firestore collections. The funnel fixture cannot live inside that fence
 * (it seeds admission rounds and course runs), so it sits outside it with a
 * fence of its own, and this file is that fence. The properties are the same
 * three the auth harness holds, because they are the properties dev needs:
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
 * all rather than the funnel being bolted onto the older guard: the funnel
 * SPEC drives a browser against a live target, so the file that decides which
 * target must be the allowlist rather than a raw string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTarget } from "../scripts/e2e/lib/env.mjs";
import {
  ARTIFACTS_DIR,
  FIXTURE_COLLECTIONS,
  FUNNEL_STEPS,
  MARKER_PATH,
  RECAPTCHA_DEPENDENT_STEPS,
  STATE_PATH,
  WITHDRAW_WORD,
  applicationId,
  assertFixtureCollection,
  cohortChannel,
  emailDocId,
  enrolmentId,
  subscriptionId,
} from "../scripts/seed-fake-applicants.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file that makes up the funnel harness. */
const FUNNEL_FILES = [
  join(REPO_ROOT, "scripts", "seed-fake-applicants.mjs"),
  join(REPO_ROOT, "scripts", "run-applicant-funnel.mjs"),
  join(REPO_ROOT, "tests", "e2e", "applicant-funnel.spec.mjs"),
];

/**
 * Privilege-granting shapes, in both bare-identifier and quoted-key spellings,
 * matching the auth harness's list. The `role` pattern admits `"pending"` only,
 * which is what `seedPendingUserDoc` hard-codes.
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

test("the funnel harness never grants a role, permission, or round authority", () => {
  for (const file of FUNNEL_FILES) {
    const source = codeOf(file);
    for (const pattern of FORBIDDEN_PRIVILEGE) {
      assert.ok(
        !pattern.test(source),
        `${relative(REPO_ROOT, file)} matches ${pattern}. The funnel fixture creates ` +
          "role-`pending` accounts and nothing above them; a privileged identity on " +
          "the dev project is not its to make.",
      );
    }
  }
});

test("assertFixtureCollection refuses everything off the fixture's list", () => {
  // BEHAVIOURAL, not a grep: the funnel reaches thirteen collections through
  // one checked chokepoint rather than thirteen literal branches, so the thing
  // worth testing is the check itself. It must throw BEFORE any credential is
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
    "eventRsvps",
    "emailSends",
    "impersonations",
    "newsletterDrafts",
    "suppressedEmails ",
    "",
    "admissionReviews",
  ]) {
    assert.throws(
      () => assertFixtureCollection(collection),
      `assertFixtureCollection accepted ${JSON.stringify(collection)}. dev holds ` +
        "real member data; the fixture's list is the whole fence.",
    );
  }
});

test("the funnel harness routes every collection access through the chokepoint", () => {
  // The grep half of the same fence. `.collection(` may appear with a literal
  // on the allowlist, or with the single identifier the chokepoints pass; a
  // third spelling would be a path the behavioural test above cannot see.
  const allowedLiterals = new Set([
    ...FIXTURE_COLLECTIONS,
    // The users document each fixture account owns: written through the auth
    // harness's own guarded seeder, deleted here by address under the
    // harness-namespace check on the account it belongs to.
    "users",
  ]);
  /**
   * The only non-literal arguments allowed.
   *
   * `collection` is the parameter both chokepoints have already run through
   * `assertFixtureCollection`. `STAGES_SUBCOLLECTION` names a SUBCOLLECTION,
   * which is reached off a document reference the chokepoint produced, so it
   * is inside the fence rather than a way around it; the test below pins its
   * value so this name cannot quietly become something else.
   */
  const ALLOWED_COLLECTION_IDENTIFIERS = ["collection", "STAGES_SUBCOLLECTION"];
  for (const file of FUNNEL_FILES) {
    const source = codeOf(file);
    for (const match of source.matchAll(/\.collection\(\s*([^)]*)\)/g)) {
      const arg = match[1].trim();
      const literal = /^["'`]([^"'`]*)["'`]$/.exec(arg);
      if (literal) {
        assert.ok(
          allowedLiterals.has(literal[1]),
          `${relative(REPO_ROOT, file)} addresses collection ${JSON.stringify(literal[1])}, ` +
            "which is not in FIXTURE_COLLECTIONS.",
        );
        continue;
      }
      assert.ok(
        ALLOWED_COLLECTION_IDENTIFIERS.includes(arg),
        `${relative(REPO_ROOT, file)} calls .collection(${arg}). Only a literal from ` +
          "FIXTURE_COLLECTIONS, the checked `collection` parameter of fixtureDoc / " +
          "fixtureQuery, or the stages subcollection constant may reach Firestore " +
          "from this harness.",
      );
    }
  }
  assert.match(
    sourceOf(FUNNEL_FILES[0]),
    /export function assertFixtureCollection\(/,
    "the chokepoint the grep above defers to must exist and be exported, so the " +
      "behavioural test can call it.",
  );
  assert.match(
    codeOf(FUNNEL_FILES[0]),
    /const STAGES_SUBCOLLECTION = "stages";/,
    "STAGES_SUBCOLLECTION must stay a literal constant: the grep above trusts the " +
      "name because it can read the value here.",
  );
});

test("the funnel fixture declares every collection its teardown must drain", () => {
  // The house rule is that a PR adding a collection also adds it to the
  // destroy manifest in the same PR. The funnel's manifest is
  // FIXTURE_COLLECTIONS, and the failure mode it guards against is a future
  // step that creates rows somewhere the counter never looks: teardown would
  // then report zero and be wrong. So the routes the spec drives are listed
  // here by hand, and this test fails when one is missing from the fixture.
  for (const required of [
    "admissionApplications",
    "admissionApplicationPrivate",
    "courseEnrolments",
    "courseAudit",
    "subscriptions",
    "subscriptionEvents",
    "tasks",
    "courseProgress",
  ]) {
    assert.ok(
      FIXTURE_COLLECTIONS.includes(required),
      `${required} is written by a route the funnel drives but is not in ` +
        "FIXTURE_COLLECTIONS, so teardown would neither sweep it nor count it.",
    );
  }
});

test("the funnel spec resolves its target through the allowlist, not a literal", () => {
  const source = sourceOf(FUNNEL_FILES[2]);
  assert.match(
    source,
    /assertTarget\(/,
    "the funnel spec must resolve its base URL through assertTarget(): it signs " +
      "accounts in and submits applications, and a raw origin string is one typo " +
      "from doing that against production.",
  );
  // Production must not appear as a literal anywhere in the harness, not even
  // in a comment that a later edit could uncomment into a default.
  for (const file of FUNNEL_FILES) {
    assert.ok(
      !/["'`]https:\/\/(www\.)?naisi\.uk/.test(sourceOf(file)),
      `${relative(REPO_ROOT, file)} contains the production origin as a string literal.`,
    );
  }
});

test("assertTarget still refuses production for the funnel's default", () => {
  // The funnel's default target is the dev origin; the negative control is
  // that the same function still refuses production spellings, so a future
  // "just point it at prod for one run" edit cannot pass quietly.
  assert.doesNotThrow(() => assertTarget("https://dev.naisi.uk"));
  assert.doesNotThrow(() => assertTarget("http://127.0.0.1:3100"));
  for (const bad of ["https://naisi.uk", "https://www.naisi.uk", "https://dev.naisi.uk@naisi.uk"]) {
    assert.throws(
      () => assertTarget(bad),
      `assertTarget accepted ${JSON.stringify(bad)}. The funnel creates accounts and ` +
        "applications; production must stay unreachable.",
    );
  }
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

test("the funnel's scratch files live outside the build output", () => {
  // The regression this pins: the ledger used to sit in `.next/`, and
  // `next build` clears that directory, so `--local` wrote the fixture ids and
  // then had the build delete them before the spec looked. The spec found no
  // fixture, skipped, and the command exited 0 having opened no browser.
  for (const [name, path] of [
    ["STATE_PATH", STATE_PATH],
    ["MARKER_PATH", MARKER_PATH],
    ["ARTIFACTS_DIR", ARTIFACTS_DIR],
  ]) {
    assert.ok(
      !path.split(/[\\/]/).includes(".next"),
      `${name} is ${path}, inside the build output. next build clears that ` +
        "directory, so anything a run needs to survive a build cannot live there.",
    );
  }
});

test("the runner and the spec agree on every step of the funnel", () => {
  // The completion marker is what turns "node --test exited 0" into "a browser
  // drove all thirteen steps". It only means that while the names the spec
  // records are the names the runner checks for.
  const spec = sourceOf(FUNNEL_FILES[2]);
  for (const name of FUNNEL_STEPS) {
    assert.ok(
      spec.includes(`step(t, ${JSON.stringify(name)}`),
      `FUNNEL_STEPS names ${JSON.stringify(name)}, which the spec does not run ` +
        "through step(). The runner would then demand a step nothing can record " +
        "and every run would fail.",
    );
  }
  const recorded = [...spec.matchAll(/step\(t, "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    recorded,
    FUNNEL_STEPS,
    "the spec's steps and FUNNEL_STEPS have diverged. A step the list does not " +
      "name is a step the runner would let a run skip silently.",
  );
  assert.match(
    sourceOf(FUNNEL_FILES[1]),
    /markerShortfall/,
    "the runner must check the completion marker: without it a skipped spec and " +
      "a passing one are the same exit code.",
  );
});

test("the steps the dev-mode run may skip are real steps, and only those", () => {
  // Against a deployed target the spec skips the reCAPTCHA-dependent leg and
  // the runner accepts exactly that set. A name here that is not a step would
  // let the runner accept a skip nothing can record; a step that is gated but
  // missing here would fail every dev-mode run. Both sides read one constant.
  for (const name of RECAPTCHA_DEPENDENT_STEPS) {
    assert.ok(
      FUNNEL_STEPS.includes(name),
      `RECAPTCHA_DEPENDENT_STEPS names ${JSON.stringify(name)}, which is not in FUNNEL_STEPS.`,
    );
  }
  assert.ok(
    RECAPTCHA_DEPENDENT_STEPS.length < FUNNEL_STEPS.length,
    "every step is marked reCAPTCHA-dependent, so a dev-mode run would prove nothing " +
      "and still pass. Sign-in, the public course page and the enrol leg are not gated.",
  );
  for (const [file, label] of [
    [FUNNEL_FILES[1], "the runner"],
    [FUNNEL_FILES[2], "the spec"],
  ]) {
    assert.match(
      codeOf(file),
      /RECAPTCHA_DEPENDENT_STEPS/,
      `${label} must decide skips from RECAPTCHA_DEPENDENT_STEPS, not a private list.`,
    );
  }
});

/**
 * Routes the funnel drives that could hand mail to Resend, and the promise the
 * fixture makes about them.
 *
 * Seeding suppresses every fixture address before anything runs, which only
 * means "this run cannot cause mail" while the send path consults the
 * suppression list. `sendEmail()` in src/lib/email/send.ts does NOT: the
 * per-feature helpers do, individually. So the check is on the helpers these
 * routes actually import, and it arms itself for new ones automatically, which
 * is what matters as PR14's admissionEmails.ts joins the submit route.
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
          "every fixture address before it runs, and that is only a no-mail " +
          "guarantee while the helper looks.",
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
