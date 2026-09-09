/**
 * NO WHOLE DOCUMENT IN A RESPONSE WITHOUT A PROJECTION THAT NAMES ITS READER.
 *
 * WHY. A normaliser (`normalizeAdmissionRound`, `normalizeCourseRun`) turns a
 * Firestore document into the shape the SERVER works with: every field,
 * typed. Handing that shape to a caller hands over every field, and the
 * audit of 8 September 2026 found routes doing exactly that: the admissions
 * rounds list serialised the whole round to any `draftCourse` holder, which
 * is how an applicant with that permission could read the live scoreboard of
 * their own intake, the uids deciding it and the criteria they were judged
 * against, four things the applicant projection is written to withhold. The
 * public event page did the same thing in HTML rather than JSON (found by the
 * events review, closed by `tests/public-client-props.test.mjs`). The class
 * is "the document is the response", and a projection function whose name
 * says who it serves (`serialiseRoundForApplicant`, `projectMembershipForMe`)
 * is the shape of the fix: the fields a persona may see are decided once, in
 * a function, and the route calls it.
 *
 * WHAT IT CHECKS. Every `NextResponse.json(...)` under `src/app/api`. The
 * first argument is read as a value, or as an object literal whose property
 * values and spreads are each read as a value. A value is RAW when it is a
 * document by one of these shapes:
 *
 *   - `snap.data()` / `doc.data()`, or a normaliser call (`normalize*`,
 *     `normalise*`), or a `.map(...)` whose callback ends in one of those;
 *   - an identifier bound, in the enclosing function, to any of the above
 *     (the binding's WHOLE expression is read, and the last `.map` in its
 *     chain decides, so `docs.map(normalize...).filter(...).map(projectRow)`
 *     is projected and `docs.map(normalize...)` is not);
 *   - a spread of such an identifier;
 *   - a ternary or `??` whose branch is any of the above.
 *
 * A value is PROJECTED when the outermost call, or the last `.map` callback,
 * is a name in `PROJECTIONS`, the registry of projection functions with the
 * persona each one serves. A raw value fails unless the site is in `ALLOWED`
 * with the reason the whole document is the right answer for the persona the
 * route admits. Both directions on both lists: a projection nobody calls
 * fails, an allowed site that has since been projected fails.
 *
 * WHAT IT CANNOT SEE. A document that reaches the response through a helper
 * in another module (`return NextResponse.json(await buildBoard(...))`) is
 * invisible here: the scan reads the route file and the bindings in it, not
 * the helper's return value. A single field of a document (`round.status`,
 * `run?.id`) is not a document and is not flagged. Text responses (the CSV
 * exports, the calendar feed, the HTML confirmation pages) are outside this
 * file; `tests/data-exports.test.mjs` owns the exports. The scanner's reading
 * is exercised on synthetic sites at the bottom of this file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";
import {
  assertReadableSource,
  balancedEnd,
  moduleScope,
  walkRoutes,
} from "./lib/routeScan.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(REPO_ROOT, "src", "app", "api");

// ---------------------------------------------------------------------------
// The registries
// ---------------------------------------------------------------------------

/**
 * Every function that turns a server-side document into what ONE persona may
 * see. `serves` names the persona; `why` says what the projection withholds
 * or adds, so a reader can tell whether a new route is calling the right one.
 */
