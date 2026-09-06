/**
 * Composite-index guard (run via `npm test`, Node's built-in runner, no
 * emulator, no credentials, no network).
 *
 * WHY THIS EXISTS. The Firestore emulator does not enforce indexes: every
 * query it is handed succeeds, whatever `firestore.indexes.json` says. So the
 * emulator suite in `scripts/rules-tests/` is structurally unable to see a
 * missing index, and the failure mode it cannot see is the worst kind we
 * ship: a `FAILED_PRECONDITION` that appears only in real Firestore, only on
 * the code path that carries the filter, and only after deploy.
 *
 * One such bug landed this month.
 * `collectionGroup("rows").where("matchedUid", "==", uid)` in
 * `src/lib/firestore/accountDeletion.ts` needs the `rows.matchedUid` field
 * override at COLLECTION_GROUP scope, because the automatic single-field
 * indexes Firestore maintains for free are COLLECTION-scoped only.
 * `tests/account-deletion-memberships.test.mjs` pins that one override by
 * hand. This file generalises it: it reads every Firestore query in `src/`
 * and `scripts/`, works out from the documented index rules whether the query
 * needs a declared index, and fails when one is missing.
 *
 * HOW IT WORKS, in three parts.
 *
 *  1. A source scanner walks the trees, resolves collection names and field
 *     names to literals the way `tests/courses-draft-reads.test.mjs` does
 *     (extended to object constants such as `SITE_NOTICE_PATH.collection` and
 *     to chains built up across statements), and produces a query shape per
 *     call site: collection, collection-group flag, filter fields and
 *     operators, orderBy fields and directions.
 *  2. `INDEX_RULES` encodes what Cloud Firestore's current documentation says
 *     about when an index is owed, one entry per rule with the sentence it
 *     came from. Nothing here is written from memory of how Firestore used to
 *     behave; where the docs are silent, the entry says so.
 *  3. The two are matched. A query that needs an index and has none fails the
 *     test, naming the file, the line, the collection, the shape and the JSON
 *     stanza that would satisfy it. A declared index no query matches is
 *     reported as a warning, because a stale index costs storage and write
 *     latency but breaks nothing.
 *
 * SCOPE, and the one deliberate exclusion. `src/` and `scripts/` are both in,
 * client SDK and Admin SDK alike, because an index is a property of the
 * database and does not care which SDK asks. `scripts/rules-tests/` is OUT:
 * that package talks only to the Firestore emulator (see its README), where
 * indexes do not exist and a query that would fail in production passes.
 * `scripts/e2e/` is IN: `scripts/e2e/lib/firestore.mjs` takes its handle from
 * `getFirestore(adminApp())` with no emulator-host branch anywhere in the
 * file, and `scripts/e2e/run.mjs` pins `DEV_PROJECT = "naisi-website-dev"`, so
 * its queries run against a real database with real index requirements.
 *
 * WHAT THIS CANNOT SEE. It reads source text, not a running query planner. A
 * collection name or filter field assembled at runtime is not resolvable by
 * reading the file, so those sites are named in `UNRESOLVED_SITES` with the
 * concrete shapes their callers pass and the reason each is safe. That list is
 * checked in both directions: a new unresolved site with no entry fails, and
 * an entry matching no site fails, so it cannot rot into decoration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The index file under test. Overridable so the guard can be pointed at a
 * doctored COPY to prove it actually fails when an index goes missing: delete
 * a stanza from a copy, run with FIRESTORE_INDEXES_PATH pointing at it, and
 * the query that needed it is named. The real file is never written to.
 */
const INDEXES_PATH =
  process.env.FIRESTORE_INDEXES_PATH ?? join(REPO_ROOT, "firestore.indexes.json");

/** Set to any non-empty value to dump every extracted query shape. */
const DUMP = process.env.FIRESTORE_INDEX_GUARD_DUMP ?? "";

const SCAN_ROOTS = ["src", "scripts"];

/**
 * Directories the walk never enters. `rules-tests` is the emulator package
 * (see the header); the other two are build output and dependencies.
 */
const SKIP_DIRS = new Set(["node_modules", ".next", "rules-tests"]);

/* -------------------------------------------------------------------------
 * 1. The documented rules
 * ---------------------------------------------------------------------- */

/**
 * Firestore's index rules, each with the sentence it was taken from. Fetched
 * from the current documentation rather than recalled, because the two have
 * diverged before (multiple inequality fields were forbidden for years and
 * are not any more).
 *
 * Sources, both fetched 2026-09-06:
 *   [overview] https://firebase.google.com/docs/firestore/query-data/index-overview
 *   [ranges]   https://firebase.google.com/docs/firestore/query-data/multiple-range-fields
 *
 * The table is data, not prose, so `classify()` below can be read against it
 * line by line.
 */
