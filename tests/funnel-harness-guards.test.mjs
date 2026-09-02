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
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTarget } from "../scripts/e2e/lib/env.mjs";
import {
  FIXTURE_COLLECTIONS,
  applicationId,
  assertFixtureCollection,
  enrolmentId,
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

test("the fixture's deterministic ids are construct-only and stable", () => {
  // Both ids are the ones the ROUTES compute (`admissionApplicationId`,
  // `courseEnrolmentId`). If the fixture's copies drift, teardown deletes
  // documents that do not exist and reports a clean manifest over live rows.
  assert.equal(applicationId("round__abc", "uid1"), "round__abc__uid1");
  assert.equal(enrolmentId("run__abc", "uid1"), "run__abc__uid1");
});
