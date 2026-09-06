/**
 * GUARD: every client-direct Firestore READ in `src` is allowed for the people
 * who actually run it.
 *
 * Two layers already have tests, and they each see half the problem.
 * `firestore.rules` is proven by the suites beside this one, which answer "may
 * this actor read this document". The source scans in `tests/` answer "which
 * file touches which collection". Neither answers the question that has
 * produced three live bugs this year: does the QUERY THIS FILE ISSUES pass the
 * rule for the PERSON THAT PAGE ADMITS.
 *
 * That gap exists because Firestore judges a `list` or a `listen` on the
 * query's SHAPE, not on the rows it returns. A query whose shape could match a
 * document the rule forbids is refused wholesale, before any document is read,
 * so an empty collection is no defence. The refusal is silent (an empty panel,
 * a console line), and an admin never reproduces it, because every rule here
 * gives an admin a resource-independent branch that matches the collection
 * entire. The three that shipped:
 *
 *   1. `/profile`'s subscriptions listener pinned `audienceId` and not
 *      `audience`, so it was denied for every non-admin from 6 May 2026 until
 *      commit 7e6c38c (PR #261).
 *   2. `RoundEditor`'s unfiltered `courseRuns` list is refused for an
 *      appointed admissions reviewer holding no course key, under the run rule
 *      narrowed in V3 W3 PR20.
 *   3. This suite's own sibling, `admissions.test.mjs`, had to grow
 *      `where("status", "!=", "draft")` on its member control for the same
 *      reason.
 *
 * WHAT THIS FILE DOES, in order:
 *
 *   1. Scans `src` for every read issued through the client SDK, resolving
 *      collection names through the repo's constants (including the object
 *      constants `SITE_NOTICE_PATH` and `MAINTENANCE_LOG_PATH`), and matches
 *      each one BOTH ways against `client-queries.registry.mjs`: an
 *      unregistered read fails with its file, line and shape, and a registry
 *      entry matching nothing fails as stale. A read whose shape cannot be
 *      resolved statically (`useTasks`'s spread constraints, `useWeek`'s
 *      ternary reference) fails unless an entry for that file writes down the
 *      shapes it can take and why.
 *   2. Runs every registered query against the emulator as every persona the
 *      entry names, and asserts allowed or refused exactly as written down.
 *      `getCountFromServer` is judged on the same shape as the equivalent
 *      list, so the count sites are proven with a `get()` of the identical
 *      query, which each of those entries says.
 *   3. Pins the three bugs above as named regression cases, plus a fourth for
 *      the registration reads that run BEFORE a `users` document exists, where
 *      the `isAdmin()` branch of a rule cannot even resolve the caller's role.
 *
 * WHAT IT DOES NOT DO. It does not prove a surface is reachable, only that the
 * read is allowed for the personas the entry claims can reach it. Naming the
 * gate honestly is a human step, and the entry's `reason` is where that
 * judgement is recorded. It also says nothing about writes, except where a
 * read precedes one, and nothing about Admin SDK code, which bypasses rules.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asAnon,
  asUser,
  assertFails,
  assertSucceeds,
  cleanup,
  clearData,
  getTestEnv,
  seed,
} from "../lib/harness.mjs";
import { BASE_PERSONAS, PERSONAS, REGISTRY, UNRESOLVED_SITE_COUNTS } from "./client-queries.registry.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(REPO_ROOT, "src");

before(async () => {
  // Unique per file: a shared project id lets one file's clearFirestore()
  // wipe another's fixtures mid-test (see harness.mjs).
  await getTestEnv("client-queries");
});
after(cleanup);
afterEach(clearData);

// ---------------------------------------------------------------------------
// The static scan
// ---------------------------------------------------------------------------

/** Files importing the client SDK. Admin SDK callers bypass rules entirely. */
const CLIENT_SDK = /from "firebase\/firestore"/;

/**
 * Every way this codebase issues a READ. `tx.get` covers the one transaction
 * read (the admin lock lease); writes are out of scope except where a read
 * precedes them, and those reads are ordinary `getDoc` calls caught here.
 */
