/**
 * View-as write guard (run via `npm test`, Node's built-in test runner). Two
 * halves: a source scan over the guarded route trees, and, at the foot of the
 * file, live calls into `assertNotImpersonating()` itself through a transpiled
 * copy of the module with its request-only imports stubbed.
 *
 * Admin "view as" is a FULL impersonation: the `__session` cookie is swapped
 * for the target's, so `getCurrentUser()` returns the target and Firestore
 * records every write as the target performing it. The `impersonations` audit
 * log records only the start and end of the window, so after the fact there is
 * no way to tell "the admin did this while viewing as Sam" from "Sam did
 * this". For a debug tool that exists to answer "what does this member see",
 * that is fine on reads and unacceptable on anything that decides, allocates,
 * publishes, removes, marks attendance, reviews work, sends email, changes
 * status or destroys.
 *
 * So every mutating route under the trees below calls
 * `assertNotImpersonating()` before it does anything else. This test is what
 * keeps that true across parallel agent work: a new route added to one of
 * those trees fails here until it either calls the guard or is added to
 * ALLOWLIST with a reason a reader can weigh.
 *
 * The route list is written out in full rather than derived, so the guard is
 * legible as a list of decisions and a deletion shows up as a diff.
 *
 * SCOPE, restated from `assertNotImpersonating()`: this covers mutating route
 * handlers in the listed trees, and `(app)/admin/layout.tsx` separately closes
 * the whole admin page tree during a view-as session because the course
 * editors there write client-direct, where no route guard can reach. Writes
 * made client-direct from anywhere else answer to `firestore.rules` alone, and
 * rules see the target. And the marker is an httpOnly cookie: no page script
 * can remove it, but an admin with devtools open can delete it from their own
 * browser. This enforces intent against accidents, not against an admin who
 * has decided to defeat it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Route trees whose mutating handlers must all be guarded.
 *
 * TODO when those workstreams land: add "src/app/api/admin/membership"
 * (periods, grants, import, export) plus the CSV export routes to this list.
 * They are named here rather than pre-registered because a tree that does not
 * exist yet cannot be scanned, and a silently-skipped tree is a hole.
 */
const GUARDED_TREES = ["src/app/api/courses", "src/app/api/admissions"];

/**
 * Every mutating route in those trees, with the reason it is high-trust.
 * Paths are repo-relative and use forward slashes.
 */
