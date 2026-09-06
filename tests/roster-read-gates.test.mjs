/**
 * Who is allowed to be holding a `users` list when the page renders.
 *
 * ## The bug this exists for
 *
 * `firestore.rules` opens the `users` COLLECTION to admins and SU-recognised
 * committee only (`isSuCommittee()`), and Firestore judges a list or a listen
 * on the query's shape rather than on the rows it would return. So a component
 * that lists `users` does not degrade for anybody else: the read is refused
 * outright, the hook hands back an empty array, and every picker built out of
 * it draws with nobody in it. Nothing on screen says why.
 *
 * That is not hypothetical and it is not a one-off. It has now been fixed by
 * hand twice, in two different consoles, for the same reason both times: a page
 * tree gated WIDER than the `users` rule mounted a roster hook unconditionally.
 *
 *  - `src/features/admissions/RoundEditor.tsx`, under `/admin/admissions`,
 *    whose gate admits an `approveCourse` holder and an appointed admissions
 *    reviewer, neither of whom the `users` rule admits.
 *  - `src/features/courses/RunEditor.tsx`, under `/admin/courses`, whose gate
 *    admits a `draftCourse` or `approveCourse` holder who is a plain member.
 *
 * In both cases the person who found it was an admin, for whom the page works
 * perfectly. That is the shape of failure this repo has already paid four
 * months for once, on the `/profile` subscriptions listener, and the reason
 * docs/testing.md says the guard for a class lands with the fix for the
 * instance.
 *
 * ## What this walks
 *
 * 1. Every file under `src` that lists the `users` collection through the
 *    CLIENT SDK, matched both ways against `ROSTER_READERS`. A new one fails
 *    here until somebody writes down how it is kept off the surfaces the rule
 *    refuses.
 * 2. Every call site of every hook those files export, matched both ways
 *    against `CALL_SITES`. A new caller fails until somebody names its gate.
 * 3. For a call site declared `page-tree`, the REAL import graph from every
 *    `src/app` entry point, so the check is "which pages can actually mount
 *    this", not "which page did somebody remember". Each such page must sit in
 *    a tree on `ROSTER_SAFE_TREES`, and each of those trees is re-checked
 *    against its own layout, so widening a layout gate fails here too.
 * 4. For a call site declared `mounted-child`, the hook call must sit inside
 *    the named inner component and NOT in the file's default export, which is
 *    the exact regression the two fixes above made: hoisting the call back up
 *    to the page component turns this red.
 *
 * ## What this does NOT prove
 *
 * That the condition guarding a `mounted-child` mount is the RIGHT condition.
 * A test cannot read `canReadRoster ? <WithRoster/> : <Without/>` and know the
 * predicate matches `isSuCommittee()`. That is what each entry's written
 * reason is for, and what a reviewer checks. What the test does prove is that
 * the split still exists, which is the half that rots silently.
 *
 * ## The fix shape, when this goes red
 *
 * A page whose gate is wider than the `users` rule does not get the roster
 * hook. Either mount the hook in a child that only an admin or an SU-recognised
 * committee member renders (`GroupsAndRolesWithRoster` in RunEditor and
 * `RolesEditor` in RoundEditor are the worked examples), make the hook refuse
 * to issue the query itself the way `usePendingCount` does, or fetch the names
 * through a server route the way `useTaskRoster` does. Do not widen the rule,
 * and do not leave the picker drawing empty.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// The registries
// ---------------------------------------------------------------------------

/**
 * Every file that lists the `users` COLLECTION through the client SDK, and how
 * it is kept away from the callers `firestore.rules` refuses.
 *
 * A single-document read (`doc(db, "users", uid)`) is deliberately out of
 * scope: the rule lets a signed-in user read their own document, and that
 * clause is resource-dependent in a way a list can never satisfy. It is the
 * collection-level read that this guard is about.
 *
 * `hooks` is the set of exported names a caller imports to issue the read. The
 * call sites of each are enumerated below.
 */
