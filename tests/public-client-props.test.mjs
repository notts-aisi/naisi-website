/**
 * No Server Component an anonymous visitor can render hands a whole document
 * to a client component.
 *
 * WHY. React serialises every prop a client component receives from a Server
 * Component into the page's HTML, so the browser can hydrate from it. The
 * component may render two fields; the payload carries them all. On
 * 8 September 2026 the public event page was found doing exactly that:
 * `EventDetailView` (a Server Component) rendered `<RsvpForm event={event} />`
 * with the whole `EventDoc`, and the form read five fields of it, so an
 * anonymous visitor's view-source carried the exact location of a
 * hidden-location event, the reviewer's notes, the author's uid and the
 * pending and waitlisted counts, none of which the page showed. Firestore
 * rules had correctly refused the same visitor a read of the document; the
 * page handed it over anyway. Every other rule about what a location says to
 * a person (`tests/event-location-disclosure.test.mjs`) was correct and none
 * of them could see this, because the leak is in a channel no render
 * function writes to.
 *
 * WHAT IT DOES. It walks every `page.tsx` and `layout.tsx` under `src/app`
 * that is NOT behind the authed `(app)` group (and is not an API route), then
 * transitively every Server Component those files import from `src`. In each
 * such file it finds every JSX element whose tag is imported from a
 * `"use client"` module, and every attribute on it whose value is a bare
 * identifier the file declares as a DOCUMENT: a binding annotated with a
 * `…Doc` type, or assigned from an `await get…()` / `fetch…()` / `load…()`
 * / `read…()` call. Each such site is registered in `ALLOWED` with the reason
 * the whole document is safe in the public HTML, both directions.
 *
 * The fix shape when this goes red: pass the fields the component uses, as
 * `RsvpForm` now does, or project the document on the server first.
 *
 * WHAT IT CANNOT SEE. A document reached through a member expression
 * (`data.event`), a spread (`{...props}`), or a projection that happens to
 * keep every field. It reads names, not types. The two scanners it relies on
 * are exercised on synthetic snippets so that a regex that stopped matching
 * fails rather than passes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const APP = join(SRC, "app");

/**
 * `<file> :: <Tag attr={ident}>` for every whole document a public Server
 * Component hands to a client component, with the reason it is safe.
 */
const ALLOWED = {};

const repoPath = (file) => file.slice(REPO_ROOT.length + 1).split(sep).join("/");

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function isClientModule(file) {
  const head = readFileSync(file, "utf8").slice(0, 400);
  return /^\s*(?:import[^;]*;\s*)*["']use client["']/.test(head) || /^\s*["']use client["']/.test(head);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Resolve an `@/` or relative specifier to a file under src, or null. */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT = /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;

/** `{ localName: resolvedFile }` for every value import that resolves under src. */
function importsOf(file, code) {
  const out = {};
  for (const m of code.matchAll(IMPORT)) {
    const [whole, clause, spec] = m;
    if (/^import\s+type\s/.test(whole)) continue;
    const target = resolveSpecifier(spec, file);
    if (!target) continue;
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (def && !clause.trim().startsWith("{")) out[def[1]] = target;
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const piece = part.trim().replace(/^type\s+/, "");
        if (!piece) continue;
        const alias = piece.split(/\s+as\s+/);
        out[(alias[1] ?? alias[0]).trim()] = target;
      }
    }
  }
  return out;
}

/** Identifiers this file declares as documents. */
const DOC_TYPED = /\b([A-Za-z_$][\w$]*)\s*\??:\s*[A-Z][A-Za-z]*Doc\b/g;
const DOC_FETCHED = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*await\s+(?:get|fetch|load|read)[A-Za-z]*\(/g;

function documentIdentifiers(code) {
  const names = new Set();
  for (const m of code.matchAll(DOC_TYPED)) names.add(m[1]);
  for (const m of code.matchAll(DOC_FETCHED)) names.add(m[1]);
  return names;
}

/**
 * Every `<Tag …>` element whose tag is one of `tags`, with its attribute text.
 * Braces are balanced so a `>` inside an arrow function does not end the
 * element early.
 */
function* elements(code, tags) {
  const open = /<([A-Z][\w.]*)\b/g;
  for (const m of code.matchAll(open)) {
    if (!tags.has(m[1])) continue;
    let i = m.index + m[0].length;
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
      i += 1;
    }
    yield { tag: m[1], attrs: code.slice(m.index + m[0].length, i) };
  }
}

const BARE_ATTR = /\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*!?\s*\}/g;

