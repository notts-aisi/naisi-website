/**
 * The shared TypeScript loader: `tests/lib/tsLoader.mjs`.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * ## What is worth executing here
 *
 * The loader exists because fifty hand-copied versions of it could not read a
 * `.tsx`, and the failure that produced was the worst shape a test failure
 * comes in: the FIRST email template a suite's graph reached killed the whole
 * FILE with a bare `SyntaxError` at import time, before one test ran. It looked
 * like a broken suite rather than a missing compiler option, and the way out
 * everybody found was to stub the template. That is a stub whose only reason to
 * exist is that the tool cannot read the file, which means the template is
 * never executed by anything and a change to it is never noticed.
 *
 * So the class is closed here rather than asserted in prose:
 *
 *  1. a real `.tsx` template compiles and RENDERS through the loader;
 *  2. the same template renders when it is reached the way production reaches
 *     it, through a `.ts` server helper that imports it. That is the exact
 *     failure that bit twice while the worksheet routes were being built;
 *  3. the two resolution rules that make (1) and (2) work are pinned on a
 *     fixture pair of their own: a `.ts` importing a relative `.tsx` with no
 *     extension finds it, and a local import that is NOT TypeScript (a
 *     stylesheet, which every client module's graph reaches within a step or
 *     two) is refused by name instead of being fed to the compiler as if it
 *     were code;
 *  4. a stub still wins over a real module, because every suite's fakes (the
 *     transport, the Admin SDK, the session) depend on that and a loader that
 *     resolved eagerly would put mail on the wire;
 *  5. no file that imports the shared loader also carries a copy of the old
 *     one, AND no file outside the frozen list below carries a copy at all.
 *     Two loaders in one file is the confusion this change removes; a
 *     forty-fourth copy is the class itself coming back, in the one shape a
 *     check that only looks at adopters would never see. A tree walk is what
 *     keeps both out once nobody remembers why.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@react-email/render";
import { createLoader } from "./lib/tsLoader.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Nothing in this file reaches a project, a bucket or an inbox. */
const DOORS = [
  ["server-only", "export {};"],
  [
    "@/lib/email/send",
    "export async function sendEmail(args) {\n  (globalThis.__sent ||= []).push(args);\n}",
  ],
  ["@/lib/push/taskNotifications", "export async function mirrorTaskEmailToPush() {}"],
  ["@/lib/firestore/taskEmailConfig", "export async function isTaskEmailEnabled() {\n  return true;\n}"],
  [
    "@/lib/email/taskMembership",
    "export async function resolveTaskUsers(db, uids) {\n" +
      "  return new Map(uids.map((uid) => [uid, { email: `${uid}@example.com`, displayName: 'Ada' }]));\n" +
      "}",
  ],
];

const TEMPLATE_PROPS = {
  recipientName: "Ada",
  worksheetTitle: "Week 3: scaling laws",
  reviewerName: "Sam",
  link: "https://naisi.uk/worksheets/respond/circ1",
};

// ---------------------------------------------------------------------------
// The loader itself
// ---------------------------------------------------------------------------

