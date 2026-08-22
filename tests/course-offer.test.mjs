/**
 * Unit tests for the COURSE OFFER — the state a member is in between "you're
 * in" and "here is your group".
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Accepting an application deliberately mints no enrolment: the seat is
 * created when allocation PUBLISHES, which is hours later at best. Until this
 * change, `/api/courses/me` listed runs from enrolments and the run's role
 * arrays only, so for that whole window an accepted member held no row in
 * anything the hub read — `/learn` told them "You're not on a course yet", the
 * dashboard card disappeared, and the public course page told them
 * applications were closed. The only thing on the whole site that said
 * otherwise was an email already in their inbox.
 *
 * `membershipFor` is the rule that closes it, and two of its three clauses are
 * only correct because of something written in a different file:
 *
 *  1. **A spent offer must not be re-announced.** The remove route flips the
 *     enrolment to `removed` and deliberately does NOT touch the application
 *     (`src/app/api/courses/runs/[runId]/enrolments/[uid]/remove/route.ts`
 *     rewinds nothing — it only writes the enrolment and the group counter).
 *     So a member who was accepted, placed, and then removed keeps an
 *     `accepted` application FOREVER. Read the application alone and the hub
 *     tells someone who has just been taken off a course that they are on it
 *     and their group is coming. Nothing type-checks that; a test has to.
 *  2. **Only `accepted` and `waitlisted` are offers.** `pending` is not news
 *     and belongs to the apply page's own status card; `rejected` and
 *     `withdrawn` are answers the member already has, and re-announcing them
 *     on the hub every time they open it would be cruel as well as wrong.
 *
 * The matrix below is exhaustive over (enrolment state × application status),
 * which is 5 × 3 + the never-applied column — small enough to enumerate, so
 * there is no room for a case to be "obviously fine" and untested.
 *
 * ## Two things the source itself is asserted on
 *
 * `membershipFor` is pure and cheap to test; the two properties that guard the
 * member's PRIVACY are not reachable from it, because they live in the shape
 * of the route's Firestore reads. Both are pinned by reading the route source:
 *
 *  - the `courseApplications` query is scoped to the caller's own uid, so the
 *    hub can never see another applicant's row;
 *  - the enrolment probe behind an offer is ADDRESSED via `courseEnrolmentId`,
 *    never queried, so it cannot be widened into a scan of anyone else's seats.
 *
 * ## Why the loader dance
 *
 * Same root cause as `course-nudge.test.mjs`: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module graph is transpiled in
 * memory with the `typescript` devDependency `npx tsc --noEmit` already uses.
 * The transpile path is taken unconditionally rather than as a fallback,
 * because the module under test is an API route: on a Node new enough to
 * import `.ts` directly, a native import would bypass the rewrites and load
 * `server-only` (which throws by design outside a React Server Component
 * graph) plus the Admin SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const ME_ROUTE = join(SRC, "app", "api", "courses", "me", "route.ts");

/**
 * Every module specifier in transpiled output: `from "x"`, `import "x"` and
 * `import("x")`, in either quote style. Deliberately a regex over the OUTPUT
 * rather than a TypeScript AST walk — by that point the type-only imports are
 * already gone and what is left is plain ES module syntax.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module, and why each one is safe to
 * replace. NOTHING BELOW IS REACHABLE FROM AN ASSERTION IN THIS FILE: the only
 * export exercised is `membershipFor`, which is pure and touches neither the
 * database nor the request. `GET` is never called.
 */