const ROSTER_READERS = new Map([
  [
    "src/features/admin/useMembers.ts",
    {
      hooks: ["useMembers"],
      selfGuarded: false,
      reason:
        "The member roster on `role in [...]`, feeding every assignee, facilitator and reviewer picker in the product. Four callers, each named below. This is the hook both hand-fixes were about, because it is the one a new staff console reaches for first.",
    },
  ],
  [
    "src/features/admin/useApprovals.ts",
    {
      hooks: ["useApprovals"],
      selfGuarded: false,
      reason:
        "Pending registrations for the approvals queue. One caller, the admin console's front page, which is inside the full-admin route group.",
    },
  ],
  [
    "src/features/admin/useUniEmailIndex.ts",
    {
      hooks: ["useUniEmailIndex"],
      selfGuarded: false,
      reason:
        "Duplicate-university-email lookup for the pending applications on screen. Narrow by design (an `in` on up to thirty addresses) but still a list over `users`, so the rule judges it the same way. Same single caller as useApprovals.",
    },
  ],
  [
    "src/features/admin/useNewsletterSubscribers.ts",
    {
      hooks: ["useNewsletterSubscribers"],
      selfGuarded: false,
      reason:
        "An UNFILTERED list of every user, filtered in memory for the newsletter category. The widest read in this file's set, and the one with the least room to be mounted anywhere but the admin console.",
    },
  ],
  [
    "src/features/admin/useVerifiedEmails.ts",
    {
      hooks: ["useVerifiedEmails"],
      selfGuarded: false,
      reason:
        "A live listen over the whole `users` collection, building the verified-address index the Subscriptions tab flags stale rows against. A listen is judged on shape exactly like a list, and this one has no clauses at all.",
    },
  ],
  [
    "src/features/admin/usePendingCount.ts",
    {
      hooks: ["usePendingCount"],
      selfGuarded: true,
      // The literal the file must still contain. If somebody deletes the
      // early return, this entry stops being true and the test says so,
      // rather than the badge quietly firing a denied count for every member
      // who loads any authed page.
      guardLine: 'if (role !== "admin") return;',
      reason:
        "SELF-GUARDING, and it has to be: the pending badge is mounted by AppShell and AdminTabs, which every authed page renders, so there is no route tree to hide behind. The hook reads `useAuth().role` and issues the count only for an admin, then masks any leftover count to 0 for everybody else. This is the cheapest shape when a roster read has no gate available to it.",
    },
  ],
]);

/**
 * Every call site of the hooks above, keyed `<hook> in <file>`, with the gate
 * that keeps it away from a caller the `users` rule refuses.
 *
 * `kind: "page-tree"` means the gate is the route tree the caller sits in, and
 * the test resolves which pages can mount it by walking the import graph.
 * `kind: "mounted-child"` means the page tree is WIDER than the rule and the
 * hook is mounted through a child only the admitted viewers render; `component`
 * names that child, and the test checks the call has not drifted back up.
 */
const CALL_SITES = new Map([
  [
    "useMembers in src/app/(app)/committee/tasks/page.tsx",
    {
      kind: "page-tree",
      reason:
        "The committee task board's assignee picker. `(app)/committee/layout.tsx` redirects anybody who is not an admin or SU-recognised committee, which is `isSuCommittee()` restated, so every caller who reaches the board is a caller the rule admits.",
    },
  ],
  [
    "useMembers in src/app/(app)/admin/(admin-only)/projects/page.tsx",
    {
      kind: "page-tree",
      reason:
        "Project lead and member pickers. Inside the `(admin-only)` group, whose layout calls requireAdminPage(), which is narrower than the rule.",
    },
  ],
  [
    "useMembers in src/app/(app)/admin/(admin-only)/members/page.tsx",
    {
      kind: "page-tree",
      reason:
        "The member roster IS this page. Inside the `(admin-only)` group, so a full admin and nobody else.",
    },
  ],
  [
    "useMembers in src/features/courses/RunEditor.tsx",
    {
      kind: "mounted-child",
      component: "GroupsAndRolesWithRoster",
      reason:
        "/admin/courses admits a `draftCourse` or `approveCourse` holder who is a plain member, which the `users` rule does not, so the roster read is mounted through a child rendered only when `canReadRoster` (admin, or committee AND suRecognised) holds. The closed-out viewer gets a written note in place of the Roles pickers rather than an empty one.",
    },
  ],
  [
    "useMembers in src/features/admissions/RoundEditor.tsx",
    {
      kind: "mounted-child",
      component: "RolesEditor",
      reason:
        "/admin/admissions admits an `approveCourse` holder and an appointed admissions reviewer, neither of whom the `users` rule admits. RolesSection is mounted for everyone and returns a read-only summary unless `isAdmin`; only the admin branch mounts RolesEditor, which is where the hook lives.",
    },
  ],
  [
    "useApprovals in src/app/(app)/admin/(admin-only)/page.tsx",
    {
      kind: "page-tree",
      reason:
        "The approvals queue. Inside the `(admin-only)` group, so a full admin only.",
    },
  ],
  [
    "useUniEmailIndex in src/app/(app)/admin/(admin-only)/page.tsx",
    {
      kind: "page-tree",
      reason:
        "Duplicate-address check on the same approvals queue, and the same `(admin-only)` gate.",
    },
  ],
  [
    "useNewsletterSubscribers in src/features/admin/NewsletterTable.tsx",
    {
      kind: "page-tree",
      reason:
        "The newsletter recipient table. Mounted only by /admin/newsletter, which is inside the `(admin-only)` group; the import walk below is what proves nothing else mounts it.",
    },
  ],
  [
    "useVerifiedEmails in src/features/admin/SubscriptionsTable.tsx",
    {
      kind: "page-tree",
      reason:
        "Stale-row detection on the subscriptions table. Mounted only by /admin/subscriptions, inside the `(admin-only)` group.",
    },
  ],
  [
    "usePendingCount in src/layout/AppShell.tsx",
    {
      kind: "self-guarded",
      reason:
        "The sidebar badge, rendered for every authed user on every authed page. There is no gate here and there cannot be one, which is why the hook refuses the query itself.",
    },
  ],
  [
    "usePendingCount in src/app/(app)/admin/AdminTabs.tsx",
    {
      kind: "self-guarded",
      reason:
        "The same badge on the admin tab strip. AdminTabs renders under `/admin`, whose front door also admits course drafters and approvers, so the hook's own refusal is what covers them.",
    },
  ],
]);

