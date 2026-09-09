/**
 * A DEADLINE SOMEBODY IS TOLD ABOUT IS ENFORCED BY THE WRITE IT BOUNDS.
 *
 * WHY. On 8 September 2026 the API red team found that an admission stage's
 * own `closesAt` was authored, stored, printed in the announcement email and
 * enforced nowhere. `effectiveStageClose` had exactly two call sites in the
 * repository: the reminder job that computed it, and the line that put it in
 * the email as a date. The only time gate on a stage submit was the ROUND's
 * window, so somebody told "Part 2 is due Friday 10 October" could answer and
 * file it on the 14th with four days of thinking time nobody else was given,
 * and no crafted request was needed: the ordinary form rendered a live submit
 * button, because it too asked the round's window. That is the same fairness
 * property the release boundary exists to protect, at the other end of the
 * stage.
 *
 * The shape of the defect is a function that computes a deadline and is only
 * ever read by something that TELLS a person about it. So the guard asks two
 * questions of the tree, and executes the fix:
 *
 *  1. EVERY STORED DEADLINE is registered. The scan walks the normalisers in
 *     `src/lib/firestore`, the files CLAUDE.md calls the authoritative shape of
 *     each collection, for a field whose name says it is a time limit. Each one
 *     says who it binds, where they are told, and either where it is enforced
 *     or, in writing, why nothing refuses past it. Both directions, per-field
 *     counts. A new deadline field fails here until the question is answered.
 *  2. EVERY FUNCTION THAT COMPUTES ONE has each of its call sites classified as
 *     telling somebody, enforcing a write, or deriving another predicate. Both
 *     directions against the tree, and the sentence that closes the class: a
 *     function with a `tells` site and no `enforces` site FAILS. That is
 *     precisely the state `effectiveStageClose` was in.
 *  3. THE FIX, EXECUTED: `isStageOpenForAnswers` over the boundary, the stage
 *     submit route one millisecond either side of the deadline, the draft save
 *     refusing a change to a closed stage, and the applicant's own view of the
 *     stage carrying the same instant the routes refuse past.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";
import { assertReadable, stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Code only: comments gone, string bodies emptied. See tests/lib/stripSource.mjs. */
function codeOf(file) {
  return stripSource(readFileSync(file, "utf8"));
}

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const rel = (file) => relative(REPO_ROOT, file).split("\\").join("/");

// ---------------------------------------------------------------------------
// 1. Every stored deadline
// ---------------------------------------------------------------------------

/** A name that says "this is a moment something stops being allowed". */
const DEADLINE_NAME = /(clos|due|deadline|expir|lock)/i;
const TIME_SUFFIX = /(At|Date|Until)$/;
/** A property declaration or a type member, which is where a field is named. */
const PROPERTY = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/;

/**
 * The one file the scan does not read, and why.
 *
 * `src/lib/devBypass/fixtures.ts` is local-only: it is excluded from git
 * (`.git/info/exclude`) because it carries real names and addresses, so it
 * exists on a developer's machine and never in CI. A scan that read it would
 * produce a different answer in the two places, which is the one thing a
 * both-directions registry cannot survive.
 */
const NOT_SCANNED = "src/lib/devBypass/";

/**
 * Every deadline-shaped field NAME under `src/lib` and `src/app/api`, with the
 * files that name it.
 *
 * The first version of this scan read only the normalisers in
 * `src/lib/firestore`, on the theory that CLAUDE.md calls those the
 * authoritative shape of each collection. A skeptic showed the premise false in
 * three ways at once: `emailVerifications` has no normaliser at all, so its
 * `expiresAt` (told to a person in as many words, and enforced) was invisible;
 * `universityEmailLockUntil` ends in `Until` and was missed by the suffix; and
 * the enclosing-function tracker never reset, so an arrow-function normaliser
 * would have had its lines attributed to whatever `function` was declared
 * above it. Reading property declarations across both trees has none of those
 * failure modes and finds eight names rather than eleven half-answers.
 */
function scanDeadlineNames(assert) {
  const found = new Map();
  for (const root of ["src/lib", "src/app/api"]) {
    for (const file of walkTs(join(REPO_ROOT, root))) {
      const path = relative(REPO_ROOT, file).split("\\").join("/");
      if (path.startsWith(NOT_SCANNED)) continue;
      const raw = readFileSync(file, "utf8");
      const source = codeOf(file);
      assertReadable(raw, source, path, assert);
      for (const line of source.split("\n")) {
        const declared = PROPERTY.exec(line);
        if (!declared) continue;
        const name = declared[1];
        if (!DEADLINE_NAME.test(name) || !TIME_SUFFIX.test(name)) continue;
        found.set(name, (found.get(name) ?? new Set()).add(path));
      }
    }
  }
  return found;
}