describe("the shared loader reads JSX", () => {
  test("a real `.tsx` template compiles and renders to HTML", async () => {
    const { loadTs } = createLoader({ stubs: DOORS });
    const { default: WorksheetFeedbackEmail } = await loadTs(
      "emails/WorksheetFeedbackEmail.tsx",
    );

    const html = await render(WorksheetFeedbackEmail(TEMPLATE_PROPS));

    assert.match(
      html,
      /Read the feedback/,
      "the button that takes somebody to the respond page is the whole point of this message",
    );
    assert.match(html, /Week 3: scaling laws/);
    assert.match(
      html,
      /<html/i,
      "the chrome came from the real `EmailChrome.tsx`, reached as a relative `.tsx` import",
    );
    assert.doesNotMatch(
      html,
      /Sam has written/,
      "the feedback words themselves stay on the respond page; the email only says there are some",
    );
  });

  test("the same template renders when a `.ts` server helper reaches it", async () => {
    // The failure this loader was built for, executed. `notify.ts` is a plain
    // `.ts` module that imports four `.tsx` templates by alias, and each of
    // those imports `./EmailChrome` relatively: a `.ts` entry, an aliased
    // `.tsx`, and a relative `.tsx` beneath it. Every hand-copied loader died
    // on the first of those with a `SyntaxError`, and the four suites that hit
    // it stubbed the templates to get moving, which left the rendering of a
    // real message untested by anything.
    //
    // (The `.ts` importing a relative `.tsx` is the same shape, pinned on its
    // own against a fixture in the test below: `src` has no server-side
    // example to load here, because the seven `.ts` files that import a
    // relative `.tsx` are all client modules whose graphs reach CSS modules.)
    const { loadTs } = createLoader({ stubs: DOORS });
    const { notifyWorksheetEvent } = await loadTs("lib/worksheets/notify.ts");

    globalThis.__sent = [];
    const result = await notifyWorksheetEvent(
      {},
      {
        circulation: {
          title: "Week 3: scaling laws",
          notifications: { feedbackReturned: { email: true, push: false } },
        },
        circulationId: "circ1",
        event: "feedbackReturned",
        recipientUids: ["member1"],
        actor: { uid: "staff1", displayName: "Sam" },
      },
    );

    assert.deepEqual(result, { sent: 1, failed: 0 });
    assert.equal(globalThis.__sent.length, 1);

    const html = await render(globalThis.__sent[0].react);
    assert.match(
      html,
      /Read the feedback/,
      "the element the send path handed the transport is the real template, rendered",
    );
    assert.equal(globalThis.__sent[0].to, "member1@example.com");
  });

  test("a stub still wins over a real module", async () => {
    // The specifier is matched as WRITTEN, before anything is resolved, so a
    // relative key stubs that import from whichever file wrote it. Every suite
    // depends on this for its doors: `@/lib/email/send` resolves to a real
    // module that would reach a transport, and a loader that preferred the file
    // on disk would put mail on the wire from `npm test`.
    const { loadTs } = createLoader({
      stubs: [
        ...DOORS,
        [
          "./EmailChrome",
          "export default function EmailChrome(props) {\n  return props.children;\n}\n" +
            "export const emailLinkStyle = {};",
        ],
      ],
    });
    const { default: WorksheetFeedbackEmail } = await loadTs(
      "emails/WorksheetFeedbackEmail.tsx",
    );

    const html = await render(WorksheetFeedbackEmail(TEMPLATE_PROPS));

    assert.match(html, /Read the feedback/, "the template itself is still the real one");
    assert.doesNotMatch(
      html,
      /<html/i,
      "the chrome came from the stub, so the real `EmailChrome.tsx` was never loaded",
    );
  });

  test("a `.ts` module reaches a relative `.tsx` neighbour", async () => {
    // The literal case, on a two-file fixture: `entry.ts` imports `./Panel`
    // with no extension, so the loader tries `.ts`, misses, and has to accept
    // the `.tsx`. Both halves matter and both used to fail: without the
    // candidate the import is unresolvable, and without the JSX option the
    // neighbour dies as a `SyntaxError`.
    const { loadTs } = createLoader();
    const { panelFor } = await loadTs(join(TESTS_DIR, "fixtures", "ts-loader", "entry.ts"));

    const element = panelFor("Ada");
    assert.equal(
      element.type,
      "span",
      "the `.tsx` compiled to an element rather than being read as a type assertion",
    );
    assert.equal([element.props.children].flat().join(""), "Hello Ada");
  });

  test("a local import that is not TypeScript is refused by name", async () => {
    // A stylesheet is ON DISK, so a loader that accepted the bare path would
    // hand `transpileModule` some CSS and the reader would get a parse error
    // from inside a `data:` URL with nothing naming the import. Refusing it
    // here is what turns that into one readable line.
    const { loadTs } = createLoader();
    await assert.rejects(
      () => loadTs(join(TESTS_DIR, "fixtures", "ts-loader", "notTypeScript.ts")),
      /"\.\/panel\.module\.css"[\s\S]*is not TypeScript/,
    );
  });

  test("a module that is not there is named, rather than failing as something else", async () => {
    const { loadTs } = createLoader({ stubs: DOORS });
    await assert.rejects(
      () => loadTs("lib/worksheets/thereIsNoSuchModule.ts"),
      /no module at src\/lib\/worksheets\/thereIsNoSuchModule\.ts/,
    );
  });
});

// ---------------------------------------------------------------------------
// The guard: one loader per file, and the register of who uses this one
// ---------------------------------------------------------------------------

/**
 * Every suite that imports the shared loader, and why.
 *
 * The seven below are the files this change migrated. Six of them have a `.tsx`
 * in their module graph and had already paid for the missing JSX option, either
 * with template stubs standing in for code nothing executed or with a door
 * stubbed a step earlier than the suite wanted. Those stubs are gone; the doors
 * each suite still fakes (the transport, the Admin SDK handle, the session, the
 * impersonation guard, `firebase-admin` sentinels) stayed, because those are
 * about reaching the outside world rather than about reading a file. The
 * seventh, `worksheet-aggregate`, is the third suite over a tree whose other
 * routes reach the templates, and it moved with its siblings.
 *
 * The list is checked BOTH WAYS: an entry naming a file that no longer imports
 * the loader fails, and a suite importing the loader with no entry fails. A
 * list that can only grow is a list nobody trusts, and the reason column is
 * what makes the next person's decision to adopt it legible.
 *
 * The forty-three suites that still carry their own copy are not required to
 * migrate. That they pass at all is the proof their graphs stop short of a
 * `.tsx`, so a wholesale rewrite would be a large diff with no failure behind
 * it. They move when they next need to change, and until then they are held
 * still by `LEGACY_LOADERS` below.
 */
