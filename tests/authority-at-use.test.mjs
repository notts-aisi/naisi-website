/**
 * Being named on a document is not a standing grant.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * ## The class
 *
 * A dozen documents carry an array of uids that decides what the people in it
 * may do: a run's `trackLeadUids`, a round's `reviewerUids`, a circulation's
 * `staffUids`, a worksheet's `authorUid`. Each array is written behind a bar —
 * the run roles route intersects with the approved accounts, the round roles
 * route runs `isEligibleAdmissionsReviewer` against each candidate's live user
 * document, a worksheet can only be created by a committee member. On
 * 8 September 2026 a review of every API route found that not one of those
 * bars was asked again when the authority was USED, and that nothing anywhere
 * removes a uid from one of these arrays when the person behind it is demoted,
 * loses SU recognition, or is rejected outright. Revoking somebody's standing
 * revoked nothing: they kept every door their name was still on, on a session
 * that `getCurrentUser` refreshes from the live user document on every
 * request, so the correct role was in hand the whole time and simply never
 * consulted.
 *
 * `firestore.rules` had already learned this once, on the same shape:
 *
 *     // AUTHORSHIP IS NOT A STANDING GRANT. The role test is inside this
 *     // helper rather than beside its callers because the author branch is
 *     // the one branch of read, update and delete that no other clause
 *     // re-tests
 *
 * The server-side half is `src/lib/firebase/eligibility.ts`: one registry of
 * bars, and `isNamedWithStanding(user, authority, named)` which asks both
 * halves of the question at once.
 *
 * ## What this guard does
 *
 * 1. It WALKS THE TREE for the raw comparison — an authority field tested
 *    against the caller's own uid without the helper — and fails on one that
 *    is not registered in `RAW_SITES` as something other than a gate, with a
 *    written reason. Both directions, with a per-file count, so a second site
 *    dropped into a file the registry already names fails instead of folding
 *    into the entry above it. A registered site whose compensating control
 *    lives elsewhere in the same file carries `provedBy`, a literal the file
 *    must still contain, so the entry is an assertion rather than a promise.
 *
 * 2. It checks the registry of bars against the tree in both directions: every
 *    authority is used by at least one file (a bar nobody calls is dead
 *    policy), and every authority NAMED in a call site exists in the registry
 *    (a typo would otherwise throw at run time, on the one branch nobody
 *    exercises).
 *
 * 3. It EXECUTES every bar against every persona and pins the whole matrix,
 *    including the approved-account floor, so widening one is a visible diff
 *    rather than a quiet predicate change.
 *
 * 4. It checks each bar AGREES WITH ITS APPOINTMENT SITE: the two admission
 *    round entries against the real `isEligibleAdmissionsReviewer`, the
 *    circulation entry against the real `canCirculateWorksheet`, the course
 *    entries against the roles routes' own `ELIGIBLE_ROLES` literal, and the
 *    worksheet entry against `isLibraryUser()` in `firestore.rules`. A bar
 *    stricter than its appointment is a support ticket; a bar looser than its
 *    appointment is this class coming back.
 *
 * 5. It pins the four findings as executed regressions.
 *
 * ## What it cannot see
 *
 * It reads names, not types. A gate that copies an authority array into a
 * local binding whose name drops the field name (`const leads =
 * run.trackLeadUids`) is invisible to it; every gate in the tree today keeps
 * the field name, and the scanner's patterns are exercised on synthetic
 * snippets below so a regex that had quietly stopped matching fails rather
 * than passes. It says nothing about whether a gate exists at all — a route
 * that reads no authority array and checks nothing is the gate-before-data
 * guard's subject, not this one. And it does not police ownership scalars that
 * grant nothing beyond the caller's own row (`tasks.creatorUid` on a personal
 * task, `circulations.senderUid`): those are not appointments, so there is no
 * appointment bar to re-ask.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const { loadTs } = createLoader({
  stubs: new Map([["server-only", "export {};"]]),
});

const { AUTHORITY, holdsStanding, isNamedWithStanding } = await loadTs(
  join("lib", "firebase", "eligibility.ts"),
);
const USERS_MODULE = await loadTs(join("lib", "firestore", "users.ts"));
const { isEligibleAdmissionsReviewer, canCirculateWorksheet } = USERS_MODULE;

const repoPath = (file) => file.slice(REPO_ROOT.length + 1).split(sep).join("/");

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * An authority whose FIELD NAME is too generic to walk the tree for, with the
 * reason. Its bar is registered, executed and checked against its appointment
 * site like every other; only the scanner half is missing, and saying so here
 * is the alternative to a scanner that reports every line in the repository.
 * Checked in both directions below.
 */
const UNSCANNABLE_FIELDS = {
  "courseEnrolments.uid": (
    "Scanning for `uid` would match `actor.uid` in every gate in the codebase and report " +
    "nothing usable. The three sites that read an enrolment as an authority are named in " +
    "ENROLMENT_GATES below and checked for the helper by name instead."
  ),
};

/**
 * The field names the scanner watches, DERIVED from the registry rather than
 * listed here, so adding an authority extends the walk without a second edit.
 * A field name is watched across every collection that uses it: `authorUid`
 * catches the events, worksheets, courses and newsletter authors at once,
 * which is what makes a new collection's author gate visible on arrival.
 */
const FIELDS = [
  ...new Set(
    Object.values(AUTHORITY)
      .filter((bar) => !(bar.field in UNSCANNABLE_FIELDS))
      .map((bar) => bar.field.split(".")[1]),
  ),
].sort();

/**
 * How this codebase spells "the person making the request".
 *
 * The leading `(?:[\w$]+[?!]?\.)*` matters: eight server components under
 * `(app)/learn` gate on `access.user.uid`, and an expression anchored at the
 * bare name would have walked straight past every one of them.
 */
const SELF = "(?:[\\w$]+[?!]?\\.)*(?:actor|user|viewer|session|caller|me|current|self)[?!]?\\.uid";

/**
 * Every shape a gate is written in today, plus the near neighbours a future
 * one might reach for. Each is exercised on a synthetic snippet below, and
 * every one of the six was arrived at by trying to slip a real gate past the
 * five before it.
 */
