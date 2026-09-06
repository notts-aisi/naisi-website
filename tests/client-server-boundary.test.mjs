/**
 * The client/server module boundary, walked rather than asserted about.
 *
 * ## The bug this exists for
 *
 * `import "server-only"` is a build-time tripwire: Next refuses a production
 * build when a module carrying it ends up in a client component's graph. The
 * trap is that NOTHING ELSE CATCHES IT. `tsc --noEmit` is happy, eslint is
 * happy, `npm test` is happy, and `next dev` only compiles the routes you
 * happen to open. The whole courses V3 stack went through twenty-seven
 * branches that were typechecked, linted and unit tested green, and the first
 * production build failed with four errors of exactly this shape:
 *
 *   RoundEditor.tsx ("use client")
 *     -> lib/admissions/appointmentQueue.ts   (for appointmentDecideBlock)
 *     -> lib/admissions/statusHub.ts          (for answerText)
 *     -> lib/admissions/applyRoutes.ts        import "server-only"
 *     -> lib/admissions/roundRoutes.ts        import "server-only"
 *
 * One value import of a nine-line helper, four modules down, and the build is
 * dead. The chain is invisible at the call site, which is the point: nobody
 * reads four modules deep to import a predicate.
 *
 * ## What this does
 *
 * It walks the REAL import graph: every file under `src` that begins with
 * `"use client"`, then transitively every relative and `@/` specifier those
 * files reach, and fails naming the whole chain if any reached module imports
 * `server-only`.
 *
 * TYPE-ONLY IMPORTS ARE SKIPPED, because TypeScript erases them and they carry
 * nothing into the bundle. `import type { AppointmentQueueRow } from
 * "@/lib/admissions/appointmentQueue"` is fine and must stay fine: refusing it
 * would push every wire shape into a parallel types module for no benefit.
 * A value import of the same module is not fine, and that is the distinction
 * the walker makes.
 *
 * ## The fix shape, when this test goes red
 *
 * Do NOT delete the `server-only` marker. It is what stops a route module
 * reaching the browser, and other guards lean on it (see
 * `tests/privacy-policy.test.mjs`, which treats reaching
 * `lib/admissions/applyContext.ts` as reaching the access-requirements
 * collection). Move the pure piece the client actually needs into a LEAF
 * module that imports nothing server-only, and have the server module
 * re-export it so no existing call site changes. `lib/admissions/answerText.ts`
 * and `lib/admissions/appointmentRules.ts` are the worked examples.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SERVER_ONLY = "server-only";

/** Specifiers that are not JavaScript and so import nothing. */
const NOT_CODE = /\.(css|scss|sass|json|png|jpe?g|svg|webp|gif|avif|woff2?|md|txt|ico)$/i;

function repoPath(file) {
  return file.slice(REPO_ROOT.length + 1).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Reading a module: comments out, then the import statements
// ---------------------------------------------------------------------------

/**
 * Strip comments while respecting strings, so a `//` inside a URL literal and
 * an apostrophe inside a prose comment both survive. This codebase comments
 * heavily and its comments are full of quotes and slashes, so a naive
 * comment-stripper would swallow half a file and the walk would go quiet,
 * which is the failure mode this whole test exists to prevent.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
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

/** `import ... from "x"` and `export ... from "x"`, however many lines it spans. */
const FROM_STATEMENT = /(?:^|\n)([ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["'])/g;
/** `import "x"`, the side-effect form, which is how `server-only` is pulled in. */
const BARE_IMPORT = /(?:^|\n)([ \t]*import\s*["']([^"']+)["'])/g;
/** `import("x")`, which does reach the bundle. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Is this statement erased at compile time?
 *
 * Two forms count: `import type { ... } from`, and a braces-only statement
 * whose every named specifier carries the inline `type` keyword. A default or
 * namespace binding outside the braces is a value, so those follow.
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

/** Every specifier this module pulls VALUES from, in source order. */
function valueSpecifiers(source) {
  const clean = stripComments(source);
  const out = [];
  for (const [, statement, specifier] of clean.matchAll(FROM_STATEMENT)) {
    if (isTypeOnly(statement)) continue;
    out.push(specifier);
  }
  for (const [, , specifier] of clean.matchAll(BARE_IMPORT)) out.push(specifier);
  for (const [, specifier] of clean.matchAll(DYNAMIC_IMPORT)) out.push(specifier);
  return out;
}

/**
 * Does this file open with the client directive?
 *
 * The directive has to be the first statement, but a leading docblock and
 * blank lines are allowed before it, so the check strips those first rather
 * than testing `startsWith`.
 */
function isClientModule(source) {
  let rest = source.replace(/^﻿/, "");
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) return false;
      rest = trimmed.slice(end + 2);
      continue;
    }
    if (trimmed.startsWith("//")) {
      const end = trimmed.indexOf("\n");
      if (end === -1) return false;
      rest = trimmed.slice(end + 1);
      continue;
    }
    return /^["']use client["']/.test(trimmed);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolveLocal(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ];
  for (const candidate of candidates) {
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

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

const allFiles = sourceFilesUnder(SRC);
const sources = new Map(allFiles.map((file) => [file, readFileSync(file, "utf8")]));
const clientFiles = allFiles.filter((file) => isClientModule(sources.get(file)));

let edgesFollowed = 0;
const unresolved = [];
const violations = [];

for (const entry of clientFiles) {
  // Breadth first, so the chain reported is the shortest one to the offender.
  const queue = [[entry]];
  const seen = new Set([entry]);
  while (queue.length > 0) {
    const chain = queue.shift();
    const file = chain[chain.length - 1];
    for (const specifier of valueSpecifiers(sources.get(file) ?? "")) {
      if (specifier === SERVER_ONLY) {
        violations.push({ entry, chain, offender: file });
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (NOT_CODE.test(specifier)) continue;
      const target = resolveLocal(specifier, file);
      if (!target) {
        unresolved.push(`${repoPath(file)} -> ${specifier}`);
        continue;
      }
      if (!sources.has(target)) continue;
      edgesFollowed += 1;
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push([...chain, target]);
    }
  }
}

function describeChain({ chain }) {
  return chain
    .map((file, index) => `${"  ".repeat(index)}${index === 0 ? "" : "-> "}${repoPath(file)}`)
    .join("\n")
    .concat(`\n${"  ".repeat(chain.length)}-> import "server-only"`);
}

describe("the client/server module boundary", () => {
  test("the walk is not vacuous: it found client files and followed edges", () => {
    // A resolver that silently returns null for everything would make the
    // guard below pass on a broken tree, which is the one way a test like this
    // fails quietly. These floors are far below the real counts.
    assert.ok(
      clientFiles.length > 20,
      `only ${clientFiles.length} "use client" files found under src; the scan is broken`,
    );
    assert.ok(
      edgesFollowed > 200,
      `only ${edgesFollowed} import edges followed from client files; the resolver is broken`,
    );
  });

  test("every relative import from a client graph resolves to a real file", () => {
    // An unresolvable specifier is a hole in the walk, so it is reported
    // rather than shrugged off: the chain it would have opened is unwalked.
    assert.deepEqual(unresolved, []);
  });

  test("no client component reaches a module that imports server-only", () => {
    assert.deepEqual(
      violations.map(describeChain),
      [],
      'these "use client" modules reach a `server-only` module through value ' +
        "imports, which fails `next build` even though tsc, eslint and the unit " +
        "suites are all green. Do not delete the marker: move the pure piece " +
        "the client needs into a leaf module that imports nothing server-only, " +
        "and re-export it from the server module so no call site changes. See " +
        "the docblock at the top of this file.",
    );
  });
});