/**
 * One entry per deadline-shaped NAME, and one PROMISE per distinct thing that
 * name means. `closesAt` is two promises (a round's and a stage's) and
 * `expiresAt` is three, and they get different answers, which is exactly why
 * the census is not keyed on the name alone.
 *
 * Each promise says:
 *  - `binds`       who is bounded by it, or `null` when it bounds nobody (an
 *                  internal lease, a record of when something happened).
 *  - `told`        the files that put it in front of the person it binds.
 *  - `enforced`    the files that refuse a write past it, with `predicate`,
 *                  the literal each of them must contain.
 *  - `notEnforced` instead of `enforced`, in writing, when nothing refuses. A
 *                  recorded decision rather than an omission, the shape
 *                  `KNOWN_MISSING_INDEXES` uses in the index guard.
 */
const DEADLINE_NAMES = new Map([
  [
    "closesAt",
    {
      files: [
        "src/app/api/admissions/rounds/route.ts",
        "src/lib/admissions/applyRoutes.ts",
        "src/lib/admissions/applyTypes.ts",
        "src/lib/admissions/readiness.ts",
        "src/lib/admissions/reminderSchedule.ts",
        "src/lib/admissions/roundRoutes.ts",
        "src/lib/admissions/stageRelease.ts",
        "src/lib/admissions/window.ts",
        "src/lib/courses/enrolWindow.ts",
        "src/lib/courses/window.ts",
        "src/lib/firestore/admissionRounds.ts",
        "src/lib/scheduler/jobs/admissionsReminders.ts",
      ],
      promises: [
        {
          of: "an admission round",
          binds: "an applicant",
          why: "The last instant a round accepts a submission of any kind.",
          told: ["src/lib/admissions/applyRoutes.ts", "src/features/admissions/ApplyFlow.tsx"],
          enforced: ["src/lib/admissions/applyContext.ts"],
          predicate: "roundWindowState(",
        },
        {
          of: "one stage of an admission round",
          binds: "an applicant",
          why:
            "A stage may close before the round does, which is the weekly-question shape: " +
            "each part is due before the next opens. This is the promise the 8 September " +
            "audit found authored, emailed and enforced nowhere.",
          told: [
            "src/lib/scheduler/jobs/admissionsStageRelease.ts",
            "src/features/admissions/ApplyFlow.tsx",
          ],
          enforced: [
            "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
            "src/lib/admissions/applyRoutes.ts",
            "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts",
          ],
          predicate: "isStageOpenForAnswers(",
        },
      ],
    },
  ],
  [
    "answersDueAt",
    {
      files: ["src/lib/admissions/applyRoutes.ts", "src/lib/admissions/applyTypes.ts"],
      promises: [
        {
          of: "the applicant's own view of a stage deadline",
          binds: "an applicant",
          why:
            "Not a stored field: `effectiveStageClose` projected onto the applicant's copy of " +
            "the stage, so what the page prints and what the routes refuse past are the same " +
            "value rather than two readings of one document.",
          told: ["src/features/admissions/ApplyFlow.tsx"],
          enforced: [
            "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
            "src/lib/admissions/applyRoutes.ts",
          ],
          predicate: "effectiveStageClose(",
        },
      ],
    },
  ],
  [
    "applicationsCloseAt",
    {
      files: [
        "src/lib/courses/enrolWindow.ts",
        "src/lib/courses/window.ts",
        "src/lib/firestore/courses.ts",
      ],
      promises: [
        {
          of: "an open-enrol course run",
          binds: "an applicant",
          why: "When a run stops accepting applications from the catalogue.",
          told: ["src/features/courses/fetchCourses.ts"],
          enforced: ["src/app/api/courses/runs/[runId]/apply/route.ts"],
          predicate: "applicationWindow(",
        },
      ],
    },
  ],
  [
    "expiresAt",
    {
      files: [
        "src/app/api/admin/site-notice/route.ts",
        "src/app/api/register/resend/route.ts",
        "src/app/api/scheduler/tick/route.ts",
        "src/app/api/verify-email/send/route.ts",
        "src/lib/email/confirmUniEmailVerification.ts",
        "src/lib/firestore/schedulerMarkers.ts",
        "src/lib/firestore/schedulerRuns.ts",
        "src/lib/scheduler/markers.ts",
        "src/lib/siteNotice.ts",
      ],
      promises: [
        {
          of: "a magic-link token in `emailVerifications`",
          binds: "the person holding the link",
          why:
            "The life of a link in somebody's inbox, and the email says it in words. It has " +
            "no normaliser in `src/lib/firestore`, which is how the first version of this " +
            "census missed it entirely.",
          told: ["src/app/api/verify-email/send/route.ts"],
          enforced: ["src/lib/email/confirmUniEmailVerification.ts"],
          predicate: "expiresAt.toMillis() <= Date.now()",
        },
        {
          of: "a scheduler marker or run-log lease",
          binds: null,
          why:
            "A lease the scheduler claims so two ticks cannot do one job twice, and the " +
            "retention window on its log rows. Both bind a background process.",
          told: [],
          notEnforced:
            "There is nobody to tell and no write of a person's to bound. The lease is read " +
            "by the marker claim itself, which is the enforcement rather than a promise made " +
            "to somebody and then broken.",
        },
        {
          of: "the site notice banner",
          binds: null,
          why:
            "When an admin-scheduled outage banner stops showing. It bounds a piece of " +
            "chrome, not a person's write.",
          told: ["src/app/api/admin/site-notice/route.ts"],
          notEnforced:
            "It IS enforced, in the only sense it has: `normaliseSiteNotice` returns the " +
            "default notice past this instant, so an expired banner stops rendering. There " +
            "is no write of anybody's for it to refuse.",
        },
      ],
    },
  ],
  [
    "dueDate",
    {
      files: [
        "src/app/api/worksheets/circulations/route.ts",
        "src/lib/courses/unmarkedRegisters.ts",
        "src/lib/email/worksheetReminderEmails.ts",
        "src/lib/firestore/circulations.ts",
        "src/lib/firestore/courseTasks.ts",
        "src/lib/firestore/tasks.ts",
        "src/lib/scheduler/jobs/unmarkedRegisters.ts",
        "src/lib/scheduler/jobs/worksheetDueReminders.ts",
        "src/lib/worksheets/mint.ts",
      ],
      promises: [
        {
          of: "a task or a subtask",
          binds: "an assignee",
          why: "When a committee task is wanted done, shown on the board and in the calendar.",
          told: ["src/features/tasks/components/TaskCard.tsx", "src/lib/email/taskMembership.ts"],
          notEnforced:
            "A task due date is a nudge between colleagues. The board shows an overdue task " +
            "in red and the calendar puts it in the past, and a completer may still tick it: " +
            "refusing the tick would leave the work done and the board saying otherwise. " +
            "There is no fairness property here, because nobody is competing for anything.",
        },
        {
          of: "a circulated worksheet",
          binds: "a recipient",
          why:
            "When a circulated worksheet is wanted back. It is the anchor the due-soon " +
            "reminder slots count back from.",
          told: ["src/lib/email/worksheetReminderEmails.ts"],
          notEnforced:
            "A worksheet due date is a nudge, not a bound, and the product says so: the " +
            "reminder job counts its slots back from this instant and stops, and nothing " +
            "refuses a late answer. What CLOSES a circulation is `status`, an explicit act " +
            "by its staff, and the submit route does refuse a closed one. Enforcing this " +
            "date instead would turn a missed reminder into lost work on a learning exercise.",
        },
      ],
    },
  ],
  [
    "dueAt",
    {
      files: [
        "src/lib/admissions/reminderSchedule.ts",
        "src/lib/firestore/schedulerMarkers.ts",
        "src/lib/reminders/schedule.ts",
        "src/lib/scheduler/jobs/admissionsReminders.ts",
        "src/lib/scheduler/jobs/unmarkedRegisters.ts",
        "src/lib/scheduler/jobs/worksheetDueReminders.ts",
      ],
      promises: [
        {
          of: "one slot of a reminder schedule",
          binds: null,
          why:
            "When a reminder slot is owed, computed back from the deadline it is about. It " +
            "bounds a job's own scan, not a person.",
          told: [],
          notEnforced:
            "Nobody is told about a slot: they are told about the deadline it counts back " +
            "from, which is registered under its own name. There is no write of anybody's " +
            "for this to refuse.",
        },
      ],
    },
  ],
  [
    "closedAt",
    {
      files: [
        "src/app/api/worksheets/circulations/[circulationId]/close/route.ts",
        "src/app/api/worksheets/circulations/route.ts",
        "src/lib/firestore/circulations.ts",
      ],
      promises: [
        {
          of: "a circulation that has been closed",
          binds: null,
          why:
            "A record of WHEN the circulation was closed, written after the fact. The limit " +
            "it looks like is `status`, which the submit route reads.",
          told: ["src/features/worksheets/circulation/SettingsPanel.tsx"],
          notEnforced:
            "It is a record of a past act, not a limit on a future one. The neighbouring " +
            "`status` is what refuses a late submission, and this field only timestamps it.",
        },
      ],
    },
  ],
  [
    "universityEmailLockUntil",
    {
      files: ["src/lib/firestore/users.ts"],
      promises: [
        {
          of: "a member who has just changed their university address",
          binds: "a member",
          why:
            "The cooling-off period before the same account may claim another university " +
            "address, which is the abuse-cycle break. Ends in `Until` rather than `At`, which " +
            "is how the first version of this census missed it.",
          told: ["src/features/profile/ProfileForm.tsx"],
          enforced: ["firestore.rules"],
          predicate: "universityEmailLockUntil",
        },
      ],
    },
  ],
]);