const INDEX_RULES = [
  {
    id: "AUTOMATIC_SINGLE_FIELD",
    says:
      "By default, Cloud Firestore automatically creates single-field indexes for every field " +
      "in a document. For non-array and non-map fields, it creates ascending and descending " +
      "collection-scope indexes. For array fields, it creates ascending, descending, and " +
      "array-contains indexes. Collection group scope automatic indexes are not maintained by " +
      "default.",
    source: "[overview] Index types > Automatic indexes > Automatic index defaults",
    encodedAs:
      "A query constraining exactly one field, at COLLECTION scope, needs no declared index in " +
      "either direction. A map subfield such as `profile.universityEmail` is an ordinary field " +
      "and is auto-indexed the same way.",
  },
  {
    id: "EQUALITY_ONLY_MERGES",
    says:
      "For queries with multiple equality (==) clauses and an optional orderBy clause, Cloud " +
      "Firestore can merge existing indexes for simple equality filters to build the composite " +
      "indexes needed for larger queries.",
    source: "[overview] Indexes and pricing > Use index merging",
    encodedAs:
      "An equality-only query with NO orderBy needs no declared index however many fields it " +
      "filters on: the automatic single-field indexes are merged (confirmed on 2026-09-06 " +
      "against the dev project: `collaborators.where(status ==).where(uid ==)` ran with no " +
      "collaborators index declared at all). The 'optional orderBy' half is " +
      "NOT free, because the indexes being merged then have to be the per-field composites " +
      "{eqField, orderByField}; that case is handled by MERGE_WITH_ORDER_BY below.",
  },
  {
    id: "MERGE_WITH_ORDER_BY",
    says:
      "Cloud Firestore can merge smaller composite indexes to satisfy these compound queries " +
      "without separate dedicated indexes, for the restaurants example where each of " +
      "category / city / editors_pick is combined with orderBy(star_rating).",
    source: "[overview] Indexes and pricing > Use index merging",
    encodedAs:
      "A query with equality filters on fields E1..En plus an orderBy list O is served if a " +
      "declared index {Ei, ...O} exists for EVERY Ei, even when no single index carries all of " +
      "E1..En. Treated as a satisfier, never as a reason to skip the requirement.",
  },
  {
    id: "IN_IS_EQUALITY",
    says:
      "in and == clauses use the same index, shown by the sample pair " +
      "citiesRef.where('country', 'in', ['USA', 'Japan', 'China']).where('population', '>', 690000) " +
      "sitting beside citiesRef.where('country', '==', 'USA').where('population', '>', 690000) " +
      "under one index. Compound equality queries such as " +
      "citiesRef.where('state', '==', 'CO').where('name', '==', 'Denver') need no composite index.",
    source: "[overview] Queries supported by automatic indexes; Queries supported by manual indexes",
    encodedAs: "`in` is classified as an equality filter, not an inequality.",
  },
  {
    id: "ARRAY_CONTAINS_MERGES_BADLY",
    says:
      "To avoid performance loss caused by index merging, we recommend that you create an index " +
      "to combine an array-contains or array-contains-any query with additional clauses.",
    source: "[overview] Queries supported by manual indexes (note)",
    encodedAs:
      "array-contains and array-contains-any DO participate in merging (confirmed on 2026-09-06 " +
      "against the dev project: `tasks.where(completerUids array-contains).where(status ==)` ran " +
      "with no two-field index declared), so combining them with equality filters is a " +
      "performance recommendation rather than a hard requirement, and this guard does not fail " +
      "on it. In a declared index the field carries arrayConfig CONTAINS, " +
      "not an order.",
  },
  {
    id: "ORDER_BY_OTHER_FIELD_NEEDS_COMPOSITE",
    says:
      "citiesRef.where('country', '==', 'USA').orderBy('population', 'asc') requires a composite " +
      "index on the filtered and ordered fields.",
    source: "[overview] Queries supported by manual indexes",
    encodedAs:
      "Any filter combined with an orderBy on a DIFFERENT field requires a composite index " +
      "(or the merge set of MERGE_WITH_ORDER_BY).",
  },
  {
    id: "RANGE_PLUS_OTHER_FIELD_NEEDS_COMPOSITE",
    says:
      "citiesRef.where('country', '==', 'USA').where('population', '<', 3800000) requires a " +
      "composite index. Manual indexes are required when you need to run a compound query that " +
      "uses a range comparison (<, <=, >, or >=) or if you need to sort by a different field.",
    source: "[overview] Queries supported by manual indexes; Manual indexes",
    encodedAs:
      "A range or inequality filter (<, <=, >, >=, !=, not-in) alongside any other constrained " +
      "field requires a composite index.",
  },
  {
    id: "DESCENDING_NEEDS_DESCENDING_INDEX",
    says:
      "citiesRef.where('country', '==', 'USA').orderBy('population', 'desc') requires a composite " +
      "index with the ordering field configured in descending order. By default, inequality " +
      "queries assume ascending sort order unless specified.",
    source: "[overview] Queries supported by manual indexes",
    encodedAs:
      "An index whose direction disagrees with the orderBy direction does not serve the query. " +
      "Equality fields are exempt: 'Ascending and Descending modes support range, equality, and " +
      "comparison operators alongside ascending or descending sorting', so an equality field's " +
      "direction in the index is not checked.",
  },
  {
    id: "INDEX_FIELD_ORDER",
    says:
      "An optimal Cloud Firestore query index is defined by fields used in equality filters, " +
      "sort orders, range and inequality filters not in sort orders, and aggregations. Order: " +
      "equality constraints first, then the range/inequality field, then the ORDER BY clause.",
    source: "[overview] Index properties; [ranges] Index field ordering",
    encodedAs:
      "The canonical field list for a query is: equality (and array-contains) fields in any " +
      "order, then the orderBy fields in their given order, then any inequality field the " +
      "orderBy does not already name (ascending). That is the order the first sentence gives, " +
      "and it is what Firestore itself asks for: a probe of `courseRuns.where(status != draft)" +
      ".orderBy(startDate)` against the dev project on 2026-09-06 failed FAILED_PRECONDITION " +
      "naming (startDate ASC, status ASC, __name__), while the same filter with " +
      "orderBy(status, startDate) was served by the declared (status, startDate). A longer " +
      "index does not serve a shorter query: `tasks.where(visibility ==).orderBy(status)` was " +
      "refused against the declared (visibility, status, dueDate) in the same probe.",
  },
  {
    id: "NAME_IS_IMPLICIT_AND_TRAILS",
    says:
      "Indexes apply a final sorting by the __name__ field of each document. By default it is " +
      "sorted in the same direction of the last sorted field.",
    source: "[overview] Index properties",
    encodedAs:
      "`FieldPath.documentId()` / `documentId()` is the field `__name__`. A trailing orderBy on " +
      "__name__ is dropped from the canonical list, because every index already ends with it. " +
      "Combined with AUTOMATIC_SINGLE_FIELD (which supplies BOTH an ascending and a descending " +
      "single-field index), a query of one equality filter plus orderBy(__name__) in either " +
      "direction is served without a declared index: the descending automatic index carries the " +
      "same pinned prefix with __name__ descending. Confirmed on 2026-09-06 against the dev " +
      "project: `memberships.where(periodId ==).orderBy(__name__, desc)` ran with no such index.",
  },
  {
    id: "COLLECTION_GROUP_SCOPE",
    says:
      "To run a collection group query that returns filtered or ordered results from a collection " +
      "group, you must create a corresponding index with collection group scope. Collection group " +
      "scope automatic indexes are not maintained by default.",
    source: "[overview] Index modes and query scopes; Automatic index defaults",
    encodedAs:
      "ANY filtered or ordered collectionGroup query needs a declaration at COLLECTION_GROUP " +
      "scope, including a single-field one, which is satisfied by a fieldOverrides entry rather " +
      "than a composite. An unfiltered, unordered collectionGroup().get() needs nothing.",
  },
  {
    id: "MULTIPLE_RANGE_FIELDS",
    says:
      "Cloud Firestore limits the number of range or inequality fields to 10. For queries with " +
      "multiple range/inequality filters, the ORDER BY clause of a query determines which indexes " +
      "can be used to serve the query.",
    source: "[ranges] Core rules; Index requirements",
    encodedAs:
      "More than one inequality field is allowed, and always needs a composite index (it is by " +
      "definition more than one constrained field).",
  },
  {
    id: "REVERSE_SCAN",
    says:
      "NOT STATED IN THE CURRENT DOCUMENTATION. The pages above describe direction per index " +
      "field and say in as many words that a descending sort 'requires a composite index with " +
      "the ordering field configured in descending order'; neither page, and neither does the " +
      "Datastore-mode indexes page, says an index may be scanned backwards to serve the exact " +
      "inverse of its declared ordering.",
    source: "(absent from [overview] and [ranges])",
    encodedAs:
      "NOT encoded as a satisfier. An index whose ordered directions are all exactly inverted " +
      "relative to the query does NOT serve it, so such a query lands in the missing list like " +
      "any other and has to be recorded in KNOWN_MISSING_INDEXES with an owner. An earlier draft " +
      "of this guard did treat a reversed index as serving the query, on the argument that " +
      "AUTOMATIC_SINGLE_FIELD maintains every field in both directions. That argument is " +
      "backwards: maintaining both directions is exactly what you do when you CANNOT scan an " +
      "index backwards. The only other support was the comment on the one query it excused, " +
      "which is circular. SETTLED on 2026-09-06 by a read-only probe against the dev project: " +
      "`schedulerMarkers.where(job ==).orderBy(claimedAt, desc)` failed FAILED_PRECONDITION " +
      "asking for (job ASC, claimedAt DESC, __name__ DESC) while the ascending sort was served " +
      "by the declared (job ASC, claimedAt ASC). Firestore does not scan an index backwards.",
  },
];

/** Operator classes. `array-contains-any` and `in` are capped at 30 values by
 *  Firestore; that is a query limit, not an index one, so it is not modelled. */
const EQUALITY_OPS = new Set(["==", "in"]);
const ARRAY_OPS = new Set(["array-contains", "array-contains-any"]);
const INEQUALITY_OPS = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);

/* -------------------------------------------------------------------------
 * 2. Sites the scanner cannot resolve by reading the file
 * ---------------------------------------------------------------------- */

/**
 * Query sites whose collection or filter field is a variable. The scanner
 * cannot know what a caller passes, and a site it cannot read is a site it
 * cannot guard, so each is written down here with the concrete shapes its
 * callers actually produce and why that set is safe.
 *
 * The key is `<file> :: <collection expression>.where(<field>,<op>)...`, taken
 * from the source text rather than a line number so a refactor that moves the
 * function does not silently drop the entry.
 *
 * Checked BOTH ways by `unresolved sites are all registered` below: a new
 * variable-driven query with no entry fails, and an entry that matches no site
 * fails.
 */
