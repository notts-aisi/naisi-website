/**
 * An id in an API path can never carry a separator.
 *
 * WHY. A dynamic route segment arrives URL-decoded, so `%2F` reaches a
 * handler as a slash inside its id, and `collection("tasks").doc(id)` with a
 * slash addresses a document in a SUBCOLLECTION rather than throwing. A
 * handler that reads that document's membership arrays to decide what the
 * caller may do is then reading the caller's own claim. An audit on
 * 8 September 2026 found every route under `/api/tasks/[id]` open that way,
 * 86 dynamic API routes with no check at all, and the check itself defined
 * fourteen separate times. The fix is one chokepoint in `src/proxy.ts`, and
 * this guard is what keeps it there:
 *
 * 1. `src/lib/addressableId.ts` behaves (the predicates are unit-tested
 *    through the shared TypeScript loader, so the test runs the real code).
 * 2. `src/proxy.ts` matches `/api/:path*`, calls `hasEncodedPathSeparator`,
 *    and does so BEFORE the protected-prefix logic, so no API request reaches
 *    a handler with an encoded slash in its path.
 * 3. The tasks tree, the one the audit exploited, also checks in each handler.
 * 4. No NEW inline copy of `isAddressableId` appears: the fourteen that exist
 *    are listed with the note that they are to be replaced by the shared
 *    import, and a listed file that stops defining it must be removed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(REPO_ROOT, "src", "lib", "addressableId.ts");
const PROXY = join(REPO_ROOT, "src", "proxy.ts");
const API_DIR = join(REPO_ROOT, "src", "app", "api");

/**
 * Files that still define their own `isAddressableId`. Burn-down list: each
 * is to import the shared one instead, and its entry leaves with the copy.
 */
const INLINE_COPIES = [
  "src/app/api/courses/exercise-responses/[responseId]/review/route.ts",
  "src/app/api/courses/groups/[groupId]/email/route.ts",
  "src/app/api/courses/groups/[groupId]/exercises/route.ts",
  "src/app/api/courses/groups/[groupId]/notice/route.ts",
  "src/app/api/courses/groups/[groupId]/pace/route.ts",
  "src/app/api/courses/groups/[groupId]/session/route.ts",
  "src/app/api/courses/groups/[groupId]/weeks/[weekId]/fork/route.ts",
  "src/app/api/courses/groups/[groupId]/weeks/[weekId]/route.ts",
  "src/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route.ts",
  "src/app/api/courses/runs/[runId]/my-exercises/route.ts",
  "src/app/api/courses/runs/[runId]/sync-tasks/route.ts",
  "src/lib/courses/registerAccess.ts",
  "src/lib/email/courseFacilitatorEmails.ts",
  "src/lib/worksheets/access.ts",
];

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry === "route.ts") yield full;
  }
}

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const { loadTs } = createLoader();
const loadModule = () => loadTs("lib/addressableId.ts");

test("isAddressableId names exactly one document", async () => {
  const { isAddressableId } = await loadModule();
  for (const ok of ["abc", "task_1", "a.b", "x-y", "%2F"]) {
    assert.equal(isAddressableId(ok), true, `${JSON.stringify(ok)} should be addressable`);
  }
  for (const bad of ["", "a/b", "/", "a/b/c", ".", ".."]) {
    assert.equal(isAddressableId(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("hasEncodedPathSeparator sees an encoded slash in either case and nothing else", async () => {
  const { hasEncodedPathSeparator } = await loadModule();
  assert.equal(hasEncodedPathSeparator("/api/tasks/a%2Fb/notify"), true);
  assert.equal(hasEncodedPathSeparator("/api/tasks/a%2fb/notify"), true);
  assert.equal(hasEncodedPathSeparator("/api/tasks/abc/notify"), false);
  assert.equal(hasEncodedPathSeparator("/api/events/x/calendar.ics"), false);
  // The URL parser keeps %2F encoded and folds dot segments away, which is
  // what makes checking the encoded pathname sufficient.
  assert.equal(new URL("http://x/api/t/a%2Fb").pathname, "/api/t/a%2Fb");
  assert.equal(new URL("http://x/api/t/%2e%2e/y").pathname, "/api/y");
});

test("the proxy refuses an encoded separator on every /api path before anything else", () => {
  const source = codeOf(PROXY);
  assert.match(source, /from "@\/lib\/addressableId"/, "proxy.ts must import the shared check.");
  assert.match(source, /hasEncodedPathSeparator\(/, "proxy.ts must call hasEncodedPathSeparator.");
  assert.match(source, /matcher:\s*\[\s*"\/api\/:path\*"/, 'config.matcher must start with "/api/:path*".');
  const apiBranch = source.indexOf('startsWith("/api/")');
  const prefixLogic = source.indexOf("PROTECTED_PREFIXES.some");
  assert.ok(apiBranch > -1, "proxy.ts must branch on /api/ paths.");
  assert.ok(apiBranch < prefixLogic, "The /api/ branch must run before the protected-prefix logic.");
  assert.match(
    source,
    /new URL\(request\.url\)\.pathname/,
    "The check must read the raw request URL, whose pathname stays encoded.",
  );
});

test("every dynamic route under /api/tasks checks its id in the handler as well", () => {
  const missing = [];
  for (const file of walk(join(API_DIR, "tasks"))) {
    if (!relative(API_DIR, file).includes("[")) continue;
    if (!/\bisAddressableId\(/.test(codeOf(file))) missing.push(relative(REPO_ROOT, file));
  }
  assert.deepEqual(missing, [], "Add `if (!isAddressableId(id)) return 404` after reading the params.");
});

test("no new inline copy of isAddressableId, and every listed copy still exists", () => {
  const defining = [];
  for (const file of walkTs(join(REPO_ROOT, "src"))) {
    if (file === MODULE) continue;
    if (/function isAddressableId\s*\(/.test(codeOf(file))) defining.push(relative(REPO_ROOT, file));
  }
  const listed = new Set(INLINE_COPIES);
  const fresh = defining.filter((f) => !listed.has(f));
  assert.deepEqual(fresh, [], "Import isAddressableId from @/lib/addressableId instead of defining it again.");
  const gone = INLINE_COPIES.filter((f) => !defining.includes(f));
  assert.deepEqual(gone, [], "These no longer define their own copy: remove them from INLINE_COPIES.");
});