describe("every deadline-shaped field is registered", () => {
  const found = scanDeadlineNames(assert);

  test("both directions on the names, and on the files that use each one", () => {
    const missing = [...found.keys()].filter((name) => !DEADLINE_NAMES.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      "A deadline-shaped field is declared with no entry saying who it binds and what refuses " +
        "past it. Add it to DEADLINE_NAMES, one promise per distinct thing the name means.",
    );
    const stale = [...DEADLINE_NAMES.keys()].filter((name) => !found.has(name)).sort();
    assert.deepEqual(stale, [], "DEADLINE_NAMES names a field that is no longer declared.");
    for (const [name, entry] of DEADLINE_NAMES) {
      assert.deepEqual(
        [...found.get(name)].sort(),
        [...entry.files].sort(),
        `${name} is declared in a different set of files than the registry lists. A new file ` +
          "reading a deadline is a new place it could be told or enforced.",
      );
    }
  });

  test("each promise answers the question in writing", () => {
    for (const [name, entry] of DEADLINE_NAMES) {
      assert.ok(entry.promises.length > 0, `${name} needs at least one promise.`);
      for (const promise of entry.promises) {
        const label = `${name} (${promise.of})`;
        assert.ok(
          typeof promise.of === "string" && promise.of.length > 0,
          `${name} has a promise with no subject.`,
        );
        assert.ok(
          typeof promise.why === "string" && promise.why.trim().length >= 40,
          `${label} needs a real reason.`,
        );
        const enforced = Array.isArray(promise.enforced) && promise.enforced.length > 0;
        const excused =
          typeof promise.notEnforced === "string" && promise.notEnforced.trim().length >= 40;
        assert.ok(
          enforced !== excused,
          `${label} must say EITHER where it is enforced OR, in writing, why nothing refuses ` +
            "past it. Not both, and not neither.",
        );
        assert.ok(Array.isArray(promise.told), `${label} must list where the person is told.`);
      }
    }
  });

  test("a deadline that binds somebody and is told to them is enforced", () => {
    for (const [name, entry] of DEADLINE_NAMES) {
      for (const promise of entry.promises) {
        if (promise.binds === null) continue;
        if (promise.told.length === 0) continue;
        if (Array.isArray(promise.enforced) && promise.enforced.length > 0) continue;
        assert.ok(
          typeof promise.notEnforced === "string" && promise.notEnforced.trim().length >= 120,
          `${name} (${promise.of}) binds ${promise.binds}, is told to them, and refuses ` +
            "nothing. That is exactly the state the stage deadline was in on 8 September " +
            "2026. If it is deliberate, the reason has to be written out at length here, " +
            "because the next reader will assume the enforcement exists.",
        );
      }
    }
  });

  test("every file named as telling or enforcing exists, and enforcers carry the predicate", () => {
    for (const [name, entry] of DEADLINE_NAMES) {
      for (const promise of entry.promises) {
        for (const file of [...promise.told, ...(promise.enforced ?? [])]) {
          assert.doesNotThrow(
            () => statSync(join(REPO_ROOT, file)),
            `${name} (${promise.of}) names ${file}, which is not a file.`,
          );
        }
        if (!promise.enforced) continue;
        assert.ok(
          typeof promise.predicate === "string",
          `${name} (${promise.of}) declares enforcers and needs a predicate.`,
        );
        for (const file of promise.enforced) {
          assert.ok(
            readFileSync(join(REPO_ROOT, file), "utf8").includes(promise.predicate),
            `${name} (${promise.of}) says ${file} enforces it with ${promise.predicate}, ` +
              "which is not in that file.",
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every function that computes a deadline, and what its callers do with it
// ---------------------------------------------------------------------------

/**
 * The predicates that turn a stored instant into "is this still allowed", and
 * every call site in `src` with what that site does:
 *
 *  - `tells`    renders it, emails it, or serialises it to a person.
 *  - `enforces` refuses a write past it.
 *  - `derives`  builds another predicate out of it.
 *
 * The rule the whole file exists for is on the last test: a predicate with a
 * `tells` site and no `enforces` site is a deadline that is announced and not
 * kept. `effectiveStageClose` was in that state for the life of the multi-stage
 * feature, and reading the code would not have said so, because each of its two
 * call sites was individually reasonable.
 */
const DEADLINE_PREDICATES = new Map([
  [
    "effectiveStageClose",
    {
      computes: "when answers to one admission stage are due",
      sites: new Map([
        [
          "src/lib/admissions/stageRelease.ts",
          {
            role: "derives",
            why: "`isStageOpenForAnswers` is built on it, which is the predicate the writes ask",
          },
        ],
        [
          "src/lib/scheduler/jobs/admissionsStageRelease.ts",
          { role: "tells", why: "the deadline printed in the stage-released announcement" },
        ],
        [
          "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
          { role: "enforces", why: "the refusal message names the instant the submit was refused past" },
        ],
        [
          "src/lib/admissions/applyRoutes.ts",
          {
            role: "enforces",
            why: "the draft save refuses a change to a stage whose deadline has passed, and the applicant projection carries the same instant",
          },
        ],
      ]),
    },
  ],
  [
    "isStageOpenForAnswers",
    {
      computes: "whether an answer to an admission stage may still be stored",
      sites: new Map([
        [
          "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
          { role: "enforces", why: "the later-stage submit, which is the only writer of a later stage" },
        ],
        [
          "src/lib/admissions/applyRoutes.ts",
          {
            role: "enforces",
            why: "`serialiseStageForApplicant` renders the form against it, and the draft save drops a closed stage's answers past the same instant",
          },
        ],
        [
          "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts",
          {
            role: "enforces",
            why: "the first submission holds a part still open to its required questions and a closed one to what was stored at the deadline",
          },
        ],
      ]),
    },
  ],
  [
    "roundWindowState",
    {
      computes: "whether an admission round is open",
      sites: new Map([
        [
          "src/lib/admissions/window.ts",
          { role: "derives", why: "`isRoundOpen`, the sugar every other caller of this module uses" },
        ],
        [
          "src/lib/admissions/stageRelease.ts",
          { role: "derives", why: "a stage of a round that is not open is never released" },
        ],
        [
          "src/lib/admissions/applyContext.ts",
          { role: "enforces", why: "`windowRefusal`, which every apply write path calls first" },
        ],
        [
          "src/lib/admissions/applyRoutes.ts",
          { role: "tells", why: "the window state serialised onto the applicant's view of the round" },
        ],
        [
          "src/lib/admissions/liveRound.ts",
          { role: "derives", why: "picks which round a public page should show" },
        ],
        [
          "src/app/api/admissions/rounds/[roundId]/stages/[stageId]/release/route.ts",
          { role: "enforces", why: "refuses a manual release into a round nobody can answer" },
        ],
      ]),
    },
  ],
  [
    "applicationWindow",
    {
      computes: "whether an open-enrol course run is accepting applications",
      sites: new Map([
        [
          "src/lib/courses/enrolWindow.ts",
          {
            role: "derives",
            why: "`courseRunWindow` picks between this and the enrol variant for one run",
          },
        ],
        [
          "src/app/api/courses/runs/[runId]/apply/route.ts",
          { role: "enforces", why: "refuses an application outside the run's own window" },
        ],
      ]),
    },
  ],
  [
    "courseRunWindow",
    {
      computes: "which window a course run is currently in, applications or enrolment",
      // It tells and never refuses, and that is correct here rather than the
      // defect: it is a projection built ON `applicationWindow`, which the
      // apply route enforces. `enforcedVia` names that predicate and the test
      // below checks it is registered and does enforce, so the chain is
      // asserted rather than assumed.
      enforcedVia: "applicationWindow",
      sites: new Map([
        [
          "src/features/courses/fetchCourses.ts",
          { role: "tells", why: "the catalogue card's open or closed state, which is what a visitor reads" },
        ],
      ]),
    },
  ],
]);

/** Every file under `src` that calls `name`, excluding its own export line. */
function callSitesOf(name) {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  const declaration = new RegExp(`\\b(?:function|const)\\s+${name}\\b`);
  const out = new Set();
  for (const file of walkTs(join(REPO_ROOT, "src"))) {
    const source = codeOf(file);
    if (!call.test(source)) continue;
    // A file that only DECLARES it and never calls it is not a site. Every
    // definition in this registry is also used inside its own module, so this
    // subtracts nothing today; it is here so a future pure declaration does
    // not read as a caller.
    const usesIt = source
      .split("\n")
      .some((line) => call.test(line) && !declaration.test(line));
    if (usesIt) out.add(rel(file));
  }
  return out;
}

describe("a deadline predicate is enforced somewhere, not only announced", () => {
  for (const [name, entry] of DEADLINE_PREDICATES) {
    test(`${name}: every call site is classified, both directions`, () => {
      const actual = callSitesOf(name);
      const registered = new Set(entry.sites.keys());
      const missing = [...actual].filter((file) => !registered.has(file)).sort();
      assert.deepEqual(
        missing,
        [],
        `${name} is called in a file with no entry. Say whether that site TELLS somebody the ` +
          "deadline, ENFORCES it, or DERIVES another predicate from it.",
      );
      const stale = [...registered].filter((file) => !actual.has(file)).sort();
      assert.deepEqual(stale, [], `${name} is registered as called in a file that no longer calls it.`);
    });

    test(`${name}: a deadline that is announced is also refused past`, () => {
      const roles = [...entry.sites.values()].map((site) => site.role);
      for (const role of roles) {
        assert.ok(
          ["tells", "enforces", "derives"].includes(role),
          `${name} has a site with role ${role}, which is not one of the three.`,
        );
      }
      for (const [file, site] of entry.sites) {
        assert.ok(
          typeof site.why === "string" && site.why.trim().length >= 20,
          `${name} at ${file} needs a written reason for its role.`,
        );
      }
      if (!roles.includes("tells")) return;
      if (entry.enforcedVia) {
        const via = DEADLINE_PREDICATES.get(entry.enforcedVia);
        assert.ok(via, `${name} says it is enforced via ${entry.enforcedVia}, which is not registered.`);
        assert.ok(
          [...via.sites.values()].some((site) => site.role === "enforces"),
          `${name} says it is enforced via ${entry.enforcedVia}, which enforces nothing either.`,
        );
        return;
      }
      assert.ok(
        roles.includes("enforces"),
        `${name} computes ${entry.computes} and every call site only tells somebody about it. ` +
          "That is a promise the product does not keep, and it is the exact state the stage " +
          "deadline was found in on 8 September 2026.",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The fix, executed
// ---------------------------------------------------------------------------

const { loadTs } = createLoader({ stubs: new Map([["server-only", "export {};"]]) });
const stageRelease = await loadTs("lib/admissions/stageRelease.ts");
const applyRoutes = await loadTs("lib/admissions/applyRoutes.ts");

const OPENS = new Date("2026-10-01T00:00:00Z");
const STAGE_CLOSE = new Date("2026-10-10T16:00:00Z");
const ROUND_CLOSE = new Date("2026-10-18T22:59:00Z");

const round = {
  id: "autumn",
  status: "open",
  archived: false,
  opensAt: OPENS,
  closesAt: ROUND_CLOSE,
  availabilityGrid: null,
};

const stage = {
  id: "s1",
  roundId: "autumn",
  label: "Part 2",
  intro: "",
  questions: [{ id: "q1", type: "shortText", label: "Why?", required: false }],
  releaseAt: null,
  releaseTimeLocal: "09:00",
  manualReleasedAt: null,
  closesAt: STAGE_CLOSE,
  locksOnSubmit: false,
  order: 1,
  createdAt: null,
  updatedAt: null,
};

describe("isStageOpenForAnswers", () => {
  const at = (date) => stageRelease.isStageOpenForAnswers(stage, round, date);

  test("open between release and the stage's own close, inclusive at both ends", () => {
    assert.equal(at(OPENS), true, "at the opening instant the stage takes answers");
    assert.equal(at(new Date(STAGE_CLOSE.getTime() - 1)), true);
    assert.equal(at(STAGE_CLOSE), true, "the close instant is inclusive, like every other bound");
  });

  test("closed one millisecond later, while the round is still open", () => {
    const justAfter = new Date(STAGE_CLOSE.getTime() + 1);
    assert.equal(at(justAfter), false);
    assert.equal(
      stageRelease.isStageReleased(stage, round, justAfter),
      true,
      "the questions stay readable: reviewers read them all through review week",
    );
  });

  test("a stage with no deadline of its own inherits the round's", () => {
    const inherits = { ...stage, closesAt: null };
    const afterRound = new Date(ROUND_CLOSE.getTime() + 1);
    assert.equal(stageRelease.isStageOpenForAnswers(inherits, round, ROUND_CLOSE), true);
    assert.equal(stageRelease.isStageOpenForAnswers(inherits, round, afterRound), false);
  });

  test("an unreleased stage is never open, whatever its deadline says", () => {
    const later = { ...stage, releaseAt: "2026-10-05", closesAt: null };
    assert.equal(stageRelease.isStageOpenForAnswers(later, round, OPENS), false);
  });
});

describe("the draft save keeps a closed stage's stored answers", () => {
  const stages = [stage];
  const save = (now) =>
    applyRoutes.readStageAnswers(
      { s1: { q1: "an answer" } },
      stages,
      round,
      now,
      {},
      false,
    );

  test("stored before the deadline", () => {
    const result = save(new Date(STAGE_CLOSE.getTime() - 1000));
    assert.deepEqual(result, { s1: { q1: "an answer" } });
  });

  test("DROPPED after it, so nothing a stage already holds can be changed", () => {
    // Dropped rather than refused, and this is the decision the guard exists to
    // hold. The island seeds its answers from the stored row and sends the
    // whole map on every autosave, so refusing here took the WHOLE save down
    // (availability, programme preference, every other part) every two minutes
    // until the tab was reloaded, on the one evening of the round when nobody
    // can afford that. Dropping keeps the property whole (the key is never
    // written) and the response's freshly serialised stages are what tell the
    // applicant, rather than a save that quietly stops working.
    const result = save(new Date(STAGE_CLOSE.getTime() + 1000));
    assert.deepEqual(result, {}, "a closed stage's answers must not reach the write");
    assert.ok(!("error" in result), "and must not take the rest of the save down with them");
  });

  test("an OPEN stage in the same save is still stored", () => {
    const open = { ...stage, id: "s2", label: "Part 3", closesAt: null };
    const result = applyRoutes.readStageAnswers(
      { s1: { q1: "late" }, s2: { q1: "in time" } },
      [stage, open],
      round,
      new Date(STAGE_CLOSE.getTime() + 1000),
      {},
      false,
    );
    assert.deepEqual(
      result,
      { s2: { q1: "in time" } },
      "one closed part must not stop the rest of the application saving",
    );
  });

  test("the round's own close still bounds a stage that names no deadline", () => {
    const result = applyRoutes.readStageAnswers(
      { s1: { q1: "an answer" } },
      [{ ...stage, closesAt: null }],
      round,
      new Date(ROUND_CLOSE.getTime() + 1000),
      {},
      false,
    );
    assert.deepEqual(result, {});
  });

  test("a stage already submitted is still REFUSED, by name", () => {
    // The frozen refusal is checked before the deadline drop and keeps its
    // message: an applicant can act on "you already sent this", and the page
    // will not offer them a box for it either way.
    const result = applyRoutes.readStageAnswers(
      { s1: { q1: "an answer" } },
      stages,
      round,
      new Date(STAGE_CLOSE.getTime() - 1000),
      { s1: new Date() },
      false,
    );
    assert.equal(result.stageId, "s1");
    assert.match(result.error, /already submitted/i);
  });
});

describe("the applicant is told the same instant the routes refuse past", () => {
  test("a released stage carries its deadline and whether it still takes answers", () => {
    const before = applyRoutes.serialiseStageForApplicant(
      stage,
      round,
      new Date(STAGE_CLOSE.getTime() - 1000),
    );
    assert.equal(before.released, true);
    assert.equal(before.answersDueAt, STAGE_CLOSE.toISOString());
    assert.equal(before.openForAnswers, true);

    const after = applyRoutes.serialiseStageForApplicant(
      stage,
      round,
      new Date(STAGE_CLOSE.getTime() + 1000),
    );
    assert.equal(after.answersDueAt, STAGE_CLOSE.toISOString());
    assert.equal(after.openForAnswers, false, "the form must not be offered past the deadline");
    assert.ok(after.questions, "the questions stay readable after the deadline");
  });

  test("a stage deadline later than the round's is clamped to the round's", () => {
    const late = { ...stage, closesAt: new Date(ROUND_CLOSE.getTime() + 86_400_000) };
    const serialised = applyRoutes.serialiseStageForApplicant(late, round, OPENS);
    assert.equal(
      serialised.answersDueAt,
      ROUND_CLOSE.toISOString(),
      "printing a date past the round's close would be a deadline nobody can meet",
    );
  });
});

// ---------------------------------------------------------------------------
// The stage submit route, executed either side of the deadline
// ---------------------------------------------------------------------------

const ROUTE_STUBS = new Map([
  ["server-only", "export {};"],
  [
    // A CLASS, because the route asks `caller instanceof NextResponse` to tell a
    // refusal from a session.
    "next/server",
    "export class NextResponse {\n" +
      "  constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; }\n" +
      "  static json(body, init) { return new NextResponse(body, init); }\n" +
      "}",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = { serverTimestamp: () => ({ __op: 'serverTimestamp' }) };",
  ],
  ["@/lib/firebase/impersonation", "export async function assertNotImpersonating() {\n  return null;\n}"],
  [
    "@/lib/admissions/applyContext",
    // The datastore-touching prologue, faked whole: what this suite is asking
    // about is the time gate between the prologue and the transaction.
    "export class ApplyError extends Error {\n" +
      "  constructor(message, status, extra = {}) { super(message); this.status = status; this.extra = extra; }\n" +
      "  toResponse() { return { status: this.status, body: { error: this.message, ...this.extra } }; }\n" +
      "}\n" +
      "export const throttleIp = () => null;\n" +
      "export const throttleUid = () => null;\n" +
      "export const requireRecaptcha = async () => null;\n" +
      "export const readJson = async (req) => req.json();\n" +
      "export const requireApplicant = async () => globalThis.__caller;\n" +
      "export const loadRound = async () => globalThis.__round;\n" +
      "export const loadStages = async () => globalThis.__stages;\n" +
      "export const applicationsPaused = async () => null;\n" +
      "export const windowRefusal = () => globalThis.__windowRefusal ?? null;\n" +
      "export const applicationRef = () => ({ __ref: true });\n" +
      "export const loadOwnApplication = async () => null;\n",
  ],
  [
    "@/lib/admissions/applyRoutes",
    "export const serialiseApplicationForOwner = () => null;",
  ],
]);

const { loadTs: loadRoute } = createLoader({ stubs: ROUTE_STUBS });
const { POST: submitStage } = await loadRoute(
  join("app", "api", "admissions", "rounds", "[roundId]", "apply", "stage", "[stageId]", "route.ts"),
);

function callSubmit() {
  globalThis.__caller = {
    user: { uid: "applicant1", email: "a@example.com", displayName: "Ada" },
    db: {
      async runTransaction(body) {
        globalThis.__committed = true;
        return body({
          get: async () => ({
            exists: true,
            id: "autumn__applicant1",
            data: () => ({ status: "submitted", stageAnswers: {}, stageSubmittedAt: {} }),
          }),
          update: (_ref, patch) => {
            globalThis.__written = patch;
          },
        });
      },
    },
  };
  globalThis.__round = round;
  globalThis.__stages = [stage];
  globalThis.__committed = false;
  globalThis.__written = null;
  return submitStage(
    { json: async () => ({ answers: { q1: "late answer" } }), headers: new Headers() },
    { params: Promise.resolve({ roundId: "autumn", stageId: "s1" }) },
  );
}

describe("the later-stage submit refuses past the stage's own deadline", () => {
  test("accepted a millisecond before it", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(STAGE_CLOSE.getTime() - 1) });
    const res = await callSubmit();
    t.mock.timers.reset();
    assert.equal(res.status, 200, `refused for another reason: ${JSON.stringify(res.body)}`);
    assert.equal(globalThis.__committed, true, "the answers were not stored");
  });

  test("refused a millisecond after it, while the round is still open", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(STAGE_CLOSE.getTime() + 1) });
    const res = await callSubmit();
    t.mock.timers.reset();
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Part 2/);
    assert.match(res.body.error, /closed/i);
    assert.equal(globalThis.__committed, false, "a late stage submit reached the transaction");
  });
});