const USERS = new Map([
  [
    "ts-loader.test.mjs",
    "the loader's own suite: it proves the JSX class is closed and walks the tree below",
  ],
  [
    "worksheet-routes.test.mjs",
    "the circulation routes reach `notify.ts` and the four `.tsx` templates behind it; all four " +
      "were stubbed, two of them for no reason but the missing JSX option, and the messages this " +
      "file sends are now asserted as rendered HTML",
  ],
  [
    "worksheet-review-routes.test.mjs",
    "the other half of the same tree, through the same `notify.ts` and the same four templates; " +
      "the no-feedback-in-the-email promise is now checked against the rendered message",
  ],
  [
    "worksheet-aggregate.test.mjs",
    "the third suite over the same tree, sharing the other two's fake store; nothing it loads " +
      "reaches a `.tsx` yet, and every route beside the three it loads imports `notify.ts`",
  ],
  [
    "worksheet-due-reminders.test.mjs",
    "it loads `registry.ts` for `policyFor`, and the registry imports every job by value, so every " +
      "job's send path is in its graph; its comments named the missing JSX option as a reason to " +
      "stub two of those doors, and now only the transport is",
  ],
  [
    "scheduler-markers.test.mjs",
    "same shape: `registry.ts` is loaded for the caps and windows and drags every job's graph in " +
      "with it, and the stub comments said so in as many words",
  ],
  [
    "admissions-reminders.test.mjs",
    "same again, plus the admissions job it actually runs; un-stubbing any one of those doors to " +
      "assert on what a job sends used to fail the file with a SyntaxError instead",
  ],
  [
    "admissions-stage-release.test.mjs",
    "it loads `admissionEmails.ts` FOR REAL for the token contract, so all six admissions " +
      "templates are compiled here; they were the eight `return null` stubs this change deleted",
  ],
  [
    "email-suppression-chokepoint.test.mjs",
    "it executes `send.ts` in-process to prove a suppressed recipient never reaches the " +
      "transport and is logged as held; the transport, the renderer and the Admin SDK door are " +
      "its only stubs, so any template a caller renders compiles for real",
  ],
  [
    "reminder-slots.test.mjs",
    "the shared reminder-slot model and its resolver: `schedule.ts` reaches `schedulerMarkers.ts` " +
      "and the suite also loads the admissions adapter to prove the two features resolve through " +
      "one piece of arithmetic, so it is a multi-module graph rather than one leaf file",
  ],
]);

/**
 * The forty-three suites that still carry a hand-copied loader, frozen.
 *
 * One reason covers the list, because it is one decision: each of these works
 * today, each one's module graph stops short of a `.tsx`, and rewriting them
 * all would be a large diff with no failure behind it. They are here so the
 * check below can tell an OLD copy from a NEW one. That distinction is the
 * whole point: a check that only asks its question of files importing the
 * shared loader would pass a forty-fourth copy pasted into a new suite, which
 * is exactly how this class arrived twice already. The next person to write a
 * suite that reaches an email template would meet the same bare `SyntaxError`
 * and nothing would tell them why.
 *
 * Checked both ways. A file missing from the list fails (import the shared
 * loader instead of pasting a copy), and an entry whose file no longer has a
 * copy fails (migrate it, then delete its line here, so the list can only
 * shrink). Deleting the last entry deletes the check.
 */