const READ_FN =
  /\b(getDocs|getDocsFromServer|getDoc|getCountFromServer|getAggregateFromServer|onSnapshot)\s*\(|\b(?:tx|transaction)\.get\s*\(/g;

const QUOTED = /^(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** `SITE_NOTICE_PATH.collection`: an object constant plus one of its fields. */
const MEMBER = /^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const toPosix = (full) => relative(REPO_ROOT, full).split(sep).join("/");

/**
 * Blanks out comments, preserving offsets and line breaks, so a read named in
 * prose ("one extra `getDocs` for a group that has...") is not scanned as
 * code. Doing this by hand rather than with a parser keeps the guard
 * dependency-free, which is the whole reason the rules-tests package stays out
 * of the root manifest.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (c === "/" && d === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The text inside the parens opening at `open`, quotes and nesting respected. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return { text: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function splitArgs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/**
 * Repo-wide constant maps, flat and object-shaped.
 *
 * Flat covers `const COURSE_PAGES_COLLECTION = "coursePages"`, declared in
 * `src/lib/firestore/` and imported by the file that issues the read. Object
 * covers `const SITE_NOTICE_PATH = { collection: "publicConfig", doc:
 * "siteNotice" }`, which the site-notice and maintenance-log readers use, and
 * which a flat-only scanner reports as an unresolvable segment.
 */
function collectConstants(files) {
  const flat = new Map();
  const objects = new Map();
  // A name declared with two different literals in two files (src has three
  // `const COLLECTION`s today, all in Admin SDK routes) cannot be trusted from
  // a flat map, because which one wins is directory walk order. Such a name is
  // recorded here and treated as unreadable in a collection-name position.
  const ambiguous = new Set();
  const DECL =
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)\s*;/g;
  const OBJ = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{([^{}]*)\}\s*(?:as const)?\s*;/g;
  const FIELD = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`$\\]*)`)/g;
  for (const full of files) {
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(DECL)) {
      const value = m[2] ?? m[3] ?? m[4];
      if (flat.has(m[1]) && flat.get(m[1]) !== value) ambiguous.add(m[1]);
      flat.set(m[1], value);
    }
    for (const m of src.matchAll(OBJ)) {
      const fields = new Map();
      for (const f of m[2].matchAll(FIELD)) fields.set(f[1], f[2] ?? f[3] ?? f[4]);
      if (fields.size) objects.set(m[1], fields);
    }
  }
  return { flat, objects, ambiguous };
}

/**
 * What one path segment names.
 *
 * COLLECTION-NAME positions (odd segments, counting from one) decide which
 * rule block applies, so one that cannot be read is reported rather than
 * guessed. DOCUMENT-ID positions are data and become `{}`: the entry's
 * `docShape` is where the id that matters gets written down, which is how the
 * `adminLocks` id patterns (`page__...` versus `useredit__...`, and the rule turns
 * on which) are covered.
 */
function resolveSegment(raw, constants, isCollectionName) {
  const text = raw.trim();
  const quoted = QUOTED.exec(text);
  if (quoted) return { value: quoted[1] ?? quoted[2] ?? quoted[3] ?? "", ok: true };
  const member = MEMBER.exec(text);
  if (member && constants.objects.has(member[1])) {
    const value = constants.objects.get(member[1]).get(member[2]);
    if (value !== undefined) return { value, ok: true };
  }
  if (IDENTIFIER.test(text) && constants.flat.has(text) && !constants.ambiguous.has(text)) {
    return { value: constants.flat.get(text), ok: true };
  }
  if (!isCollectionName) return { value: "{}", ok: true };
  return { value: text, ok: false };
}

