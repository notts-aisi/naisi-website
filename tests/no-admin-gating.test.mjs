/**
 * Two guards on the admin console (run via `npm test`, Node's built-in test
 * runner, no dependencies).
 *
 * 1. SELF-LOCKOUT. Nothing under src/app/api/admin/ may ever be gated on the
 *    site-maintenance notice: an admin must always be able to reach the console
 *    and switch the notice OFF while it is on. This asserts no file in that tree
 *    references the gating helpers, today's `isSurfacePaused` or the deferred
 *    server-guard module (`siteNoticeServer` / `assertSurfaceEnabled`), checked
 *    by name now so the test also holds the line if Phase 2 is ever built.
 *    Importing types or validation limits from `@/lib/siteNotice` (as the admin
 *    site-notice route does) is fine; gating is what is forbidden.
 *
 * 2. ROLE GATING. `(app)/admin/layout.tsx` used to be the only role check on
 *    every admin page, and it required `role === "admin"`. It no longer does:
 *    course drafters and approvers are let through the front door so they can
 *    reach `/admin/courses`. Every page that still needs a full admin therefore
 *    has to be gated below that layout, and the shape chosen is a route group:
 *    `src/app/(app)/admin/(admin-only)/**` is wrapped by a layout that calls
 *    `requireAdminPage()`, and `src/app/(app)/admin/courses/**` by one that
 *    calls `requireCourseAuthorPage()`. This asserts every admin page lives in
 *    one of those two trees and that both gates are still in place, so a course
 *    permission holder cannot reach /admin (approvals), /admin/members,
 *    /admin/danger-zone or any other section. A new page dropped straight into
 *    `src/app/(app)/admin/` fails here, which is the point: that location has
 *    no role gate of its own any more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API_DIR = join(REPO_ROOT, "src", "app", "api", "admin");
const ADMIN_PAGE_DIR = join(REPO_ROOT, "src", "app", "(app)", "admin");

const FORBIDDEN = [
  /\bisSurfacePaused\b/,
  /\bassertSurfaceEnabled\b/,
  /siteNoticeServer/,
];

/**
 * The two gated trees under src/app/(app)/admin, each with the gate its layout
 * must call. Kept literal so the next person to add an admin section can see
 * exactly which of the two it belongs in.
 */
const GATED_TREES = [
  {
    dir: "(admin-only)",
    gate: "requireAdminPage",
    why: "full admins only: approvals, members, collaborators, registrations, projects, newsletter, subscriptions, email designs, deliverability, task templates, site status, danger zone",
  },
  {
    dir: "courses",
    gate: "requireCourseAuthorPage",
    why: "the course authoring tree, also open to draftCourse and approveCourse holders",
  },
];

/** Pages a course permission holder must never be able to open. Spot-checks of
 *  the general rule below, named so a regression reads as a sentence rather
 *  than as a path count. */
const ADMIN_ONLY_ROUTES = [
  { route: "/admin", file: join("(admin-only)", "page.tsx") },
  { route: "/admin/members", file: join("(admin-only)", "members", "page.tsx") },
  { route: "/admin/danger-zone", file: join("(admin-only)", "danger-zone", "page.tsx") },
  { route: "/admin/subscriptions", file: join("(admin-only)", "subscriptions", "page.tsx") },
  { route: "/admin/email-designs", file: join("(admin-only)", "email-designs", "page.tsx") },
];

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("no admin API route gates on the site notice", () => {
  const files = sourceFiles(ADMIN_API_DIR);
  assert.ok(
    files.length > 0,
    `expected source files under ${ADMIN_API_DIR}: was the tree moved? Update this test's path.`,
  );
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert.ok(
        !pattern.test(source),
        `${file} references ${pattern}: admin routes must never be gated by ` +
          "the site notice, or an admin could be locked out of switching it off.",
      );
    }
  }
});

test("every admin page sits inside a gated route tree", () => {
  const pages = sourceFiles(ADMIN_PAGE_DIR).filter((f) => f.endsWith(`${sep}page.tsx`));
  assert.ok(
    pages.length > 0,
    `expected page files under ${ADMIN_PAGE_DIR}: was the tree moved? Update this test's path.`,
  );
  const allowedRoots = GATED_TREES.map((t) => t.dir);
  for (const page of pages) {
    const rel = relative(ADMIN_PAGE_DIR, page);
    const root = rel.split(sep)[0];
    assert.ok(
      allowedRoots.includes(root),
      `${rel} is an admin page outside every gated tree. The /admin layout now ` +
        "admits course drafters and approvers, so a page directly under " +
        "src/app/(app)/admin/ has no role gate of its own. Move it into " +
        `one of: ${allowedRoots.join(", ")}.`,
    );
  }
});

test("each gated admin tree still calls its gate", () => {
  for (const { dir, gate, why } of GATED_TREES) {
    const layout = join(ADMIN_PAGE_DIR, dir, "layout.tsx");
    assert.ok(
      existsSync(layout),
      `${dir}/layout.tsx is missing: that layout is the only role gate on ` +
        `${dir} (${why}).`,
    );
    const source = readFileSync(layout, "utf8");
    assert.match(
      source,
      new RegExp(`\\b${gate}\\(`),
      `${dir}/layout.tsx no longer calls ${gate}(): without it the tree is ` +
        `gated only by /admin/layout.tsx, which admits course permission holders.`,
    );
  }
});

test("the /admin layout admits course permission holders and nobody else", () => {
  const source = readFileSync(join(ADMIN_PAGE_DIR, "layout.tsx"), "utf8");
  assert.match(
    source,
    /canDraftCourse\(/,
    "the /admin layout must let draftCourse holders through, or the grant is unreachable.",
  );
  assert.match(
    source,
    /canApproveCourse\(/,
    "the /admin layout must let approveCourse holders through, or the grant is unreachable.",
  );
  assert.match(
    source,
    /redirect\("\/dashboard"\)/,
    "the /admin layout must still redirect everyone else away.",
  );
});

test("a course permission holder cannot reach the full-admin sections", () => {
  const gate = readFileSync(
    join(ADMIN_PAGE_DIR, "(admin-only)", "layout.tsx"),
    "utf8",
  );
  assert.match(gate, /requireAdminPage\(/);
  for (const { route, file } of ADMIN_ONLY_ROUTES) {
    const path = join(ADMIN_PAGE_DIR, file);
    assert.ok(
      existsSync(path),
      `${route} should be served from ${file}, inside the (admin-only) group ` +
        "whose layout requires a full admin. If the page moved, move it to " +
        "another admin-gated location and update this list.",
    );
  }
  const helper = readFileSync(
    join(REPO_ROOT, "src", "lib", "firebase", "pageGates.ts"),
    "utf8",
  );
  assert.match(
    helper,
    /user\.role !== "admin"/,
    "requireAdminPage() must check the role itself; a course permission holder " +
      "who reaches /admin/members has to be redirected there.",
  );
});