const UNRESOLVED_SITES = new Map([
  [
    'src/lib/firestore/accountDeletion.ts :: collection.where(field,"==")',
    {
      why:
        "deleteOwnedCourseRows(db, collection, uid, field) is the account cascade's paging " +
        "delete. Its callers pass (courseApplications | courseProgress | courseExerciseResponses " +
        "| schedulerMarkers, 'uid') and (admissionReviews, 'applicantUid') and " +
        "(admissionReviews, 'reviewerUid'). Every one is a single equality filter with no " +
        "orderBy at collection scope, so AUTOMATIC_SINGLE_FIELD covers all six and no shape here " +
        "can ever owe a composite index. A caller adding a second filter or an orderBy would " +
        "have to edit this function, at which point the shapes below stop describing it.",
      shapes: [
        { collection: "courseApplications", filters: [["uid", "=="]], orders: [] },
        { collection: "courseProgress", filters: [["uid", "=="]], orders: [] },
        { collection: "courseExerciseResponses", filters: [["uid", "=="]], orders: [] },
        { collection: "schedulerMarkers", filters: [["uid", "=="]], orders: [] },
        { collection: "admissionReviews", filters: [["applicantUid", "=="]], orders: [] },
        { collection: "admissionReviews", filters: [["reviewerUid", "=="]], orders: [] },
      ],
    },
  ],
  [
    'src/lib/firestore/courseDeletion.ts :: collection.where("runId","==")',
    {
      why:
        "byRunId(collection) is the run-destroy cascade's query factory: the field and operator " +
        "are literal and only the collection varies. The stage table immediately below it names " +
        "every collection it is called with. All are single-equality, unordered, collection " +
        "scope, so AUTOMATIC_SINGLE_FIELD covers them.",
      shapes: [
        { collection: "courseProgress", filters: [["runId", "=="]], orders: [] },
        { collection: "courseExerciseResponses", filters: [["runId", "=="]], orders: [] },
        { collection: "courseAttendance", filters: [["runId", "=="]], orders: [] },
        { collection: "courseMaterialNotes", filters: [["runId", "=="]], orders: [] },
        { collection: "courseEnrolments", filters: [["runId", "=="]], orders: [] },
        { collection: "courseApplications", filters: [["runId", "=="]], orders: [] },
        { collection: "courseNudges", filters: [["runId", "=="]], orders: [] },
        { collection: "courseAudit", filters: [["runId", "=="]], orders: [] },
        { collection: "courseGroups", filters: [["runId", "=="]], orders: [] },
      ],
    },
  ],
  [
    'src/lib/firestore/emailSends.ts :: "emailSends".where(field,"==")',
    {
      why:
        "markSendStatus() looks a delivery row up by whichever provider id the webhook carried: " +
        "`field` is 'sesMessageId' or 'resendEmailId', chosen three lines above and nowhere else. " +
        "Both are single equality filters with no orderBy, so AUTOMATIC_SINGLE_FIELD covers them.",
      shapes: [
        { collection: "emailSends", filters: [["sesMessageId", "=="]], orders: [] },
        { collection: "emailSends", filters: [["resendEmailId", "=="]], orders: [] },
      ],
    },
  ],
]);

/**
 * Queries this guard says need an index that `firestore.indexes.json` does not
 * declare, RECORDED RATHER THAN FIXED.
 *
 * These are findings, not exemptions. The guard was written as a test-only
 * change, so it may not edit the index file; an entry here is a bug the next
 * person to touch that surface owes an index for, written down so the suite
 * stays honest about what it found instead of going green by pretending it
 * found nothing. `scripts/rules-tests/candidate-findings.test.mjs` records its
 * findings the same way, for the same reason.
 *
 * The list is checked BOTH ways. A new missing index fails outright, and an
 * entry that stops matching a missing query also fails, so the day somebody
 * declares the index (or deletes the query) they are told to delete the entry.
 * Key is `<file> :: <shape>`, with no line number in it, so the entry survives
 * an edit above the query.
 */
const KNOWN_MISSING_INDEXES = new Map([
  [
    'src/app/api/tasks/[id]/send-review-outcome/route.ts :: collection("activity") | kind ==, ' +
      "createdAt >= | orderBy no sort",
    "The review-outcome send scans the task's activity subcollection for subtasks questioned " +
      "during the current review pass: one equality filter on `kind` and a `>=` on `createdAt`, " +
      "two different fields, which is RANGE_PLUS_OTHER_FIELD_NEEDS_COMPOSITE exactly. It owes " +
      "{activity: kind ASC, createdAt ASC} at COLLECTION scope and nothing in " +
      "firestore.indexes.json provides it. Live: the branch runs whenever the block has a " +
      "reviewPassSentAt or sealedAt stamp, which every sealed block has, so the first reviewer " +
      "to press Send review outcome on a sealed block gets a FAILED_PRECONDITION. The emulator " +
      "suite cannot see it and neither can any existing test. CONFIRMED against the dev " +
      "project on 2026-09-06: the same shape on an empty activity subcollection failed " +
      "FAILED_PRECONDITION asking for (kind ASC, createdAt ASC).",
  ],
  [
    'src/app/api/admin/scheduler/route.ts :: collection("schedulerMarkers") | job == | orderBy ' +
      "claimedAt desc",
    "The scheduler job drill-down filters on `job` and sorts `claimedAt` DESCENDING, and the only " +
      "declaration is {schedulerMarkers: job ASCENDING, claimedAt ASCENDING}. The route's own " +
      "comment says that index is 'scanned in reverse', but the documentation says the opposite " +
      "in as many words (a descending sort 'requires a composite index with the ordering field " +
      "configured in descending order') and nowhere states that an index can be walked backwards, " +
      "so this guard refuses to call it served: see the REVERSE_SCAN rule. REFUSED AND REACHABLE. " +
      "Any admin who opens /admin with ?job=<id> on the scheduler panel runs it. CONFIRMED " +
      "against the dev project on 2026-09-06: the query failed FAILED_PRECONDITION asking for " +
      "(job ASC, claimedAt DESC). The fix is to redeclare that index as (job ASCENDING, " +
      "claimedAt DESCENDING); nothing else in the tree touches the pair, so the ascending " +
      "declaration serves no other query.",
  ],
]);

/**
 * Local helpers that hand back a collection reference, so a chain rooted on
 * one is really a chain rooted on `db.collection(<first argument>)`. Named
 * rather than inferred: a wrapper that did something else with its argument
 * would otherwise be silently misread.
 */
const COLLECTION_WRAPPERS = new Map([
  [
    "fixtureQuery",
    "scripts/e2e-fixtures/core.mjs: `fixtureQuery(name)` is `db().collection(name)` behind an " +
      "allow-list assertion, called from the spec modules beside it. The fixtures target the " +
      "real dev project (loadEnv() refuses anything but naisi-website-dev and there is no " +
      "emulator escape hatch), so their queries owe indexes.",
  ],
]);

/* -------------------------------------------------------------------------
 * 3. The source scanner
 * ---------------------------------------------------------------------- */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (/\.(tsx?|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(full) {
  return relative(REPO_ROOT, full).split(sep).join("/");
}

/**
 * Blank out comments while keeping every byte offset, so a line number taken
 * from the stripped text still points at the real line. A `.where(` inside a
 * doc comment (there are several, explaining the queries) must not be scanned
 * as code.
 */
function stripComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let quote = null;
  while (i < n) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < n) out[i] = " ";
      if (i + 1 < n) out[i + 1] = " ";
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Offset of the bracket closing the one at `openIdx`, strings skipped. */
function matchBracket(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an argument list on top-level commas. */
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim() !== "") parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

const QUOTED = /^(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DOTTED = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/**
 * Every `const NAME = "literal"` and every `const OBJ = { key: "literal" }` in
 * the scanned trees, indexed BOTH per file and repo-wide.
 *
 * Repo-wide is needed because collection names are declared in
 * `src/lib/firestore/<collection>.ts` and imported by the file that issues the
 * read, so a per-file map alone would resolve almost nothing. Per file is
 * needed because a repo-wide map alone is a lie: `const COLLECTION` is declared
 * three times in this repo with three different values (`memberConductFlags`,
 * `applicationEmailTemplates`, `subscriptions`), and a flat map hands whichever
 * one the directory walk saw last to every site that mentions the name. That is
 * a guard checking a query against the wrong collection's indexes and saying
 * nothing, which is worse than no guard.
 *
 * So: a same-file declaration always wins; failing that, a repo-wide name wins
 * only if every declaration of it agrees; a name with two different values and
 * no local declaration resolves to `null` and the site has to be registered in
 * UNRESOLVED_SITES. The object form exists for `SITE_NOTICE_PATH.collection`
 * and its neighbours.
 */
const AMBIGUOUS = Symbol("ambiguous constant");

function collectConstants(files) {
  const global = new Map();
  const perFile = new Map();
  const DECL =
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)\s*;/g;
  const OBJECT_DECL =
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{([^{}]*)\}\s*(?:as\s+const\s*)?;/g;
  const PROPERTY = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)/g;
  for (const full of files) {
    const rel = toPosix(full);
    const src = stripComments(readFileSync(full, "utf8"));
    const local = new Map();
    const note = (name, value) => {
      local.set(name, value);
      if (global.has(name) && global.get(name) !== value) global.set(name, AMBIGUOUS);
      else global.set(name, value);
    };
    for (const m of src.matchAll(DECL)) note(m[1], m[2] ?? m[3] ?? m[4]);
    for (const m of src.matchAll(OBJECT_DECL)) {
      for (const p of m[2].matchAll(PROPERTY)) {
        note(`${m[1]}.${p[1]}`, p[2] ?? p[3] ?? p[4]);
      }
    }
    perFile.set(rel, local);
  }
  return { global, perFile };
}