const LEGACY_LOADERS = [
  "account-deletion-admission-roles.test.mjs",
  "account-deletion-attendance.test.mjs",
  "account-deletion-memberships.test.mjs",
  "admissions-apply-flow.test.mjs",
  "admissions-appointment-decide.test.mjs",
  "admissions-appointment-round.test.mjs",
  "admissions-predicates.test.mjs",
  "admissions-round-console.test.mjs",
  "admissions-stage-ids.test.mjs",
  "admissions-status-hub.test.mjs",
  "course-cohort-audience.test.mjs",
  "course-deletion.test.mjs",
  "course-enrol.test.mjs",
  "course-group-resolve.test.mjs",
  "course-nudge.test.mjs",
  "course-offer.test.mjs",
  "course-pages.test.mjs",
  "course-programme-page.test.mjs",
  "course-schedule-changes.test.mjs",
  "course-sessions.test.mjs",
  "course-streams.test.mjs",
  "course-task-mirror.test.mjs",
  "course-templates.test.mjs",
  "course-window.test.mjs",
  "data-exports.test.mjs",
  "form-question-limits.test.mjs",
  "impersonation-guard.test.mjs",
  "member-conduct-flag.test.mjs",
  "membership-grant-route.test.mjs",
  "membership-import-routes.test.mjs",
  "membership-import.test.mjs",
  "membership.test.mjs",
  "privacy-policy.test.mjs",
  "push-preferences.test.mjs",
  "recaptcha-bypass.test.mjs",
  "scheduler.test.mjs",
  "task-artefact.test.mjs",
  "unmarked-registers.test.mjs",
  "week-plan.test.mjs",
  "worksheet-editor-helpers.test.mjs",
  "worksheet-respond-helpers.test.mjs",
  "worksheets-circulation-view.test.mjs",
  "worksheets-model.test.mjs",
];

/**
 * A CALL to the compiler, in either shape a copy is written in: qualified on
 * the compiler object, or destructured out of it and called bare. It matches a
 * call rather than the name, so the prose in this file, which names the
 * function repeatedly and never follows it with an opening bracket, is not
 * itself read as a loader.
 */
const LOCAL_LOADER = /\btranspileModule\s*\(/;

/**
 * Every `*.test.mjs` under `tests/`, at any depth. The recursion is not
 * decoration: this change created `tests/lib/`, and a suite parked in a
 * subdirectory is exactly the one a top-level-only walk would stop seeing.
 */
function testFiles() {
  return readdirSync(TESTS_DIR, { recursive: true })
    .map((entry) => entry.split(sep).join("/"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
}

function readTest(name) {
  return readFileSync(join(TESTS_DIR, name), "utf8");
}

const importsSharedLoader = (source) => source.includes("lib/tsLoader.mjs");

describe("one loader per file", () => {
  test("no file imports the shared loader AND defines its own", () => {
    const offenders = testFiles().filter((name) => {
      const source = readTest(name);
      return importsSharedLoader(source) && LOCAL_LOADER.test(source);
    });

    assert.deepEqual(
      offenders,
      [],
      "these files have two loaders in them. Delete the local `transpileModule` dance and " +
        "move its `STUBS` into `createLoader({ stubs })`: a file with both will quietly " +
        "load half its graph through a loader that cannot read JSX.",
    );
  });

  test("no suite outside the frozen list carries a hand-copied loader", () => {
    const copies = testFiles().filter((name) => LOCAL_LOADER.test(readTest(name)));

    assert.deepEqual(
      copies,
      [...LEGACY_LOADERS].sort(),
      "a suite is compiling TypeScript with a loader of its own. If it is NEW, delete the " +
        "copy and `import { createLoader } from \"./lib/tsLoader.mjs\"`: a copy cannot read " +
        "a `.tsx`, so the first email template its graph reaches will kill the whole file " +
        "with a bare SyntaxError before one test runs, which is the afternoon this shared " +
        "loader exists to give back. If instead a listed suite has just been MIGRATED, " +
        "delete its line from `LEGACY_LOADERS` and add it to `USERS` with its reason.",
    );
  });

  test("every user of the shared loader is registered, with a reason", () => {
    const users = testFiles().filter((name) => importsSharedLoader(readTest(name)));

    assert.deepEqual(
      users,
      [...USERS.keys()].sort(),
      "the register in this file and the suites importing `tests/lib/tsLoader.mjs` disagree. " +
        "Add the new suite with the reason its graph needs the shared loader, or delete the " +
        "entry for a suite that no longer uses it.",
    );

    for (const [name, why] of USERS) {
      assert.ok(
        typeof why === "string" && why.length > 30,
        `${name} needs a written reason, not a placeholder`,
      );
    }
  });

  test("no registered file still stubs an email template to dodge JSX", () => {
    // The stubs this change deleted, named. A template stub that comes back is
    // either a real need (a suite that wants to assert on props rather than on
    // HTML, which should say so in a comment) or the old reflex returning, and
    // the failure message asks the question rather than assuming.
    const offenders = [];
    for (const name of USERS.keys()) {
      const source = readTest(name);
      for (const [specifier] of source.matchAll(/"@\/emails\/[A-Za-z]+"/g)) {
        offenders.push(`${name}: ${specifier}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "the shared loader compiles `.tsx`, so an email template no longer has to be stubbed. " +
        "If a suite stubs one for a different reason, that reason belongs in a comment and " +
        "this check belongs alongside it.",
    );
  });
});