const PROJECTIONS = {
  serialiseRound: {
    from: "@/lib/admissions/roundRoutes",
    serves:
      "the canSeeRound bar: round authors (admin or approveCourse), draftCourse holders, and " +
      "the round's own reviewers and decider",
    why:
      "the whole round, dates as ISO strings: the console's shape, with the scoreboard, the " +
      "reviewer uids and the criteria that serialiseRoundForApplicant withholds. RECORDED: the " +
      "draftCourse admission is documented intent in roundRoutes.ts and RoundEditor.tsx and is " +
      "the audit's open low finding; a draftCourse holder who is also an applicant sees their " +
      "own round whole. Narrowing it is one edit to canSeeRound and an owner decision.",
  },
  serialiseStage: {
    from: "@/lib/admissions/roundRoutes",
    serves: "round authors and the round's own reviewers",
    why: "a stage with its questions and its release state, for the console that edits them",
  },
  serialiseRoundForApplicant: {
    from: "@/lib/admissions/applyRoutes",
    serves: "the applicant",
    why: "withholds applicationCounts, reviewerUids, finalDeciderUid, criteria, scoreScale and blind",
  },
  serialiseStageForApplicant: {
    from: "@/lib/admissions/applyRoutes",
    serves: "the applicant",
    why: "only a released stage's questions, with its own deadline resolved against the round's",
  },
  serialiseApplicationForOwner: {
    from: "@/lib/admissions/applyRoutes",
    serves: "the applicant, on their own application",
    why: "withholds reviewer scores, notes and the decision trail; adds the open state of each stage",
  },
  projectImportBatch: {
    from: "@/lib/firestore/membershipImports",
    serves: "admins and manageMembership holders",
    why: "the batch's counters and status without the raw upload",
  },
  projectImportRow: {
    from: "@/lib/firestore/membershipImports",
    serves: "admins and manageMembership holders",
    why: "one import row with its match state; the console needs every column it shows",
  },
  projectMembershipRow: {
    from: "@/features/admin/membershipList",
    serves: "admins and manageMembership holders",
    why: "one membership record as the console lists it, with the member's name resolved",
  },
  projectMembershipForMe: {
    from: "@/lib/firestore/memberships",
    serves: "the member, about their own membership",
    why: "the current period and the member's own history, nothing about anybody else",
  },
  toRegistrationView: {
    from: "@/lib/firestore/registrations",
    serves: "admins",
    why: "the signup tracker row as the admin console renders it",
  },
  conductFlagForQueue: {
    from: "@/lib/firestore/memberConductFlags",
    serves: "admins",
    why: "the conduct flag as the approvals queue shows it, with the reviewer's uid resolved to a name",
  },
};

/**
 * Exported functions named like projections that no route response calls
 * directly, each with where it is applied instead. The reverse walk below
 * finds every such export under src/lib and src/features and requires it to
 * be here or in PROJECTIONS, so a projection can be neither used nor written
 * down.
 */
const PROJECTIONS_ELSEWHERE = {
  projectGroupForPicker: {
    from: "src/features/courses/fetchGroupPicker.ts",
    why: "applied inside fetchGroupPicker, whose result the enrol route returns; a document that reaches a response through a helper is this scan's documented blind spot",
  },
  serialiseNotifications: {
    from: "src/lib/firestore/notifications.ts",
    why: "shapes the notifications map for a WRITE (the profile form, sign-in and the migration route), never a response",
  },
  serialisePush: {
    from: "src/lib/firestore/notifications.ts",
    why: "the push half of the same write, from the profile form",
  },
  serializeTipTapDoc: {
    from: "src/features/tasks/lib/comments/markdown.ts",
    why: "turns editor state into markdown in the browser; not a document projection at all",
  },
};

/**
 * Sites that return a document raw, each with the reason that is the right
 * answer for the persona the route admits. Keyed `path:line`.
 */