function patternsFor(field) {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // run.trackLeadUids.includes(actor.uid), asUidList(x.field).includes(…),
    // (event.collaboratorUids ?? []).includes(…)
    new RegExp(`${f}[\\s\\S]{0,12}\\.includes\\(\\s*${SELF}\\s*\\)`),
    // worksheet.authorUid === actor.uid  /  actor.uid === event.authorUid
    new RegExp(`${f}\\s*!?===?\\s*${SELF}`),
    new RegExp(`${SELF}\\s*!?===?\\s*[\\w.?!()\\[\\]{} ]{0,30}${f}\\b`),
    // .where("trackLeadUids", "array-contains", actor.uid), however the field
    // is spelled on the way in.
    new RegExp(`${f}[\\s\\S]{0,40}["']array-contains["']\\s*,\\s*${SELF}`),
    // run.trackLeadUids.indexOf(actor.uid)
    new RegExp(`${f}[\\s\\S]{0,12}\\.indexOf\\(\\s*${SELF}\\s*\\)`),
    // new Set(run.trackLeadUids).has(actor.uid) — the Set spelling reverts the
    // gate exactly and matched none of the five patterns above it.
    new RegExp(`${f}[\\s\\S]{0,60}?\\.has\\(\\s*${SELF}\\s*\\)`),
    // groups.some((g) => g.facilitatorUids… actor.uid) inside one expression
    new RegExp(`${f}[\\s\\S]{0,12}\\.(?:some|find|filter)\\([\\s\\S]{0,120}?${SELF}`),
  ];
}

/**
 * Source with comments removed, TypeScript casts removed and whitespace
 * collapsed, so a gate split across lines or written through
 * `(task.completerUids as unknown[]).includes(…)` reads as the one expression
 * it is. Dropping the cast matters: half the task routes read their arrays off
 * a raw snapshot and every one of them carries one.
 */
function scannableSource(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/\s+as\s+(?:readonly\s+)?[\w.]+(?:\s*\[\s*\])*/g, "")
    .replace(/\s+/g, " ");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(full)) yield full;
  }
}

