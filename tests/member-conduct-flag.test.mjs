/**
 * The conduct flag: the reviewer projection, and source pins on the one route
 * allowed to write `memberConductFlags/{uid}`.
 *
 * ## Why the projection is tested this hard for a two-key object
 *
 * `conductFlagForQueue` is the boundary between "a reviewer knows to ask an
 * admin" and "a rotating pool of student reviewers reads an allegation about a
 * named classmate". The failure mode is not a thrown error, it is a payload
 * that quietly carries one extra key, so the assertions are on the KEY SET and
 * not only on the values: a `reason` that is present but empty is one careless
 * `Object.keys` away from being logged, exported, or rendered as a blank field
 * that invites somebody to fill it in.
 *
 * ## Why the rest are source pins
 *
 * The route is `import`-able only with `firebase-admin` and a request context,
 * so the properties that matter (the guard runs first, the gate is admin, the
 * clear is a delete) are asserted at the source in the `course-deletion.test.mjs`
 * idiom. If a pin fails, the route has drifted from the rule; do not fix it by
 * loosening the pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;
const STUBS = new Map([["server-only", "export {};"]]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const { conductChip, conductFlagForQueue, normalizeMemberConductFlag } = await loadTs(
  "lib/firestore/memberConductFlags.ts",
);

const ROUTE = readFileSync(
  join(SRC, "app", "api", "admin", "members", "[uid]", "conduct-flag", "route.ts"),
  "utf8",
);

/** Comments stripped: several pins below ask "does the code do X", and the
 *  comments in the file name the very things being asserted. */
const ROUTE_CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FLAG = normalizeMemberConductFlag("u1", {
  flagged: true,
  reason: "Shouted down another participant in week two and would not stop.",
  byUid: "admin1",
  byName: "Admin One",
  at: new Date("2026-10-12T09:30:00Z"),
});

// ===========================================================================
// The projection
// ===========================================================================

test("a non-admin viewer gets a boolean and NO reason key at all", () => {
  const chip = conductFlagForQueue(FLAG, false);
  assert.deepEqual(Object.keys(chip), ["flagged"]);
  assert.equal(chip.flagged, true);
  // Absent, not undefined and not null. A key that exists with an empty value
  // is a key a downstream reader can render, log or export.
  assert.equal("reason" in chip, false);
  assert.equal("flaggedAt" in chip, false);
  assert.equal("byUid" in chip, false);
  assert.equal("byName" in chip, false);
});

test("an unflagged member reads the same shape as a flagged one", () => {
  // A payload whose shape changes with the answer tells a reviewer something
  // by its silence. Both cases are one key.
  const none = conductFlagForQueue(null, false);
  assert.deepEqual(none, { flagged: false });
  assert.deepEqual(Object.keys(none), ["flagged"]);
});

test("an admin viewer gets the reason and the date, and nothing more", () => {
  const view = conductFlagForQueue(FLAG, true);
  assert.deepEqual(Object.keys(view).sort(), ["flagged", "flaggedAt", "reason"]);
  assert.equal(view.flagged, true);
  assert.equal(view.reason, FLAG.reason);
  assert.equal(view.flaggedAt, "2026-10-12T09:30:00.000Z");
});

test("an admin viewing an unflagged member gets empties, not a missing key", () => {
  // The admin shape is what the Members row renders against, so it is stable
  // whether or not there is a flag; only the reviewer shape narrows.
  const view = conductFlagForQueue(null, true);
  assert.deepEqual(view, { flagged: false, reason: "", flaggedAt: null });
});

test("the reason survives the projection exactly, capped only by the normaliser", () => {
  const long = "x".repeat(600);
  const flag = normalizeMemberConductFlag("u1", { flagged: true, reason: long });
  assert.equal(flag.reason.length, 500);
  assert.equal(conductFlagForQueue(flag, true).reason.length, 500);
  assert.equal("reason" in conductFlagForQueue(flag, false), false);
});

test("a doc that says flagged: false is not a flag, however it got there", () => {
  const cleared = normalizeMemberConductFlag("u1", {
    flagged: false,
    reason: "left behind by an older write",
  });
  assert.deepEqual(conductFlagForQueue(cleared, false), { flagged: false });
  assert.deepEqual(conductChip(cleared), { flagged: false });
});

// ===========================================================================
// Source pins on the route
// ===========================================================================

test("MODEL: the view-as guard runs before anything else the POST does", () => {
  const post = ROUTE_CODE.slice(ROUTE_CODE.indexOf("export async function POST"));
  const guard = post.indexOf("assertNotImpersonating()");
  assert.ok(guard > -1, "POST no longer calls assertNotImpersonating()");
  // Before the session lookup, before the body is read, before the write.
  for (const later of ["requireAdmin()", "ctx.params", "req.json()", "ref.set("]) {
    const at = post.indexOf(later);
    assert.ok(at > guard, `${later} runs before the view-as guard`);
  }
});

test("MODEL: both handlers are admin-only, and the gate is the live session", () => {
  assert.match(ROUTE_CODE, /getCurrentUser\(\)/);
  assert.match(ROUTE_CODE, /actor\.role !== "admin"/);
  for (const handler of ["export async function GET", "export async function POST"]) {
    const body = ROUTE_CODE.slice(ROUTE_CODE.indexOf(handler));
    assert.ok(
      body.indexOf("requireAdmin()") > -1,
      `${handler} does not go through the admin gate`,
    );
    assert.ok(
      body.indexOf("requireAdmin()") < body.indexOf("collection(COLLECTION)"),
      `${handler} touches the collection before checking the caller`,
    );
  }
});

test("MODEL: clearing DELETES the row rather than writing flagged: false", () => {
  // Absence is the cleared state (`conductChip(null)` is `{ flagged: false }`),
  // so a kept row would only preserve the allegation with nothing pointing at
  // it, and the account-deletion sweep would have a second shape to handle.
  assert.match(ROUTE_CODE, /if \(!body\.flagged\) \{[\s\S]*?ref\.delete\(\)/);
  assert.doesNotMatch(ROUTE_CODE, /flagged: false/);
});

test("MODEL: a flag without a reason is refused, and the cap is the shared one", () => {
  assert.match(ROUTE_CODE, /CONDUCT_FLAG_FIELD_LIMITS\.reason/);
  assert.match(ROUTE_CODE, /const reason = cleanReason\(body\.reason\);\s*if \(!reason\)/);
  // 400, not a silently-empty flag.
  const at = ROUTE_CODE.indexOf("if (!reason)");
  assert.match(ROUTE_CODE.slice(at, at + 400), /status: 400/);
});

test("MODEL: the write names its author and never touches users/{uid}", () => {
  const set = /ref\.set\(\{([\s\S]*?)\}\);/.exec(ROUTE_CODE);
  assert.ok(set, "the flag write is no longer a single set()");
  for (const field of ["uid,", "flagged: true", "reason,", "byUid:", "byName:", "at:"]) {
    assert.ok(set[1].includes(field), `the written document lost ${field}`);
  }
  // The whole point of the collection: nothing here writes to the user doc,
  // which is own-row readable and carries a live listener.
  assert.doesNotMatch(ROUTE_CODE, /collection\("users"\)\.doc\(uid\)\.(set|update)/);
});

test("MODEL: neither handler answers with the reviewer projection", () => {
  // Only admins reach this route, so both handlers use the admin shape. A
  // `false` here would mean an admin control that cannot show its own state.
  assert.match(ROUTE_CODE, /conductFlagForQueue\(flag, true\)/);
  assert.doesNotMatch(ROUTE_CODE, /conductFlagForQueue\([^)]*, false\)/);
});
