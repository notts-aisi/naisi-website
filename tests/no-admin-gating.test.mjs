/**
 * Self-lockout guard for the site-maintenance notice (run via `npm test`,
 * Node's built-in test runner — no dependencies).
 *
 * Nothing under src/app/api/admin/ may ever be gated on the site notice: an
 * admin must always be able to reach the console and switch the notice OFF
 * while it is on. This asserts no file in that tree references the gating
 * helpers — today's `isSurfacePaused` or the deferred server-guard module
 * (`siteNoticeServer` / `assertSurfaceEnabled`), checked by name now so the
 * test also holds the line if Phase 2 is ever built. Importing types or
 * validation limits from `@/lib/siteNotice` (as the admin site-notice route
 * does) is fine; gating is what is forbidden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API_DIR = join(REPO_ROOT, "src", "app", "api", "admin");

const FORBIDDEN = [
  /\bisSurfacePaused\b/,
  /\bassertSurfaceEnabled\b/,
  /siteNoticeServer/,
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
    `expected source files under ${ADMIN_API_DIR} — was the tree moved? Update this test's path.`,
  );
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert.ok(
        !pattern.test(source),
        `${file} references ${pattern} — admin routes must never be gated by ` +
          "the site notice, or an admin could be locked out of switching it off.",
      );
    }
  }
});