/** The public roots: every page and layout not behind `(app)` and not an API route. */
function publicRoots() {
  const roots = [];
  for (const file of walk(APP)) {
    const rel = repoPath(file);
    if (rel.startsWith("src/app/(app)/") || rel.startsWith("src/app/api/")) continue;
    if (/\/(page|layout)\.tsx$/.test(rel)) roots.push(file);
  }
  return roots;
}

/** The public roots plus every Server Component they reach under src. */
function publicServerComponents() {
  const seen = new Set();
  const queue = publicRoots();
  const out = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx$/.test(file) || isClientModule(file)) continue;
    out.push(file);
    const code = codeOf(file);
    for (const target of Object.values(importsOf(file, code))) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return out.sort();
}

function findings() {
  const found = {};
  for (const file of publicServerComponents()) {
    const code = codeOf(file);
    const imports = importsOf(file, code);
    const clientTags = new Set(
      Object.entries(imports)
        .filter(([, target]) => /\.tsx$/.test(target) && isClientModule(target))
        .map(([name]) => name),
    );
    if (clientTags.size === 0) continue;
    const docs = documentIdentifiers(code);
    if (docs.size === 0) continue;
    for (const { tag, attrs } of elements(code, clientTags)) {
      for (const m of attrs.matchAll(BARE_ATTR)) {
        const [, attr, ident] = m;
        if (docs.has(ident)) found[`${repoPath(file)} :: <${tag} ${attr}={${ident}}>`] = true;
      }
    }
  }
  return Object.keys(found).sort();
}

describe("public Server Components hand client components fields, not documents", () => {
  test("the scanners see what they are for", () => {
    assert.deepEqual([...documentIdentifiers("export default function View({ event }: { event: EventDoc }) {}")], ["event"]);
    assert.deepEqual([...documentIdentifiers("const event = await getPublishedEvent(id);")], ["event"]);
    assert.deepEqual([...documentIdentifiers("let application: ApplicantApplication | null = null;")], []);
    assert.deepEqual([...documentIdentifiers("const { week: weekDoc } = data;")], []);
    const els = [...elements("<RsvpForm\n  event={event}\n  onDone={() => x > 1}\n  previewMode\n/>", new Set(["RsvpForm"]))];
    assert.equal(els.length, 1);
    assert.deepEqual([...els[0].attrs.matchAll(BARE_ATTR)].map((m) => [m[1], m[2]]), [["event", "event"]]);
    assert.equal(
      [...elements("<Other event={event} />", new Set(["RsvpForm"]))].length,
      0,
      "a tag that is not a client import is not an element of interest",
    );
    assert.ok(isClientModule(join(SRC, "features", "events", "RsvpForm.tsx")));
    assert.ok(!isClientModule(join(SRC, "features", "events", "EventDetailView.tsx")));
  });

  test("the walk reaches the public event page and its detail view", () => {
    const files = publicServerComponents().map(repoPath);
    assert.ok(files.includes("src/app/(public)/events/[id]/page.tsx"), "the public event page is not in the walk");
    assert.ok(files.includes("src/features/events/EventDetailView.tsx"), "the detail view is not reached from the public page");
    assert.ok(!files.some((f) => f.startsWith("src/app/(app)/")), "an authed page leaked into the public walk");
  });

  test("every whole document handed to a client component is registered, both directions", () => {
    const found = findings();
    const unregistered = found.filter((site) => !(site in ALLOWED));
    assert.deepEqual(
      unregistered,
      [],
      "A public Server Component hands a whole document to a client component, so every field of it is in the page's HTML for anybody. Pass the fields the component uses, or register the site with the reason the whole document is public.",
    );
    const stale = Object.keys(ALLOWED).filter((site) => !found.includes(site));
    assert.deepEqual(stale, [], "These registered sites no longer exist: remove them.");
    for (const [site, reason] of Object.entries(ALLOWED)) {
      assert.ok(String(reason).trim().length >= 40, `${site}: the reason is a placeholder.`);
    }
  });

  test("the regression: the RSVP form takes facts, never the event", () => {
    const form = codeOf(join(SRC, "features", "events", "RsvpForm.tsx"));
    assert.doesNotMatch(form, /\bevent\s*:\s*EventDoc\b/, "RsvpForm takes the whole EventDoc again.");
    const view = codeOf(join(SRC, "features", "events", "EventDetailView.tsx"));
    assert.doesNotMatch(view, /<RsvpForm[^>]*\bevent=\{event\}/, "EventDetailView hands RsvpForm the whole event again.");
  });
});