const MUST_GUARD = [
  ["src/app/api/courses/[courseId]/destroy/route.ts", "destroys a course and everything under it"],
  ["src/app/api/courses/[courseId]/page/route.ts", "rewrites the public marketing page a logged-out visitor reads"],
  ["src/app/api/courses/[courseId]/page/generate-themes/route.ts", "regenerates the public weekly themes and their provenance"],
  ["src/app/api/courses/[courseId]/publish/route.ts", "publishes a course to the public catalogue"],
  ["src/app/api/courses/[courseId]/templates/route.ts", "writes a reusable curriculum template"],
  ["src/app/api/courses/exercise-responses/[responseId]/review/route.ts", "reviews a learner's submitted work and releases the comment"],
  ["src/app/api/courses/groups/[groupId]/attendance/route.ts", "marks and pushes a session register, which also sends the week's email"],
  ["src/app/api/courses/groups/[groupId]/email/route.ts", "sends email to a group"],
  ["src/app/api/courses/groups/[groupId]/facilitators/route.ts", "appoints and removes facilitators"],
  ["src/app/api/courses/groups/[groupId]/notice/route.ts", "publishes a notice to a whole group"],
  ["src/app/api/courses/groups/[groupId]/pace/route.ts", "changes a group's pacing, moving every learner's dates"],
  ["src/app/api/courses/groups/[groupId]/session/route.ts", "changes a group's meeting details"],
  ["src/app/api/courses/groups/[groupId]/weeks/[weekId]/fork/route.ts", "forks a week's content for a group"],
  ["src/app/api/courses/groups/[groupId]/weeks/[weekId]/route.ts", "edits a group's week content"],
  ["src/app/api/courses/progress/[progressId]/moderate/route.ts", "moderates a learner's recorded progress"],
  ["src/app/api/courses/runs/[runId]/allocate/route.ts", "allocates applicants to groups"],
  ["src/app/api/courses/runs/[runId]/allocation/publish/route.ts", "publishes an allocation, which tells applicants their place"],
  ["src/app/api/courses/runs/[runId]/applications/[uid]/decide/route.ts", "accepts, waitlists or rejects an application"],
  ["src/app/api/courses/runs/[runId]/applications/[uid]/notes/route.ts", "writes reviewer notes on an applicant"],
  ["src/app/api/courses/runs/[runId]/apply/route.ts", "creates, edits and withdraws an application in the applicant's own name"],
  ["src/app/api/courses/runs/[runId]/apply-template/route.ts", "overwrites a run's curriculum from a template"],
  ["src/app/api/courses/runs/[runId]/archive/route.ts", "archives a run"],
  ["src/app/api/courses/runs/[runId]/clone-weeks/route.ts", "copies a whole week plan onto a run"],
  ["src/app/api/courses/runs/[runId]/destroy/route.ts", "destroys a run and every row under it"],
  ["src/app/api/courses/runs/[runId]/email/route.ts", "sends email to a cohort"],
  ["src/app/api/courses/runs/[runId]/enrol/route.ts", "takes, moves and gives up a seat on an open-enrolment run in the member's own name"],
  ["src/app/api/courses/runs/[runId]/enrolments/[uid]/remove/route.ts", "removes a learner from a run"],
  ["src/app/api/courses/runs/[runId]/enrolments/[uid]/reinstate/route.ts", "puts a member who left back on a run, taking a seat back off the group"],
  ["src/app/api/courses/runs/[runId]/enrol-mode/route.ts", "flips a run between admissions and open enrolment, which changes what the enrol route accepts"],
  ["src/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route.ts", "submits a learner's answer in their own name"],
  ["src/app/api/courses/runs/[runId]/material-notes/route.ts", "records feedback attributed to the reader"],
  ["src/app/api/courses/runs/[runId]/normalise-weeks/route.ts", "rewrites every week id on a run"],
  ["src/app/api/courses/runs/[runId]/nudge/route.ts", "sends the weekly nudge email"],
  ["src/app/api/courses/runs/[runId]/roles/route.ts", "grants and revokes staff roles on a run"],
  ["src/app/api/courses/runs/[runId]/status/route.ts", "moves a run along its lifecycle, opening or closing applications"],
  ["src/app/api/courses/runs/[runId]/sync-tasks/route.ts", "creates committee tasks on the board"],
  ["src/app/api/courses/templates/[templateId]/route.ts", "deletes a curriculum template"],
  // Admissions: the round authoring console. A round is the object an intake
  // hangs off, so every write here changes what applicants are asked, when the
  // window is, who reads their answers, or who decides.
  ["src/app/api/admissions/rounds/route.ts", "creates an admission round"],
  ["src/app/api/admissions/rounds/[roundId]/route.ts", "edits a round's dates, questions framework and criteria"],
  ["src/app/api/admissions/rounds/[roundId]/status/route.ts", "opens, closes, settles or cancels a round"],
  ["src/app/api/admissions/rounds/[roundId]/stages/[stageId]/route.ts", "writes and deletes the questions a stage asks"],
  ["src/app/api/admissions/rounds/[roundId]/stages/[stageId]/release/route.ts", "releases a stage's questions to applicants, which cannot be undone"],
  ["src/app/api/admissions/rounds/[roundId]/roles/route.ts", "appoints reviewers and the final decider, which grants access to applications"],
  // Admissions: the applicant's own lane. Every write here is recorded by
  // Firestore as the MEMBER performing it, and each one is a fact about their
  // intake: an application starting, an answer changing, a submission going in
  // or a withdrawal coming out. An admin viewing as somebody must not be able
  // to type into their application, submit it, or take it out of the queue.
  ["src/app/api/admissions/rounds/[roundId]/apply/route.ts", "starts, saves and withdraws an application in the applicant's own name"],
  ["src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts", "submits an application, which puts somebody's work in a reviewer's queue"],
  ["src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts", "submits one later-released stage of an application, which cannot be undone"],
  // Outside the scanned trees above (it lives under /api/admin), so it is
  // named here or it is checked by nothing: it writes `config/courses`, whose
  // knobs reach every course surface at once.
  ["src/app/api/admin/courses-config/route.ts", "changes site-wide course settings"],
];