/** `{ file -> { field -> matchCount } }` for every raw self-uid authority test. */
function scanTree() {
  const found = new Map();
  for (const file of walk(SRC)) {
    const code = scannableSource(file);
    for (const field of FIELDS) {
      if (!code.includes(field)) continue;
      // Collected as SPANS and merged where they overlap, so a site that two
      // patterns both see counts once: `matches` in the registry means sites
      // rather than pattern hits, and a second gate in the same file still
      // moves the number.
      const spans = [];
      for (const pattern of patternsFor(field)) {
        const global = new RegExp(pattern.source, "g");
        for (const m of code.matchAll(global)) {
          spans.push([m.index, m.index + m[0].length]);
        }
      }
      spans.sort((a, b) => a[0] - b[0]);
      const hits = [];
      for (const [start, end] of spans) {
        const last = hits[hits.length - 1];
        if (last && start < last[1]) last[1] = Math.max(last[1], end);
        else hits.push([start, end]);
      }
      if (hits.length === 0) continue;
      const path = repoPath(file);
      if (!found.has(path)) found.set(path, {});
      found.get(path)[field] = hits.length;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The registry of raw sites
// ---------------------------------------------------------------------------

/**
 * Every place in `src` that still compares an authority field to the caller's
 * own uid WITHOUT the helper, and why that is not a gate.
 *
 * `role` is one of:
 *   "client"      — a client component. The list it filters was already
 *                   filtered by `firestore.rules` or by the route that served
 *                   it; the grouping is cosmetic and the server decides.
 *   "not-a-gate"  — the comparison answers something other than "may this
 *                   caller act": excluding yourself from a mailing list,
 *                   scoping a query to your own rows, recognising your own
 *                   document.
 *
 * `matches` is the number of raw hits the scanner finds in that file, per
 * field. `provedBy`, where present, is the LIST of control literals the file
 * must still contain, one per branch the reason claims is covered, and each
 * one is written so it includes the control itself (`if (!x) return false;`)
 * rather than the expression the control tests. Both of those were learned
 * the hard way: an entry proved by a bare expression stayed green when the
 * `return` beneath it was deleted, and an entry proved by one literal stayed
 * green when the second of the two loops it named lost its bar. An entry
 * without a `provedBy` is asserting that no control is needed.
 */
const RAW_SITES = {
  "src/app/(app)/events/manage/page.tsx": {
    role: "client",
    matches: { authorUid: 3, collaboratorUids: 2 },
    why:
      "Three list filters in a client component that sort the events the caller can already read " +
      "into 'mine', 'shared with me' and 'everyone else'. `firestore.rules` decides what the " +
      "listener returns and every edit goes through a route that applies the bar.",
  },
  "src/app/(app)/newsletter/page.tsx": {
    role: "client",
    matches: { authorUid: 4 },
    why:
      "`newsletterDrafts.authorUid` again, in the drafts list: two filters that split 'yours' " +
      "from 'everyone else's', one that decides whether the sent-copy link shows, and one that " +
      "renders the word 'You'. The draft, approve and send routes each re-read the live " +
      "newsletter permissions.",
  },
  "src/app/(app)/worksheets/(author)/[worksheetId]/page.tsx": {
    role: "client",
    matches: { authorUid: 1 },
    why:
      "Decides whether the editor renders read-only. Editing a worksheet is a client-direct " +
      "write, so the boundary is `isAuthor()` in `firestore.rules`, which carries the library " +
      "role test inside it; this page cannot widen what the rules allow.",
  },
  "src/features/events/EventEditor.tsx": {
    role: "client",
    matches: { authorUid: 1, collaboratorUids: 1 },
    why:
      "Draws or hides the editor's controls. The event document is written client-direct under " +
      "rules that pin `authorUid` and `collaboratorUids`, and the server routes that act on an " +
      "event apply the `events.*` bars.",
  },
  "src/features/newsletter/DraftEditor.tsx": {
    role: "client",
    matches: { authorUid: 1 },
    why:
      "`newsletterDrafts.authorUid`, not one of the appointment-gated arrays: the author is " +
      "whoever created the draft while holding `draftNewsletter`, which the send and approve " +
      "routes re-read from the live session. Caught here only because the scanner watches the " +
      "field NAME across every collection, which is the property that makes a new collection's " +
      "author gate visible on arrival.",
  },
  "src/features/tasks/components/TaskCard.tsx": {
    role: "client",
    matches: { completerUids: 1 },
    why:
      "Decides whether the card shows the completer's controls. Every action behind those " +
      "controls is a route that applies the `tasks.*` bars.",
  },
  "src/lib/firestore/coursePages.ts": {
    role: "not-a-gate",
    matches: { authorUid: 1, collaboratorUids: 1 },
    provedBy: ["if (!onTheRoster) return false;", "if (!holdsPermission) return false;"],
    why:
      "`canAuthorCoursePage` already re-reads a LIVE course permission from the session and " +
      "returns false before it looks at either field, which is this guard's rule applied by " +
      "hand. It cannot call the helper: the module is imported by client components " +
      "(CoursePageEditor, WeeklyThemes, useCoursePage) and says so at the type it declares for " +
      "the actor, so a `server-only` import here would break the client bundle.",
  },
  "src/app/api/courses/me/route.ts": {
    role: "not-a-gate",
    matches: { admissionsReviewerUids: 1, trackLeadUids: 1 },
    provedBy: [
      'if (holdsStanding(actor, "courseRuns.trackLeadUids")) {',
      'if (holdsStanding(actor, "courseRuns.admissionsReviewerUids")) {',
    ],
    why:
      "Two `array-contains` queries scoped to the caller's own uid, which is how the hub finds " +
      "the runs it might draw a door for. The bar is applied where the door is actually drawn, " +
      "on the two loops that add the `reviewer` and `lead` roles.",
  },
  "src/app/api/members/roster/route.ts": {
    role: "not-a-gate",
    matches: { completerUids: 1, reviewerUids: 1 },
    provedBy: ['if (!session || !holdsStanding(session, "tasks.completerUids")) {'],
    why:
      "Two `array-contains` queries scoped to the caller's own task memberships, to resolve the " +
      "names of the people they share tasks with. The approved-account floor is applied at the " +
      "top of the handler, before either query runs.",
  },
  "src/app/api/courses/runs/[runId]/sync-tasks/route.ts": {
    role: "not-a-gate",
    matches: { completerUids: 1 },
    why:
      "A collision check on a mirror task whose id is built from the caller's own uid: is the " +
      "document already sitting at that address ours, or has somebody squatted the id? It " +
      "decides whether to write, never whether the caller may.",
  },
  "src/app/api/tasks/[id]/send-for-review/route.ts": {
    role: "not-a-gate",
    matches: { reviewerUids: 1 },
    provedBy: [
      'isNamedWithStanding(viewer, "tasks.reviewerUids", task.reviewerUids);',
      "if (!canAccess) return NextResponse.json({ error: \"Forbidden\" }, { status: 403 });",
    ],
    why:
      "Removes the requester from the list of reviewers about to be emailed, so nobody is " +
      "notified of their own request. The handler's gate is above it and applies the bar.",
  },
  "src/app/api/worksheets/circulations/[circulationId]/submit/route.ts": {
    role: "not-a-gate",
    matches: { reviewerUids: 1 },
    why:
      "Drops the submitting recipient from the reviewer list carried onto their own task, so a " +
      "person is never their own reviewer. Not an authorisation: this route's gate is the " +
      "response's own uid.",
  },
  "src/app/api/worksheets/circulations/route.ts": {
    role: "not-a-gate",
    matches: { reviewerUids: 1 },
    provedBy: [
      'isNamedWithStanding(actor, "worksheets.authorUid", worksheet.authorUid);',
      'if (!mayRead) {',
    ],
    why:
      "Dedupes the sender out of the reviewer list they submitted, before adding them back at " +
      "the head of it. The read gate above it applies the worksheet author bar.",
  },
};

// ---------------------------------------------------------------------------
// 1. The tree walk, both directions
// ---------------------------------------------------------------------------

const scanned = scanTree();

describe("the raw comparison, walked over the whole tree", () => {
  test("every raw authority test is registered as something other than a gate", () => {
    const unregistered = [...scanned.keys()].filter((path) => !(path in RAW_SITES));
    assert.deepEqual(
      unregistered,
      [],
      "these files test an authority field against the caller's own uid without the live bar.\n" +
        "Route it through `isNamedWithStanding` from src/lib/firebase/eligibility.ts, or add an\n" +
        "entry to RAW_SITES saying why it is not a gate:\n" +
        unregistered.map((p) => `  ${p}: ${JSON.stringify(scanned.get(p))}`).join("\n"),
    );
  });

  test("every registered site still exists, with the fields and the counts it claims", () => {
    for (const [path, entry] of Object.entries(RAW_SITES)) {
      const hits = scanned.get(path);
      assert.ok(hits, `${path} is in RAW_SITES but the scanner finds no raw test there`);
      assert.deepEqual(
        hits,
        entry.matches,
        `${path}: the raw tests in this file are no longer the ones the registry describes`,
      );
    }
  });

  test("every entry gives a real reason, and a claimed compensating control is really there", () => {
    for (const [path, entry] of Object.entries(RAW_SITES)) {
      assert.ok(
        ["client", "not-a-gate"].includes(entry.role),
        `${path}: role must be "client" or "not-a-gate", got ${entry.role}`,
      );
      assert.ok(
        typeof entry.why === "string" && entry.why.length > 60,
        `${path}: needs a written reason, not a placeholder`,
      );
      if (entry.provedBy) {
        assert.ok(
          Array.isArray(entry.provedBy) && entry.provedBy.length > 0,
          `${path}: provedBy is a LIST of control literals, one per branch the reason claims`,
        );
        const code = scannableSource(join(REPO_ROOT, path));
        for (const control of entry.provedBy) {
          assert.ok(
            code.includes(control.replace(/\s+/g, " ")),
            `${path}: claims to be covered by \`${control}\`, which the file no longer contains`,
          );
        }
      }
      if (entry.role === "client") {
        const head = readFileSync(join(REPO_ROOT, path), "utf8").slice(0, 400);
        assert.match(
          head,
          /["']use client["']/,
          `${path}: registered as a client component but does not declare "use client"`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The registry against the tree, both directions
// ---------------------------------------------------------------------------

/** Every `"collection.field"` literal handed to the helper anywhere in src. */
function authoritiesNamedInTree() {
  const named = new Map();
  for (const file of walk(SRC)) {
    const path = repoPath(file);
    if (path === "src/lib/firebase/eligibility.ts") continue;
    const code = scannableSource(file);
    for (const m of code.matchAll(
      /(?:isNamedWithStanding|holdsStanding)\(\s*[\w.?!]+\s*,\s*"([^"]+)"/g,
    )) {
      if (!named.has(m[1])) named.set(m[1], []);
      named.get(m[1]).push(path);
    }
  }
  return named;
}

describe("the registry of bars against the tree", () => {
  const named = authoritiesNamedInTree();

  test("every authority named at a call site exists in the registry", () => {
    const unknown = [...named.keys()].filter((key) => !(key in AUTHORITY));
    assert.deepEqual(
      unknown,
      [],
      `these call sites name an authority the registry does not define, which throws at run time ` +
        `on whichever branch reaches it: ${unknown.map((k) => `${k} (${named.get(k).join(", ")})`).join("; ")}`,
    );
  });

  test("every authority in the registry is used by at least one file", () => {
    const unused = Object.keys(AUTHORITY).filter((key) => !named.has(key));
    assert.deepEqual(
      unused,
      [],
      `these bars are defined and called nowhere, which is dead policy: ${unused.join(", ")}`,
    );
  });

  test("every authority carries its field, its appointment site and a written reason", () => {
    for (const [key, bar] of Object.entries(AUTHORITY)) {
      assert.equal(bar.field, key, `${key}: \`field\` must repeat the key`);
      assert.match(key, /^[a-zA-Z]+\.[a-zA-Z]+$/, `${key}: keys are "collection.field"`);
      assert.ok(
        typeof bar.appointedBy === "string" && bar.appointedBy.length > 20,
        `${key}: name the file that WRITES the array`,
      );
      assert.ok(
        typeof bar.why === "string" && bar.why.length > 60,
        `${key}: needs a written reason, not a placeholder`,
      );
      assert.equal(typeof bar.test, "function", `${key}: needs a live test`);
    }
  });

  test("the scanner watches every field the registry names, or says why it cannot", () => {
    for (const bar of Object.values(AUTHORITY)) {
      if (bar.field in UNSCANNABLE_FIELDS) {
        assert.ok(
          UNSCANNABLE_FIELDS[bar.field].length > 60,
          `${bar.field}: an unscannable field needs a written reason, not a placeholder`,
        );
        assert.ok(
          !FIELDS.includes(bar.field.split(".")[1]),
          `${bar.field} is listed as unscannable and is being scanned anyway`,
        );
        continue;
      }
      assert.ok(
        FIELDS.includes(bar.field.split(".")[1]),
        `${bar.field} is registered but the scanner does not watch its field name`,
      );
    }
    for (const field of Object.keys(UNSCANNABLE_FIELDS)) {
      assert.ok(
        field in AUTHORITY,
        `${field} is excused from the walk but is not an authority at all`,
      );
    }
  });

  /**
   * The three files that read an enrolment as an authority. The scanner cannot
   * walk for `uid`, so this stands in for that half: each file must call the
   * helper with the enrolment key, and the list is checked against the tree in
   * both directions by grepping for the key itself.
   */
  const ENROLMENT_GATES = {
    "src/app/api/courses/runs/[runId]/overview/route.ts":
      "the run overview, where the enrolment is the first of three paths to access",
    "src/app/api/courses/runs/[runId]/comments/route.ts":
      "the run comment feed, gated on the same enrolment",
    "src/features/courses/runAccess.ts":
      "the shared gate behind every /learn server page",
  };

  test("every file that reads an enrolment as an authority calls the helper, both ways", () => {
    const key = '"courseEnrolments.uid"';
    const found = [];
    for (const file of walk(SRC)) {
      const path = repoPath(file);
      if (path === "src/lib/firebase/eligibility.ts") continue; // the registry itself
      if (scannableSource(file).includes(key)) found.push(path);
    }
    assert.deepEqual(
      found.sort(),
      Object.keys(ENROLMENT_GATES).sort(),
      "the files that gate on an enrolment are no longer the ones ENROLMENT_GATES names",
    );
    for (const [file, why] of Object.entries(ENROLMENT_GATES)) {
      assert.ok(why.length > 30, `${file}: needs a written reason`);
      const code = scannableSource(join(REPO_ROOT, file));
      assert.match(
        code,
        /isNamedWithStanding\([^)]*"courseEnrolments\.uid"/,
        `${file}: names the enrolment authority without calling isNamedWithStanding on it`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The bars, executed against every persona
// ---------------------------------------------------------------------------

function session(overrides) {
  return {
    uid: "u1",
    email: "u1@example.com",
    role: "member",
    suRecognised: false,
    permissions: {
      draftNewsletter: false,
      approveNewsletter: false,
      draftEvent: false,
      approveEvent: false,
      draftCourse: false,
      approveCourse: false,
      manageMembership: false,
      circulateWorksheet: false,
    },
    ...overrides,
  };
}

const PERSONAS = {
  pending: session({ role: "pending" }),
  rejected: session({ role: "rejected" }),
  member: session({ role: "member" }),
  // A plain member holding the one permission key that is orthogonal to role.
  // Rejected-with-the-key is the persona the approved-account floor exists for.
  memberWithCirculate: session({
    role: "member",
    permissions: { ...session().permissions, circulateWorksheet: true },
  }),
  rejectedWithCirculate: session({
    role: "rejected",
    permissions: { ...session().permissions, circulateWorksheet: true },
  }),
  committeeNonSu: session({ role: "committee" }),
  committeeSu: session({ role: "committee", suRecognised: true }),
  admin: session({ role: "admin" }),
};

/**
 * The whole matrix, written out. Widening a bar changes a letter here, which
 * is a diff a reviewer can see, rather than a predicate nobody re-reads.
 * Order: pending, rejected, member, member+circulate, rejected+circulate,
 * committee (non-SU), committee (SU), admin.
 */
const ORDER = [
  "pending",
  "rejected",
  "member",
  "memberWithCirculate",
  "rejectedWithCirculate",
  "committeeNonSu",
  "committeeSu",
  "admin",
];

const MATRIX = {
  "admissionRounds.reviewerUids": "-- - - - - Y Y".replace(/ /g, ""),
  "admissionRounds.finalDeciderUid": "-- - - - - Y Y".replace(/ /g, ""),
  "courseRuns.admissionsReviewerUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "courseRuns.trackLeadUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "courseRuns.runFacilitatorUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "courseEnrolments.uid": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "courseGroups.facilitatorUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "events.authorUid": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "events.collaboratorUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "worksheets.authorUid": "-- - - - Y Y Y".replace(/ /g, ""),
  "circulations.staffUids": "-- - Y - Y Y Y".replace(/ /g, ""),
  "tasks.completerUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
  "tasks.reviewerUids": "-- Y Y - Y Y Y".replace(/ /g, ""),
};

describe("the bars, executed", () => {
  test("the matrix names every authority, and only authorities", () => {
    assert.deepEqual(Object.keys(MATRIX).sort(), Object.keys(AUTHORITY).sort());
    for (const [key, row] of Object.entries(MATRIX)) {
      assert.equal(row.length, ORDER.length, `${key}: the row is not one cell per persona`);
    }
  });

  for (const [key, row] of Object.entries(MATRIX)) {
    test(`${key} answers the same for every persona it did when this landed`, () => {
      ORDER.forEach((persona, i) => {
        assert.equal(
          holdsStanding(PERSONAS[persona], key),
          row[i] === "Y",
          `${key} as ${persona}: expected ${row[i] === "Y" ? "standing" : "no standing"}`,
        );
      });
    });
  }

  test("no bar admits an account that is pending or rejected, whatever it carries", () => {
    for (const key of Object.keys(AUTHORITY)) {
      for (const persona of ["pending", "rejected", "rejectedWithCirculate"]) {
        assert.equal(
          holdsStanding(PERSONAS[persona], key),
          false,
          `${key} admitted ${persona}: the approved-account floor is not being applied`,
        );
      }
    }
  });

  test("an unknown authority throws rather than answering", () => {
    assert.throws(
      () => holdsStanding(PERSONAS.admin, "courseRuns.notAnArray"),
      /Unknown authority/,
    );
  });
});

describe("isNamedWithStanding asks both halves", () => {
  const AUTH = "courseRuns.trackLeadUids";

  test("named and standing is the only true", () => {
    assert.equal(
      isNamedWithStanding(PERSONAS.member, AUTH, ["u1", "other"]),
      true,
      "a named approved member holds the role",
    );
    assert.equal(
      isNamedWithStanding(PERSONAS.member, AUTH, ["other"]),
      false,
      "standing without membership is not authority",
    );
    assert.equal(
      isNamedWithStanding(PERSONAS.rejected, AUTH, ["u1", "other"]),
      false,
      "membership without standing is not authority",
    );
  });

  test("a single uid field works the same way", () => {
    assert.equal(isNamedWithStanding(PERSONAS.member, "events.authorUid", "u1"), true);
    assert.equal(isNamedWithStanding(PERSONAS.member, "events.authorUid", "u2"), false);
    assert.equal(isNamedWithStanding(PERSONAS.rejected, "events.authorUid", "u1"), false);
  });

  test("a field that is absent, malformed or hand-edited reads as not named", () => {
    for (const named of [undefined, null, "", 0, 42, {}, [42], [{ uid: "u1" }]]) {
      assert.equal(
        isNamedWithStanding(PERSONAS.admin, AUTH, named),
        false,
        `${JSON.stringify(named)} should not name anybody`,
      );
    }
  });

  test("a session with no uid is never named, even against an array of empties", () => {
    assert.equal(
      isNamedWithStanding(session({ uid: "", role: "admin" }), AUTH, ["", "u1"]),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Each bar against its appointment site
// ---------------------------------------------------------------------------

describe("each bar agrees with the bar its appointment applied", () => {
  const ROUND_ROLES = readFileSync(
    join(SRC, "app", "api", "admissions", "rounds", "[roundId]", "roles", "route.ts"),
    "utf8",
  );
  const RUN_ROLES = readFileSync(
    join(SRC, "app", "api", "courses", "runs", "[runId]", "roles", "route.ts"),
    "utf8",
  );
  const GROUP_FACILITATORS = readFileSync(
    join(SRC, "app", "api", "courses", "groups", "[groupId]", "facilitators", "route.ts"),
    "utf8",
  );
  const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

  test("the round bars ARE isEligibleAdmissionsReviewer, the predicate the roles route runs", () => {
    assert.match(
      ROUND_ROLES,
      /if \(!isEligibleAdmissionsReviewer\(candidate\)\)/,
      "the round roles route no longer checks candidates against the live user document",
    );
    for (const key of [
      "admissionRounds.reviewerUids",
      "admissionRounds.finalDeciderUid",
    ]) {
      for (const persona of ORDER) {
        assert.equal(
          holdsStanding(PERSONAS[persona], key),
          isEligibleAdmissionsReviewer(PERSONAS[persona]),
          `${key} and the appointment predicate disagree about ${persona}`,
        );
      }
    }
  });

  test("the course-role bars ARE the approved-accounts query the two roles routes intersect with", () => {
    for (const [name, source] of [
      ["the run roles route", RUN_ROLES],
      ["the group facilitators route", GROUP_FACILITATORS],
    ]) {
      assert.match(
        source,
        /const ELIGIBLE_ROLES = \["member", "committee", "admin"\] as const;/,
        `${name} no longer intersects with exactly the approved accounts`,
      );
      assert.match(
        source,
        /\.where\("role", "in", \[\.\.\.ELIGIBLE_ROLES\]\)/,
        `${name} no longer builds its candidate set from that constant`,
      );
    }
    for (const key of [
      "courseRuns.admissionsReviewerUids",
      "courseRuns.trackLeadUids",
      "courseRuns.runFacilitatorUids",
      "courseGroups.facilitatorUids",
    ]) {
      for (const persona of ORDER) {
        const approved = ["member", "committee", "admin"].includes(
          PERSONAS[persona].role,
        );
        assert.equal(
          holdsStanding(PERSONAS[persona], key),
          approved,
          `${key} and ELIGIBLE_ROLES disagree about ${persona}`,
        );
      }
    }
  });

  test("the worksheet author bar IS isLibraryUser(), the helper the rules put the role test inside", () => {
    assert.match(
      RULES,
      /function isLibraryUser\(\) \{ return hasRole\(\['committee', 'admin'\]\); \}/,
      "firestore.rules no longer defines the library tier as committee plus admin",
    );
    assert.match(
      RULES,
      /function isAuthor\(\) \{\s*return isLibraryUser\(\) && resource\.data\.authorUid == request\.auth\.uid;/,
      "firestore.rules no longer keeps the role test inside isAuthor()",
    );
    for (const persona of ORDER) {
      assert.equal(
        holdsStanding(PERSONAS[persona], "worksheets.authorUid"),
        ["committee", "admin"].includes(PERSONAS[persona].role),
        `the worksheet author bar and isLibraryUser() disagree about ${persona}`,
      );
    }
  });

  test("the event bars are the appointment's, or the widening is a written exception", () => {
    const COLLABORATORS = readFileSync(
      join(SRC, "app", "api", "events", "[id]", "collaborators", "route.ts"),
      "utf8",
    );
    assert.match(
      COLLABORATORS,
      /\.where\("role", "in", \["committee", "admin"\]\)/,
      "the collaborators route no longer offers exactly committee and admins",
    );
    // THE ONE DELIBERATE WIDENING IN THE REGISTRY, recorded here rather than
    // left as an omission. Appointment is committee-or-admin; the use bar is
    // an approved account, because the broadcast route settled the pair on
    // purpose: "a member demoted off the committee still passes, deliberately:
    // they are still an approved member and still the person responsible for
    // the event their name is on." Narrowing it would take an event away from
    // the person running it the day they step off the committee.
    for (const persona of ORDER) {
      const user = PERSONAS[persona];
      const approved = ["member", "committee", "admin"].includes(user.role);
      for (const key of ["events.authorUid", "events.collaboratorUids"]) {
        assert.equal(
          holdsStanding(user, key),
          approved,
          `${key} is no longer the approved-account bar the broadcast route settled on (${persona})`,
        );
      }
    }
    assert.match(
      AUTHORITY["events.collaboratorUids"].why,
      /Appointment is narrower than this/,
      "the widening has stopped saying it is a widening",
    );
  });

  test("the task bars are the roster floor, because assignment applies no other", () => {
    // There is no role bar on being assigned a task and there should not be:
    // the visibility model puts plain members on their own. So the bar is the
    // floor, and the check is that it is EXACTLY the floor rather than
    // something that drifted upward and quietly stopped a member acting on
    // their own work.
    for (const persona of ORDER) {
      const user = PERSONAS[persona];
      const approved = ["member", "committee", "admin"].includes(user.role);
      for (const key of ["tasks.completerUids", "tasks.reviewerUids", "courseEnrolments.uid"]) {
        assert.equal(holdsStanding(user, key), approved, `${key} as ${persona}`);
      }
    }
  });

  test("the circulation staff bar is the union of the two ways a uid gets into staffUids", () => {
    for (const persona of ORDER) {
      const user = PERSONAS[persona];
      const approved = ["member", "committee", "admin"].includes(user.role);
      const expected =
        approved &&
        (["committee", "admin"].includes(user.role) || canCirculateWorksheet(user));
      assert.equal(
        holdsStanding(user, "circulations.staffUids"),
        expected,
        `the circulation staff bar disagrees with (library tier OR canCirculateWorksheet) about ${persona}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The four findings, pinned
// ---------------------------------------------------------------------------

describe("the four findings this closed", () => {
  test("a demoted round reviewer or final decider loses the round", async () => {
    const { canSeeRound } = await loadTs(join("lib", "admissions", "roundRoutes.ts"));
    const { canDecideAppointments, canViewAppointmentQueue } = await loadTs(
      join("lib", "admissions", "appointmentQueueData.ts"),
    );
    const round = { reviewerUids: ["u1"], finalDeciderUid: "u1" };

    assert.equal(canSeeRound(PERSONAS.committeeSu, round), true, "still recognised, still on it");
    assert.equal(canDecideAppointments(PERSONAS.committeeSu, round), true);
    assert.equal(canViewAppointmentQueue(PERSONAS.committeeSu, round), true);

    for (const persona of ["member", "committeeNonSu", "pending", "rejected"]) {
      assert.equal(
        canSeeRound(PERSONAS[persona], round),
        false,
        `${persona} still sees a round they are named on`,
      );
      assert.equal(
        canDecideAppointments(PERSONAS[persona], round),
        false,
        `${persona} can still appoint facilitators and mail applicants`,
      );
      assert.equal(canViewAppointmentQueue(PERSONAS[persona], round), false);
    }
    assert.equal(
      canDecideAppointments(PERSONAS.admin, { finalDeciderUid: "somebody-else" }),
      true,
      "admins stay resource-independent",
    );
  });

  test("an ex-committee worksheet author cannot delete the document any more", () => {
    const author = "u1";
    assert.equal(
      isNamedWithStanding(PERSONAS.committeeNonSu, "worksheets.authorUid", author),
      true,
      "a committee author keeps their worksheet; SU recognition is not the library tier",
    );
    for (const persona of ["member", "pending", "rejected"]) {
      assert.equal(
        isNamedWithStanding(PERSONAS[persona], "worksheets.authorUid", author),
        false,
        `${persona} can still destroy a document the whole committee browses`,
      );
    }
  });

  test("a rejected track lead loses the allocation board and the admissions queue", () => {
    const run = { trackLeadUids: ["u1"], admissionsReviewerUids: ["u1"] };
    assert.equal(
      isNamedWithStanding(PERSONAS.member, "courseRuns.trackLeadUids", run.trackLeadUids),
      true,
      "a plain member track lead is a shipped product decision and stays",
    );
    for (const persona of ["pending", "rejected"]) {
      assert.equal(
        isNamedWithStanding(PERSONAS[persona], "courseRuns.trackLeadUids", run.trackLeadUids),
        false,
      );
      assert.equal(
        isNamedWithStanding(
          PERSONAS[persona],
          "courseRuns.admissionsReviewerUids",
          run.admissionsReviewerUids,
        ),
        false,
        `${persona} can still accept and reject applicants and send them the email`,
      );
    }
  });

  test("the two admissions subsystems still answer differently, and that is the recorded decision", () => {
    // The run-level roles route offers every approved account by design and
    // documents why; the round-level one refuses anybody below the SU bar. The
    // split is a policy question for the owner rather than a hole, and this
    // pins it so raising the run bar is a deliberate, visible change here.
    assert.equal(holdsStanding(PERSONAS.member, "courseRuns.admissionsReviewerUids"), true);
    assert.equal(holdsStanding(PERSONAS.member, "admissionRounds.reviewerUids"), false);
    assert.equal(holdsStanding(PERSONAS.committeeNonSu, "courseRuns.trackLeadUids"), true);
    assert.equal(holdsStanding(PERSONAS.committeeNonSu, "admissionRounds.reviewerUids"), false);
  });
});

// ---------------------------------------------------------------------------
// 6. The scanner's own patterns
// ---------------------------------------------------------------------------

describe("the scanner still matches what it claims to", () => {
  const POSITIVE = [
    "const isTrackLead = run.trackLeadUids.includes(actor.uid);",
    "const isLead = asUidList(run.trackLeadUids).includes(actor.uid);",
    "const isAuthor = worksheet.authorUid === actor.uid;",
    "if (viewer.uid === event.authorUid) return true;",
    "if (e.authorUid !== user?.uid) return false;",
    'db.collection("courseRuns").where("trackLeadUids", "array-contains", actor.uid)',
    "if (round.reviewerUids.indexOf(session.uid) >= 0) return true;",
    "groups.some((g) => g.facilitatorUids.includes(actor.uid))",
    "const staff = circulation.staffUids.includes(user.uid);",
  ];
  const NEGATIVE = [
    'isNamedWithStanding(actor, "courseRuns.trackLeadUids", run.trackLeadUids)',
    'isNamedWithStanding(viewer, "events.authorUid", event.authorUid)',
    'holdsStanding(actor, "courseRuns.trackLeadUids")',
    "patch.trackLeadUids = clean(body.trackLeadUids, COURSE_FIELD_LIMITS.maxTrackLeads);",
    "for (const uid of group.facilitatorUids) uids.add(uid);",
    "reviewerUids: circulation.reviewerUids.filter((uid) => uid !== target),",
    "const isCreator = viewer.uid === task.creatorUid;",
  ];

  const matchesAny = (snippet) =>
    FIELDS.some((field) =>
      patternsFor(field).some((pattern) => pattern.test(snippet.replace(/\s+/g, " "))),
    );

  test("it matches every gate shape in the tree", () => {
    for (const snippet of POSITIVE) {
      assert.ok(matchesAny(snippet), `the scanner no longer sees: ${snippet}`);
    }
  });

  test("it does not match the fixed shape, a write, or an unrelated field", () => {
    for (const snippet of NEGATIVE) {
      assert.ok(!matchesAny(snippet), `the scanner now false-positives on: ${snippet}`);
    }
  });

  test("comments cannot hide a gate from it, and cannot invent one", () => {
    const hidden = "const x = 1; /* run.trackLeadUids.includes(actor.uid) */";
    assert.ok(
      !matchesAny(scannableSource.name ? hidden.replace(/\/\*[\s\S]*?\*\//g, " ") : hidden),
      "a commented-out gate is not a gate",
    );
    assert.ok(
      matchesAny("run.trackLeadUids\n    .includes(actor.uid)"),
      "a gate split across two lines is still a gate",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. The other way a grant outlives an account: a permissions key
// ---------------------------------------------------------------------------

/**
 * `permissions` is admin-granted and orthogonal to the governance role, which
 * is the point of it. What it is NOT is a grant that survives the account:
 * `setRole` and `rejectUser` write `role` and `suRecognised` and nothing else,
 * so a rejected account keeps every key it was ever given. The floor lives in
 * the `can*` helpers in `lib/firestore/users.ts`, which is worth nothing if a
 * route reads the raw key beside them, and on 9 September 2026 twenty-seven of
 * them did: a rejected `approveEvent` holder could approve an RSVP on any
 * event, and a rejected `approveCourse` holder could publish a course.
 *
 * So the raw read is walked for, the same way the authority arrays are.
 */
const PERMISSION_KEYS = [
  "draftNewsletter",
  "approveNewsletter",
  "draftEvent",
  "approveEvent",
  "draftCourse",
  "approveCourse",
  "manageMembership",
  "circulateWorksheet",
];

/** file -> { matches, role, why } for every raw key read left in the tree. */
const RAW_PERMISSION_SITES = {
  "src/lib/firestore/users.ts": {
    matches: 9,
    role: "definition",
    why:
      "The nine `can*` helpers themselves, which is where the key is READ and where the roster " +
      "floor is applied. Every other site calls one of them.",
  },
  "src/lib/firestore/coursePages.ts": {
    matches: 2,
    role: "floored-locally",
    why:
      "`canAuthorCoursePage` writes the floor out by hand because this module is imported by " +
      "client components and cannot reach either shared helper. Its own RAW_SITES entry above " +
      "pins the two controls.",
  },
  "src/layout/AppShell.tsx": {
    matches: 7,
    role: "client",
    why:
      "The sidebar draws the drafter and approver entries off the live auth snapshot. Every one " +
      "of those entries lands on a layout or a route that applies the floored helper, so the " +
      "worst a stale key does here is show a link that redirects.",
  },
  "src/features/admin/MemberItem.tsx": {
    matches: 4,
    role: "client",
    why:
      "The admin console's permission toggles, which DISPLAY the stored map and write it. " +
      "Reading the raw key is the point of the surface rather than a gate on it.",
  },
  "src/features/courses/WeekPlanBuilder.tsx": {
    matches: 1,
    role: "client",
    why:
      "Shows or hides a control in the run editor. The write behind it is a route that applies " +
      "`canApproveCourse`.",
  },
  "src/features/worksheets/circulation/CirculationPage.tsx": {
    matches: 1,
    role: "client",
    why:
      "Shows or hides the add-recipients control. The recipients route applies `canCirculate`, " +
      "which is `canCirculateWorksheet`.",
  },
  "src/lib/firebase/eligibility.ts": {
    matches: 1,
    role: "prose",
    why:
      "The words `permissions.draftEvent` inside the written reason on the `events.authorUid` " +
      "bar, which the scanner cannot tell from code because it is a string literal.",
  },
};

describe("a permissions key is not a standing grant either", () => {
  const KEY_READ = new RegExp(
    `permissions\\??\\.(?:${PERMISSION_KEYS.join("|")})\\b`,
    "g",
  );

  const rawKeySites = (() => {
    const found = new Map();
    for (const file of walk(SRC)) {
      const hits = [...scannableSource(file).matchAll(KEY_READ)];
      if (hits.length) found.set(repoPath(file), hits.length);
    }
    return found;
  })();

  test("every raw key read is registered, and every entry still exists", () => {
    assert.deepEqual(
      [...rawKeySites.keys()].sort(),
      Object.keys(RAW_PERMISSION_SITES).sort(),
      "a file reads a permissions key directly instead of through its `can*` helper in " +
        "src/lib/firestore/users.ts, where the roster floor lives",
    );
    for (const [path, entry] of Object.entries(RAW_PERMISSION_SITES)) {
      assert.equal(
        rawKeySites.get(path),
        entry.matches,
        `${path}: the raw key reads in this file are no longer the ones the registry describes`,
      );
      assert.ok(
        ["definition", "floored-locally", "client", "prose"].includes(entry.role),
        `${path}: unknown role ${entry.role}`,
      );
      assert.ok(
        typeof entry.why === "string" && entry.why.length > 60,
        `${path}: needs a written reason, not a placeholder`,
      );
    }
  });

  test("no route handler or server page reads a raw key", () => {
    const serverSide = [...rawKeySites.keys()].filter(
      (p) => p.startsWith("src/app/api/") || /\/(page|layout)\.tsx$/.test(p),
    );
    assert.deepEqual(
      serverSide,
      [],
      "these are ENFORCEMENT points and must call the floored helper: " + serverSide.join(", "),
    );
  });

  test("every helper applies the roster floor, executed", () => {
    const HELPERS = {
      canDraftNewsletter: "draftNewsletter",
      canApproveNewsletter: "approveNewsletter",
      canDraftEvent: "draftEvent",
      canApproveEvent: "approveEvent",
      canDraftCourse: "draftCourse",
      canApproveCourse: "approveCourse",
      canManageMembership: "manageMembership",
      canCirculateWorksheet: "circulateWorksheet",
      canAuthorAdmissionRound: "approveCourse",
    };
    assert.deepEqual(
      Object.keys(HELPERS).sort(),
      Object.keys(USERS_MODULE)
        .filter((name) => /^can[A-Z]/.test(name))
        .sort(),
      "the list of permission helpers is no longer the list this file executes",
    );
    for (const [helper, key] of Object.entries(HELPERS)) {
      const fn = USERS_MODULE[helper];
      for (const role of ["pending", "rejected"]) {
        assert.equal(
          fn({ role, permissions: { [key]: true } }),
          false,
          `${helper} admitted a ${role} account holding ${key}`,
        );
      }
      for (const role of ["member", "committee"]) {
        assert.equal(
          fn({ role, permissions: { [key]: true } }),
          true,
          `${helper} refused an approved ${role} holding ${key}`,
        );
        assert.equal(
          fn({ role, permissions: {} }),
          false,
          `${helper} admitted a ${role} without the key`,
        );
      }
      assert.equal(fn({ role: "admin", permissions: {} }), true, `${helper} refused an admin`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The same sentence in firestore.rules
// ---------------------------------------------------------------------------

/**
 * A route that refuses a rejected account is worth nothing if the browser can
 * read the same document directly. `firestore.rules` had the role test inside
 * `isAuthor()` on `worksheets` and nowhere else, so this walks the rules file
 * for every helper that grants by NAMING the caller and requires each one to
 * carry a role test of its own.
 */
describe("the rules grant by name only to an account still on the roster", () => {
  const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

  /** helper name -> the role test it must carry, with the reason it is that one. */
  const NAMED_HELPERS = {
    isCompleter: ["isApprovedAccount()", "a task's completers"],
    isReviewer: ["isApprovedAccount()", "a task's reviewers"],
    canAccessParent: [
      "isApprovedAccount()",
      "the same two arrays, read from a task's comments, activity and attachments",
    ],
    isStaff: ["isApprovedAccount()", "a circulation's staff"],
    isParentStaff: ["isApprovedAccount()", "the same staff, from a subcollection"],
    isCollaborator: ["isApprovedAccount()", "an event's named collaborators"],
    isOwnEvent: ["isApprovedAccount()", "an event's author"],
    isCourseCollaborator: ["isApprovedAccount()", "a course's named collaborators"],
    isOwnCourse: ["isApprovedAccount()", "a course's author"],
    isOwnDraft: ["isApprovedAccount()", "a newsletter draft's author"],
    isOwnRun: ["isApprovedAccount()", "a run's author"],
    isRunTrackLead: ["isApprovedAccount()", "a run's track leads"],
    isParentRunTrackLead: ["isApprovedAccount()", "the same leads, from a group"],
    isNotedRunTrackLead: ["isApprovedAccount()", "the same leads, from a material note"],
    isSourceRunTrackLead: ["isApprovedAccount()", "the same leads, from a clone's source run"],
    isGroupFacilitator: ["isApprovedAccount()", "a group's facilitators"],
    canEditRun: ["isApprovedAccount()", "its track-lead disjunct; the rest are permissions"],
    isAuthor: ["isLibraryUser()", "a worksheet's author, the one that had it right first"],
  };

  /**
   * Ownership scalars over the caller's OWN row rather than appointments, so
   * there is no appointment bar to re-ask. Listed rather than skipped, with the
   * reason each is not an authority, and checked to still exist.
   */
  const NOT_APPOINTMENTS = {
    isTaskCreator: "the creator of a personal task, deleting the thing they made for themselves",
    isOwner: "a worksheet response, bound to its recipient by the document id",
    progressShapeOk:
      "a SHAPE check on an incoming course-progress row, not a read gate: it pins the "
      + "written uid and the document id to the caller so nobody writes a row as somebody "
      + "else, and the access decision beside it is isEnrolledActive()",
  };

  /** Bodies by name, matched with a brace counter rather than a regex. */
  function ruleFunctions(source) {
    const out = [];
    for (const m of source.matchAll(/function (\w+)\([^)]*\)\s*\{/g)) {
      const open = source.indexOf("{", m.index + m[0].length - 1);
      let depth = 0;
      let end = open;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push([m[1], source.slice(open, end + 1)]);
    }
    return out;
  }

  test("every helper that names the caller is found, and carries its role test", () => {
    // Both directions: a helper whose body tests `request.auth.uid` against a
    // document field must be in one of the two lists, and every entry must
    // still exist.
    const bodies = ruleFunctions(RULES);
    const namesTheCaller = bodies
      .filter(([, body]) =>
        /request\.auth\.uid\s+in\s+|==\s*request\.auth\.uid|request\.auth\.uid\s*==/.test(body),
      )
      .map(([name]) => name)
      .filter((name) => !(name in NOT_APPOINTMENTS));
    for (const [name, why] of Object.entries(NOT_APPOINTMENTS)) {
      assert.ok(why.length > 30, `${name}: needs a written reason`);
      assert.ok(
        bodies.some(([n]) => n === name),
        `${name} is excused as an ownership scalar but no longer exists in the rules`,
      );
    }
    assert.deepEqual(
      [...new Set(namesTheCaller)].sort(),
      Object.keys(NAMED_HELPERS).sort(),
      "a rules helper grants by naming the caller and is not in NAMED_HELPERS. Give it a role " +
        "test (isApprovedAccount(), or a narrower one) and register it here, or put it in " +
        "NOT_APPOINTMENTS with the reason it grants nothing beyond the caller's own row.",
    );
    for (const [helper, [test_, why]] of Object.entries(NAMED_HELPERS)) {
      const body = ruleFunctions(RULES)
        .filter(([name]) => name === helper)
        .map(([, b]) => b);
      assert.ok(body.length > 0, `${helper} is registered but no longer exists in the rules`);
      assert.ok(why.length > 10, `${helper}: needs a written reason`);
      for (const one of body) {
        assert.ok(
          one.includes(test_),
          `${helper} grants by name without ${test_}: ${why}`,
        );
      }
    }
  });

  test("the floor helper is the roster, and the three hasPerm copies apply it", () => {
    assert.match(
      RULES,
      /function isApprovedAccount\(\) \{ return hasRole\(\['member', 'committee', 'admin'\]\); \}/,
      "isApprovedAccount() is no longer the roster",
    );
    const hasPerms = ruleFunctions(RULES).filter(([name]) => name === "hasPerm");
    assert.equal(hasPerms.length, 3, "the outer hasPerm plus the newsletter and events copies");
    for (const [, body] of hasPerms) {
      assert.ok(
        body.includes("isApprovedAccount()"),
        "a hasPerm copy grants a permissions key with no roster floor: nothing clears the map " +
          "when an account is rejected",
      );
    }
  });
});