const STUBS = new Map([
  // Throws by design when imported outside a React Server Component graph.
  // Its real job is a build-time guard, and there is no build here.
  ["server-only", "export {};"],
  // Next's server runtime. Only `GET` builds a response.
  [
    "next/server",
    "export const NextResponse = {\n" +
      "  json() {\n" +
      "    throw new Error('NextResponse is stubbed in tests');\n  },\n};",
  ],
  // The Admin SDK handle. Only `GET` opens a connection, and a unit test must
  // not reach a real Firestore.
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() {\n" +
      "  throw new Error('getAdminDb is stubbed in tests');\n}",
  ],
  // Reads the session cookie via `next/headers`, which needs a request scope.
  [
    "@/lib/firebase/session",
    "export function getCurrentUser() {\n" +
      "  throw new Error('getCurrentUser is stubbed in tests');\n}",
  ],
]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** file path (or stub key) → data: URL of its module source. Memoised. */
const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      // A package. `import.meta.resolve` is the runtime's own resolver, so this
      // is exactly the file the app would have loaded.
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(file) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed — run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(file));
}

const { membershipFor } = await loadTs(ME_ROUTE);
const { COURSE_APPLICATION_STATUSES } = await loadTs(
  join(SRC, "lib", "firestore", "courseApplications.ts"),
);