/**
 * Deliberate exemptions. Each entry is a path plus the reason a mutating route
 * may run while an admin is viewing as someone else. The bar is high: the
 * write must be invisible in the audit trail (no attribution to reason about),
 * reversible by the member themselves, and pointless to perform on someone
 * else's behalf. Nothing under the course tree meets it today, which is why
 * this list is empty. Adding an entry is a decision, not a workaround for a
 * failing test.
 */
const ALLOWLIST = [];

const METHODS = "POST|PATCH|PUT|DELETE";

/**
 * Every shape Next accepts for a route handler export, because a scan that
 * only knows one of them is a scan a refactor walks straight through.
 *
 *  1. `export async function POST(` / `export function POST(`
 *  2. `export const POST = ` / `export const POST: RouteHandler = ` (the arrow
 *     and the typed-const forms, which the old scan missed entirely)
 *  3. `export { handlePost as POST }` (a re-export; the body is elsewhere in
 *     the file, so the guard window is measured from the DECLARATION, resolved
 *     below, not from the export statement)
 *
 * Each returns the offset the guard window starts at, so the check is "this
 * handler calls the guard near its top", not "the file mentions the guard as
 * many times as it has handlers", which a file with one guarded handler and
 * one unguarded one could satisfy twice over.
 */
const DECLARED_HANDLER = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${METHODS})\\s*\\(`,
  "g",
);
const CONST_HANDLER = new RegExp(`export\\s+const\\s+(${METHODS})\\s*[:=]`, "g");
const ALIASED_EXPORT = /export\s*\{([^}]*)\}/g;
const GUARD_CALL = /assertNotImpersonating\(\)/g;

/** Lines after a handler's opening within which the guard must appear. Wide
 *  enough for a multi-line signature and a RouteContext type, far too narrow
 *  for the guard to be sitting in some other handler further down. */
const GUARD_WINDOW_LINES = 12;

/** Where the local declaration of `name` starts, or -1. Used only to resolve
 *  the `export { x as POST }` form back to the function it re-exports. */
function declarationIndex(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(
    `(?:async\\s+)?function\\s+${escaped}\\s*\\(|(?:const|let|var)\\s+${escaped}\\s*[:=]`,
  );
  return source.search(decl);
}

/**
 * Every mutating handler a route file exports: `{ method, at }`, where `at` is
 * the offset the guard window is measured from.
 */
function mutatingHandlers(source) {
  const found = [];
  for (const pattern of [DECLARED_HANDLER, CONST_HANDLER]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      found.push({ method: match[1], at: match.index });
    }
  }
  ALIASED_EXPORT.lastIndex = 0;
  for (const match of source.matchAll(ALIASED_EXPORT)) {
    for (const clause of match[1].split(",")) {
      const alias = /^\s*([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)\s*$/.exec(clause);
      if (!alias) continue;
      const [, local, exported] = alias;
      if (!new RegExp(`^(?:${METHODS})$`).test(exported)) continue;
      const at = declarationIndex(source, local);
      found.push({ method: exported, at: at === -1 ? match.index : at });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Does the guard appear inside this handler's window? */
function guardedAt(source, at) {
  const lines = source.slice(at).split("\n").slice(0, GUARD_WINDOW_LINES).join("\n");
  GUARD_CALL.lastIndex = 0;
  return GUARD_CALL.test(lines);
}

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(path));
    else if (entry.name === "route.ts") out.push(path);
  }
  return out;
}

function repoRelative(absolute) {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

test("every listed high-trust course route calls assertNotImpersonating()", () => {
  for (const [path, why] of MUST_GUARD) {
    const absolute = join(REPO_ROOT, ...path.split("/"));
    assert.ok(
      existsSync(absolute),
      `${path} is on the view-as guard list but does not exist. If the route ` +
        "moved, move its entry too; if it was deleted, delete the entry.",
    );
    const source = readFileSync(absolute, "utf8");
    const handlers = mutatingHandlers(source);
    assert.ok(
      handlers.length > 0,
      `${path} is on the view-as guard list but exports no POST/PATCH/PUT/DELETE. ` +
        "Drop the entry if the route no longer mutates anything.",
    );
    for (const { method, at } of handlers) {
      assert.ok(
        guardedAt(source, at),
        `${path} (${why}) exports ${method} without calling ` +
          `assertNotImpersonating() in its first ${GUARD_WINDOW_LINES} lines. ` +
          "Every mutating handler must refuse during a view-as session, at the " +
          "TOP and before any other work, because Firestore would record the " +
          "write as the member, not as the admin who made it.",
      );
    }
    assert.match(
      source,
      /from "@\/lib\/firebase\/impersonation"/,
      `${path} must import assertNotImpersonating from @/lib/firebase/impersonation.`,
    );
  }
});

test("no mutating course route escapes the view-as guard", () => {
  const listed = new Set(MUST_GUARD.map(([path]) => path));
  const exempt = new Set(ALLOWLIST.map(([path]) => path));
  for (const tree of GUARDED_TREES) {
    const dir = join(REPO_ROOT, ...tree.split("/"));
    assert.ok(
      existsSync(dir),
      `${tree} is on the guarded-tree list but does not exist. Update the list.`,
    );
    const files = routeFiles(dir);
    assert.ok(files.length > 0, `no route.ts files found under ${tree}.`);
    for (const file of files) {
      const path = repoRelative(file);
      const source = readFileSync(file, "utf8");
      if (mutatingHandlers(source).length === 0) continue;
      assert.ok(
        listed.has(path) || exempt.has(path),
        `${path} exports a mutating handler but is on neither the view-as ` +
          "guard list nor the allowlist in tests/impersonation-guard.test.mjs. " +
          "Call assertNotImpersonating() at the top of each handler and add " +
          "the route to MUST_GUARD, or add it to ALLOWLIST with the reason it " +
          "is safe to run while an admin is viewing as someone else.",
      );
    }
  }
});

test("the scan catches handler forms nobody has written in this tree yet", (t) => {
  // A scratch route tree, written and removed here rather than committed: the
  // point is to prove the SCANNER catches an unguarded arrow-form handler, and
  // a fixture living under src/ would either be a real route or a file the
  // sweep above has to be taught to skip. Every course route today uses
  // `export async function`, so without this the widened patterns would be
  // untested code claiming to be a guard.
  const dir = mkdtempSync(join(tmpdir(), "view-as-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const unguarded = join(dir, "route.ts");
  writeFileSync(
    unguarded,
    [
      'import { NextResponse } from "next/server";',
      "",
      "export const POST = async () => {",
      "  return NextResponse.json({ ok: true });",
      "};",
      "",
      "const handleDelete = async () => NextResponse.json({ ok: true });",
      "export { handleDelete as DELETE };",
      "",
    ].join("\n"),
  );
  const source = readFileSync(unguarded, "utf8");
  const handlers = mutatingHandlers(source);
  assert.deepEqual(
    handlers.map((h) => h.method).sort(),
    ["DELETE", "POST"],
    "the arrow-const and aliased-export handler forms must both be detected: " +
      "a route written either way is exactly as capable of writing as the " +
      "member as `export async function POST` is.",
  );
  for (const { method, at } of handlers) {
    assert.equal(
      guardedAt(source, at),
      false,
      `${method} in the fixture calls no guard, so the scan must report it unguarded.`,
    );
  }

  // And the same forms WITH the guard pass, so the check is not just "arrow
  // handlers always fail".
  const guarded = [
    'import { assertNotImpersonating } from "@/lib/firebase/impersonation";',
    "",
    "export const PATCH = async () => {",
    "  const blocked = await assertNotImpersonating();",
    "  if (blocked) return blocked;",
    "  return new Response(null, { status: 204 });",
    "};",
    "",
  ].join("\n");
  const [patch] = mutatingHandlers(guarded);
  assert.equal(patch.method, "PATCH");
  assert.equal(guardedAt(guarded, patch.at), true);

  // A guard call far below the handler is NOT that handler's guard.
  const distant = [
    "export const PUT = async () => {",
    ...Array.from({ length: GUARD_WINDOW_LINES + 4 }, () => "  // filler"),
    "  const blocked = await assertNotImpersonating();",
    "  if (blocked) return blocked;",
    "};",
    "",
  ].join("\n");
  const [put] = mutatingHandlers(distant);
  assert.equal(
    guardedAt(distant, put.at),
    false,
    "the guard has to run BEFORE the handler's other work; a call buried " +
      "further down may sit behind a branch that already wrote something.",
  );
});

test("every allowlisted route still exists and carries a reason", () => {
  for (const entry of ALLOWLIST) {
    assert.equal(
      entry.length,
      2,
      "each ALLOWLIST entry is [path, reason]; an exemption without a stated " +
        "reason is not reviewable.",
    );
    const [path, reason] = entry;
    assert.ok(
      existsSync(join(REPO_ROOT, ...path.split("/"))),
      `${path} is allowlisted but does not exist. Remove the stale entry.`,
    );
    assert.ok(
      typeof reason === "string" && reason.trim().length > 20,
      `${path} needs a real reason, not a placeholder.`,
    );
  }
});

test("the admin view-as start and exit routes are not self-blocked", () => {
  // Starting a view-as session is an admin acting as themselves, and exiting
  // one is the way OUT of the state this guard refuses in. Guarding either
  // would be a lockout: exit in particular would become unreachable the moment
  // the marker is set.
  for (const path of [
    "src/app/api/admin/impersonate/route.ts",
    "src/app/api/admin/impersonate/exit/route.ts",
  ]) {
    const source = readFileSync(join(REPO_ROOT, ...path.split("/")), "utf8");
    assert.ok(
      !GUARD_CALL.test(source),
      `${path} must not call assertNotImpersonating(): the start route runs ` +
        "before any marker exists and the exit route is the only way to clear one.",
    );
    GUARD_CALL.lastIndex = 0;
  }
});

test("assertNotImpersonating refuses with a 403 and honest copy", () => {
  const source = readFileSync(
    join(REPO_ROOT, "src", "lib", "firebase", "impersonation.ts"),
    "utf8",
  );
  assert.match(
    source,
    /export async function assertNotImpersonating\(/,
    "assertNotImpersonating() lives in src/lib/firebase/impersonation.ts, " +
      "beside the marker it reads.",
  );
  assert.match(source, /getImpersonator\(\)/, "it must read the existing marker.");
  assert.match(source, /status: 403/, "a blocked write answers 403.");
  assert.match(
    source,
    /viewing as another member/,
    "the copy must say what happened, not just Forbidden.",
  );
});

// ---------------------------------------------------------------------------
// Live behaviour: what assertNotImpersonating() actually answers
//
// Everything above reads source. These load the module and call it, because
// the stale-marker rule below is a decision no amount of grepping can pin: a
// marker whose actorUid is the CURRENT session's uid means the admin is signed
// in as themselves again (a half-failed start, or a sign-in that never went
// through the exit route). `(app)/layout.tsx` has always suppressed the banner
// on it and POST /api/admin/impersonate self-heals it, so treating it as a
// live session here would have locked an admin out of every high-trust course
// route until they thought to clear a cookie they cannot see.
//
// The module is TypeScript and imports next/headers, next/server and the
// session module, none of which run outside a request, so it is transpiled in
// memory with the `typescript` devDependency (the dance tests/course-window
// .test.mjs explains at length) and those four specifiers are rewritten to
// stubs driven by `harness` below.
// ---------------------------------------------------------------------------

const harness = { cookie: null, user: null, deleted: false };
globalThis.__viewAsGuardHarness = harness;

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "next/headers",
    `const h = globalThis.__viewAsGuardHarness;
     export async function cookies() {
       return {
         get: (name) => (h.cookie === null ? undefined : { name, value: h.cookie }),
         set: (name, value) => { h.cookie = value; },
         delete: () => { h.cookie = null; h.deleted = true; },
       };
     }`,
  ],
  [
    "next/server",
    `export const NextResponse = {
       json: (body, init) => ({ body, status: init?.status ?? 200 }),
     };`,
  ],
  [
    "./session",
    `export async function getCurrentUser() {
       return globalThis.__viewAsGuardHarness.user;
     }`,
  ],
]);

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

async function loadImpersonationModule() {
  let tsc;
  try {
    tsc = (await import("typescript")).default;
  } catch (err) {
    throw new Error(
      "the `typescript` devDependency is not installed. Run `npm install`.",
      { cause: err },
    );
  }
  const file = join(REPO_ROOT, "src", "lib", "firebase", "impersonation.ts");
  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });
  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) => {
      if (!STUBS.has(specifier)) {
        throw new Error(
          `impersonation.ts imports "${specifier}", which this harness has no ` +
            "stub for. Add one, or the guard's behaviour goes untested.",
        );
      }
      return `${prefix}${quote}${dataUrl(STUBS.get(specifier))}${quote}`;
    },
  );
  return import(dataUrl(rewritten));
}

const { assertNotImpersonating, markerIsLive, IMPERSONATION_BLOCKED_MESSAGE } =
  await loadImpersonationModule();

function setState({ marker, uid }) {
  harness.cookie = marker === null ? null : JSON.stringify(marker);
  harness.user = uid === null ? null : { uid, role: "member" };
  harness.deleted = false;
}

const ADMIN_UID = "admin-uid";
const TARGET_UID = "member-uid";
const LIVE_MARKER = {
  actorUid: ADMIN_UID,
  actorName: "An Admin",
  actorEmail: "admin@example.com",
  auditId: "audit-1",
};

test("no marker means no view-as session, so the write proceeds", async () => {
  setState({ marker: null, uid: TARGET_UID });
  assert.equal(await assertNotImpersonating(), null);
});

test("a live marker refuses with 403 and the honest copy", async () => {
  setState({ marker: LIVE_MARKER, uid: TARGET_UID });
  const blocked = await assertNotImpersonating();
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, IMPERSONATION_BLOCKED_MESSAGE);
  assert.equal(
    harness.deleted,
    false,
    "a live marker must survive the guard: the session is still borrowed and " +
      "the banner and the exit route both depend on it.",
  );
});

test("a same-uid marker is stale, not a session: the write proceeds and the cookie is cleared", async () => {
  // The admin is signed in as THEMSELVES with a leftover marker. Refusing here
  // would leave them unable to publish a course, allocate a cohort or send a
  // nudge, with nothing on screen explaining why: the banner is already
  // suppressed in exactly this case.
  setState({ marker: LIVE_MARKER, uid: ADMIN_UID });
  assert.equal(await assertNotImpersonating(), null);
  assert.equal(
    harness.deleted,
    true,
    "the stale marker must be cleared, the same self-heal " +
      "POST /api/admin/impersonate does, so the next request is not asked again.",
  );
});

test("a marker with no session at all still refuses", async () => {
  // No session means nothing can prove the marker stale, and the route is
  // about to 401 anyway. Refusing is the safe reading.
  setState({ marker: LIVE_MARKER, uid: null });
  const blocked = await assertNotImpersonating();
  assert.equal(blocked.status, 403);
});

test("markerIsLive is the one comparison the banner, the gate and the guard share", () => {
  assert.equal(markerIsLive(null, TARGET_UID), false);
  assert.equal(markerIsLive(LIVE_MARKER, TARGET_UID), true);
  assert.equal(markerIsLive(LIVE_MARKER, ADMIN_UID), false);
  assert.equal(markerIsLive(LIVE_MARKER, null), true);
});

test("the admin page tree is closed while a view-as session is live", () => {
  // The course editors under /admin/courses write to Firestore client-direct
  // (courseMutations.ts), so no route handler exists for assertNotImpersonating
  // to sit in. The layout closing the tree is what covers them, and now that a
  // draftCourse holder can reach that tree, an admin viewing as one would
  // otherwise land on the authoring surfaces.
  const layout = readFileSync(
    join(REPO_ROOT, "src", "app", "(app)", "admin", "layout.tsx"),
    "utf8",
  );
  assert.match(
    layout,
    /markerIsLive\(/,
    "(app)/admin/layout.tsx must consult the impersonation marker: the course " +
      "editors below it write client-direct, where the route guard cannot reach.",
  );
  assert.match(
    layout,
    /getImpersonator\(/,
    "(app)/admin/layout.tsx must read the marker it tests.",
  );
});
