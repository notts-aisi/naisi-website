/**
 * Where the society lives off the site, written down once.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * `src/content/socials.ts` exists because the SU page address once had four
 * copies and a fifth was about to be added. Two things went wrong again
 * afterwards, and this holds both:
 *
 *  1. A COPY. The landing page's Elsewhere row carried its own hard-coded
 *     addresses, so changing a social in `socials.ts` changed the footer and
 *     left the landing page pointing at the old one.
 *  2. THE THIRD-PARTY LINK PAGE. It was replaced by `/links`, which is ours to
 *     edit, renders without JavaScript on fair-day signal and records which
 *     printed code a sign-up came from. Printed and posted copies of the old
 *     address survive, which is why that page is kept alive as a forwarder,
 *     but nothing on this site should send anybody to it again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const codeOf = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|css|json)$/.test(entry)) yield full;
  }
}

test("nothing in src points at the retired third-party link page", () => {
  const offenders = [];
  for (const file of walk(join(REPO_ROOT, "src"))) {
    if (/linktr\.ee/i.test(readFileSync(file, "utf8"))) {
      offenders.push(relative(REPO_ROOT, file).split("\\").join("/"));
    }
  }
  assert.deepEqual(offenders, [], "Send people to /links (LINKS_PAGE_PATH in src/content/socials.ts).");
});

test("every entry in SOCIAL_LINKS is a full https address", () => {
  // Everything that renders the list opens a new tab, which is wrong for a
  // page on this site. That is why /links is a constant of its own.
  const code = codeOf("src/content/socials.ts");
  const list = code.slice(code.indexOf("export const SOCIAL_LINKS"), code.indexOf("];", code.indexOf("export const SOCIAL_LINKS")));
  const hrefs = [...list.matchAll(/href:\s*("[^"]*"|\w+)/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3);
  for (const href of hrefs) {
    assert.ok(href === "SU_PAGE_URL" || /^"https:\/\//.test(href), `${href} is not an off-site address`);
  }
  assert.match(code, /export const LINKS_PAGE_PATH = "\/links";/);
});

test("the landing page's Elsewhere row takes its addresses from socials.ts", () => {
  const code = codeOf("src/app/(public)/ElsewhereRow.tsx");
  assert.doesNotMatch(code, /https?:\/\//, "an address is written out here; read it from @/content/socials");
  assert.match(code, /from "@\/content\/socials"/);
});

test("the links page takes its social addresses from socials.ts too", () => {
  const code = codeOf("src/content/links.ts");
  assert.doesNotMatch(code, /https?:\/\/(www\.)?(instagram|nottsaisafety\.substack)/);
  assert.match(code, /socialHref\("Instagram"\)/);
});

test("the footer links to /links as a page on this site, not as somewhere else", () => {
  const code = codeOf("src/layout/PublicFooter.tsx");
  assert.match(code, /<Link href=\{LINKS_PAGE_PATH\}>/);
});