/**
 * Route trees whose gate is at least as narrow as the `users` rule, so a
 * roster read mounted anywhere inside one is safe.
 *
 * Each entry re-checks the gate against the layout that enforces it. A layout
 * widened to admit a new permission holder makes these strings stop matching,
 * which is the point: the pages inside would start refusing roster reads the
 * same day, and this is the check that says so before a person notices an
 * empty picker.
 */
const ROSTER_SAFE_TREES = new Map([
  [
    "src/app/(app)/admin/(admin-only)/",
    {
      layout: "src/app/(app)/admin/(admin-only)/layout.tsx",
      mustContain: ["requireAdminPage()"],
      reason:
        "requireAdminPage() redirects anybody whose role is not `admin`. Strictly narrower than isSuCommittee(), which also admits SU-recognised committee.",
    },
  ],
  [
    "src/app/(app)/committee/",
    {
      layout: "src/app/(app)/committee/layout.tsx",
      mustContain: [
        'const isSuCommittee = user.role === "committee" && user.suRecognised;',
        'if (user.role !== "admin" && !isSuCommittee) {',
      ],
      reason:
        "The committee layout's own predicate is isSuCommittee() restated in TypeScript: admin, or committee with suRecognised. Exactly the set the `users` rule admits, which is why the board can list the roster at all.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// Reading source: comments blanked, offsets preserved
// ---------------------------------------------------------------------------

/**
 * Replace every comment with spaces of the same length, keeping newlines.
 *
 * Blanking rather than deleting, because the positional checks below compare
 * offsets against the original text: a stripped file would report the wrong
 * component for a call. Strings are respected so an apostrophe in prose and a
 * `//` in a URL cannot swallow the rest of the file, which is how a scanner
 * like this goes quiet and passes on a tree it never read.
 */
function blankComments(source) {
  let out = "";
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i += 1;
      out += blank(source.slice(start, i));
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, source.length);
      out += blank(source.slice(start, i));
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Specifiers that are not JavaScript and so import nothing. */
const NOT_CODE = /\.(css|scss|sass|json|png|jpe?g|svg|webp|gif|avif|woff2?|md|txt|ico)$/i;
const FROM_STATEMENT = /(?:^|\n)([ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["'])/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Is this statement erased at compile time? A type-only import carries nothing
 * into the bundle and mounts nothing, so following it would invent pages that
 * cannot reach the hook.
 */
function isTypeOnly(statement) {
  if (/^\s*(?:import|export)\s+type\b/.test(statement)) return true;
  const open = statement.indexOf("{");
  const close = statement.lastIndexOf("}");
  if (open === -1 || close < open) return false;
  const before = statement
    .slice(0, open)
    .replace(/^\s*(?:import|export)\s*/, "")
    .replace(/[,\s]/g, "");
  if (before.length > 0) return false;
  const specifiers = statement
    .slice(open + 1, close)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (specifiers.length === 0) return false;
  return specifiers.every((entry) => /^type\s/.test(entry));
}

function valueSpecifiers(clean) {
  const out = [];
  for (const [, statement, specifier] of clean.matchAll(FROM_STATEMENT)) {
    if (isTypeOnly(statement)) continue;
    out.push(specifier);
  }
  for (const [, specifier] of clean.matchAll(DYNAMIC_IMPORT)) out.push(specifier);
  return out;
}

function resolveLocal(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function sourceFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFilesUnder(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function repoPath(file) {
  return file.slice(REPO_ROOT.length + 1).split(sep).join("/");
}

const allFiles = sourceFilesUnder(SRC);
const raw = new Map(allFiles.map((file) => [file, readFileSync(file, "utf8")]));
const clean = new Map(allFiles.map((file) => [file, blankComments(raw.get(file))]));
const byRepoPath = new Map(allFiles.map((file) => [repoPath(file), file]));

// ---------------------------------------------------------------------------
// Step 1: who lists the `users` collection through the client SDK
// ---------------------------------------------------------------------------

const CLIENT_SDK = /from "firebase\/firestore"/;
/** `collection(db, <segment>)`, segment captured raw so a constant can be resolved. */
const COLLECTION_CALL = /\bcollection\(\s*[A-Za-z0-9_.()]+\s*,\s*([^,)]+)\)/g;
const QUOTED = /^(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `const NAME = "value"` anywhere under src, so an imported constant resolves. */
function collectConstants() {
  const map = new Map();
  const DECL = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)\s*;/g;
  for (const file of allFiles) {
    for (const m of clean.get(file).matchAll(DECL)) map.set(m[1], m[2] ?? m[3] ?? m[4]);
  }
  return map;
}

const CONSTANTS = collectConstants();

function resolveSegment(rawSegment) {
  const text = rawSegment.trim();
  const quoted = QUOTED.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? "";
  if (IDENTIFIER.test(text)) return CONSTANTS.has(text) ? CONSTANTS.get(text) : null;
  // A template literal with a substitution, a ternary or a call is not a
  // constant collection name, so there is nothing here to resolve.
  return "";
}

const foundReaders = new Set();
const unresolvedSegments = [];

for (const file of allFiles) {
  const source = clean.get(file);
  if (!CLIENT_SDK.test(source)) continue;
  for (const match of source.matchAll(COLLECTION_CALL)) {
    const name = resolveSegment(match[1]);
    if (name === null) {
      unresolvedSegments.push(`${repoPath(file)}: collection(..., ${match[1].trim()})`);
      continue;
    }
    if (name === "users") foundReaders.add(repoPath(file));
  }
}

// ---------------------------------------------------------------------------
// Step 2: the call sites of every hook those files export
// ---------------------------------------------------------------------------

const foundCallSites = new Set();

for (const [readerPath, entry] of ROSTER_READERS) {
  const readerFile = byRepoPath.get(readerPath);
  if (!readerFile) continue;
  for (const file of allFiles) {
    if (file === readerFile) continue;
    const source = clean.get(file);
    for (const specifier of valueSpecifiers(source)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (resolveLocal(specifier, file) !== readerFile) continue;
      for (const hook of entry.hooks) {
        // The import edge alone is not a call: a file may import the type of
        // its return. The call is what issues the read.
        if (new RegExp(`\\b${hook}\\s*\\(`).test(source)) {
          foundCallSites.add(`${hook} in ${repoPath(file)}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: which app entry points can reach a given file
// ---------------------------------------------------------------------------

const ENTRY_FILE = /^(?:page|layout|template|default|loading|error|not-found|global-error)\.tsx?$/;
const APP_DIR = join(SRC, "app");
const entryPoints = allFiles.filter(
  (file) => file.startsWith(APP_DIR + sep) && ENTRY_FILE.test(basename(file)),
);

let edgesFollowed = 0;

/** Every file this entry point reaches through value imports. */
function reachableFrom(entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const specifier of valueSpecifiers(clean.get(file) ?? "")) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (NOT_CODE.test(specifier)) continue;
      const target = resolveLocal(specifier, file);
      if (!target || !clean.has(target)) continue;
      edgesFollowed += 1;
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

const reach = new Map(entryPoints.map((entry) => [entry, reachableFrom(entry)]));

function entryPointsReaching(repoRelative) {
  const file = byRepoPath.get(repoRelative);
  if (!file) return [];
  const out = [];
  for (const [entry, seen] of reach) if (seen.has(file)) out.push(repoPath(entry));
  return out.sort();
}

// ---------------------------------------------------------------------------
// Positional check: which top-level function a call sits in
// ---------------------------------------------------------------------------

/** Top-level function declarations, as {name, declaration, start, end} offsets. */
function topLevelFunctions(source) {
  const DECL = /^(export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/gm;
  const found = [];
  for (const m of source.matchAll(DECL)) {
    found.push({ name: m[2], declaration: m[0], start: m.index });
  }
  return found.map((fn, index) => ({
    ...fn,
    end: index + 1 < found.length ? found[index + 1].start : source.length,
  }));
}

function functionContaining(source, offset) {
  for (const fn of topLevelFunctions(source)) {
    if (offset >= fn.start && offset < fn.end) return fn;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("roster read gates", () => {
  test("the walk is not vacuous", () => {
    // A resolver that quietly returned null for everything would make every
    // check below pass on a broken tree, which is the one way a guard like
    // this fails silently. These floors sit far below the real counts.
    assert.ok(
      entryPoints.length > 40,
      `only ${entryPoints.length} app entry points found under src/app; the scan is broken`,
    );
    assert.ok(
      edgesFollowed > 500,
      `only ${edgesFollowed} import edges followed from app entry points; the resolver is broken`,
    );
    assert.ok(
      foundCallSites.size >= 8,
      `only ${foundCallSites.size} roster hook call sites found; the call-site scan is broken`,
    );
  });

  test("every collection path segment resolves to a name", () => {
    // A segment this test cannot read is a collection it cannot guard, so it
    // is reported rather than skipped.
    assert.deepEqual(
      unresolvedSegments.sort(),
      [],
      "these client-SDK collection paths are identifiers this test cannot resolve to a name, so it " +
        "cannot tell whether they read `users`. Declare each as a plain `const NAME = \"collection\"` " +
        "under src, or inline the string:\n\n  " +
        unresolvedSegments.join("\n  "),
    );
  });

  test("every client-direct list of `users` is a declared roster reader", () => {
    const undeclared = [...foundReaders].filter((f) => !ROSTER_READERS.has(f)).sort();
    assert.deepEqual(
      undeclared,
      [],
      "these files list the `users` collection through the client SDK and are not in ROSTER_READERS.\n\n" +
        "`users` is admin and SU-recognised committee only, and Firestore refuses a list on its shape, " +
        "so this read returns nothing at all for anybody else and every picker built from it draws " +
        "empty with no error on screen. Add the file with how it is kept off the surfaces the rule " +
        "refuses, then add each call site below:\n\n  " +
        undeclared.join("\n  "),
    );

    const stale = [...ROSTER_READERS.keys()].filter((f) => !foundReaders.has(f)).sort();
    assert.deepEqual(
      stale,
      [],
      "these ROSTER_READERS entries no longer list `users` from the client. Delete them so the list " +
        "keeps meaning something:\n\n  " + stale.join("\n  "),
    );
  });

  test("every roster hook call site is declared with its gate", () => {
    const undeclared = [...foundCallSites].filter((k) => !CALL_SITES.has(k)).sort();
    assert.deepEqual(
      undeclared,
      [],
      "these call sites of a roster hook are not in CALL_SITES.\n\n" +
        "Name the gate that keeps a caller the `users` rule refuses away from this read. If the page " +
        "tree admits a permission holder or a plain member, the gate is not the tree: mount the hook " +
        "in a child only an admin or SU-recognised committee member renders, or refuse the query in " +
        "the hook the way usePendingCount does:\n\n  " + undeclared.join("\n  "),
    );

    const stale = [...CALL_SITES.keys()].filter((k) => !foundCallSites.has(k)).sort();
    assert.deepEqual(
      stale,
      [],
      "these CALL_SITES entries match no call site any more. Delete them:\n\n  " + stale.join("\n  "),
    );
  });

  test("a self-guarded hook still carries its refusal", () => {
    for (const [file, entry] of ROSTER_READERS) {
      if (!entry.selfGuarded) continue;
      const source = clean.get(byRepoPath.get(file)) ?? "";
      assert.ok(
        source.includes(entry.guardLine),
        `${file} is declared self-guarding but no longer contains \`${entry.guardLine}\`. ` +
          "Every call site of it is declared safe ONLY because the hook refuses the query itself; " +
          "without that line the read fires for every member who loads the page that mounts it.",
      );
    }
    // And a call site may only claim self-guarded when the hook actually is.
    for (const [key, entry] of CALL_SITES) {
      if (entry.kind !== "self-guarded") continue;
      const hook = key.slice(0, key.indexOf(" in "));
      const reader = [...ROSTER_READERS.values()].find((r) => r.hooks.includes(hook));
      assert.ok(
        reader?.selfGuarded === true,
        `${key} claims kind "self-guarded" but ${hook} is not declared self-guarding in ROSTER_READERS.`,
      );
    }
  });

  test("every page that can mount a page-tree call site sits in a roster-safe tree", () => {
    const problems = [];
    for (const [key, entry] of CALL_SITES) {
      if (entry.kind !== "page-tree") continue;
      const file = key.slice(key.indexOf(" in ") + 4);
      const pages = entryPointsReaching(file);
      if (pages.length === 0) {
        problems.push(
          `${key}: no app entry point reaches this file at all, so either the caller is dead code ` +
            "or the import walk missed it. Either way the declared gate proves nothing.",
        );
        continue;
      }
      const unsafe = pages.filter(
        (page) => ![...ROSTER_SAFE_TREES.keys()].some((tree) => page.startsWith(tree)),
      );
      if (unsafe.length > 0) {
        problems.push(
          `${key} is reachable from pages outside every roster-safe tree:\n      ` +
            unsafe.join("\n      "),
        );
      }
    }
    assert.deepEqual(
      problems,
      [],
      "a roster read is mounted by a page whose gate is wider than the `users` rule, so the read is " +
        "refused for whoever that gate admits and the pickers draw empty with nothing on screen to " +
        "say why:\n\n  " + problems.join("\n  "),
    );
  });

  test("every roster-safe tree's layout still enforces the gate claimed for it", () => {
    for (const [tree, entry] of ROSTER_SAFE_TREES) {
      const layout = byRepoPath.get(entry.layout);
      assert.ok(layout, `${tree}: ${entry.layout} does not exist any more.`);
      const source = clean.get(layout);
      for (const needle of entry.mustContain) {
        assert.ok(
          source.includes(needle),
          `${entry.layout} no longer contains \`${needle}\`, so ${tree} may no longer be limited to ` +
            "callers the `users` rule admits. Every roster read inside it is refused the day that " +
            "gate widens, silently. Re-check the gate, then either fix it or move those reads to a " +
            "mounted child.",
        );
      }
    }
  });

  test("every mounted-child call site keeps the hook out of the page component", () => {
    for (const [key, entry] of CALL_SITES) {
      if (entry.kind !== "mounted-child") continue;
      const hook = key.slice(0, key.indexOf(" in "));
      const filePath = key.slice(key.indexOf(" in ") + 4);
      const file = byRepoPath.get(filePath);
      assert.ok(file, `${key}: ${filePath} does not exist any more.`);
      const source = clean.get(file);

      const calls = [...source.matchAll(new RegExp(`\\b${hook}\\s*\\(`, "g"))];
      assert.ok(calls.length > 0, `${key}: no call to ${hook} found.`);
      for (const call of calls) {
        const fn = functionContaining(source, call.index);
        assert.ok(
          fn !== null && fn.name === entry.component,
          `${key}: ${hook}() is called from ${fn ? fn.name : "the module body"}, not from ` +
            `${entry.component}.\n\nThat component is mounted only for a viewer the \`users\` rule ` +
            "admits, and this file's page tree is gated wider than the rule, so a call anywhere else " +
            "fires a denied list for a permission holder or a plain member and leaves their pickers " +
            "empty with no explanation. Move it back, or split a new child the same way.",
        );
        assert.ok(
          !fn.declaration.includes("export default"),
          `${key}: ${entry.component} is the file's default export, so it is the component the page ` +
            "mounts unconditionally. The whole point of the split is that the roster read sits in a " +
            "child the page renders only for an admitted viewer.",
        );
      }

      assert.ok(
        new RegExp(`<${entry.component}\\b`).test(source),
        `${key}: ${entry.component} is never mounted in ${filePath}, so the section it carries is ` +
          "dead. A roster read nobody renders is not a passing gate, it is a missing feature.",
      );
    }
  });

  test("every entry carries a written reason", () => {
    for (const [file, entry] of ROSTER_READERS) {
      assert.ok(entry.reason.length > 60, `${file} needs a real reason, not a placeholder.`);
    }
    for (const [key, entry] of CALL_SITES) {
      assert.ok(entry.reason.length > 60, `${key} needs a real reason naming its gate.`);
    }
    for (const [tree, entry] of ROSTER_SAFE_TREES) {
      assert.ok(
        entry.reason.length > 60,
        `${tree} needs a real reason saying why its gate is at least as narrow as the users rule.`,
      );
    }
  });
});
