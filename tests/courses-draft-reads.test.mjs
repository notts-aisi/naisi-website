/**
 * Guard for the V3 W3 PR20 draft-read narrowing (run via `npm test`, Node's
 * built-in runner, no dependencies).
 *
 * The rule: a `courses` document with `status: 'draft'` and a `courseRuns`
 * document with `status: 'draft'` are readable only by admins, `draftCourse`
 * and `approveCourse` holders, the author, and (on the course only) the
 * course's `collaboratorUids`. The emulator suite
 * (`scripts/rules-tests/tests/courses.test.mjs`) proves the rule. This test
 * guards the OTHER half, which rules cannot see: WHO ISSUES THE READ.
 *
 * Two things make that worth a standing test rather than a review note.
 *
 *  1. Firestore judges a list on the query's potential result set, not on the
 *     rows it returns, so an UNFILTERED client list over either collection is
 *     now refused wholesale for a caller holding no course permission, even
 *     when every stored document happens to be published. A member-facing
 *     surface that adds such a list does not degrade: it breaks, and it breaks
 *     only once somebody saves a draft.
 *  2. The narrowing is invisible from the calling code. Nothing in
 *     `getDocs(collection(db, "courses"))` says who may run it.
 *
 * So the list below is the guard: every file allowed to touch the `courses` or
 * `courseRuns` document or collection through the CLIENT SDK is named here with
 * the surface it belongs to, and a new one fails this test until somebody
 * writes down which gate it sits behind.
 *
 * OUT OF SCOPE, deliberately. The `courseRuns/{runId}/weeks` subcollection was
 * not narrowed (see docs/courses-ops.md), so a path whose segments continue
 * into `"weeks"` is ignored here: `useWeek`, `useGroupWeeks` and `ProgressBody`
 * read draft curriculum client-direct and are meant to. Admin SDK code is out
 * of scope too, because it bypasses rules entirely; this test only looks at
 * files importing from `firebase/firestore`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/**
 * Every file permitted to read or write `courses` / `courseRuns` at the
 * document or collection level through the client SDK, and the gate it sits
 * behind. Paths are POSIX-style and relative to the repo root.
 *
 * To add one: name the surface, name the gate, and check the caller can
 * actually pass that gate. If the surface serves a plain member, it must
 * constrain the query on `status` or move to an Admin SDK route.
 */
const ALLOWED = new Map([
  [
    "src/features/courses/useAdminCourses.ts",
    "useCourses() lists `courses` unfiltered and useCourseRuns() lists `courseRuns` by courseId. Mounted only by AdminCourseList, CourseEditor and CoursePageEditor, all under /admin/courses, whose gate is admin OR draftCourse OR approveCourse. All three satisfy a resource-independent clause in the read rule, so the whole list passes.",
  ],
  [
    "src/features/courses/AdminCourseList.tsx",
    "One unfiltered `courseRuns` list for the whole page, to label each course row. Same /admin/courses gate.",
  ],
  [
    "src/features/courses/RunEditor.tsx",
    "Reads the one run document it edits. Same /admin/courses gate.",
  ],
  [
    "src/features/courses/WeekPlanBuilder.tsx",
    "Re-reads its run document to refresh the plan after a normalise. Rendered inside RunEditor, so the same gate.",
  ],
  [
    "src/features/courses/WeekEditor.tsx",
    "Reads its run document for the week context. Same /admin/courses gate.",
  ],
  [
    "src/features/courses/courseMutations.ts",
    "WRITES only: builds document references for setDoc/updateDoc from the admin editors above. The read rule does not apply to a write, and the write rules are unchanged by PR20.",
  ],
  [
    "src/features/admissions/RoundEditor.tsx",
    "One unfiltered `courseRuns` list feeding the outcome-run and evidence-run pickers, under /admin/admissions. That gate also admits an appointed admissions reviewer who holds neither course key, and for that caller the read now fails: it is caught, and the pickers it feeds render only inside the canAuthor branch, so nothing they were shown disappears.",
  ],
]);

/** Files importing the client SDK. Admin SDK callers bypass rules entirely. */
const CLIENT_SDK = /from "firebase\/firestore"/;

/**
 * A `collection(...)` or `doc(...)` call whose first path segment is one of the
 * two narrowed collections. The trailing group captures the rest of the call so
 * a path continuing into "weeks" can be skipped.
 */
const PATH_CALL = /\b(?:collection|doc)\(\s*[A-Za-z0-9_.()]+\s*,\s*"(courses|courseRuns)"([^)]*)\)/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function toPosix(full) {
  return relative(REPO_ROOT, full).split(sep).join("/");
}

test("only the named surfaces read courses/courseRuns through the client SDK", () => {
  const found = new Map();

  for (const full of walk(SRC)) {
    const source = readFileSync(full, "utf8");
    if (!CLIENT_SDK.test(source)) continue;

    for (const match of source.matchAll(PATH_CALL)) {
      // A path that continues into the weeks subcollection is out of scope:
      // that rule was deliberately left at `allow read: if isSignedIn()`.
      if (match[2].includes('"weeks"')) continue;
      const rel = toPosix(full);
      if (!found.has(rel)) found.set(rel, new Set());
      found.get(rel).add(match[1]);
    }
  }

  const unexpected = [...found.keys()].filter((f) => !ALLOWED.has(f)).sort();
  assert.deepEqual(
    unexpected,
    [],
    `These files read or write courses/courseRuns through the client SDK but are not in the ALLOWED list in ${toPosix(
      join(REPO_ROOT, "tests", "courses-draft-reads.test.mjs"),
    )}.\n\nSince V3 W3 PR20 a draft course and a draft run are staff-only, and an UNFILTERED list over either collection fails wholesale for a caller with no course permission. Add the file with the gate it sits behind, and if it serves a plain member, constrain the query on status or move it to an Admin SDK route.\n\n  ${unexpected.join(
      "\n  ",
    )}`,
  );

  const stale = [...ALLOWED.keys()].filter((f) => !found.has(f)).sort();
  assert.deepEqual(
    stale,
    [],
    `These files are on the ALLOWED list but no longer touch courses/courseRuns from the client. Delete the entries so the list keeps meaning something:\n\n  ${stale.join(
      "\n  ",
    )}`,
  );
});

test("every allowed surface carries a written reason naming its gate", () => {
  for (const [file, why] of ALLOWED) {
    assert.ok(
      why.length > 60,
      `${file} needs a real reason, not a placeholder: say which gate the caller passes.`,
    );
  }
});

test("no learner or public surface reads a course or run document client-direct", () => {
  // The learn hub reads runs through /api/courses/me and the public catalogue
  // through the Admin SDK fetchers in src/features/courses, both of which
  // bypass rules. Nothing under these trees should be reaching for the
  // documents itself, and if one starts to, it will be a plain member doing it.
  const MEMBER_TREES = ["src/app/(app)/learn/", "src/app/(public)/"];
  for (const file of ALLOWED.keys()) {
    for (const tree of MEMBER_TREES) {
      assert.ok(
        !file.startsWith(tree),
        `${file} sits under ${tree}, which serves plain members. A draft read there will fail: route it through the Admin SDK instead of allow-listing it.`,
      );
    }
  }
});