const ME_SOURCE = readFileSync(ME_ROUTE, "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** No enrolment document at all — the state an offer lives in. */
const NO_SEAT = { hasLiveEnrolment: false, hasEnrolmentDoc: false };
/** `active` or `completed` — a real place on the run. */
const LIVE_SEAT = { hasLiveEnrolment: true, hasEnrolmentDoc: true };
/** `withdrawn` or `removed` — a seat document that is no longer a seat. */
const SPENT_SEAT = { hasLiveEnrolment: false, hasEnrolmentDoc: true };

const SEATS = [
  ["no enrolment", NO_SEAT],
  ["a live enrolment", LIVE_SEAT],
  ["a withdrawn/removed enrolment", SPENT_SEAT],
];

const membership = (seat, applicationStatus) =>
  membershipFor({ ...seat, applicationStatus });

// ---------------------------------------------------------------------------
// The reported bug: accepted, not yet allocated
// ---------------------------------------------------------------------------

test("an accepted applicant with no enrolment yet is OFFERED, not invisible", () => {
  // The exact window the owner hit: admissions pressed Accept, the acceptance
  // email went out, allocation has not been published, so no `courseEnrolments`
  // row exists anywhere. Before this rule the hub had nothing to render and
  // said "You're not on a course yet".
  assert.equal(membership(NO_SEAT, "accepted"), "offered");
});

test("a waitlisted applicant gets their own state, never the accepted one", () => {
  // Same absence of a seat, a materially different sentence to read. Folding
  // the two together would tell someone on the waitlist that they are in.
  assert.equal(membership(NO_SEAT, "waitlisted"), "waitlisted");
});

// ---------------------------------------------------------------------------
// The rule that needs the test: a spent offer
// ---------------------------------------------------------------------------

test("a removed member is NOT re-offered their old place", () => {
  // The remove route writes the enrolment and nothing else, so the application
  // still reads `accepted` for the rest of time. The enrolment document is the
  // record of what happened LAST; the application is what happened FIRST.
  assert.equal(membership(SPENT_SEAT, "accepted"), "none");
  assert.equal(membership(SPENT_SEAT, "waitlisted"), "none");
});

test("a live enrolment outranks the application it came from", () => {
  // Every enrolled member on an admissions-run course still owns an `accepted`
  // application. If the application were consulted first, allocation
  // publishing would DOWNGRADE them from enrolled to offered.
  assert.equal(membership(LIVE_SEAT, "accepted"), "enrolled");
  // ...and a run they were enrolled onto directly, with no application at all.
  assert.equal(membership(LIVE_SEAT, null), "enrolled");
});

// ---------------------------------------------------------------------------
// Which statuses are an offer
// ---------------------------------------------------------------------------

test("only accepted and waitlisted are offers — the rest are silence", () => {
  // `pending` belongs to the apply page's status card (the run is by
  // definition still open, so that card is still reachable). `rejected` and
  // `withdrawn` are answers the member already has.
  for (const status of ["pending", "rejected", "withdrawn"]) {
    assert.equal(
      membership(NO_SEAT, status),
      "none",
      `${status} must not reach the hub as a membership`,
    );
  }
  assert.equal(membership(NO_SEAT, null), "none");
});

test("the offer vocabulary is the applications collection's own", () => {
  // Reusing `CourseApplicationStatus` rather than inventing a parallel set is
  // what stops the hub and the admissions queue drifting apart. If a status is
  // ever added there, this fails until someone decides what the hub says about
  // it.
  assert.deepEqual(COURSE_APPLICATION_STATUSES, [
    "pending",
    "accepted",
    "waitlisted",
    "rejected",
    "withdrawn",
  ]);
});

// ---------------------------------------------------------------------------
// Exhaustive matrix — every (seat, application status) pair
// ---------------------------------------------------------------------------

test("every (enrolment state, application status) pair resolves as intended", () => {
  /** seat label → application status → expected membership. */
  const expected = {
    "no enrolment": {
      pending: "none",
      accepted: "offered",
      waitlisted: "waitlisted",
      rejected: "none",
      withdrawn: "none",
      null: "none",
    },
    "a live enrolment": {
      pending: "enrolled",
      accepted: "enrolled",
      waitlisted: "enrolled",
      rejected: "enrolled",
      withdrawn: "enrolled",
      null: "enrolled",
    },
    "a withdrawn/removed enrolment": {
      pending: "none",
      accepted: "none",
      waitlisted: "none",
      rejected: "none",
      withdrawn: "none",
      null: "none",
    },
  };

  for (const [label, seat] of SEATS) {
    for (const status of [...COURSE_APPLICATION_STATUSES, null]) {
      assert.equal(
        membership(seat, status),
        expected[label][String(status)],
        `${label} + application ${String(status)}`,
      );
    }
  }
});

test("every membership the hub can return is one of the four wire values", () => {
  const allowed = new Set(["enrolled", "offered", "waitlisted", "none"]);
  for (const [, seat] of SEATS) {
    for (const status of [...COURSE_APPLICATION_STATUSES, null]) {
      assert.ok(
        allowed.has(membership(seat, status)),
        `unexpected membership for ${JSON.stringify({ ...seat, status })}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Privacy properties, pinned against the route source
// ---------------------------------------------------------------------------

test("the applications query is scoped to the caller's own uid", () => {
  // The hub has no uid parameter and must never grow one. An application query
  // that is not uid-equality is a list of other people's applications.
  const query = ME_SOURCE.match(
    /\.collection\("courseApplications"\)([\s\S]*?)\.get\(\)/,
  );
  assert.ok(query, "the /me route no longer queries courseApplications at all");
  assert.match(query[1], /\.where\("uid", "==", actor\.uid\)/);
  // Exactly one clause, and it is that one: a second `where` on a field other
  // than uid would be fine, but one that replaces the uid scope would not, so
  // the assertion is that every `where` in the query names uid.
  for (const [, field] of query[1].matchAll(/\.where\(\s*"([^"]+)"/g)) {
    assert.equal(field, "uid", `courseApplications query filters on ${field}`);
  }
});

test("the offer's enrolment probe is addressed, never queried", () => {
  // `courseEnrolmentId(runId, uid)` binds the pair, so there is no way to
  // spell another member's seat. A `.where("runId", ...)` here would return
  // the whole cohort's enrolments to any applicant.
  assert.match(
    ME_SOURCE,
    /courseEnrolmentId\(\s*id,\s*actor\.uid\s*\)/,
    "the enrolment probe must be addressed by (run, uid)",
  );
});

test("nothing but runId and status is read off an application", () => {
  // The row carries the applicant's email, their free-text answers and the
  // reviewer's notes. None of it belongs on a hub payload, and the cheapest
  // guarantee of that is that the route never touches the fields at all.
  const fields = new Set(
    [...ME_SOURCE.matchAll(/\bapp\.([A-Za-z0-9_]+)/g)].map(([, field]) => field),
  );
  assert.deepEqual(
    [...fields].sort(),
    ["runId", "status", "uid"],
    "an application field beyond (uid, runId, status) is being read",
  );
});
