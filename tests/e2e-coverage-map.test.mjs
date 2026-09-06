/**
 * The end-to-end COVERAGE MAP (run under `npm test`: no browser, no network,
 * no credentials).
 *
 * WHY THIS EXISTS. The other guards in this repo ask "is this thing correct".
 * This one asks "is this thing tested at all", which is the question nobody
 * answers on their own initiative. A suite of end-to-end specs grows in the
 * direction of whatever was last broken, and the surfaces nobody has looked at
 * are exactly the surfaces nobody knows are uncovered. So the map is written
 * down, checked in both directions, and every gap carries a reason and the
 * trigger that closes it.
 *
 * HOW IT WORKS.
 *
 *  1. It WALKS `src/app` for every `route.ts` and every `page.tsx` and keys
 *     them the way a SPEC's `covers` does: the path under `src/app` with the
 *     trailing `/route.ts` or `/page.tsx` removed, route groups kept verbatim.
 *     A hand-written list of routes is a list that is wrong by the end of the
 *     week, so there is no hand-written list.
 *  2. The EXERCISED set is assembled from two places: every `SPEC.covers` in
 *     `scripts/e2e-fixtures/` whose `SPEC.status` is "verified", and the
 *     `AUTH_BATTERIES` map below, which names what each fetch battery under
 *     `scripts/e2e/tests/` drives.
 *  3. Everything else must be in `NOT_COVERED`, with a written reason and a
 *     written trigger. A key with neither an exercising spec nor an entry
 *     fails, naming itself.
 *
 * A SPEC WHOSE STATUS IS "unverified" CONTRIBUTES NOTHING. A spec that has
 * never passed end to end proves nothing about the routes it names, and a
 * coverage map that counted intentions would be a map that lies in the
 * direction nobody checks. Those specs are printed on every run, so writing
 * one and never running it is loud rather than quiet.
 *
 * BOTH DIRECTIONS, like every registry in this repo. An entry whose key no
 * longer exists fails (the route moved and the reason went stale with it). An
 * entry whose key a verified spec now covers fails (the burn-down rule: a
 * spec's pull request moves its keys out of this list in the same diff). A
 * `covers` key that resolves to no file fails, which
 * `tests/funnel-harness-guards.test.mjs` also checks, deliberately: the two
 * guards disagree the day somebody edits one of them.
 *
 * WHAT IT CANNOT SEE. It reads declarations, not behaviour. A spec that visits
 * a page and asserts nothing about it still counts that page as covered, and
 * an API route a page calls internally is covered only because a human wrote
 * it into `covers`. The map's honesty therefore rests on the SPEC modules
 * being honest about what they drove, which is the same bargain
 * `KNOWN_MISSING_INDEXES` and `MUST_GUARD` make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(REPO_ROOT, "src", "app");
const FIXTURES_DIR = join(REPO_ROOT, "scripts", "e2e-fixtures");
const BATTERIES_DIR = join(REPO_ROOT, "scripts", "e2e", "tests");

/**
 * Every route or page in the app, keyed as a SPEC's `covers` names it and
 * mapped to the file it came from, so a failure can print the file rather than
 * leave the reader to find it.
 */
function appKeys(kind) {
  const file = kind === "routes" ? "route.ts" : "page.tsx";
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === file) {
        const key = `/${relative(APP_DIR, dirname(path)).split("\\").join("/")}`;
        found.set(key === "/." ? "/" : key, relative(REPO_ROOT, path).split("\\").join("/"));
      }
    }
  };
  walk(APP_DIR);
  return found;
}

const ROUTE_KEYS = appKeys("routes");
const PAGE_KEYS = appKeys("pages");
/** One map, because a key is unique across both kinds and the map is one map. */
const ALL_KEYS = new Map([...ROUTE_KEYS, ...PAGE_KEYS]);

/* -------------------------------------------------------------------------
 * 1. What the fetch batteries drive
 * ---------------------------------------------------------------------- */

/**
 * The nine batteries under `scripts/e2e/tests/`, and the routes each one
 * really drives. Written by reading them, one entry per file, checked in both
 * directions: a battery with no entry fails, an entry naming a file that is
 * gone fails, and a `drives` key that is not a route or page in `src/app`
 * fails.
 *
 * These are `fetch()` batteries rather than browser specs, so what they prove
 * is narrower: the route answers correctly. Nothing about the page that calls
 * it. That is enough to call the ROUTE exercised, which is what this map is
 * about, and it is why the pages in `redirectOnly` below are NOT counted.
 *
 * BOTH CI JOBS RUN THEM (`npm run e2e:local` in the local job, `npm run e2e`
 * in the dev job, before each one's browser step), because a credit collected
 * by no job is a credit that rots. If that ever stops being true, the honest
 * move is to say so here rather than to keep counting these routes.
 */
const AUTH_BATTERIES = {
  "password-set.test.mjs": {
    why: "The throwaway password is really replaced and the old session really revoked.",
    drives: ["/api/register/password-set", "/api/verify-email/reconcile"],
  },
  "protected-route-gate.test.mjs": {
    why:
      "The proxy gate: a protected path 307s to /login?next=, a minted cookie opens it, " +
      "and DELETE closes it again.",
    drives: ["/api/auth/session"],
    /**
     * Pages this battery requests, but only ever as a SIGNED-OUT visitor whose
     * request is redirected before the page renders. That proves the gate, not
     * the page, so these do not enter the exercised set: each one carries a
     * NOT_COVERED entry that says the redirect is all that is asserted, and
     * the test below checks the entry says so.
     */
    redirectOnly: [
      "/(app)/dashboard",
      "/(app)/tasks",
      "/(app)/credentials",
      "/(app)/profile",
      "/(app)/newsletter",
      "/(app)/admin/(admin-only)",
      "/collaborator",
    ],
    /**
     * Paths it also requests that resolve to no page at all. `/calendar` is in
     * `PROTECTED_PREFIXES` in src/proxy.ts and has no page behind it yet, so
     * the 307 comes from the proxy and there is nothing to cover. Declared
     * rather than dropped: the day a page lands there, this list is wrong and
     * the test says so.
     */
    unmappedPaths: {
      "/calendar": "PROTECTED_PREFIXES names it, but no page.tsx exists for it yet.",
    },
  },
  "recaptcha-gate.test.mjs": {
    why: "The reCAPTCHA gate is live on every deployed backend: a junk token must bounce.",
    drives: ["/api/register"],
  },
  "register-email-flow.test.mjs": {
    why:
      "What /api/register puts in the inbox, and the emailed link driven through to a " +
      "working credential. Local mode only.",
    drives: ["/api/register", "/api/register/password-set", "/verify-email/[tokenId]"],
  },
  "register-enumeration.test.mjs": {
    why: "Account-enumeration uniformity on /api/register. Local mode only.",
    drives: ["/api/register"],
  },
  "token-negatives.test.mjs": {
    why: "Forged, edited, expired and cross-scope magic-link tokens are all refused.",
    drives: ["/api/verify-email/confirm"],
  },
  "uni-email-gate.test.mjs": {
    why: "The PR #209 regression guard: a non-Nottingham address is refused.",
    drives: ["/api/verify-email/send"],
  },
  "uni-email-inbox.test.mjs": {
    why: "Enumeration uniformity on the uni-email leg extends to what lands in the inbox.",
    /**
     * NOT `/verify-email/[tokenId]`, though this battery reads the link out of
     * the mail: it only string-matches the prefix the link is supposed to
     * carry and never requests the page, so it proves what was sent, not what
     * renders. `register-email-flow.test.mjs` really GETs that page, and the
     * page's coverage rests there alone.
     */
    drives: [
      "/api/register",
      "/api/verify-email/send",
      "/api/verify-email/confirm",
      "/api/verify-email/reconcile",
    ],
  },
  "uni-email-stamp.test.mjs": {
    why: "The two-phase uniEmailVerifiedAt stamp and its survival of the session revocation.",
    drives: [
      "/api/verify-email/confirm",
      "/api/verify-email/reconcile",
      "/api/register/password-set",
    ],
  },
};