const ALLOWED = new Map([
  [
    "src/app/api/courses/[courseId]/page/route.ts:279",
    {
      serves: "the course's own authors (admin, draftCourse, approveCourse)",
      why:
        "The page editor's save echoes the page document it has just written so the editor can " +
        "adopt the server's normalisation. The document is the course's public pitch content, " +
        "authored by the caller, and carries nothing about any other person.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const NORMALISER = /^normali[sz]e[A-Z]\w*$/;

/** Top-level split of `text` on `sep`, ignoring brackets. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The index of `token` at bracket depth zero in `text`, or -1. */
function topLevelIndex(text, token) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (depth === 0 && text.startsWith(token, i)) return i;
  }
  return -1;
}

/** The last `.map(` at depth zero in `text`, with its callback text, or null. */
function lastTopLevelMap(text) {
  let depth = 0;
  let found = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0 && text.startsWith(".map(", i)) {
      const open = i + 4;
      const close = balancedEnd(text, open);
      if (close > open) found = { callback: text.slice(open + 1, close).trim() };
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
  }
  return found;
}

/** `name` when `text` is `name(...)` (or `await name(...)`) and nothing else. */
function outermostCall(text) {
  const match = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (!match) return null;
  const open = text.indexOf("(", match.index);
  const close = balancedEnd(text, open);
  return close === text.length - 1 ? match[1] : null;
}

/**
 * What a `.map` callback produces: a bare function name (`.map(projectRow)`),
 * the outermost call of an expression body, or, for a block body, the
 * outermost call of its last `return`. An object literal that spreads a
 * document (`({ id: d.id, ...d.data() })`) produces `.data()`; one that picks
 * fields by hand produces nothing, because that IS a projection, written
 * inline.
 */
function callbackProducer(callback) {
  const bare = /^[A-Za-z_$][\w$]*$/.exec(callback);
  if (bare) return bare[0];
  const arrow = topLevelIndex(callback, "=>");
  if (arrow < 0) return null;
  let body = callback.slice(arrow + 2).trim();
  if (body.startsWith("{") && balancedEnd(body, 0, "{", "}") === body.length - 1) {
    const inner = body.slice(1, -1);
    const ret = inner.lastIndexOf("return ");
    if (ret < 0) return null;
    body = inner.slice(ret + 7).trim().replace(/;\s*$/, "");
  }
  // A multi-line callback keeps the trailing comma Prettier puts before the
  // closing bracket of `.map(`.
  return producerOf(body.replace(/,\s*$/, ""));
}

/** The document-producing shape of one expression, or null. */
function producerOf(expression) {
  let text = expression.trim().replace(/^await\s+/, "");
  if (text.startsWith("(") && balancedEnd(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
  if (text.startsWith("{") && balancedEnd(text, 0, "{", "}") === text.length - 1) {
    for (const prop of splitTopLevel(text.slice(1, -1), ",")) {
      if (!prop.startsWith("...")) continue;
      const spread = producerOf(prop.slice(3));
      if (spread) return spread;
    }
    return null;
  }
  const call = outermostCall(text);
  if (call) return call;
  if (/(?:\?\.|\.)data\(\)$/.test(text)) return ".data()";
  return null;
}

/**
 * Classify one value expression: "raw", "projected" or "other", with the
 * name that decided it.
 */
export function classify(expr, bindings, seen = new Set()) {
  let text = expr.trim().replace(/^\.\.\./, "").replace(/^await\s+/, "");
  if (text.startsWith("(") && balancedEnd(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim();
  }
  // A ternary: either branch being raw makes the value raw.
  const q = topLevelIndex(text, "?");
  if (q > 0 && text[q + 1] !== "?" && text[q + 1] !== ".") {
    const colon = topLevelIndex(text.slice(q + 1), ":");
    if (colon > -1) {
      const branches = [text.slice(q + 1, q + 1 + colon), text.slice(q + 2 + colon)];
      const results = branches.map((b) => classify(b, bindings, seen));
      const raw = results.find((r) => r.kind === "raw");
      if (raw) return raw;
      const projected = results.find((r) => r.kind === "projected");
      return projected ?? { kind: "other", by: "ternary" };
    }
  }
  const coalesce = topLevelIndex(text, "??");
  if (coalesce > 0) return classify(text.slice(0, coalesce), bindings, seen);

  const map = lastTopLevelMap(text);
  if (map) {
    const producer = callbackProducer(map.callback);
    if (producer && producer in PROJECTIONS) return { kind: "projected", by: producer };
    if (producer === ".data()" || (producer && NORMALISER.test(producer))) {
      return { kind: "raw", by: `.map(${producer})` };
    }
    return { kind: "other", by: "map" };
  }
  const call = outermostCall(text);
  if (call) {
    if (call in PROJECTIONS) return { kind: "projected", by: call };
    if (NORMALISER.test(call)) return { kind: "raw", by: call };
    return { kind: "other", by: call };
  }
  if (/^[A-Za-z_$][\w$]*(?:\?\.|\.)data\(\)$/.test(text)) return { kind: "raw", by: ".data()" };
  const ident = /^[A-Za-z_$][\w$]*$/.exec(text);
  if (ident && bindings.has(ident[0]) && !seen.has(ident[0])) {
    const inner = classify(bindings.get(ident[0]), bindings, new Set([...seen, ident[0]]));
    return inner.kind === "other" ? inner : { ...inner, by: `${ident[0]} = ${inner.by}` };
  }
  return { kind: "other", by: "expression" };
}

/** `const NAME = <expression>;` bindings in `body`, name -> expression. */
export function bindingsOf(body) {
  const found = new Map();
  const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/g;
  let match;
  while ((match = decl.exec(body)) !== null) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    for (; end < body.length; end++) {
      const c = body[end];
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) depth -= 1;
      else if (c === ";" && depth === 0) break;
    }
    found.set(match[1], body.slice(start, end));
  }
  return found;
}

/** The property values (and spreads) of an object literal, or the value itself. */
export function valuesOf(arg) {
  const text = arg.trim();
  if (!(text.startsWith("{") && balancedEnd(text, 0, "{", "}") === text.length - 1)) return [text];
  const values = [];
  for (const prop of splitTopLevel(text.slice(1, -1), ",")) {
    if (prop.startsWith("...")) {
      values.push(prop);
      continue;
    }
    const colon = topLevelIndex(prop, ":");
    if (colon < 0) {
      values.push(prop); // shorthand
      continue;
    }
    // A method shorthand (`key() {}`) or a computed key is not a value.
    if (/^[A-Za-z_$][\w$]*\s*\(/.test(prop)) continue;
    values.push(prop.slice(colon + 1).trim());
  }
  return values;
}

/** Every `NextResponse.json(` site in the tree with its classification. */
export function scanTree() {
  const sites = [];
  for (const file of walkRoutes(API_DIR)) {
    const raw = readFileSync(file, "utf8");
    const source = stripSource(raw);
    const path = relative(REPO_ROOT, file).split("\\").join("/");
    assertReadableSource(raw, source, path);
    const scope = moduleScope(source, stripSource(raw, { keepStrings: true }));
    const call = /NextResponse\.json\s*\(/g;
    let match;
    while ((match = call.exec(source)) !== null) {
      const open = source.indexOf("(", match.index);
      const close = balancedEnd(source, open);
      const [arg] = splitTopLevel(source.slice(open + 1, close), ",");
      if (!arg) continue;
      const line = source.slice(0, match.index).split("\n").length;
      // The enclosing function: the innermost module-scope span containing
      // the call, else the whole file.
      let enclosing = source;
      let best = Infinity;
      for (const span of scope.locals.values()) {
        if (span.start <= match.index && match.index <= span.end && span.end - span.start < best) {
          enclosing = span.text;
          best = span.end - span.start;
        }
      }
      const bindings = bindingsOf(enclosing);
      for (const value of valuesOf(arg)) {
        const verdict = classify(value, bindings);
        sites.push({ key: `${path}:${line}`, path, line, value, ...verdict });
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const sites = scanTree();

describe("no whole document reaches a response without a projection", () => {
  test("the scan found the tree", () => {
    assert.ok(sites.length > 1000, `only ${sites.length} response values found under src/app/api`);
  });

  test("every raw document in a response is projected or allowed", () => {
    const failures = [];
    const rawKeys = new Set();
    for (const site of sites) {
      if (site.kind !== "raw") continue;
      rawKeys.add(site.key);
      if (ALLOWED.has(site.key)) continue;
      failures.push(
        `${site.key} returns a document raw (${site.by}): ${site.value.replace(/\s+/g, " ").slice(0, 90)}. ` +
          "Pass it through a projection in PROJECTIONS that names the persona, or add an ALLOWED entry with the reason.",
      );
    }
    for (const key of ALLOWED.keys()) {
      if (!rawKeys.has(key)) failures.push(`ALLOWED names ${key}, which no longer returns a document raw. Delete the entry.`);
    }
    assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  });

  test("every ALLOWED entry carries a reason and names the persona", () => {
    for (const [key, entry] of ALLOWED) {
      assert.ok(typeof entry.serves === "string" && entry.serves.length > 3, `ALLOWED["${key}"] must say who is served.`);
      assert.ok(typeof entry.why === "string" && entry.why.length > 60, `ALLOWED["${key}"] needs a reason a reader can check.`);
    }
  });

  test("every projection in PROJECTIONS is used by a response, and says who it serves", () => {
    const used = new Set();
    for (const site of sites) {
      if (site.kind !== "projected") continue;
      used.add(site.by.split(" = ").pop());
    }
    for (const [name, entry] of Object.entries(PROJECTIONS)) {
      assert.ok(used.has(name), `PROJECTIONS.${name} projects no response. Delete it, or the route that used it has changed.`);
      assert.ok(entry.serves.length > 3, `PROJECTIONS.${name} must name the persona it serves.`);
      assert.ok(entry.why.length > 30, `PROJECTIONS.${name} must say what it withholds or adds.`);
    }
  });

  test("every projection comes from where PROJECTIONS says, wherever a route imports it", () => {
    for (const file of walkRoutes(API_DIR)) {
      const raw = readFileSync(file, "utf8");
      const scope = moduleScope(stripSource(raw), stripSource(raw, { keepStrings: true }));
      const path = relative(REPO_ROOT, file).split("\\").join("/");
      for (const [name, entry] of Object.entries(PROJECTIONS)) {
        const spec = scope.imports.get(name);
        if (!spec) continue;
        assert.equal(
          spec,
          entry.from,
          `PROJECTIONS.${name} says ${entry.from}; ${path} imports it from ${spec}.`,
        );
      }
    }
  });

  test("every projection-named export under src is in PROJECTIONS or PROJECTIONS_ELSEWHERE", () => {
    const pattern =
      /export\s+(?:async\s+)?function\s+((?:serialis|serializ|project|redact)[A-Za-z]*|to[A-Z][A-Za-z]*View|[A-Za-z]+For(?:Queue|Applicant|Owner|Me|Picker))\s*[<(]/g;
    const found = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = stripSource(readFileSync(full, "utf8"));
          for (const match of source.matchAll(pattern)) {
            found.set(match[1], relative(REPO_ROOT, full).split("\\").join("/"));
          }
        }
      }
    };
    walk(join(REPO_ROOT, "src", "lib"));
    walk(join(REPO_ROOT, "src", "features"));
    const unlisted = [...found].filter(([name]) => !(name in PROJECTIONS) && !(name in PROJECTIONS_ELSEWHERE));
    assert.deepEqual(
      unlisted.map(([name, file]) => `${name} (${file})`),
      [],
      "A function named like a projection is not written down. Add it to PROJECTIONS with the persona " +
        "it serves, or to PROJECTIONS_ELSEWHERE with where it is applied instead.",
    );
    for (const [name, entry] of Object.entries(PROJECTIONS_ELSEWHERE)) {
      assert.ok(found.has(name), `PROJECTIONS_ELSEWHERE.${name} is defined nowhere under src. Delete it.`);
      assert.equal(found.get(name), entry.from, `PROJECTIONS_ELSEWHERE.${name} is defined in ${found.get(name)}, not ${entry.from}.`);
      assert.ok(!(name in PROJECTIONS), `${name} is in both lists.`);
      assert.ok(entry.why.length > 40, `PROJECTIONS_ELSEWHERE.${name} needs a reason.`);
    }
  });

  test("report", () => {
    const counts = { raw: 0, projected: 0, other: 0 };
    for (const site of sites) counts[site.kind] += 1;
    console.log(
      `[response-projection] ${sites.length} response values: ${counts.projected} projected, ` +
        `${counts.raw} raw (${ALLOWED.size} allowed), ${counts.other} neither.`,
    );
  });
});

describe("the scanner's own reading", () => {
  const b = new Map([
    ["rows", 'docs.map((d) => normalizeRow(d.id, d.data() ?? {})).filter((r) => r.ok).map(projectImportRow)'],
    ["rawRows", "docs.map((d) => normalizeRow(d.id, d.data() ?? {}))"],
    ["round", "normalizeAdmissionRound(snap.id, snap.data() ?? {})"],
    ["saved", "serialiseRound(round)"],
  ]);
  test("a normaliser result is raw, a projection over it is not", () => {
    assert.equal(classify("normalizeThing(id, snap.data())", b).kind, "raw");
    assert.equal(classify("serialiseRound(round)", b).kind, "projected");
    assert.equal(classify("snap.data()", b).kind, "raw");
    assert.equal(classify("round.status", b).kind, "other");
  });
  test("a binding is read through, and the last map in a chain decides", () => {
    assert.equal(classify("rows", b).kind, "projected");
    assert.equal(classify("rawRows", b).kind, "raw");
    assert.equal(classify("round", b).kind, "raw");
    assert.equal(classify("saved", b).kind, "projected");
    assert.equal(classify("...round", b).kind, "raw");
  });
  test("a ternary is raw if either branch is; a coalesce reads its left side", () => {
    assert.equal(classify("loaded ? serialiseRound(loaded) : null", b).kind, "projected");
    assert.equal(classify("loaded ? round : null", b).kind, "raw");
    assert.equal(classify("round ?? null", b).kind, "raw");
  });
  test("an object literal's values are read one by one, a field is not a document", () => {
    assert.deepEqual(valuesOf("{ ok: true, round: serialiseRound(round), stages }"), [
      "true",
      "serialiseRound(round)",
      "stages",
    ]);
    assert.deepEqual(valuesOf("{ ...summary, count: rows.length }"), ["...summary", "rows.length"]);
  });
});
