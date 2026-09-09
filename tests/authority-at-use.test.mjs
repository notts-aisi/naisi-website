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
const { isEligibleAdmissionsReviewer, canCirculateWorksheet } = await loadTs(
  join("lib", "firestore", "users.ts"),
);

const repoPath = (file) => file.slice(REPO_ROOT.length + 1).split(sep).join("/");

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * The field names the scanner watches, DERIVED from the registry rather than
 * listed here, so adding an authority extends the walk without a second edit.
 * A field name is watched across every collection that uses it: `authorUid`
 * catches the events, worksheets, courses and newsletter authors at once,
 * which is what makes a new collection's author gate visible on arrival.
 */
const FIELDS = [
  ...new Set(Object.values(AUTHORITY).map((bar) => bar.field.split(".")[1])),
].sort();

/** How this codebase spells "the person making the request". */
const SELF = "(?:actor|user|viewer|session|caller|me|current|self)[?!]?\\.uid";

/**
 * Every shape a gate is written in today, plus the two near neighbours a
 * future one might reach for. Each is exercised on a synthetic snippet below.
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
    // .where("trackLeadUids", "array-contains", actor.uid)
    new RegExp(`["']${f}["']\\s*,\\s*["']array-contains["']\\s*,\\s*${SELF}`),
    // run.trackLeadUids.indexOf(actor.uid)
    new RegExp(`${f}[\\s\\S]{0,12}\\.indexOf\\(\\s*${SELF}\\s*\\)`),
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
      // Deduped by WHERE the match starts, so a site two patterns both see
      // counts once and `matches` in the registry means sites rather than
      // pattern hits.
      const hits = new Set();
      for (const pattern of patternsFor(field)) {
        const global = new RegExp(pattern.source, "g");
        for (const m of code.matchAll(global)) hits.add(m.index);
      }
      if (hits.size === 0) continue;
      const path = repoPath(file);
      if (!found.has(path)) found.set(path, {});
      found.get(path)[field] = hits.size;
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
 * field. `provedBy`, where present, is a literal the file must still contain:
 * the compensating control that makes the entry true. An entry without one is
 * asserting that no control is needed.
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
    provedBy: "actor.permissions.draftCourse || actor.permissions.approveCourse",
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
    provedBy: 'holdsStanding(actor, "courseRuns.trackLeadUids")',
    why:
      "Two `array-contains` queries scoped to the caller's own uid, which is how the hub finds " +
      "the runs it might draw a door for. The bar is applied where the door is actually drawn, " +
      "on the two loops that add the `reviewer` and `lead` roles.",
  },
  "src/app/api/members/roster/route.ts": {
    role: "not-a-gate",
    matches: { completerUids: 1, reviewerUids: 1 },
    provedBy: 'holdsStanding(session, "tasks.completerUids")',
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
    provedBy: 'isNamedWithStanding(viewer, "tasks.reviewerUids", task.reviewerUids)',
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
    provedBy: 'isNamedWithStanding(actor, "worksheets.authorUid", worksheet.authorUid)',
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
        const code = scannableSource(join(REPO_ROOT, path));
        assert.ok(
          code.includes(entry.provedBy.replace(/\s+/g, " ")),
          `${path}: claims to be covered by \`${entry.provedBy}\`, which the file no longer contains`,
        );
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

  test("the scanner watches every field the registry names", () => {
    for (const bar of Object.values(AUTHORITY)) {
      assert.ok(
        FIELDS.includes(bar.field.split(".")[1]),
        `${bar.field} is registered but the scanner does not watch its field name`,
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
