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
 * HONEST LIMIT, restated from `assertNotImpersonating()`: the marker is an
 * httpOnly cookie. No page script can remove it, but an admin with devtools
 * open can delete it from their own browser. This enforces intent against
 * accidents, not against an admin who has decided to defeat it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Route trees whose mutating handlers must all be guarded.
 *
 * TODO when those workstreams land: add "src/app/api/admissions" (rounds,
 * stages, apply, review, decide, promote) and "src/app/api/admin/membership"
 * (periods, grants, import, export), plus the CSV export routes, to this list.
 * They are named here rather than pre-registered because a tree that does not
 * exist yet cannot be scanned, and a silently-skipped tree is a hole.
 */
const GUARDED_TREES = ["src/app/api/courses"];

/**
 * Every mutating route in those trees, with the reason it is high-trust.
 * Paths are repo-relative and use forward slashes.
 */
const MUST_GUARD = [
  ["src/app/api/courses/[courseId]/destroy/route.ts", "destroys a course and everything under it"],
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
  ["src/app/api/courses/runs/[runId]/enrolments/[uid]/remove/route.ts", "removes a learner from a run"],
  ["src/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route.ts", "submits a learner's answer in their own name"],
  ["src/app/api/courses/runs/[runId]/material-notes/route.ts", "records feedback attributed to the reader"],
  ["src/app/api/courses/runs/[runId]/normalise-weeks/route.ts", "rewrites every week id on a run"],
  ["src/app/api/courses/runs/[runId]/nudge/route.ts", "sends the weekly nudge email"],
  ["src/app/api/courses/runs/[runId]/roles/route.ts", "grants and revokes staff roles on a run"],
  ["src/app/api/courses/runs/[runId]/status/route.ts", "moves a run along its lifecycle, opening or closing applications"],
  ["src/app/api/courses/runs/[runId]/sync-tasks/route.ts", "creates committee tasks on the board"],
  ["src/app/api/courses/templates/[templateId]/route.ts", "deletes a curriculum template"],
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

const MUTATING_METHOD = /^export async function (POST|PATCH|PUT|DELETE)\s*\(/gm;
const GUARD_CALL = /assertNotImpersonating\(\)/g;

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

function countMatches(source, pattern) {
  return source.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
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
    const handlers = countMatches(source, MUTATING_METHOD);
    const guards = countMatches(source, GUARD_CALL);
    assert.ok(
      handlers > 0,
      `${path} is on the view-as guard list but exports no POST/PATCH/PUT/DELETE. ` +
        "Drop the entry if the route no longer mutates anything.",
    );
    assert.ok(
      guards >= handlers,
      `${path} (${why}) exports ${handlers} mutating handler(s) but calls ` +
        `assertNotImpersonating() ${guards} time(s). Every one of them must ` +
        "refuse during a view-as session, because Firestore would record the " +
        "write as the member, not as the admin who made it.",
    );
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
      if (countMatches(source, MUTATING_METHOD) === 0) continue;
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