/* -------------------------------------------------------------------------
 * 2. The gaps, each with a reason and a trigger
 * ---------------------------------------------------------------------- */

/**
 * Every route and page no spec and no battery exercises, with the reason it is
 * uncovered and the trigger that closes it.
 *
 * `reason` says why the gap is acceptable TODAY. `coverWhen` is a trigger, not
 * a wish: a thing that will happen, on which somebody writes the spec. "When
 * we get round to it" is not a trigger, which is why both strings are
 * length-checked and why the burn-down rule is that a spec's pull request
 * deletes its keys from here in the same diff.
 *
 * It is long on purpose. The list is the honest shape of the suite on the day
 * it shipped: the journeys the specs drive, and every other surface written
 * down rather than quietly absent.
 */
const NOT_COVERED = {
  // Worksheet engine. Built in a parallel branch during the week this map
  // landed (#278, #279) and still moving; a spec written against today's shape
  // would be thrown away with its next iteration. The engine's own chat adds
  // its later routes here until it settles.
  "/api/worksheets/circulations": {
    reason:
      "Worksheet engine: /api/worksheets/circulations belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/api/worksheets/circulations/[circulationId]/recipients": {
    reason:
      "Worksheet engine: /api/worksheets/circulations/[circulationId]/recipients belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/api/worksheets/circulations/[circulationId]/submit": {
    reason:
      "Worksheet engine: /api/worksheets/circulations/[circulationId]/submit belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/api/worksheets/circulations/[circulationId]/upload": {
    reason:
      "Worksheet engine: /api/worksheets/circulations/[circulationId]/upload belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/api/worksheets/recipients": {
    reason:
      "Worksheet engine: /api/worksheets/recipients belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/(app)/worksheets/(author)": {
    reason:
      "Worksheet engine: /(app)/worksheets/(author) belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/(app)/worksheets/(author)/[worksheetId]": {
    reason:
      "Worksheet engine: /(app)/worksheets/(author)/[worksheetId] belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/(app)/worksheets/(author)/[worksheetId]/circulations/[circulationId]": {
    reason:
      "Worksheet engine: /(app)/worksheets/(author)/[worksheetId]/circulations/[circulationId] belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/(app)/worksheets/respond/[circulationId]": {
    reason:
      "Worksheet engine: /(app)/worksheets/respond/[circulationId] belongs to a parallel build that is still landing on dev, so its shape is not yet stable enough to pin.",
    coverWhen:
      "When the worksheet engine has landed in full and its first circulation has gone to real committee members.",
  },
  "/api/account/delete": {
    reason:
      "Account deletion is irreversible and its sweep is pinned by three unit suites over a fake database.",
    coverWhen:
      "When account deletion is offered to members rather than run by hand, because a missed row is then somebody's data left behind.",
  },
  "/api/account/reconsent": {
    reason:
      "The reconsent gate is skipped under NODE_ENV=development, so a dev-server run cannot see it at all.",
    coverWhen:
      "When a spec runs against a production build and a policy version bumps.",
  },
  "/api/admin/application-emails/[templateId]/send-test": {
    reason:
      "Email rendering: /api/admin/application-emails/[templateId]/send-test renders a template for a person who is looking at the result, so a bad render is seen the moment it happens.",
    coverWhen:
      "When a template's copy is generated rather than written, so nobody reads it before it sends.",
  },
  "/api/admin/application-emails/preview": {
    reason:
      "Email rendering: /api/admin/application-emails/preview renders a template for a person who is looking at the result, so a bad render is seen the moment it happens.",
    coverWhen:
      "When a template's copy is generated rather than written, so nobody reads it before it sends.",
  },
  "/api/admin/backfill-subscriptions": {
    reason:
      "Admin CRUD: /api/admin/backfill-subscriptions answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/collaborators/verification": {
    reason:
      "Admin CRUD: /api/admin/collaborators/verification answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/config/task-emails": {
    reason:
      "Admin CRUD: /api/admin/config/task-emails answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/course-emails/[templateId]/send-test": {
    reason:
      "Email rendering: /api/admin/course-emails/[templateId]/send-test renders a template for a person who is looking at the result, so a bad render is seen the moment it happens.",
    coverWhen:
      "When a template's copy is generated rather than written, so nobody reads it before it sends.",
  },
  "/api/admin/course-emails/preview": {
    reason:
      "Email rendering: /api/admin/course-emails/preview renders a template for a person who is looking at the result, so a bad render is seen the moment it happens.",
    coverWhen:
      "When a template's copy is generated rather than written, so nobody reads it before it sends.",
  },
  "/api/admin/courses-config": {
    reason:
      "Admin CRUD: /api/admin/courses-config answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/deliverability/exports": {
    reason:
      "Admin CRUD: /api/admin/deliverability/exports answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/deliverability/sends": {
    reason:
      "Admin CRUD: /api/admin/deliverability/sends answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/deliverability/suppressed": {
    reason:
      "Admin CRUD: /api/admin/deliverability/suppressed answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/deliverability/suppressed/[docId]": {
    reason:
      "Admin CRUD: /api/admin/deliverability/suppressed/[docId] answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/impersonate": {
    reason:
      "View as: /api/admin/impersonate mints a custom token for another member's account, a privilege this harness is fenced out of holding.",
    coverWhen:
      "When impersonation can be driven on a project of its own rather than shared dev.",
  },
  "/api/admin/impersonate/exit": {
    reason:
      "View as: /api/admin/impersonate/exit mints a custom token for another member's account, a privilege this harness is fenced out of holding.",
    coverWhen:
      "When impersonation can be driven on a project of its own rather than shared dev.",
  },
  "/api/admin/members/[uid]/conduct-flag": {
    reason:
      "Admin CRUD: /api/admin/members/[uid]/conduct-flag answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/membership/export": {
    reason:
      "Membership: the column matching behind /api/admin/membership/export is a guess until a real Students' Union export exists to match against.",
    coverWhen:
      "When a real SU export is in hand and can be checked in as a fixture.",
  },
  "/api/admin/membership/import": {
    reason:
      "Membership: the column matching behind /api/admin/membership/import is a guess until a real Students' Union export exists to match against.",
    coverWhen:
      "When a real SU export is in hand and can be checked in as a fixture.",
  },
  "/api/admin/membership/import/[batchId]/abandon": {
    reason:
      "Membership: the column matching behind /api/admin/membership/import/[batchId]/abandon is a guess until a real Students' Union export exists to match against.",
    coverWhen:
      "When a real SU export is in hand and can be checked in as a fixture.",
  },
  "/api/admin/membership/import/[batchId]/commit": {
    reason:
      "Membership: the column matching behind /api/admin/membership/import/[batchId]/commit is a guess until a real Students' Union export exists to match against.",
    coverWhen:
      "When a real SU export is in hand and can be checked in as a fixture.",
  },
  "/api/admin/membership/periods/[periodId]": {
    reason:
      "Membership: /api/admin/membership/periods/[periodId] is an admin action whose result lands on the console that called it.",
    coverWhen:
      "When a period is recounted for a real cohort, because the number it prints is the one the Students' Union is given.",
  },
  "/api/admin/membership/periods/[periodId]/recount": {
    reason:
      "Membership: /api/admin/membership/periods/[periodId]/recount is an admin action whose result lands on the console that called it.",
    coverWhen:
      "When a period is recounted for a real cohort, because the number it prints is the one the Students' Union is given.",
  },
  "/api/admin/migrate-notifications": {
    reason:
      "Admin CRUD: /api/admin/migrate-notifications answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/nuke-tasks": {
    reason:
      "Admin CRUD: /api/admin/nuke-tasks answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/registrations": {
    reason:
      "Admin CRUD: /api/admin/registrations answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/registrations/[uid]": {
    reason:
      "Admin CRUD: /api/admin/registrations/[uid] answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/registrations/summary": {
    reason:
      "Admin CRUD: /api/admin/registrations/summary answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/scheduler": {
    reason:
      "Scheduler: /api/admin/scheduler is executed against a fake database in tests/scheduler.test.mjs, which reaches branches a browser run cannot schedule.",
    coverWhen:
      "When a marker or cursor change has to be proven against real Firestore rather than the fake.",
  },
  "/api/admin/scheduler/config": {
    reason:
      "Scheduler: /api/admin/scheduler/config is executed against a fake database in tests/scheduler.test.mjs, which reaches branches a browser run cannot schedule.",
    coverWhen:
      "When a marker or cursor change has to be proven against real Firestore rather than the fake.",
  },
  "/api/admin/scheduler/run": {
    reason:
      "Scheduler: /api/admin/scheduler/run is executed against a fake database in tests/scheduler.test.mjs, which reaches branches a browser run cannot schedule.",
    coverWhen:
      "When a marker or cursor change has to be proven against real Firestore rather than the fake.",
  },
  "/api/admin/site-notice": {
    reason:
      "Admin CRUD: /api/admin/site-notice answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/subscriptions/[id]": {
    reason:
      "Admin CRUD: /api/admin/subscriptions/[id] answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/subscriptions/[id]/set-status": {
    reason:
      "Admin CRUD: /api/admin/subscriptions/[id]/set-status answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admin/test-email": {
    reason:
      "Email rendering: /api/admin/test-email renders a template for a person who is looking at the result, so a bad render is seen the moment it happens.",
    coverWhen:
      "When a template's copy is generated rather than written, so nobody reads it before it sends.",
  },
  "/api/admin/users/[uid]": {
    reason:
      "Admin CRUD: /api/admin/users/[uid] answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/admissions/applications/me": {
    reason:
      "/api/admissions/applications/me answers the signed-in applicant with their own applications, and a wrong answer is visible on the status hub that renders it.",
    coverWhen:
      "When the first round publishes its decisions, because this is the screen an applicant refreshes.",
  },
  "/api/admissions/rounds/[roundId]/apply/stage/[stageId]": {
    reason:
      "Admissions: /api/admissions/rounds/[roundId]/apply/stage/[stageId] is pressed by a reviewer or an admin who reads the outcome on the console.",
    coverWhen:
      "When a round runs with a reviewer who is not the owner, so a release lands on somebody else's screen before anybody has read it.",
  },
  "/api/admissions/rounds/[roundId]/reminders/send-now": {
    reason:
      "Admissions: /api/admissions/rounds/[roundId]/reminders/send-now is pressed by a reviewer or an admin who reads the outcome on the console.",
    coverWhen:
      "When a round runs with a reviewer who is not the owner, so a release lands on somebody else's screen before anybody has read it.",
  },
  "/api/admissions/rounds/[roundId]/stages": {
    reason:
      "Admissions: /api/admissions/rounds/[roundId]/stages is pressed by a reviewer or an admin who reads the outcome on the console.",
    coverWhen:
      "When a round runs with a reviewer who is not the owner, so a release lands on somebody else's screen before anybody has read it.",
  },
  "/api/admissions/rounds/[roundId]/stages/[stageId]/release": {
    reason:
      "Admissions: /api/admissions/rounds/[roundId]/stages/[stageId]/release is pressed by a reviewer or an admin who reads the outcome on the console.",
    coverWhen:
      "When a round runs with a reviewer who is not the owner, so a release lands on somebody else's screen before anybody has read it.",
  },
  "/api/auth/google/callback": {
    reason:
      "Google sign-in is not automatable by design: GIS refuses the interception a script would need, as src/auth/signInWithGoogle.ts documents.",
    coverWhen:
      "Never automated: keep Google sign-in on the manual smoke pass before every dev to main merge.",
  },
  "/api/auth/session/clear": {
    reason:
      "The clear route drops a stale cookie for a session the client can no longer repair, a branch a healthy run never reaches.",
    coverWhen:
      "When a member reports a stuck session again, which is the symptom this route exists to clear.",
  },
  "/api/collaborators": {
    reason:
      "Admin CRUD: /api/collaborators answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/collaborators/[id]": {
    reason:
      "Admin CRUD: /api/collaborators/[id] answers one admin's deliberate press, and its failure lands on that admin's own screen.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/api/courses/[courseId]/destroy": {
    reason:
      "Destroy protocol: /api/courses/[courseId]/destroy removes a whole course or run, and must never be automated against a database other people are using.",
    coverWhen:
      "Never automated here: cover it by hand against the written destroy checklist before an archive.",
  },
  "/api/courses/[courseId]/destroy-manifest": {
    reason:
      "Destroy protocol: /api/courses/[courseId]/destroy-manifest removes a whole course or run, and must never be automated against a database other people are using.",
    coverWhen:
      "Never automated here: cover it by hand against the written destroy checklist before an archive.",
  },
  "/api/courses/[courseId]/page": {
    reason:
      "Courses: /api/courses/[courseId]/page is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/[courseId]/page/generate-themes": {
    reason:
      "Courses: /api/courses/[courseId]/page/generate-themes is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/[courseId]/publish": {
    reason:
      "Courses: /api/courses/[courseId]/publish is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/[courseId]/templates": {
    reason:
      "Courses: /api/courses/[courseId]/templates is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/exercise-responses/[responseId]/review": {
    reason:
      "Learn hub: /api/courses/exercise-responses/[responseId]/review belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/groups/[groupId]/email": {
    reason:
      "Courses: /api/courses/groups/[groupId]/email is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/groups/[groupId]/exercises": {
    reason:
      "Learn hub: /api/courses/groups/[groupId]/exercises belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/groups/[groupId]/facilitators": {
    reason:
      "Courses: /api/courses/groups/[groupId]/facilitators is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/groups/[groupId]/notice": {
    reason:
      "Courses: /api/courses/groups/[groupId]/notice is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/groups/[groupId]/pace": {
    reason:
      "Courses: /api/courses/groups/[groupId]/pace is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/groups/[groupId]/session": {
    reason:
      "Courses: /api/courses/groups/[groupId]/session is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/groups/[groupId]/weeks/[weekId]": {
    reason:
      "Learn hub: /api/courses/groups/[groupId]/weeks/[weekId] belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/groups/[groupId]/weeks/[weekId]/fork": {
    reason:
      "Learn hub: /api/courses/groups/[groupId]/weeks/[weekId]/fork belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/me": {
    reason:
      "/api/courses/me answers the signed-in member's own row, and the client-queries suite runs the reads behind it as every persona.",
    coverWhen:
      "When the dashboard next changes what it shows a member about their run.",
  },
  "/api/courses/progress/[progressId]/moderate": {
    reason:
      "Learn hub: /api/courses/progress/[progressId]/moderate belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/allocate": {
    reason:
      "Courses: /api/courses/runs/[runId]/allocate is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/allocation": {
    reason:
      "Courses: /api/courses/runs/[runId]/allocation is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/allocation/publish": {
    reason:
      "Courses: /api/courses/runs/[runId]/allocation/publish is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/applications": {
    reason:
      "Courses: /api/courses/runs/[runId]/applications is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/applications/[uid]/decide": {
    reason:
      "Courses: /api/courses/runs/[runId]/applications/[uid]/decide is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/applications/[uid]/notes": {
    reason:
      "Courses: /api/courses/runs/[runId]/applications/[uid]/notes is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/apply": {
    reason:
      "Courses: /api/courses/runs/[runId]/apply is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/apply-template": {
    reason:
      "Courses: /api/courses/runs/[runId]/apply-template is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/archive": {
    reason:
      "Courses: /api/courses/runs/[runId]/archive is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/clone-weeks": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/clone-weeks belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/comments": {
    reason:
      "Courses: /api/courses/runs/[runId]/comments is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/destroy": {
    reason:
      "Destroy protocol: /api/courses/runs/[runId]/destroy removes a whole course or run, and must never be automated against a database other people are using.",
    coverWhen:
      "Never automated here: cover it by hand against the written destroy checklist before an archive.",
  },
  "/api/courses/runs/[runId]/destroy-manifest": {
    reason:
      "Destroy protocol: /api/courses/runs/[runId]/destroy-manifest removes a whole course or run, and must never be automated against a database other people are using.",
    coverWhen:
      "Never automated here: cover it by hand against the written destroy checklist before an archive.",
  },
  "/api/courses/runs/[runId]/email": {
    reason:
      "Courses: /api/courses/runs/[runId]/email is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/enrol-mode": {
    reason:
      "Courses: /api/courses/runs/[runId]/enrol-mode is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/enrolments/[uid]/reinstate": {
    reason:
      "Courses: /api/courses/runs/[runId]/enrolments/[uid]/reinstate is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/enrolments/[uid]/remove": {
    reason:
      "Courses: /api/courses/runs/[runId]/enrolments/[uid]/remove is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/exercises/[exerciseId]/submit": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/exercises/[exerciseId]/submit belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/material-notes": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/material-notes belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/my-exercises": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/my-exercises belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/normalise-weeks": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/normalise-weeks belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/nudge": {
    reason:
      "Courses: /api/courses/runs/[runId]/nudge is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/overview": {
    reason:
      "Courses: /api/courses/runs/[runId]/overview is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/retrospective": {
    reason:
      "Learn hub: /api/courses/runs/[runId]/retrospective belongs to the curriculum surface being rebuilt in October.",
    coverWhen:
      "When the October curriculum rebuild lands, because a spec written against today's shape would be thrown away with it.",
  },
  "/api/courses/runs/[runId]/roles": {
    reason:
      "Courses: /api/courses/runs/[runId]/roles is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/status": {
    reason:
      "Courses: /api/courses/runs/[runId]/status is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/runs/[runId]/sync-tasks": {
    reason:
      "Courses: /api/courses/runs/[runId]/sync-tasks is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/courses/templates/[templateId]": {
    reason:
      "Courses: /api/courses/templates/[templateId] is staff-facing, taken deliberately, and answered on the screen that called it.",
    coverWhen:
      "When the run that opens on 21 September is administered through these routes with real applicants in it, because a mistake then costs a member their group rather than an admin a retry.",
  },
  "/api/events/[id]/archive": {
    reason:
      "Events authoring: /api/events/[id]/archive is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/broadcast": {
    reason:
      "Events authoring: /api/events/[id]/broadcast is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/calendar.ics": {
    reason:
      "Events authoring: /api/events/[id]/calendar.ics is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/cancel": {
    reason:
      "Events authoring: /api/events/[id]/cancel is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/collaborators": {
    reason:
      "Events authoring: /api/events/[id]/collaborators is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/delete": {
    reason:
      "Events authoring: /api/events/[id]/delete is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/publish": {
    reason:
      "Events authoring: /api/events/[id]/publish is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/approve": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/approve is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/approve-change": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/approve-change is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/cancel": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/cancel is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/deny": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/deny is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/deny-change": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/deny-change is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/rsvp/[rsvpId]/request-change": {
    reason:
      "Events RSVP: /api/events/[id]/rsvp/[rsvpId]/request-change is guest-facing, and is proven today by the hand pass over the frozen mobile baseline.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/api/events/[id]/test-rsvps": {
    reason:
      "Events authoring: /api/events/[id]/test-rsvps is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/events/[id]/update": {
    reason:
      "Events authoring: /api/events/[id]/update is a deliberate committee action whose result is visible on the manage screen.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/api/members/roster": {
    reason:
      "The members roster feeds a directory that is feature-flagged off, so nothing renders from it today.",
    coverWhen:
      "When the members directory is switched back on.",
  },
  "/api/newsletter/[id]/send": {
    reason:
      "Newsletter: /api/newsletter/[id]/send is pressed by a drafter or an approver who then reads the outcome on the screen.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/api/newsletter/[id]/send-test": {
    reason:
      "Newsletter: /api/newsletter/[id]/send-test is pressed by a drafter or an approver who then reads the outcome on the screen.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/api/newsletter/preview": {
    reason:
      "Newsletter: /api/newsletter/preview is pressed by a drafter or an approver who then reads the outcome on the screen.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/api/push/subscribe": {
    reason:
      "Web push: /api/push/subscribe needs a browser permission grant and the VAPID secrets, which are provisioned in neither environment.",
    coverWhen:
      "When VAPID secrets are provisioned on dev and a spec can accept the permission prompt.",
  },
  "/api/push/test": {
    reason:
      "Web push: /api/push/test needs a browser permission grant and the VAPID secrets, which are provisioned in neither environment.",
    coverWhen:
      "When VAPID secrets are provisioned on dev and a spec can accept the permission prompt.",
  },
  "/api/push/unsubscribe": {
    reason:
      "Web push: /api/push/unsubscribe needs a browser permission grant and the VAPID secrets, which are provisioned in neither environment.",
    coverWhen:
      "When VAPID secrets are provisioned on dev and a spec can accept the permission prompt.",
  },
  "/api/register/resend": {
    reason:
      "The resend route re-sends the registration magic link and sits behind the same reCAPTCHA gate as /api/register.",
    coverWhen:
      "When registration next changes the cooldown or the copy on the check-your-inbox screen.",
  },
  "/api/scheduler/tick": {
    reason:
      "Scheduler: /api/scheduler/tick is executed against a fake database in tests/scheduler.test.mjs, which reaches branches a browser run cannot schedule.",
    coverWhen:
      "When a marker or cursor change has to be proven against real Firestore rather than the fake.",
  },
  "/api/subscriptions": {
    reason:
      "Subscriptions: /api/subscriptions is covered by unit tests over the junction rows, and its answer is read on the page that posted it.",
    coverWhen:
      "When the first issue goes to the real list and an unsubscribe link is somebody's only way out.",
  },
  "/api/subscriptions/confirm": {
    reason:
      "Subscriptions: /api/subscriptions/confirm is covered by unit tests over the junction rows, and its answer is read on the page that posted it.",
    coverWhen:
      "When the first issue goes to the real list and an unsubscribe link is somebody's only way out.",
  },
  "/api/tasks/[id]/delete": {
    reason:
      "Task manager: /api/tasks/[id]/delete is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/delete-block": {
    reason:
      "Task manager: /api/tasks/[id]/delete-block is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/delete-subtask": {
    reason:
      "Task manager: /api/tasks/[id]/delete-subtask is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/notify": {
    reason:
      "Task manager: /api/tasks/[id]/notify is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/notify-member": {
    reason:
      "Task manager: /api/tasks/[id]/notify-member is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/send-for-review": {
    reason:
      "Task manager: /api/tasks/[id]/send-for-review is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/send-initial-notifications": {
    reason:
      "Task manager: /api/tasks/[id]/send-initial-notifications is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/tasks/[id]/send-review-outcome": {
    reason:
      "Task manager: /api/tasks/[id]/send-review-outcome is committee-only, pressed by hand every day, and its failure shows on the board that called it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/api/unsubscribe": {
    reason:
      "Subscriptions: /api/unsubscribe is covered by unit tests over the junction rows, and its answer is read on the page that posted it.",
    coverWhen:
      "When the first issue goes to the real list and an unsubscribe link is somebody's only way out.",
  },
  "/api/webhooks/resend-events": {
    reason:
      "Webhooks: /api/webhooks/resend-events is driven by the provider rather than by a person, and its parsing is covered by the deliverability unit tests.",
    coverWhen:
      "When the provider changes its event shape and the parse has to be proven against a real delivery.",
  },
  "/api/webhooks/ses-events": {
    reason:
      "Webhooks: /api/webhooks/ses-events is driven by the provider rather than by a person, and its parsing is covered by the deliverability unit tests.",
    coverWhen:
      "When the provider changes its event shape and the parse has to be proven against a real delivery.",
  },
  "/(app)/admin/(admin-only)/collaborators": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/collaborators is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/danger-zone": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/danger-zone is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/deliverability": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/deliverability is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/email-designs": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/email-designs is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/email-designs/[templateId]": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/email-designs/[templateId] is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/email-designs/course/[templateId]": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/email-designs/course/[templateId] is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/members": {
    reason:
      "The admin members screen is the owner's own console: role changes, permission grants and the view-as button, each read back on the same page.",
    coverWhen:
      "When a permission grant is next handed to somebody who is not the owner.",
  },
  "/(app)/admin/(admin-only)/newsletter": {
    reason:
      "Newsletter: /(app)/admin/(admin-only)/newsletter is used by two people deliberately, and the result is read back on the page they are looking at.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/(app)/admin/(admin-only)/projects": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/projects is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/registrations": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/registrations is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/site-status": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/site-status is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/subscriptions": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/subscriptions is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/(admin-only)/task-templates": {
    reason:
      "Admin CRUD: /(app)/admin/(admin-only)/task-templates is used by one admin, fails loudly on the screen of the person who pressed the button, and nothing member-facing waits on it.",
    coverWhen:
      "When the risk-ordered list reaches admin CRUD, which is after every applicant-facing and member-facing journey in this map is verified.",
  },
  "/(app)/admin/courses": {
    reason:
      "Course authoring: /(app)/admin/courses is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId] is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/page": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/page is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/runs/[runId] is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/allocation": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/runs/[runId]/allocation is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/applications": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/runs/[runId]/applications is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/retrospective": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/runs/[runId]/retrospective is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/weeks/[weekId]": {
    reason:
      "Course authoring: /(app)/admin/courses/[courseId]/runs/[runId]/weeks/[weekId] is admin-only, and a mistake there is visible to its author before a member reaches it.",
    coverWhen:
      "When somebody other than the owner authors a course, because the cover today is the author reading back their own screen.",
  },
  "/(app)/committee/tasks": {
    reason:
      "Task manager: the committee's daily surface, unchanged for months, and a break is reported by a person within the hour.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/(app)/credentials": {
    reason:
      "The credentials page is a placeholder: the feature has rules deployed but no code behind it. The protected-route-gate battery asserts only that a signed-out visitor is redirected off it.",
    coverWhen:
      "When the credentials store is built and holds a real secret.",
  },
  "/(app)/dashboard": {
    reason:
      "The dashboard summarises the task manager and owns no write of its own, so it breaks only when its sources do. The protected-route-gate battery asserts only that a signed-out visitor is redirected off it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/(app)/events/manage": {
    reason:
      "Events authoring: /(app)/events/manage is committee-facing, and a failure surfaces on the editor that caused it.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/(app)/events/manage/[id]": {
    reason:
      "Events authoring: /(app)/events/manage/[id] is committee-facing, and a failure surfaces on the editor that caused it.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/(app)/events/manage/[id]/attendees": {
    reason:
      "Events authoring: /(app)/events/manage/[id]/attendees is committee-facing, and a failure surfaces on the editor that caused it.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/(app)/events/manage/[id]/preview": {
    reason:
      "Events authoring: /(app)/events/manage/[id]/preview is committee-facing, and a failure surfaces on the editor that caused it.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/(app)/events/manage/new": {
    reason:
      "Events authoring: /(app)/events/manage/new is committee-facing, and a failure surfaces on the editor that caused it.",
    coverWhen:
      "When the events editor is next reshaped, because the hand pass that covers it today is a memory of the old screen.",
  },
  "/(app)/learn": {
    reason:
      "Learn hub: /(app)/learn is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]": {
    reason:
      "Learn hub: /(app)/learn/[runId] is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/admissions": {
    reason:
      "Learn hub: /(app)/learn/[runId]/admissions is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/email": {
    reason:
      "Learn hub: /(app)/learn/[runId]/email is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/group/[groupId]/edit": {
    reason:
      "Learn hub: /(app)/learn/[runId]/group/[groupId]/edit is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/group/[groupId]/edit/[weekId]": {
    reason:
      "Learn hub: /(app)/learn/[runId]/group/[groupId]/edit/[weekId] is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/group/[groupId]/email": {
    reason:
      "Learn hub: /(app)/learn/[runId]/group/[groupId]/email is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/group/[groupId]/review": {
    reason:
      "Learn hub: /(app)/learn/[runId]/group/[groupId]/review is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/nudge": {
    reason:
      "Learn hub: /(app)/learn/[runId]/nudge is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/progress": {
    reason:
      "Learn hub: /(app)/learn/[runId]/progress is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/learn/[runId]/weeks/[n]": {
    reason:
      "Learn hub: /(app)/learn/[runId]/weeks/[n] is part of the curriculum surface being rebuilt in October, so a spec written now would be rewritten with it.",
    coverWhen:
      "When the October curriculum rebuild lands and its first cohort works a week through the new shape.",
  },
  "/(app)/newsletter": {
    reason:
      "Newsletter: /(app)/newsletter is used by two people deliberately, and the result is read back on the page they are looking at. The protected-route-gate battery asserts only that a signed-out visitor is redirected off it.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/(app)/newsletter/[id]": {
    reason:
      "Newsletter: /(app)/newsletter/[id] is used by two people deliberately, and the result is read back on the page they are looking at.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/(app)/newsletter/new": {
    reason:
      "Newsletter: /(app)/newsletter/new is used by two people deliberately, and the result is read back on the page they are looking at.",
    coverWhen:
      "When the first issue goes to the real list, because a mis-send cannot be recalled.",
  },
  "/(app)/tasks": {
    reason:
      "My Work is the member half of the task manager: unchanged, and used daily by the people who would report it. The protected-route-gate battery asserts only that a signed-out visitor is redirected off it.",
    coverWhen:
      "When the task manager is next changed, or when the risk-ordered list reaches it: today it is covered only by the committee noticing within the hour.",
  },
  "/(auth)/pending-approval": {
    reason:
      "Pending approval is one sentence and a sign-out link, rendered for every account this harness creates.",
    coverWhen:
      "When registration next changes what a fresh account lands on.",
  },
  "/(public)": {
    reason:
      "The landing page is server-rendered from static content or one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/applications/[roundId]": {
    reason:
      "The per-round applicant status page is the detail behind the hub the funnel already asserts.",
    coverWhen:
      "When the first round publishes its decisions, because this is the screen an applicant refreshes.",
  },
  "/(public)/courses": {
    reason:
      "The catalogue lists published courses and is one query behind the course page a spec already drives.",
    coverWhen:
      "When the catalogue lists more than one published course, so an ordering or a filter can be wrong.",
  },
  "/(public)/courses/[courseId]/apply": {
    reason:
      "The course apply page forwards to the round a course points at, which the funnel drives directly.",
    coverWhen:
      "When a course points at a round on the day that round opens and applicants arrive by the forward.",
  },
  "/(public)/courses/[courseId]/weeks/[week]": {
    reason:
      "The public week page renders published curriculum, which the October rebuild reshapes.",
    coverWhen:
      "When the October curriculum rebuild lands and the first published week is public.",
  },
  "/(public)/events": {
    reason:
      "Events RSVP: /(public)/events belongs to the flow frozen by docs/mobile-baseline-events.md, which is re-checked by hand on every touching change.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/(public)/events/[id]/rsvp/[rsvpId]/cancel": {
    reason:
      "Events RSVP: /(public)/events/[id]/rsvp/[rsvpId]/cancel belongs to the flow frozen by docs/mobile-baseline-events.md, which is re-checked by hand on every touching change.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/(public)/events/[id]/rsvp/[rsvpId]/change": {
    reason:
      "Events RSVP: /(public)/events/[id]/rsvp/[rsvpId]/change belongs to the flow frozen by docs/mobile-baseline-events.md, which is re-checked by hand on every touching change.",
    coverWhen:
      "When an event next runs with a capacity and a waitlist, because a wrong decision there is a real person losing their place.",
  },
  "/(public)/members": {
    reason:
      "The public members page is server-rendered from static content or one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/news": {
    reason:
      "The public news page is server-rendered from static content or one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/news/[slug]": {
    reason:
      "The public news article page is server-rendered from one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/privacy": {
    reason:
      "/(public)/privacy renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/(public)/privacy/v/[version]": {
    reason:
      "/(public)/privacy/v/[version] renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/(public)/privacy/versions": {
    reason:
      "/(public)/privacy/versions renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/(public)/resources": {
    reason:
      "The public resources page is server-rendered from static content or one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/status": {
    reason:
      "The public status page is server-rendered from static content or one read, and a break is visible to anybody who opens it.",
    coverWhen:
      "When the public site is next restyled, which changes all of these renders in one pull request.",
  },
  "/(public)/terms": {
    reason:
      "/(public)/terms renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/(public)/terms/v/[version]": {
    reason:
      "/(public)/terms/v/[version] renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/(public)/terms/versions": {
    reason:
      "/(public)/terms/versions renders the versioned policy files, whose content tests/privacy-policy-v3.test.mjs already pins.",
    coverWhen:
      "When a policy version ships and the re-consent gate has to be proven end to end.",
  },
  "/collaborator": {
    reason:
      "The collaborator page is reached by an invited outsider through a signed link, and the redirect half of it is asserted by the protected-route-gate battery.",
    coverWhen:
      "When an outside collaborator is next invited to an event and has to follow the signed link in.",
  },
  "/re-consent": {
    reason:
      "The re-consent gate is skipped under NODE_ENV=development, so a dev-server run cannot see it at all.",
    coverWhen:
      "When a spec runs against a production build and a policy version bumps.",
  },
};

/* -------------------------------------------------------------------------
 * 3. Reading the spec modules
 * ---------------------------------------------------------------------- */

/** The two answers `SPEC.status` may give. Anything else is a broken module. */
const STATUSES = ["verified", "unverified"];

/**
 * Every spec module beside `core.mjs`, imported for its `SPEC`.
 *
 * Safe under `npm test` because `core.mjs` does no work at import: no
 * `loadEnv()`, no Firestore handle, no file read. A module that reached for a
 * credential on import would make this guard unrunnable without credentials,
 * which is why that property is written down in `core.mjs` and asserted by
 * `tests/funnel-harness-guards.test.mjs`.
 */
async function readSpecs() {
  const out = [];
  for (const entry of readdirSync(FIXTURES_DIR).sort()) {
    if (!entry.endsWith(".mjs") || entry === "core.mjs") continue;
    const mod = await import(pathToFileURL(join(FIXTURES_DIR, entry)).href);
    out.push({ rel: `scripts/e2e-fixtures/${entry}`, spec: mod.SPEC });
  }
  return out;
}

const coversOf = (spec) => [...(spec?.covers?.routes ?? []), ...(spec?.covers?.pages ?? [])];

/* -------------------------------------------------------------------------
 * 4. The checks
 * ---------------------------------------------------------------------- */

test("the src/app walk finds the tree it is supposed to map", () => {
  // Without this, a walk rooted somewhere that no longer exists would find no
  // routes at all, every key would be trivially "covered", and this file would
  // pass by mapping nothing. The thresholds are far below today's counts (155
  // routes, 81 pages on 6 September 2026) and exist only to catch zero.
  assert.ok(
    ROUTE_KEYS.size > 100,
    `the walk found ${ROUTE_KEYS.size} route.ts files under src/app, which is far too few.`,
  );
  assert.ok(
    PAGE_KEYS.size > 50,
    `the walk found ${PAGE_KEYS.size} page.tsx files under src/app, which is far too few.`,
  );
});

test("every spec module declares a status this map can read", async () => {
  const specs = await readSpecs();
  assert.ok(specs.length > 0, "no spec module was found beside core.mjs.");
  for (const { rel, spec } of specs) {
    assert.ok(spec && typeof spec === "object", `${rel} exports no SPEC object.`);
    assert.ok(
      STATUSES.includes(spec.status),
      `${rel}: SPEC.status is ${JSON.stringify(spec.status)}. It must be one of ` +
        `${STATUSES.map((s) => JSON.stringify(s)).join(" or ")}. "verified" means this ` +
        "spec has passed end to end at least once, with a teardown manifest of zero; " +
        "until then it is \"unverified\" and its covers count for nothing here.",
    );
  }
});

test("a spec that has never passed is reported, and covers nothing", async () => {
  // Not a failure. Writing a spec and not running it is a normal state on the
  // day it is written. It is only dangerous when it is SILENT, because the map
  // would then read as covered while nothing had ever driven the routes.
  const specs = await readSpecs();
  const unverified = specs.filter(({ spec }) => spec?.status === "unverified");
  for (const { rel, spec } of unverified) {
    console.log(
      `[e2e-coverage] spec written, never run: ${spec.name} (${rel}): ` +
        `${coversOf(spec).join(", ") || "nothing declared"}`,
    );
  }
  const verified = specs.filter(({ spec }) => spec?.status === "verified");
  console.log(
    `[e2e-coverage] ${verified.length} of ${specs.length} spec module(s) are verified and ` +
      "count towards the map.",
  );
});

test("every auth battery is declared, and everything it names exists", () => {
  const files = readdirSync(BATTERIES_DIR)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  assert.ok(files.length > 0, `no batteries found under ${relative(REPO_ROOT, BATTERIES_DIR)}.`);

  // Both directions. A battery with no entry is a battery whose coverage this
  // map cannot see; an entry with no battery is a claim about a file somebody
  // deleted.
  for (const name of files) {
    assert.ok(
      AUTH_BATTERIES[name],
      `scripts/e2e/tests/${name} has no AUTH_BATTERIES entry, so whatever it drives is ` +
        "invisible to this map. Read it and add one naming the routes it exercises.",
    );
  }
  for (const name of Object.keys(AUTH_BATTERIES)) {
    assert.ok(
      files.includes(name),
      `AUTH_BATTERIES names scripts/e2e/tests/${name}, which does not exist. Delete the ` +
        "entry, or point it at the file that replaced it.",
    );
  }

  for (const [name, battery] of Object.entries(AUTH_BATTERIES)) {
    assert.ok(
      typeof battery.why === "string" && battery.why.length >= 25,
      `AUTH_BATTERIES["${name}"].why must say what the battery protects.`,
    );
    for (const key of battery.drives) {
      assert.ok(
        ALL_KEYS.has(key),
        `AUTH_BATTERIES["${name}"] drives ${JSON.stringify(key)}, which is not a route or ` +
          "page in src/app. Keys are the src/app path with /route.ts or /page.tsx removed.",
      );
    }
    for (const key of battery.redirectOnly ?? []) {
      assert.ok(
        ALL_KEYS.has(key),
        `AUTH_BATTERIES["${name}"].redirectOnly names ${JSON.stringify(key)}, which is not ` +
          "a page in src/app.",
      );
    }
    for (const [path, why] of Object.entries(battery.unmappedPaths ?? {})) {
      assert.ok(
        why.length >= 25,
        `AUTH_BATTERIES["${name}"].unmappedPaths["${path}"] needs a written reason.`,
      );
      // The one thing worth asserting about an unmapped path: that it is still
      // unmapped. A page landing there turns a declared hole into real
      // coverage nobody recorded.
      const asPageKeys = [...PAGE_KEYS.keys()].filter((key) =>
        key.replace(/\/\([^)]+\)/g, "") === path,
      );
      assert.equal(
        asPageKeys.length,
        0,
        `AUTH_BATTERIES["${name}"].unmappedPaths lists ${path} as having no page, but ` +
          `${asPageKeys.join(", ")} now serves it. Move it into drives or redirectOnly.`,
      );
    }
  }
});

test("every route and page is exercised, or written down as a gap", async () => {
  const specs = await readSpecs();
  const verified = specs.filter(({ spec }) => spec?.status === "verified");
  const unverified = specs.filter(({ spec }) => spec?.status !== "verified");

  /** key -> what exercises it, for the summary and the failure messages. */
  const exercised = new Map();
  for (const { rel, spec } of verified) {
    for (const key of coversOf(spec)) {
      exercised.set(key, `${spec.name} (${rel})`);
    }
  }
  for (const [name, battery] of Object.entries(AUTH_BATTERIES)) {
    for (const key of battery.drives) {
      const before = exercised.get(key);
      exercised.set(key, before ? `${before}, scripts/e2e/tests/${name}` : `scripts/e2e/tests/${name}`);
    }
  }

  const gaps = [];
  for (const [key, file] of ALL_KEYS) {
    if (exercised.has(key)) continue;
    if (NOT_COVERED[key]) continue;
    const claimed = unverified
      .filter(({ spec }) => coversOf(spec).includes(key))
      .map(({ rel }) => rel);
    gaps.push(
      `${key} (${file}) is exercised by nothing and has no NOT_COVERED entry.` +
        (claimed.length > 0
          ? ` ${claimed.join(", ")} ${claimed.length === 1 ? "claims" : "claim"} it, but ` +
            `${claimed.length === 1 ? "its" : "their"} SPEC.status is "unverified", so it ` +
            "counts for nothing until the spec has passed once."
          : " Write a spec for it, or add an entry saying why it is uncovered and what " +
            "would trigger covering it."),
    );
  }

  console.log(
    `[e2e-coverage] ${exercised.size} of ${ALL_KEYS.size} routes and pages are exercised; ` +
      `${Object.keys(NOT_COVERED).length} are written down as gaps.`,
  );
  assert.deepEqual(gaps, [], `\n${gaps.join("\n")}\n`);
});

test("no NOT_COVERED entry has gone stale", async () => {
  const specs = await readSpecs();
  const verified = specs.filter(({ spec }) => spec?.status === "verified");
  const stale = [];

  for (const key of Object.keys(NOT_COVERED)) {
    if (!ALL_KEYS.has(key)) {
      stale.push(
        `${key} is in NOT_COVERED but is no longer a route or page in src/app. It moved or ` +
          "was deleted, and its reason went with it. Delete the entry, or re-key it.",
      );
      continue;
    }
    const by = verified.filter(({ spec }) => coversOf(spec).includes(key));
    if (by.length > 0) {
      stale.push(
        `${key} is in NOT_COVERED and is also covered by ${by
          .map(({ spec }) => spec.name)
          .join(", ")}, which is verified. A key is covered or it is a written-down gap, ` +
          "never both: delete the entry in the same pull request as the spec that covers it.",
      );
    }
    // A battery's own routes are covered the same way, minus the pages it only
    // ever sees a redirect from, which are deliberately in both lists.
    for (const [name, battery] of Object.entries(AUTH_BATTERIES)) {
      if (battery.drives.includes(key)) {
        stale.push(
          `${key} is in NOT_COVERED and is driven by scripts/e2e/tests/${name}. Delete the ` +
            "entry: a route a battery exercises is covered.",
        );
      }
    }
  }
  assert.deepEqual(stale, [], `\n${stale.join("\n")}\n`);
});

test("every NOT_COVERED entry carries a real reason and a real trigger", () => {
  const bad = [];
  for (const [key, entry] of Object.entries(NOT_COVERED)) {
    if (typeof entry?.reason !== "string" || entry.reason.trim().length < 25) {
      bad.push(
        `${key}: reason must be a sentence saying why the gap is acceptable today, not ` +
          `${JSON.stringify(entry?.reason)}.`,
      );
    }
    if (typeof entry?.coverWhen !== "string" || entry.coverWhen.trim().length < 15) {
      bad.push(
        `${key}: coverWhen must name the trigger that closes the gap, not ` +
          `${JSON.stringify(entry?.coverWhen)}. A trigger is a thing that happens ` +
          "(a rebuild lands, a real export arrives, a spec reaches this screen), never " +
          "an intention.",
      );
    }
    /**
     * THE CIRCULAR TRIGGER, which the length check above cannot see. "When a
     * course spec drives /api/courses/[courseId]/publish for a seeded run" is
     * eighty characters of nothing: it says the gap closes when somebody
     * closes it. A trigger names an event OUTSIDE this file (a rebuild lands,
     * a cohort starts, a real export arrives, the risk-ordered list gets
     * here), and the cheapest tell of the circular kind is that it recites its
     * own key back. So a coverWhen may not name the route or page it belongs
     * to. The `reason` may, and does: that one is allowed to describe the
     * surface.
     */
    if (typeof entry?.coverWhen === "string" && entry.coverWhen.includes(key)) {
      bad.push(
        `${key}: coverWhen names its own key back, which makes it circular: it says the gap ` +
          "closes when somebody closes it. Name the event that will prompt the spec instead " +
          "(a rebuild landing, a cohort starting, a real export arriving, the risk-ordered " +
          "list reaching this group).",
      );
    }
    for (const field of Object.keys(entry ?? {})) {
      assert.ok(
        ["reason", "coverWhen"].includes(field),
        `${key}: unknown field ${JSON.stringify(field)}. An entry is { reason, coverWhen }.`,
      );
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}\n`);
});

test("every covers key resolves to a route or page that exists", async () => {
  // Also checked by tests/funnel-harness-guards.test.mjs, on purpose. That one
  // is the SPEC contract; this one is the map. They agree today, and the day
  // somebody relaxes one of them the other still fails.
  const specs = await readSpecs();
  const wrong = [];
  for (const { rel, spec } of specs) {
    for (const key of spec?.covers?.routes ?? []) {
      if (!ROUTE_KEYS.has(key)) wrong.push(`${rel}: covers.routes names ${key}, which is not a route.`);
    }
    for (const key of spec?.covers?.pages ?? []) {
      if (!PAGE_KEYS.has(key)) wrong.push(`${rel}: covers.pages names ${key}, which is not a page.`);
    }
  }
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}\n`);
});

test("the pages a battery only redirects off are written down as such", async () => {
  const specs = await readSpecs();
  const covered = new Set(
    specs.filter(({ spec }) => spec?.status === "verified").flatMap(({ spec }) => coversOf(spec)),
  );
  // The trap this closes: counting a 307 as coverage. The protected-route-gate
  // battery requests /dashboard and friends as a signed-out visitor and
  // asserts the redirect. Nothing renders. So each of those pages stays a
  // written-down gap, and its reason has to SAY that the redirect is all that
  // is asserted, or the next reader will take the entry as pessimism and
  // delete it.
  const missing = [];
  for (const [name, battery] of Object.entries(AUTH_BATTERIES)) {
    for (const key of battery.redirectOnly ?? []) {
      // A verified spec that really drives the page settles the question: the
      // page is covered, the redirect note is moot, and the stale check above
      // has already required the NOT_COVERED entry to be gone.
      if (covered.has(key)) continue;
      const entry = NOT_COVERED[key];
      if (!entry) {
        missing.push(
          `${key} is redirect-only for scripts/e2e/tests/${name} and has no NOT_COVERED ` +
            "entry. A redirect is not coverage of the page behind it.",
        );
        continue;
      }
      if (!/redirect/i.test(entry.reason)) {
        missing.push(
          `${key}: scripts/e2e/tests/${name} asserts only the signed-out redirect off this ` +
            "page, and the NOT_COVERED reason does not say so.",
        );
      }
    }
  }
  assert.deepEqual(missing, [], `\n${missing.join("\n")}\n`);
});