/** A `collection(...)` or `doc(...)` call, as a templated path. */
function parsePathCall(expr, constants) {
  const trimmed = expr.trim();
  const head = /^(collection|doc)\s*\(/.exec(trimmed);
  if (!head) return null;
  const inner = balanced(trimmed, trimmed.indexOf("("));
  if (!inner) return null;
  const args = splitArgs(inner.text);
  const first = (args[0] ?? "").trim();
  const segments = args.slice(1);
  // `doc(collection(db, "tasks"), id)`: the reference is built from a
  // collection reference rather than from the database handle.
  if (/^collection\s*\(/.test(first)) {
    const nested = parsePathCall(first, constants);
    if (nested) {
      const depth = nested.path.split("/").length;
      const rest = segments.map(
        (s, i) => resolveSegment(s, constants, (depth + i) % 2 === 0).value,
      );
      return { kind: head[1], path: [nested.path, ...rest].join("/"), bad: nested.bad };
    }
  }
  const parts = [];
  const bad = [];
  segments.forEach((s, index) => {
    const resolved = resolveSegment(s, constants, index % 2 === 0);
    if (!resolved.ok) bad.push(s.trim());
    parts.push(resolved.value);
  });
  return { kind: head[1], path: parts.join("/"), bad };
}

/** `where` / `orderBy` / `limit`, with every value treated as dynamic. */
function parseClauses(args) {
  const clauses = [];
  let spread = false;
  for (const arg of args) {
    const text = arg.trim();
    if (text.startsWith("...")) {
      spread = true;
      continue;
    }
    const inner = () => balanced(text, text.indexOf("("));
    const unquote = (raw) => {
      const q = QUOTED.exec((raw ?? "").trim());
      return q ? (q[1] ?? q[2] ?? q[3] ?? "") : (raw ?? "").trim();
    };
    if (/^where\s*\(/.test(text)) {
      const parts = splitArgs(inner().text);
      clauses.push(`where(${unquote(parts[0])},${unquote(parts[1])})`);
    } else if (/^orderBy\s*\(/.test(text)) {
      const parts = splitArgs(inner().text);
      clauses.push(`orderBy(${unquote(parts[0])},${parts[1] ? unquote(parts[1]) : "asc"})`);
    } else if (/^limit\s*\(/.test(text)) {
      clauses.push("limit()");
    } else {
      // Anything else in a constraint position is a shape this scanner cannot
      // read, and silence is the one outcome that is never acceptable here.
      spread = true;
    }
  }
  return { clauses, spread };
}

/**
 * The shapes one read argument can take. A bare identifier is resolved against
 * the nearest preceding declaration in the same file, which is what makes
 * `const q = query(...)` and `const ref = doc(...)` readable without a parser;
 * a reference assigned by a ternary is reported rather than picked from.
 */
function shapesFor(expr, source, constants, readAt, depth = 0) {
  const text = expr.trim();
  if (/^query\s*\(/.test(text)) {
    const inner = balanced(text, text.indexOf("("));
    const args = splitArgs(inner.text);
    const base = parsePathCall(args[0] ?? "", constants);
    if (!base) return [{ unresolved: `query() over ${args[0]}` }];
    const { clauses, spread } = parseClauses(args.slice(1));
    if (spread) {
      return [{ path: base.path, clauses, unresolved: "constraints spread into query()" }];
    }
    return [{ path: base.path, clauses, bad: base.bad }];
  }
  if (/^(collection|doc)\s*\(/.test(text)) {
    const base = parsePathCall(text, constants);
    return base ? [{ path: base.path, clauses: [], bad: base.bad }] : [{ unresolved: text }];
  }
  if (/^collectionGroup\s*\(/.test(text)) {
    return [{ unresolved: `collection group query: ${text}` }];
  }
  if (IDENTIFIER.test(text) && depth < 2) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${text}\\s*(?::[^=]+)?=\\s*`, "g");
    const all = [...source.matchAll(decl)];
    if (all.length === 0) return [{ unresolved: `identifier ${text}` }];
    const before = all.filter((hit) => hit.index < readAt);
    const hits = before.length ? [before[before.length - 1]] : all;
    const out = [];
    for (const hit of hits) {
      const rest = source.slice(hit.index + hit[0].length);
      const stop = rest.search(/;\s*\n/);
      const rhs = (stop === -1 ? rest.slice(0, 400) : rest.slice(0, stop)).trim();
      if (/^[^?]*\?[\s\S]*:/.test(rhs) && /(collection|doc)\s*\(/.test(rhs)) {
        out.push({
          unresolved: `reference chosen by a ternary: ${rhs.replace(/\s+/g, " ").slice(0, 110)}`,
        });
        continue;
      }
      out.push(...shapesFor(rhs, source, constants, readAt, depth + 1));
    }
    return out;
  }
  return [{ unresolved: text.replace(/\s+/g, " ").slice(0, 110) }];
}

/** Every read site in `src`, resolved as far as the scanner can take it. */
function scanSrc() {
  const files = walk(SRC);
  const constants = collectConstants(files);
  const sites = [];
  for (const full of files) {
    const raw = readFileSync(full, "utf8");
    if (!CLIENT_SDK.test(raw)) continue;
    const source = stripComments(raw);
    READ_FN.lastIndex = 0;
    let match;
    while ((match = READ_FN.exec(source)) !== null) {
      const open = source.indexOf("(", match.index + (match[1] ? match[1].length : 0));
      const args = balanced(source, open);
      const line = source.slice(0, match.index).split("\n").length;
      if (!args) {
        // An argument list the walker cannot close (an unmatched bracket
        // inside a regex literal, say) was the one place a read could vanish
        // without a trace. It lands in UNRESOLVED instead, where an entry has
        // to own it or the coverage test fails.
        sites.push({
          file: toPosix(full),
          line,
          fn: match[1] ?? "tx.get",
          unresolved: "could not read the argument list",
        });
        continue;
      }
      const first = splitArgs(args.text)[0] ?? "";
      for (const shape of shapesFor(first, source, constants, match.index)) {
        sites.push({ file: toPosix(full), line, fn: match[1] ?? "tx.get", ...shape });
      }
    }
  }
  return sites;
}

/** A registry path is written with names; the scanner emits bare braces. */
const normalisePath = (path) => path.replace(/\{[^}]*\}/g, "{}");
const siteKey = (file, path, clauses) =>
  `${file}::${normalisePath(path)}::${[...clauses].join(" ")}`;

const SCANNED = scanSrc();
const RESOLVED = new Map();
const UNRESOLVED = new Map();
for (const site of SCANNED) {
  if (site.unresolved || (site.bad && site.bad.length)) {
    const detail = site.unresolved ?? `unreadable collection name: ${site.bad.join(", ")}`;
    const list = UNRESOLVED.get(site.file) ?? [];
    list.push({ ...site, detail });
    UNRESOLVED.set(site.file, list);
    continue;
  }
  const key = siteKey(site.file, site.path, site.clauses);
  const found = RESOLVED.get(key) ?? { ...site, lines: [] };
  found.lines.push(site.line);
  RESOLVED.set(key, found);
}

describe("client queries: the scan and the registry agree", () => {
  it("every client-direct read in src has a registry entry", () => {
    const registered = new Set(
      REGISTRY.filter((e) => !e.unresolved).map((e) => siteKey(e.file, e.path, e.clauses)),
    );
    const missing = [...RESOLVED.values()]
      .filter((site) => !registered.has(siteKey(site.file, site.path, site.clauses)))
      .map(
        (site) =>
          `${site.file}:${site.lines.join(",")}  ${site.fn}  ${site.path} [${site.clauses.join(" ")}]`,
      )
      .sort();

    assert.deepEqual(
      missing,
      [],
      `These client-direct reads have no entry in client-queries.registry.mjs.\n\nFirestore judges a list on the query's SHAPE, so a new read can be refused for the very people the page admits, with an empty collection and no error anyone sees. Add an entry naming the gate the caller sits behind and giving every base persona an outcome:\n\n  ${missing.join(
        "\n  ",
      )}`,
    );
  });

  it("every registry entry still matches a read in src", () => {
    const live = new Set([...RESOLVED.keys()]);
    const stale = REGISTRY.filter((e) => !e.unresolved)
      .filter((e) => !live.has(siteKey(e.file, e.path, e.clauses)))
      .map((e) => `${e.id}  ${e.file}  ${e.path} [${e.clauses.join(" ")}]`)
      .sort();

    assert.deepEqual(
      stale,
      [],
      `These registry entries match no read in src any more. Delete them, or fix the shape they claim, so the list keeps meaning something:\n\n  ${stale.join(
        "\n  ",
      )}`,
    );
  });

  it("every read the scanner cannot resolve is declared by an entry", () => {
    const declared = new Set(REGISTRY.filter((e) => e.unresolved).map((e) => e.file));
    const undeclared = [];
    const miscounted = [];
    for (const [file, sites] of UNRESOLVED) {
      if (!declared.has(file)) {
        for (const site of sites) undeclared.push(`${file}:${site.line}  ${site.detail}`);
        continue;
      }
      // The declaration is per file, but the file's entries describe ONE
      // unreadable read each. A second unreadable read added beside it would
      // otherwise ride the existing declaration unseen, so the registry also
      // states how many such reads the file carries.
      const expected = UNRESOLVED_SITE_COUNTS[file];
      if (expected !== sites.length) {
        miscounted.push(
          `${file}: ${sites.length} unreadable read(s) found, ${expected ?? "none"} declared in UNRESOLVED_SITE_COUNTS: ${sites
            .map((s) => `line ${s.line} (${s.detail})`)
            .join("; ")}`,
        );
      }
    }
    assert.deepEqual(
      undeclared.sort(),
      [],
      `The scanner cannot work out the shape of these reads, so it cannot guard them. Add a registry entry for the file whose \`unresolved\` field writes down the shapes the site can take and how they were enumerated (read the call sites; do not guess):\n\n  ${undeclared.join(
        "\n  ",
      )}`,
    );

    assert.deepEqual(
      miscounted,
      [],
      `The number of unreadable reads in these files no longer matches UNRESOLVED_SITE_COUNTS in client-queries.registry.mjs. A new unreadable read needs its own entries declaring the shapes it can take; a removed one needs the count lowered:\n\n  ${miscounted.join(
        "\n  ",
      )}`,
    );

    const stale = REGISTRY.filter((e) => e.unresolved && !UNRESOLVED.has(e.file))
      .map((e) => `${e.id}  ${e.file}`)
      .sort();
    assert.deepEqual(
      stale,
      [],
      `These entries declare an unresolvable read, but the scanner can now read every site in that file. Either the code was made legible (delete the \`unresolved\` field and let the shape be matched) or the read is gone:\n\n  ${stale.join(
        "\n  ",
      )}`,
    );

    const staleCounts = Object.keys(UNRESOLVED_SITE_COUNTS).filter((file) => !UNRESOLVED.has(file));
    assert.deepEqual(
      staleCounts,
      [],
      `UNRESOLVED_SITE_COUNTS names files in which the scanner can now read every site. Delete the entries:\n\n  ${staleCounts.join(
        "\n  ",
      )}`,
    );
  });

  it("every unresolved declaration pins the call sites it enumerated", () => {
    // The shapes an `unresolved` entry claims live only in its prose, because
    // the scanner cannot match them, so each entry also pins the literal call
    // site it was read from. Change the call and the pin fails, which is the
    // stale check the ordinary bidirectional match cannot give these entries.
    const broken = [];
    for (const entry of REGISTRY.filter((e) => e.unresolved)) {
      assert.ok(
        Array.isArray(entry.pins) && entry.pins.length > 0,
        `${entry.id} declares an unresolvable read but pins no call site; name the file and the literal text the shape was read from.`,
      );
      for (const pin of entry.pins) {
        const full = join(REPO_ROOT, pin.file);
        const source = existsSync(full) ? readFileSync(full, "utf8") : "";
        if (!source.includes(pin.text)) {
          broken.push(`${entry.id}: ${pin.file} no longer contains ${JSON.stringify(pin.text)}`);
        }
      }
    }
    assert.deepEqual(
      broken.sort(),
      [],
      `These call sites no longer read the way their registry entry says. Re-read the caller and update the entry's shape, outcomes and pin together:\n\n  ${broken.join(
        "\n  ",
      )}`,
    );
  });

  it("entries that share a scanner key name each other", () => {
    // Two entries may describe one scanned site when the FIXTURE is the
    // interesting variable (the two adminLocks id shapes, a task the viewer
    // is and is not on). The stale check then sees the key through either
    // entry, so the pair is written down and checked for symmetry here.
    const byId = new Map(REGISTRY.map((e) => [e.id, e]));
    for (const entry of REGISTRY) {
      if (entry.sharesKeyWith === undefined) continue;
      const other = byId.get(entry.sharesKeyWith);
      assert.ok(other, `${entry.id} shares its key with ${entry.sharesKeyWith}, which does not exist.`);
      assert.equal(
        other.sharesKeyWith,
        entry.id,
        `${entry.id} names ${entry.sharesKeyWith} as its pair, but that entry does not name it back.`,
      );
      assert.equal(
        siteKey(other.file, other.path, other.clauses),
        siteKey(entry.file, entry.path, entry.clauses),
        `${entry.id} and ${entry.sharesKeyWith} claim to share a scanner key but scan to different ones.`,
      );
    }
    const keyed = new Map();
    for (const entry of REGISTRY.filter((e) => !e.unresolved)) {
      const key = siteKey(entry.file, entry.path, entry.clauses);
      const list = keyed.get(key) ?? [];
      list.push(entry);
      keyed.set(key, list);
    }
    for (const [key, entries] of keyed) {
      if (entries.length < 2) continue;
      for (const entry of entries) {
        assert.ok(
          entry.sharesKeyWith !== undefined,
          `${entry.id} shares the scanner key ${key} with ${entries
            .filter((e) => e !== entry)
            .map((e) => e.id)
            .join(", ")} but does not say so; add sharesKeyWith so the reader knows the stale check covers both.`,
        );
      }
    }
  });

  it("every entry carries a written reason, a persona outcome, and a document shape", () => {
    const personaKeys = new Set(PERSONAS.map((p) => p.key));
    const ids = new Set();
    for (const entry of REGISTRY) {
      assert.ok(!ids.has(entry.id), `${entry.id} is used by two entries; ids must be unique.`);
      ids.add(entry.id);
      assert.ok(
        typeof entry.reason === "string" && entry.reason.length > 80,
        `${entry.id} needs a real reason, not a placeholder: name the gate the caller sits behind and why the shape passes it.`,
      );
      for (const persona of BASE_PERSONAS) {
        assert.ok(
          entry.outcomes[persona] === "allowed" || entry.outcomes[persona] === "refused",
          `${entry.id} leaves the ${persona} persona silent. Every base persona gets an outcome, so a refusal is a decision somebody wrote down rather than an omission.`,
        );
      }
      for (const key of Object.keys(entry.outcomes)) {
        assert.ok(
          personaKeys.has(key),
          `${entry.id} names a persona (${key}) that PERSONAS does not define.`,
        );
      }
      // A path with an even number of segments addresses a DOCUMENT, and a
      // single-document read is judged against that document's own data, so
      // the entry has to say which document its fixture stands for.
      if (normalisePath(entry.path).split("/").length % 2 === 0) {
        assert.ok(
          typeof entry.docShape === "string" && entry.docShape.length > 40,
          `${entry.id} reads one document, so it needs a docShape saying which document the fixture stands for. A rule that dereferences resource.data refuses a read of a document that does not exist, so "any id" is not an answer.`,
        );
      }
      if (entry.unresolved !== undefined) {
        assert.ok(
          entry.unresolved.length > 80,
          `${entry.id} declares an unresolvable read, so it must say what the shapes are and how they were enumerated.`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Live execution against the emulator
// ---------------------------------------------------------------------------

const PERSONA_BY_KEY = new Map(PERSONAS.map((p) => [p.key, p]));

/**
 * Every persona's `users` document, written in one pass with rules disabled.
 *
 * Written as one `seed()` rather than through `seedUser()` per hat because
 * this file re-seeds the cast for every entry, and the read-back that helper
 * does for the Storage suite's benefit buys nothing here: no rule in this file
 * reaches across services.
 */
async function seedCast() {
  await seed(async (db) => {
    for (const persona of PERSONAS) {
      if (persona.anon) continue;
      await db
        .collection("users")
        .doc(persona.uid)
        .set({
          uid: persona.uid,
          email: `${persona.uid}@example.com`,
          displayName: persona.uid,
          createdAt: new Date(),
          ...persona.data,
        });
    }
    await db.collection("users").doc("admin1").get();
  });
}

const clientFor = (persona) => (persona.anon ? asAnon() : asUser(persona.uid));

for (const entry of REGISTRY) {
  describe(`client query: ${entry.id}`, () => {
    it(`is allowed or refused exactly as the registry states (${entry.path})`, async () => {
      await seedCast();
      for (const [key, expected] of Object.entries(entry.outcomes)) {
        const persona = PERSONA_BY_KEY.get(key);
        if (entry.seed) await seed(async (db) => entry.seed(db, persona));
        const db = await clientFor(persona);
        const query = entry.run(db, persona);
        const detail = `${entry.id}: ${entry.file} reading ${entry.path} [${entry.clauses.join(
          " ",
        )}] as ${key}. The registry says ${expected}. ${entry.reason}`;
        if (expected === "allowed") {
          await assertSucceeds(query).catch((err) => {
            throw new Error(`Expected ALLOWED, got refused. ${detail}\n\n${err}`);
          });
        } else {
          await assertFails(query).catch((err) => {
            throw new Error(`Expected REFUSED, got allowed. ${detail}\n\n${err}`);
          });
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Named regression cases: one per bug that actually shipped
// ---------------------------------------------------------------------------

describe("regression: profile subscriptions listener pins audience and audienceId", () => {
  it("serves a member with both clauses and is refused with only audienceId", async () => {
    // The bug, live from 6 May 2026 to commit 7e6c38c (PR #261): the listener
    // pinned `audienceId` alone. The rule grants a non-admin
    // `audience == 'user' && audienceId == request.auth.uid`, and a query that
    // does not pin `audience` has a shape that could match a guest row, so the
    // whole listen was denied and the Email preferences grid rendered empty.
    // Admins never saw it, because their branch of the rule has no such test.
    await seedCast();
    await seed(async (db) => {
      await db.doc("subscriptions/sub__member1__newsletter").set({
        email: "member1@example.com",
        channel: "newsletter",
        audience: "user",
        audienceId: "member1",
        confirmed: true,
        subscribed: true,
        source: "guard",
      });
    });

    const db = await asUser("member1");
    await assertSucceeds(
      db
        .collection("subscriptions")
        .where("audience", "==", "user")
        .where("audienceId", "==", "member1")
        .get(),
    );
    await assertFails(
      db.collection("subscriptions").where("audienceId", "==", "member1").get(),
    );

    // An admin passes either shape, which is exactly why the bug survived
    // eight weeks of admin use.
    const admin = await asUser("admin1");
    await assertSucceeds(
      admin.collection("subscriptions").where("audienceId", "==", "member1").get(),
    );
  });

  it("still carries both clauses in ProfileForm.tsx", () => {
    const source = readFileSync(join(SRC, "features", "profile", "ProfileForm.tsx"), "utf8");
    for (const clause of ['where("audience", "==", "user")', 'where("audienceId", "==", user.uid)']) {
      assert.ok(
        source.includes(clause),
        `src/features/profile/ProfileForm.tsx no longer contains ${clause}. Both clauses are load-bearing: dropping either one makes the subscriptions listener a query whose shape could match another audience's row, and Firestore refuses it wholesale for every non-admin. That is PR #261 undone.`,
      );
    }
  });
});

describe("regression: round editor run list under the narrowed courseRuns rule", () => {
  it("is refused for an SU committee reviewer with no course key, and allowed for the three staff hats", async () => {
    // V3 W3 PR20 narrowed `courseRuns` to `status != 'draft'` for a caller
    // holding no course permission. `/admin/admissions` admits an appointed
    // reviewer who is SU committee and holds neither course key, and
    // RoundEditor's unfiltered list is refused for them. NOTHING IS SEEDED
    // HERE ON PURPOSE: the refusal is a property of the query's shape, so it
    // happens with an empty collection, which is the half people do not
    // believe until they watch it.
    await seedCast();

    const reviewer = await asUser("sucom1");
    await assertFails(reviewer.collection("courseRuns").get());
    // The shape a member-facing list would have to carry instead. Note it is
    // `!= 'draft'` rather than `== 'published'`: CourseRunStatus has no
    // published member.
    await assertSucceeds(
      reviewer.collection("courseRuns").where("status", "!=", "draft").get(),
    );

    for (const uid of ["admin1", "drafter-course", "approver-course"]) {
      const staff = await asUser(uid);
      await assertSucceeds(staff.collection("courseRuns").get());
    }
  });
});

describe("regression: the admissions member run-list control carries status != draft", () => {
  it("is allowed filtered and refused unfiltered, for a plain member", async () => {
    // The same narrowing landed inside this suite's sibling: the 25-document
    // control in admissions.test.mjs lists `courseRuns` as a member, and had
    // to grow the status clause to keep passing. Pinned here as well, because
    // that control exists to prove something else entirely (that no get()
    // crept into a read rule) and would be quietly weakened by anyone
    // "simplifying" the clause away.
    await seedCast();
    await seed(async (db) => {
      await db.doc("courseRuns/published-run").set({
        courseId: "guard-course",
        label: "Open run",
        status: "applications-open",
        authorUid: "someone-else",
      });
      await db.doc("courseRuns/draft-run").set({
        courseId: "guard-course",
        label: "Draft run",
        status: "draft",
        authorUid: "someone-else",
      });
    });

    const member = await asUser("member1");
    const open = await assertSucceeds(
      member.collection("courseRuns").where("status", "!=", "draft").get(),
    );
    assert.equal(open.size, 1);
    await assertFails(member.collection("courseRuns").get());
  });

  it("still carries the clause in admissions.test.mjs", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "admissions.test.mjs"), "utf8");
    assert.ok(
      source.includes('where("status", "!=", "draft")'),
      'scripts/rules-tests/tests/admissions.test.mjs no longer contains where("status", "!=", "draft"). Without it the member control there is an unfiltered courseRuns list, which the narrowed rule refuses, and the 25-document regression it exists for stops being tested.',
    );
  });
});

describe("regression: the registration reads run before a users document exists", () => {
  it("serves a signed-in account with no users doc its own collaborator row and verification token", async () => {
    // /register and /collaborator both read Firestore as an account that has
    // signed in with Google and has NO `users` document yet. That matters
    // because `isAdmin()` resolves the caller's role with a get() on that
    // missing document, so the first branch of both rules cannot evaluate. The
    // reads survive on their second branch: `resource.data.uid ==
    // request.auth.uid` on collaborators, `resource.data.authUid ==
    // request.auth.uid` on the verification token. This case exists because a
    // rule rewrite that made either branch depend on the users document would
    // lock every new registrant out of the flow that creates it, and no other
    // test here runs as an account without a users row.
    const newcomer = "newcomer-no-user-doc";
    await seed(async (db) => {
      await db.collection("collaborators").doc(`collab__${newcomer}`).set({
        uid: newcomer,
        status: "pending",
        name: "Guard applicant",
      });
      await db.collection("emailVerifications").doc(`token__${newcomer}`).set({
        authUid: newcomer,
        email: `${newcomer}@nottingham.ac.uk`,
        verifiedAt: null,
      });
    });

    const db = await asUser(newcomer);
    await assertSucceeds(db.collection("collaborators").where("uid", "==", newcomer).get());
    await assertSucceeds(db.doc(`emailVerifications/token__${newcomer}`).get());

    // The controls: without the own-uid clause the collaborators list is a
    // membership enumeration, and the users collection stays shut to them.
    await assertFails(db.collection("collaborators").get());
    await assertFails(db.collection("users").get());
  });
});
