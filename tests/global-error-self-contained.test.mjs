/**
 * Guard for src/app/global-error.tsx (run via `npm test`, Node's built-in
 * test runner, no dependencies).
 *
 * global-error.tsx is the boundary Next renders when the ROOT LAYOUT itself
 * throws, which means it replaces that layout entirely: no <html>, no <body>,
 * no globals.css, no next/font variables, no providers. Anything it depends on
 * that the root layout would normally have supplied is unavailable at exactly
 * the moment it is needed.
 *
 * That failure is invisible in every normal code path. The file renders fine
 * in isolation, imports resolve, the build passes, and the missing stylesheet
 * only shows up on the one day the root layout breaks in production, as an
 * unstyled white page on a site that is black everywhere else. So it gets a
 * test rather than a comment.
 *
 * Enforced here:
 *   - no CSS import of any kind (a CSS Module, or globals.css directly)
 *   - no import from the component or feature trees, since anything there may
 *     transitively import CSS or expect a provider
 *   - it renders its own <html> and <body>
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(REPO_ROOT, "src", "app", "global-error.tsx");

const source = readFileSync(FILE, "utf8");

/** Every `import ... from "<specifier>"` and bare `import "<specifier>"`. */
function importSpecifiers(src) {
  const out = [];
  const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

test("global-error.tsx imports no stylesheet", () => {
  const css = importSpecifiers(source).filter((s) => s.endsWith(".css"));
  assert.deepEqual(
    css,
    [],
    `global-error.tsx must not import CSS (found ${css.join(", ")}). It replaces the root layout, so no stylesheet is guaranteed to have loaded. Style it inline.`,
  );
});

test("global-error.tsx imports nothing from the component or feature trees", () => {
  const risky = importSpecifiers(source).filter((s) =>
    /^@\/(components|features|layout)\//.test(s),
  );
  assert.deepEqual(
    risky,
    [],
    `global-error.tsx must not import app components (found ${risky.join(", ")}). They may transitively import CSS or expect a provider that is not mounted at this point.`,
  );
});

test("global-error.tsx renders its own html and body", () => {
  assert.match(source, /<html\b/, "global-error.tsx must render its own <html>");
  assert.match(source, /<body\b/, "global-error.tsx must render its own <body>");
});