/**
 * What a raw argument names in the file that wrote it, or `null` when that
 * file does not say. `null` is not "harmless": it is reported, and has to be
 * registered in UNRESOLVED_SITES with the shapes its callers pass.
 */
function resolveLiteral(raw, constants, file) {
  const text = String(raw ?? "").trim();
  const quoted = QUOTED.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? "";
  if (IDENTIFIER.test(text) || DOTTED.test(text)) {
    const local = constants.perFile.get(file);
    if (local?.has(text)) return local.get(text);
    const shared = constants.global.get(text);
    if (shared === undefined || shared === AMBIGUOUS) return null;
    return shared;
  }
  return null;
}

/**
 * A field argument, with `FieldPath.documentId()` and the modular
 * `documentId()` folded to the name Firestore itself uses in an index.
 */
function resolveField(raw, constants, file) {
  const text = String(raw ?? "").trim();
  if (/^(?:FieldPath\.)?documentId\s*\(\s*\)$/.test(text)) return "__name__";
  return resolveLiteral(text, constants, file);
}

/** A direction argument. Absent means ascending. */
function resolveDirection(raw, constants, file) {
  if (raw === undefined) return "asc";
  const lit = resolveLiteral(raw, constants, file);
  if (lit === "asc" || lit === "desc") return lit;
  return null;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

const CHAIN_LINK = /^\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

/**
 * Walk `.where(...).orderBy(...).limit(...)` forwards from an offset,
 * accumulating into `state`. Chains in this codebase routinely span five
 * lines, so this is offset-driven rather than line-driven. `limit`,
 * `startAfter`, `select`, `count` and friends are consumed and ignored: none
 * of them changes which index serves the query.
 */
function walkChain(src, from, state) {
  let i = from;
  for (;;) {
    // Skip whitespace to the next real character rather than testing a
    // fixed-width window. `stripComments` blanks comments to spaces, and this
    // codebase puts long comments BETWEEN chain links (the account-deletion
    // sweep has five lines of them between its `.where` and its `.orderBy`), so
    // a window would silently drop the rest of the chain, and a dropped
    // orderBy is a missed index requirement with no output.
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    const link = j < src.length && src[j] === "." ? CHAIN_LINK.exec(src.slice(j, j + 200)) : null;
    if (!link) break;
    const open = j + link[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) break;
    const args = splitArgs(src.slice(open + 1, close));
    if (link[1] === "where") {
      state.filters.push({ fieldRaw: args[0], opRaw: args[1] });
    } else if (link[1] === "orderBy") {
      state.orders.push({ fieldRaw: args[0], dirRaw: args[1] });
    } else if (link[1] === "collection" || link[1] === "collectionGroup") {
      // A path that continues into a subcollection: the tail is the
      // collection the query actually runs against, and anything gathered
      // before it belonged to a different collection.
      state.collectionRaw = args[0];
      state.isGroup = link[1] === "collectionGroup";
      state.filters = [];
      state.orders = [];
      state.at = open;
    }
    i = close + 1;
  }
  state.end = i;
  return state;
}

const NARROW_BOUNDARY = new Set([";", "{", "}", "[", "(", ",", ":"]);
const WIDE_BOUNDARY = new Set([";", "{", "}"]);

/** The name and the offset of the `=` in `<decl> <name> = <chain>`, or null. */
function assignmentIn(src, from, chainStart) {
  const slice = src.slice(from, chainStart);
  // The last real assignment operator in the statement. `==`, `===`, `!=`,
  // `<=`, `>=` and `=>` all contain an `=` and none of them stores anything,
  // so a plain "last = wins" search would read
  // `let query = filter === "orphans" ? coll.where(...)` as an assignment to
  // nothing and lose the orderBy that follows it two lines later.
  let assign = -1;
  for (let k = 0; k < slice.length; k += 1) {
    if (slice[k] !== "=") continue;
    if (slice[k + 1] === "=" || slice[k + 1] === ">") continue;
    if ("=!<>+-*/%&|^".includes(slice[k - 1] ?? "")) continue;
    assign = k;
  }
  if (assign < 0) return null;
  const head = slice.slice(0, assign);
  const at = from + assign;
  const declared = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?\s*$/.exec(head);
  if (declared) return { name: declared[1], at };
  const reassigned = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(head);
  if (reassigned) return { name: reassigned[1], at };
  return null;
}

/**
 * The variable a chain's result is stored in, plus the offset of the `=` that
 * stores it, or null when the chain is used inline.
 *
 * Two scans, narrow then wide, because one boundary set cannot do both jobs.
 * The narrow set stops at a `(`, `[`, `,` or `:` so that
 * `coll.where(...).count().get(),` sitting inside a `Promise.all([...])` is
 * correctly read as assigned to nothing. But those same characters sit between
 * a variable and one branch of a ternary:
 * `let query = a ? coll.where(x) : b.includes(f) ? coll.where(y) : coll` (which
 * is src/app/api/admin/registrations/route.ts) puts a `(` and a `:` in front of
 * the second branch, so the narrow scan reads that branch as inline and drops
 * the `orderBy` chained onto `query` two lines later. Silently dropping a
 * constraint is silently dropping an index requirement, so when the narrow
 * scan finds nothing we widen to the statement itself and try again.
 *
 * The offset is returned so the caller can tell two branches of ONE assignment
 * (same offset: both live, union them) from a genuine reassignment (different
 * offset: the earlier shape is superseded).
 */
function assignmentTarget(src, chainStart) {
  let narrow = chainStart - 1;
  while (narrow >= 0 && !NARROW_BOUNDARY.has(src[narrow])) narrow -= 1;
  const close = assignmentIn(src, narrow + 1, chainStart);
  if (close) return close;
  let wide = chainStart - 1;
  while (wide >= 0 && !WIDE_BOUNDARY.has(src[wide])) wide -= 1;
  return assignmentIn(src, wide + 1, chainStart);
}

function cloneShape(shape) {
  return {
    collectionRaw: shape.collectionRaw,
    isGroup: shape.isGroup,
    filters: shape.filters.map((f) => ({ ...f })),
    orders: shape.orders.map((o) => ({ ...o })),
  };
}

/**
 * Every query shape in one file.
 *
 * Three root forms are recognised, which between them cover every query in
 * the tree:
 *   - Admin SDK, `<anything>.collection(X)` / `.collectionGroup(X)`, including
 *     a chain that starts inside another call such as `countAgg(db.collection
 *     (X).where(...))` and one built inside a transaction.
 *   - a named collection wrapper from COLLECTION_WRAPPERS.
 *   - client SDK, `query(collection(db, X, ...), where(...), orderBy(...))`.
 * Chains rooted on a variable holding one of those are followed afterwards, so
 * `const coll = db.collection(X); let q = coll.where(...); q = q.orderBy(...)`
 * is read as the single query it becomes.
 */
function extractFile(full) {
  const rel = toPosix(full);
  const src = stripComments(readFileSync(full, "utf8"));
  const usesClientSdk = /from "firebase\/firestore"/.test(src);
  const found = [];
  const consumed = [];
  const isConsumed = (i) => consumed.some(([a, b]) => i >= a && i < b);
  /** name -> { shapes, assignAt }: what the variable may hold, and where it
   *  was last written. Two writes at the SAME offset are two branches of one
   *  ternary and both stay live; a write at a new offset replaces. */
  const vars = new Map();
  const setVar = (target, shapes) => {
    const prior = vars.get(target.name);
    const sameStatement = prior && prior.assignAt === target.at;
    vars.set(target.name, {
      shapes: sameStatement ? [...prior.shapes, ...shapes] : shapes,
      assignAt: target.at,
    });
  };
  const record = (shape, extra) => {
    const rec = {
      file: rel,
      line: extra.line,
      ...cloneShape(shape),
      superseded: false,
      spreads: extra.spreads ?? [],
    };
    found.push(rec);
    return rec;
  };

  const wrapperNames = [...COLLECTION_WRAPPERS.keys()].join("|");
  // `(?<!function\s)` keeps the wrapper's own declaration out of the match:
  // `function fixtureQuery(collection)` is where the wrapper is defined, not a
  // place a query is issued.
  const ROOT = new RegExp(
    `(?:\\.\\s*(collection|collectionGroup)|(?<!function\\s)\\b(${wrapperNames}))\\s*\\(`,
    "g",
  );
  for (const m of src.matchAll(ROOT)) {
    if (isConsumed(m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    const args = splitArgs(src.slice(open + 1, close));
    const shape = {
      collectionRaw: m[2] ? args[0] : args[0],
      isGroup: m[1] === "collectionGroup",
      filters: [],
      orders: [],
      at: open,
    };
    walkChain(src, close + 1, shape);
    consumed.push([m.index, shape.end]);
    const rec = record(shape, { line: lineOf(src, shape.at) });
    const target = assignmentTarget(src, m.index);
    if (target) setVar(target, [rec]);
  }

  // Chains rooted on a variable. Three passes, because one variable is commonly
  // derived from another (`const coll = db.collection(X)` then
  // `let query = coll.where(...)` then `query = query.orderBy(...)`).
  //
  // `vars.get(name)` is re-read per match rather than destructured once per
  // pass. A snapshot taken at the top of the pass is a snapshot of the shape
  // BEFORE any of this pass's growth, so `q = q.where(b)` followed by
  // `q = q.orderBy(c)` would grow the second from the pre-`where` shape and
  // drop a constraint, and a dropped constraint is a missed index, which is the
  // one failure this guard exists to prevent.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const name of [...vars.keys()]) {
      const uses = new RegExp(`\\b${name}\\s*\\.\\s*(?:where|orderBy)\\s*\\(`, "g");
      for (const m of src.matchAll(uses)) {
        if (isConsumed(m.index)) continue;
        const bases = vars.get(name)?.shapes ?? [];
        if (bases.length === 0) continue;
        const delta = { collectionRaw: null, isGroup: false, filters: [], orders: [] };
        walkChain(src, m.index + name.length, delta);
        consumed.push([m.index, delta.end]);
        const target = assignmentTarget(src, m.index);
        const grown = bases.map((base) => {
          const shape = cloneShape(base);
          shape.filters.push(...delta.filters);
          shape.orders.push(...delta.orders);
          return record(shape, { line: lineOf(src, m.index) });
        });
        if (target) {
          // The base was an intermediate: only the grown query is ever run.
          for (const base of bases) base.superseded = true;
          setVar(target, grown);
        }
      }
    }
  }

  if (usesClientSdk) {
    for (const m of src.matchAll(/\bquery\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const args = splitArgs(src.slice(open + 1, close));
      if (args.length === 0) continue;
      const head = args[0];
      const rooted = /^(collection|collectionGroup)\s*\(/.exec(head);
      if (!rooted) continue;
      const inner = splitArgs(head.slice(head.indexOf("(") + 1, head.lastIndexOf(")")));
      const shape = {
        // A subcollection path is `collection(db, "a", id, "b")`: the query
        // runs against the LAST segment.
        collectionRaw: inner[inner.length - 1],
        isGroup: rooted[1] === "collectionGroup",
        filters: [],
        orders: [],
      };
      const spreads = [];
      for (const arg of args.slice(1)) {
        if (/^where\s*\(/.test(arg)) {
          const a = splitArgs(arg.slice(arg.indexOf("(") + 1, arg.lastIndexOf(")")));
          shape.filters.push({ fieldRaw: a[0], opRaw: a[1] });
        } else if (/^orderBy\s*\(/.test(arg)) {
          const a = splitArgs(arg.slice(arg.indexOf("(") + 1, arg.lastIndexOf(")")));
          shape.orders.push({ fieldRaw: a[0], dirRaw: a[1] });
        } else if (arg.startsWith("...")) {
          spreads.push(arg.slice(3));
        }
      }
      record(shape, { line: lineOf(src, m.index), spreads });
    }
    // A collectionGroup handed straight to getDocs/onSnapshot with no
    // constraints. Kept because COLLECTION_GROUP_SCOPE turns on filters, and
    // this proves the unfiltered form is recognised rather than missed.
    for (const m of src.matchAll(/\bcollectionGroup\s*\(/g)) {
      if (isConsumed(m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(src, open);
      if (close < 0) continue;
      const inner = splitArgs(src.slice(open + 1, close));
      record(
        {
          collectionRaw: inner[inner.length - 1],
          isGroup: true,
          filters: [],
          orders: [],
        },
        { line: lineOf(src, m.index) },
      );
    }
  }

  return found.filter((r) => !r.superseded);
}

/**
 * Spread constraint arrays, resolved by naming the hook and enumerating what
 * its callers pass. `useTasks` is the only one in the tree.
 */
const SPREAD_SITES = new Map([
  [
    "src/features/tasks/hooks/useTasks.ts::constraints",
    {
      why:
        "useTasks() builds its constraint array from four optional arguments: projectId, " +
        "completerUid, source and visibility. Every combination is enumerated below. The hook " +
        "adds NO orderBy on purpose (the comment above the query says dueDate is sparse and " +
        "updatedAt ordering conflicts with the visibility filter, so it sorts client-side), " +
        "which is what keeps all sixteen combinations equality-only and therefore free under " +
        "EQUALITY_ONLY_MERGES. Adding a server-side sort here would owe an index per combination.",
      combinations: [
        ["projectId", "=="],
        ["completerUids", "array-contains"],
        ["source", "=="],
        ["visibility", "=="],
      ],
    },
  ],
]);

/* -------------------------------------------------------------------------
 * 4. Turning a shape into an index requirement
 * ---------------------------------------------------------------------- */

/**
 * The canonical index for a query, per INDEX_FIELD_ORDER: equality and
 * array-contains fields first (order among them is free), then the inequality
 * field, then the orderBy fields. A trailing orderBy on `__name__` is dropped,
 * per NAME_IS_IMPLICIT_AND_TRAILS.
 */
function canonicalFields(q) {
  // Every stage dedupes on the field path, because an index that names the same
  // field twice is one Firestore rejects, and this function's output is both
  // what `serves()` matches against and what the failure message tells a reader
  // to paste. A query CAN repeat a field: `where("createdAt", ">=", a)
  // .where("createdAt", "<", b)` is one range field written twice, and
  // `where("a", "==", x).orderBy("a")` is an equality field a caller also
  // sorted on (redundant, since an equality pins it to one value, but legal).
  const equalities = [];
  const inequalities = [];
  const equalityPaths = new Set();
  for (const f of q.filters) {
    if (ARRAY_OPS.has(f.op)) {
      if (equalityPaths.has(f.field)) continue;
      equalityPaths.add(f.field);
      equalities.push({ fieldPath: f.field, arrayConfig: "CONTAINS" });
    } else if (EQUALITY_OPS.has(f.op)) {
      if (equalityPaths.has(f.field)) continue;
      equalityPaths.add(f.field);
      equalities.push({ fieldPath: f.field, order: "ANY" });
    } else if (!inequalities.includes(f.field)) {
      inequalities.push(f.field);
    }
  }
  const orders = [];
  const orderPaths = new Set();
  for (const o of q.orders) {
    if (equalityPaths.has(o.field) || orderPaths.has(o.field)) continue;
    orderPaths.add(o.field);
    orders.push({ fieldPath: o.field, order: o.dir === "desc" ? "DESCENDING" : "ASCENDING" });
  }
  while (orders.length > 0 && orders[orders.length - 1].fieldPath === "__name__") orders.pop();
  // INDEX_FIELD_ORDER: explicit sort orders come BEFORE an inequality field
  // the sort does not name. Firestore appends the implicit ordering on that
  // field after the explicit ones, so the index it asks for has the same
  // shape; see the rule for the probe that pinned this.
  const tail = [];
  for (const field of inequalities) {
    if (!orderPaths.has(field)) tail.push({ fieldPath: field, order: "ASCENDING" });
  }
  return [...equalities, ...orders, ...tail];
}

/** Distinct fields the query constrains, filters and sorts together. */
function constrainedFields(q) {
  const set = new Set();
  for (const f of q.filters) set.add(f.field);
  for (const o of q.orders) if (o.field !== "__name__") set.add(o.field);
  return set;
}

/**
 * Does this query need something declared in firestore.indexes.json?
 * Returns { needed: boolean, why: string, ruleId: string }.
 */
function classify(q) {
  const fields = constrainedFields(q);
  const hasInequality = q.filters.some((f) => INEQUALITY_OPS.has(f.op));
  const sortsOnRealField = q.orders.some((o) => o.field !== "__name__");

  if (q.isGroup) {
    if (q.filters.length === 0 && q.orders.length === 0) {
      return {
        needed: false,
        ruleId: "COLLECTION_GROUP_SCOPE",
        why: "unfiltered, unordered collection-group read: nothing to index",
      };
    }
    return {
      needed: true,
      ruleId: "COLLECTION_GROUP_SCOPE",
      why:
        "a collection-group query needs a COLLECTION_GROUP-scoped declaration on every field it " +
        "filters or orders by; the automatic single-field indexes are COLLECTION-scoped only",
    };
  }

  if (fields.size === 0) {
    return { needed: false, ruleId: "NAME_IS_IMPLICIT_AND_TRAILS", why: "no constrained field" };
  }
  if (fields.size === 1) {
    return {
      needed: false,
      ruleId: "AUTOMATIC_SINGLE_FIELD",
      why: "one constrained field, served by the automatic ascending/descending single-field index",
    };
  }
  if (!hasInequality && !sortsOnRealField) {
    // The citation has to match the query. EQUALITY_ONLY_MERGES quotes a
    // sentence about "multiple equality (==) clauses" and says nothing about
    // arrays, so a query whose second field is an array-contains is reported
    // against ARRAY_CONTAINS_MERGES_BADLY, which is the entry that actually
    // covers it (and which says such a query works but is a performance
    // recommendation away from wanting its own index).
    const hasArrayOp = q.filters.some((f) => ARRAY_OPS.has(f.op));
    return hasArrayOp
      ? {
          needed: false,
          ruleId: "ARRAY_CONTAINS_MERGES_BADLY",
          why:
            "array-contains alongside equality filters, no sort: served by merging, though the " +
            "docs recommend a dedicated index for the performance rather than the correctness",
        }
      : {
          needed: false,
          ruleId: "EQUALITY_ONLY_MERGES",
          why: "equality-only with no sort: Firestore merges the automatic single-field indexes",
        };
  }
  if (hasInequality) {
    return {
      needed: true,
      ruleId: "RANGE_PLUS_OTHER_FIELD_NEEDS_COMPOSITE",
      why: "a range or inequality filter alongside another constrained field",
    };
  }
  return {
    needed: true,
    ruleId: "ORDER_BY_OTHER_FIELD_NEEDS_COMPOSITE",
    why: "a filter combined with a sort on a different field",
  };
}

/* -------------------------------------------------------------------------
 * 5. Matching a declared index to a query
 * ---------------------------------------------------------------------- */

function invert(order) {
  return order === "ASCENDING" ? "DESCENDING" : "ASCENDING";
}

/**
 * "exact" | "reversed" | null.
 *
 * "exact" is the only value that means served. "reversed" means the index
 * carries every ordered field in exactly the opposite direction, which WOULD
 * serve the query if Firestore scanned indexes backwards; the documentation
 * does not say it does (see the REVERSE_SCAN rule), so callers treat this as
 * not served and it exists only so the failure message can name the index that
 * is nearly right. Equality fields are excluded from the direction test per
 * DESCENDING_NEEDS_DESCENDING_INDEX.
 */
function serves(index, q) {
  if (index.collectionGroup !== q.collection) return null;
  const wantScope = q.isGroup ? "COLLECTION_GROUP" : "COLLECTION";
  if ((index.queryScope ?? "COLLECTION") !== wantScope) return null;

  const want = canonicalFields(q);
  const have = (index.fields ?? []).filter((f) => f.fieldPath !== "__name__");
  if (have.length !== want.length) return null;

  const equalityCount = want.filter((f) => f.order === "ANY" || f.arrayConfig).length;
  const wantHead = want.slice(0, equalityCount);
  const haveHead = have.slice(0, equalityCount);
  const key = (f) => `${f.fieldPath}|${f.arrayConfig ? `ARRAY:${f.arrayConfig}` : "ORDER"}`;
  const headWanted = wantHead.map(key).sort();
  const headHave = haveHead.map(key).sort();
  if (headWanted.join(",") !== headHave.join(",")) return null;

  const wantTail = want.slice(equalityCount);
  const haveTail = have.slice(equalityCount);
  let exact = true;
  let reversed = true;
  for (let i = 0; i < wantTail.length; i += 1) {
    const w = wantTail[i];
    const h = haveTail[i];
    if (!h || h.fieldPath !== w.fieldPath) return null;
    if (h.arrayConfig || !w.order) return null;
    if (h.order !== w.order) exact = false;
    if (h.order !== invert(w.order)) reversed = false;
  }
  if (exact) return "exact";
  if (reversed) return "reversed";
  return null;
}

/**
 * MERGE_WITH_ORDER_BY: an equality-plus-sort query is also served when a
 * {equalityField, ...sort} index exists for every equality field.
 */
function servedByMerge(indexes, q) {
  if (q.isGroup) return false;
  if (q.filters.some((f) => INEQUALITY_OPS.has(f.op))) return false;
  if (q.orders.length === 0) return false;
  const equalityFields = q.filters.map((f) => f.field);
  if (equalityFields.length < 2) return false;
  return equalityFields.every((field) =>
    indexes.some(
      (index) =>
        serves(index, {
          ...q,
          filters: q.filters.filter((f) => f.field === field),
        }) === "exact",
    ),
  );
}

/** The stanza that would satisfy a query, ready to paste. */
function stanzaFor(q) {
  const fields = canonicalFields(q).map((f) =>
    f.arrayConfig
      ? { fieldPath: f.fieldPath, arrayConfig: f.arrayConfig }
      : { fieldPath: f.fieldPath, order: f.order === "ANY" ? "ASCENDING" : f.order },
  );
  return JSON.stringify(
    {
      collectionGroup: q.collection,
      queryScope: q.isGroup ? "COLLECTION_GROUP" : "COLLECTION",
      fields,
    },
    null,
    2,
  );
}

function describe(q) {
  const filters = q.filters.map((f) => `${f.field} ${f.op}`).join(", ") || "no filter";
  const orders = q.orders.map((o) => `${o.field} ${o.dir}`).join(", ") || "no sort";
  return `${q.isGroup ? "collectionGroup" : "collection"}("${q.collection}") | ${filters} | orderBy ${orders}`;
}

/* -------------------------------------------------------------------------
 * 6. Build the model once, share it across the tests
 * ---------------------------------------------------------------------- */

function buildModel() {
  const files = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));
  const constants = collectConstants(files);
  const raw = files.flatMap((f) => extractFile(f));

  const resolved = [];
  const unresolved = [];
  for (const rec of raw) {
    const collection = resolveLiteral(rec.collectionRaw, constants, rec.file);
    const filters = rec.filters.map((f) => ({
      field: resolveField(f.fieldRaw, constants, rec.file),
      op: resolveLiteral(f.opRaw, constants, rec.file),
      fieldRaw: String(f.fieldRaw ?? "").trim(),
      opRaw: String(f.opRaw ?? "").trim(),
    }));
    const orders = rec.orders.map((o) => ({
      field: resolveField(o.fieldRaw, constants, rec.file),
      dir: resolveDirection(o.dirRaw, constants, rec.file),
      fieldRaw: String(o.fieldRaw ?? "").trim(),
    }));
    const broken =
      collection === null ||
      filters.some((f) => f.field === null || f.op === null) ||
      orders.some((o) => o.field === null || o.dir === null);
    const base = { file: rec.file, line: rec.line, isGroup: rec.isGroup, spreads: rec.spreads };
    // A bare `.collection(x)` with nothing chained onto it is a path, not a
    // query: it owes no index whatever `x` turns out to be, so an unreadable
    // name there is not a hole. Only a site that actually filters, sorts or
    // spans a collection group has to be registered.
    const isQuery = filters.length > 0 || orders.length > 0 || rec.isGroup;
    if (broken && !isQuery) continue;
    if (broken) {
      const shape =
        `${rec.collectionRaw}` +
        filters.map((f) => `.where(${f.fieldRaw},${f.opRaw})`).join("") +
        orders.map((o) => `.orderBy(${o.fieldRaw})`).join("");
      unresolved.push({ ...base, key: `${rec.file} :: ${shape}`, collection, filters, orders });
      continue;
    }
    if (rec.spreads.length > 0) {
      const key = `${rec.file}::${rec.spreads[0]}`;
      const site = SPREAD_SITES.get(key);
      if (!site) {
        unresolved.push({
          ...base,
          key,
          collection,
          filters,
          orders,
          spread: true,
        });
        continue;
      }
      // Every subset of the optional constraints is a query a caller can run.
      const combos = site.combinations;
      for (let mask = 0; mask < 1 << combos.length; mask += 1) {
        const chosen = combos.filter((_, i) => (mask >> i) & 1);
        resolved.push({
          ...base,
          collection,
          filters: [
            ...filters,
            ...chosen.map(([field, op]) => ({ field, op, fieldRaw: field, opRaw: op })),
          ],
          orders,
          via: key,
        });
      }
      continue;
    }
    resolved.push({ ...base, collection, filters, orders });
  }

  // Registered variable-driven sites contribute their concrete shapes.
  for (const [key, entry] of UNRESOLVED_SITES) {
    const site = unresolved.find((u) => u.key === key);
    if (!site) continue;
    for (const shape of entry.shapes) {
      resolved.push({
        file: site.file,
        line: site.line,
        isGroup: site.isGroup,
        collection: shape.collection,
        filters: shape.filters.map(([field, op]) => ({ field, op, fieldRaw: field, opRaw: op })),
        orders: (shape.orders ?? []).map(([field, dir]) => ({ field, dir, fieldRaw: field })),
        via: key,
      });
    }
  }

  const declared = JSON.parse(readFileSync(INDEXES_PATH, "utf8"));
  const indexes = declared.indexes ?? [];
  const overrides = [];
  for (const o of declared.fieldOverrides ?? []) {
    for (const idx of o.indexes ?? []) {
      overrides.push({
        collectionGroup: o.collectionGroup,
        queryScope: idx.queryScope ?? "COLLECTION",
        fields: [
          idx.arrayConfig
            ? { fieldPath: o.fieldPath, arrayConfig: idx.arrayConfig }
            : { fieldPath: o.fieldPath, order: idx.order },
        ],
        isOverride: true,
        label: `fieldOverride ${o.collectionGroup}.${o.fieldPath} (${idx.queryScope ?? "COLLECTION"})`,
      });
    }
  }
  const servable = [
    ...indexes.map((index, i) => ({
      ...index,
      label:
        `indexes[${i}] ${index.collectionGroup} (${index.queryScope}) ` +
        (index.fields ?? [])
          .map((f) => `${f.fieldPath} ${f.arrayConfig ?? f.order}`)
          .join(", "),
    })),
    ...overrides,
  ];

  return { resolved, unresolved, indexes, overrides, servable, constants };
}

const MODEL = buildModel();

/* -------------------------------------------------------------------------
 * 7. The tests
 * ---------------------------------------------------------------------- */

test("every query that needs an index has one declared", () => {
  const missing = [];
  const mergeOnly = [];
  for (const q of MODEL.resolved) {
    const verdict = classify(q);
    if (!verdict.needed) continue;
    let exact = null;
    let reversed = null;
    for (const index of MODEL.servable) {
      const how = serves(index, q);
      if (how === "exact") {
        exact = index;
        break;
      }
      if (how === "reversed" && !reversed) reversed = index;
    }
    if (exact) continue;
    if (servedByMerge(MODEL.servable, q)) {
      mergeOnly.push(q);
      continue;
    }
    // A reversed index does NOT rescue the query: the docs say a descending
    // sort needs a descending index field and never mention scanning an index
    // backwards, so this counts as missing and is named as missing. The
    // near-miss is carried along only so the message can say which declaration
    // is one direction away from serving it.
    missing.push({ q, verdict, reversed, key: `${q.file} :: ${describe(q)}` });
  }

  const recorded = missing.filter((m) => KNOWN_MISSING_INDEXES.has(m.key));
  const unrecorded = missing.filter((m) => !KNOWN_MISSING_INDEXES.has(m.key));
  const fixed = [...KNOWN_MISSING_INDEXES.keys()].filter(
    (key) => !missing.some((m) => m.key === key),
  );

  if (mergeOnly.length > 0) {
    console.log(
      `\n[firestore-indexes] served by MERGE_WITH_ORDER_BY rather than a single index:\n` +
        mergeOnly.map((q) => `  - ${q.file}:${q.line} ${describe(q)}`).join("\n"),
    );
  }

  if (recorded.length > 0) {
    console.log(
      `\n[firestore-indexes] KNOWN MISSING, recorded in KNOWN_MISSING_INDEXES rather than fixed ` +
        `here (this guard is a test-only change and may not edit the index file):\n` +
        recorded
          .map(
            ({ q, reversed }) =>
              `  - ${q.file}:${q.line} ${describe(q)}` +
              (reversed ? `\n      nearest declaration, wrong direction: ${reversed.label}` : "") +
              `\n${stanzaFor(q)}`,
          )
          .join("\n"),
    );
  }

  assert.deepEqual(
    fixed,
    [],
    "These entries in KNOWN_MISSING_INDEXES no longer describe a query that is missing an " +
      "index, so either the index was declared or the query was changed. Delete the entries:\n\n  " +
      fixed.join("\n  "),
  );

  assert.deepEqual(
    unrecorded.map(({ q, verdict }) => `${q.file}:${q.line} ${describe(q)} [${verdict.ruleId}]`),
    [],
    `These queries need an index that ${INDEXES_PATH} does not declare. In real ` +
      `Firestore each one fails with FAILED_PRECONDITION; the emulator will not show you this.\n\n` +
      unrecorded
        .map(
          ({ q, verdict, reversed }) =>
            `${q.file}:${q.line}\n  collection: ${q.collection}\n  shape: ${describe(q)}\n` +
            `  rule: ${verdict.ruleId} (${verdict.why})\n` +
            (reversed
              ? `  nearest declaration, every sort direction inverted: ${reversed.label}\n`
              : "") +
            `  add to firestore.indexes.json:\n` +
            stanzaFor(q)
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n"),
        )
        .join("\n\n"),
  );
});

test("the membership import row sweep's collection-group query has its field override", () => {
  // The bug this whole file generalises. `matchedUid` is indexed automatically
  // at COLLECTION scope on every `rows` subcollection, and that automatic
  // index does nothing for a query that spans them all, so the sweep needs the
  // fieldOverrides entry at COLLECTION_GROUP scope.
  const sweep = MODEL.resolved.find(
    (q) =>
      q.file === "src/lib/firestore/accountDeletion.ts" &&
      q.isGroup &&
      q.collection === "rows" &&
      q.filters.length === 1 &&
      q.filters[0].field === "matchedUid",
  );
  assert.ok(
    sweep,
    "collectionGroup('rows').where('matchedUid', '==', uid) is no longer in " +
      "src/lib/firestore/accountDeletion.ts. If the sweep moved, move this test with it; if it " +
      "was deleted, the rows.matchedUid fieldOverride can go too.",
  );
  assert.equal(sweep.filters[0].op, "==");

  const verdict = classify(sweep);
  assert.equal(
    verdict.needed,
    true,
    "the encoding must classify a filtered collection-group query as needing a declaration",
  );
  assert.equal(verdict.ruleId, "COLLECTION_GROUP_SCOPE");

  const override = MODEL.overrides.find(
    (o) =>
      o.collectionGroup === "rows" &&
      o.queryScope === "COLLECTION_GROUP" &&
      o.fields[0].fieldPath === "matchedUid",
  );
  assert.ok(
    override,
    "firestore.indexes.json has no fieldOverrides entry for rows.matchedUid at " +
      "COLLECTION_GROUP scope. Without it the account-deletion sweep over membership import rows " +
      "fails with FAILED_PRECONDITION in real Firestore, which is exactly the production bug " +
      "this guard exists to prevent.",
  );
  assert.equal(
    serves(override, sweep),
    "exact",
    "the rows.matchedUid override must be what serves the sweep",
  );

  // And nothing else does: a COLLECTION-scoped index cannot serve it.
  const collectionScoped = MODEL.servable.filter(
    (i) => i.collectionGroup === "rows" && (i.queryScope ?? "COLLECTION") === "COLLECTION",
  );
  for (const index of collectionScoped) {
    assert.equal(
      serves(index, sweep),
      null,
      `${index.label} must not be treated as serving a COLLECTION_GROUP query`,
    );
  }
});

test("unresolved sites are all registered, and every registration matches a site", () => {
  const seen = MODEL.unresolved.map((u) => u.key);
  const unregistered = MODEL.unresolved
    .filter((u) => !UNRESOLVED_SITES.has(u.key) && !SPREAD_SITES.has(u.key))
    .map((u) => `${u.file}:${u.line}  ${u.key}`)
    .sort();
  assert.deepEqual(
    unregistered,
    [],
    "These query sites build their collection name, filter field or constraint list at runtime, " +
      "so this guard cannot tell what they ask Firestore for. Add each to UNRESOLVED_SITES (or " +
      "SPREAD_SITES) with the concrete shapes its callers pass and why that set is safe:\n\n  " +
      unregistered.join("\n  "),
  );

  const stale = [...UNRESOLVED_SITES.keys(), ...SPREAD_SITES.keys()]
    .filter((key) => !seen.includes(key) && !MODEL.resolved.some((r) => r.via === key))
    .sort();
  assert.deepEqual(
    stale,
    [],
    "These registry entries match no query in the tree any more. Delete them so the list keeps " +
      "meaning something:\n\n  " + stale.join("\n  "),
  );
});

test("every registered site carries a reason, not a placeholder", () => {
  for (const [key, entry] of UNRESOLVED_SITES) {
    assert.ok(
      entry.why.length > 80,
      `${key} needs a real reason: name the callers and say why their shapes owe no index.`,
    );
    assert.ok(entry.shapes.length > 0, `${key} registers no concrete shape.`);
  }
  for (const [key, entry] of SPREAD_SITES) {
    assert.ok(
      entry.why.length > 80,
      `${key} needs a real reason: name the callers and the combinations they produce.`,
    );
  }
  for (const [name, why] of COLLECTION_WRAPPERS) {
    assert.ok(why.length > 80, `the ${name} wrapper needs a reason naming the file and the target.`);
  }
  for (const [key, why] of KNOWN_MISSING_INDEXES) {
    assert.ok(
      why.length > 120,
      `${key} needs a reason a reader can act on: which index is owed, and who hits the failure.`,
    );
  }
});

test("every encoded rule cites the sentence it came from", () => {
  assert.ok(INDEX_RULES.length >= 12, "the rule table has lost entries");
  for (const rule of INDEX_RULES) {
    assert.ok(rule.id && rule.says && rule.source && rule.encodedAs, `${rule.id} is incomplete`);
    assert.ok(
      rule.says.length > 40,
      `${rule.id} quotes too little of the documentation to be checkable`,
    );
  }
  // The one rule that is NOT from the docs must say so in as many words, so a
  // reader never mistakes it for a citation.
  const reverse = INDEX_RULES.find((r) => r.id === "REVERSE_SCAN");
  assert.match(reverse.says, /NOT STATED/);
});

test("declared indexes that no query uses are listed as a warning, never a failure", () => {
  const unused = [];
  for (const index of MODEL.servable) {
    const used = MODEL.resolved.some((q) => serves(index, q) !== null);
    if (!used) unused.push(index.label);
  }
  if (unused.length > 0) {
    console.log(
      `\n[firestore-indexes] declared but matched by no query in the tree (${unused.length} of ` +
        `${MODEL.servable.length}). A stale index costs storage and write latency but breaks ` +
        `nothing, so this is a warning: check each against removed code before deleting it.\n` +
        unused.map((l) => `  - ${l}`).join("\n"),
    );
  }
  // Warning only, deliberately: see the header. The assertion is that the
  // check ran and produced a list, not that the list is empty.
  assert.ok(Array.isArray(unused));
});

test("the scan actually saw the tree", () => {
  // A scanner that silently stops matching would make every other test in this
  // file pass vacuously, which is the classic way a guard rots.
  assert.ok(
    MODEL.resolved.length > 150,
    `only ${MODEL.resolved.length} query shapes were extracted; the scanner has probably stopped ` +
      "matching a chain form it used to read",
  );
  const collections = new Set(MODEL.resolved.map((q) => q.collection));
  for (const expected of [
    "users",
    "tasks",
    "eventRsvps",
    "subscriptions",
    "courseEnrolments",
    "admissionApplications",
    "schedulerMarkers",
    "rows",
  ]) {
    assert.ok(collections.has(expected), `no query against ${expected} was found`);
  }
  // A name declared in several files must resolve per file. `const COLLECTION`
  // is the live example: three declarations, three values, and a repo-wide map
  // hands the last one the walk saw to all three call sites. That failure is
  // invisible (the guard checks a real query against another collection's
  // indexes and passes), so it is pinned here rather than left to review.
  const conductFlags = MODEL.resolved.filter(
    (q) => q.file === "src/app/api/admin/members/[uid]/conduct-flag/route.ts",
  );
  assert.ok(
    conductFlags.some((q) => q.collection === "memberConductFlags"),
    "the conduct-flag route's `const COLLECTION` no longer resolves to memberConductFlags",
  );
  assert.ok(
    !conductFlags.some((q) => q.collection === "subscriptions"),
    "a constant declared in several files is resolving to another file's value: the conduct-flag " +
      "route reads memberConductFlags, and src/lib/firestore/subscriptions.ts declares the same " +
      "name as `subscriptions`",
  );

  assert.ok(
    MODEL.resolved.some((q) => q.file.startsWith("scripts/")),
    "no query under scripts/ was found, but the e2e fixtures and the auth harness both " +
      "query a real project",
  );

  if (DUMP) {
    for (const q of MODEL.resolved) {
      console.log(`${q.file}:${q.line} ${describe(q)} -> ${classify(q).ruleId}`);
    }
  }
});
