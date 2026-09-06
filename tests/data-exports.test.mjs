/**
 * Unit tests for `src/lib/firestore/dataExports.ts`, the log of every CSV the
 * site generates.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is pinned here, and why each part matters
 *
 *  - **logExport THROWS.** A route calls it immediately before it streams a
 *    file of named people, so a swallowed failure is an unlogged export. The
 *    rejecting-write test is the whole contract: if somebody later wraps the
 *    write in a try/catch "so an export never fails", this goes red.
 *  - **No `undefined` reaches Firestore.** `scope` has five optional keys and
 *    a route will pass `{ runId, groupId: undefined }` sooner or later.
 *    Firestore refuses undefined outright, which would turn a missing group
 *    id into a failed write and, through the rule above, a refused export.
 *  - **An unrecognised `kind` is kept verbatim.** A rolled-back deploy reading
 *    rows a newer build wrote must not re-label them as a different export.
 *  - **RETENTION POSTURE.** Neither cascade DELETES from this collection, and
 *    the tests at the bottom pin that against the cascade SOURCES. They are
 *    the executable half of the module comment: a future PR that adds a
 *    `dataExports` drain to account deletion or to DESTROY goes red and has
 *    to argue the case rather than land quietly. Counting is a different
 *    thing and is required, not forbidden: the run destroy manifest reports
 *    `dataExportRows` as retained, and a test below pins that too.
 *
 * ## The loader dance
 *
 * Same as tests/scheduler-markers.test.mjs: this repo's Node is v20 and
 * cannot import `.ts`, so the module is transpiled in memory with the
 * `typescript` devDependency, `@/…` is resolved by hand, and
 * `firebase-admin/firestore` is stubbed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** The sentinel the stubbed `FieldValue.serverTimestamp()` returns. */
const SERVER_TIMESTAMP = "__serverTimestamp__";

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      `  serverTimestamp: () => ({ __sentinel: "${SERVER_TIMESTAMP}" }),\n` +
      "};",
  ],
]);

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

const {
  DATA_EXPORTS_COLLECTION,
  DATA_EXPORT_KINDS,
  DATA_EXPORT_KIND_LABEL,
  DATA_EXPORT_LIMITS,
  DATA_EXPORT_SCOPE_KEYS,
  UNKNOWN_DATA_EXPORT_LABEL,
  compactScope,
  dataExportKindLabel,
  isDataExportKind,
  logExport,
  normalizeDataExport,
} = await loadTs("lib/firestore/dataExports.ts");

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

/**
 * The two behaviours `logExport` depends on and nothing else: `add()` records
 * the document, or rejects the way the Admin SDK does when a write cannot be
 * committed.
 */
function makeDb({ failWith = null } = {}) {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        async add(data) {
          if (failWith) throw failWith;
          writes.push({ collection: name, data });
          return { id: `auto-${writes.length}` };
        },
      };
    },
  };
}

const ENTRY = {
  kind: "roster",
  actorUid: "admin1",
  actorName: "A Nother Admin",
  scope: { runId: "precourse-autumn-2026__aa11bb22" },
  rowCount: 42,
  filename: "roster-precourse-autumn-2026.csv",
};

// ---------------------------------------------------------------------------
// §1 The kinds
// ---------------------------------------------------------------------------

describe("DataExportKind", () => {
  test("is exactly the six kinds the contract names", () => {
    assert.deepEqual(DATA_EXPORT_KINDS, [
      "register",
      "roster",
      "applications",
      "membership",
      "attendance-summary",
      // Worksheets (docs/worksheets.md): the circulation export, scoped by
      // `circulationId` rather than by the worksheet it was sent from.
      "worksheet-responses",
    ]);
  });

  test("every kind has a label", () => {
    for (const kind of DATA_EXPORT_KINDS) {
      assert.equal(typeof DATA_EXPORT_KIND_LABEL[kind], "string");
      assert.notEqual(DATA_EXPORT_KIND_LABEL[kind], "");
      assert.equal(dataExportKindLabel(kind), DATA_EXPORT_KIND_LABEL[kind]);
    }
  });

  test("a kind this build predates is labelled as unrecognised, never re-labelled", () => {
    // A newer route writing a kind this bundle has never seen must not be
    // rendered as one of the kinds it does know: an audit that mislabels a
    // row is worse than one that says it cannot name the action.
    assert.equal(isDataExportKind("survey-responses"), false);
    assert.equal(dataExportKindLabel("survey-responses"), UNKNOWN_DATA_EXPORT_LABEL);
  });
});

// ---------------------------------------------------------------------------
// §2 logExport
// ---------------------------------------------------------------------------

describe("logExport", () => {
  test("appends one row to dataExports with the fields the tab renders", async () => {
    const db = makeDb();
    const id = await logExport(db, ENTRY);
    assert.equal(id, "auto-1");
    assert.equal(db.writes.length, 1);
    const { collection, data } = db.writes[0];
    assert.equal(collection, DATA_EXPORTS_COLLECTION);
    assert.equal(data.kind, "roster");
    assert.equal(data.actorUid, "admin1");
    assert.equal(data.actorName, "A Nother Admin");
    assert.equal(data.rowCount, 42);
    assert.equal(data.filename, "roster-precourse-autumn-2026.csv");
    assert.deepEqual(data.scope, { runId: "precourse-autumn-2026__aa11bb22" });
    assert.equal(data.viaImpersonation, false);
    assert.deepEqual(data.at, { __sentinel: SERVER_TIMESTAMP });
  });

  test("THROWS when the write fails, so the route can refuse the export", async () => {
    // The contract of the whole module. An export that streams after a failed
    // log write is an unlogged copy of a list of named people.
    const boom = new Error("UNAVAILABLE");
    const db = makeDb({ failWith: boom });
    await assert.rejects(() => logExport(db, ENTRY), /UNAVAILABLE/);
    assert.equal(db.writes.length, 0);
  });

  test("never writes undefined, whatever the caller passes in scope", async () => {
    const db = makeDb();
    await logExport(db, {
      ...ENTRY,
      scope: {
        runId: "run1",
        groupId: undefined,
        roundId: "",
        periodId: null,
      },
    });
    const { scope } = db.writes[0].data;
    assert.deepEqual(scope, { runId: "run1" });
    for (const [key, value] of Object.entries(db.writes[0].data)) {
      assert.notEqual(value, undefined, `${key} must never be written undefined`);
    }
  });

  test("an unscoped export writes an empty map, not a map of nulls", async () => {
    const db = makeDb();
    await logExport(db, { ...ENTRY, scope: {} });
    assert.deepEqual(db.writes[0].data.scope, {});
  });

  test("records the view-as flag the caller passes, and defaults it to false", async () => {
    // Every export route calls assertNotImpersonating() first, so `false` is
    // what every real row carries. The flag is still accepted rather than
    // hard-coded, because the honest reading of `false` is "this request
    // presented no view-as marker" and only the caller knows that.
    const db = makeDb();
    await logExport(db, ENTRY);
    assert.equal(db.writes[0].data.viaImpersonation, false);
    await logExport(db, ENTRY, { viaImpersonation: true });
    assert.equal(db.writes[1].data.viaImpersonation, true);
  });

  test("clamps a silly rowCount and truncates long free text", async () => {
    const db = makeDb();
    await logExport(db, {
      ...ENTRY,
      actorName: "n".repeat(500),
      filename: "f".repeat(500),
      rowCount: -3,
    });
    const { data } = db.writes[0];
    assert.equal(data.rowCount, 0);
    assert.equal(data.actorName.length, DATA_EXPORT_LIMITS.actorName);
    assert.equal(data.filename.length, DATA_EXPORT_LIMITS.filename);
  });
});

// ---------------------------------------------------------------------------
// §3 Reading rows back
// ---------------------------------------------------------------------------

describe("normalizeDataExport", () => {
  test("reads a row the way logExport wrote it", () => {
    const at = new Date("2026-09-16T10:00:00Z");
    const row = normalizeDataExport("row1", {
      kind: "applications",
      actorUid: "admin1",
      actorName: "A Nother Admin",
      scope: { roundId: "autumn-2026-intake__k3f9a2b1" },
      rowCount: 87,
      filename: "applications-autumn-2026.csv",
      at,
      viaImpersonation: false,
    });
    assert.deepEqual(row, {
      id: "row1",
      kind: "applications",
      kindKnown: true,
      actorUid: "admin1",
      actorName: "A Nother Admin",
      scope: { roundId: "autumn-2026-intake__k3f9a2b1" },
      rowCount: 87,
      filename: "applications-autumn-2026.csv",
      at,
      viaImpersonation: false,
    });
  });

  test("keeps an unknown kind verbatim and flags it", () => {
    const row = normalizeDataExport("row2", { kind: "survey-responses" });
    assert.equal(row.kind, "survey-responses");
    assert.equal(row.kindKnown, false);
  });

  test("survives a half-written row without inventing values", () => {
    const row = normalizeDataExport("row3", {});
    assert.equal(row.kind, "");
    assert.equal(row.kindKnown, false);
    assert.equal(row.actorUid, "");
    assert.equal(row.rowCount, 0);
    assert.deepEqual(row.scope, {});
    assert.equal(row.at, null);
    assert.equal(row.viaImpersonation, false);
  });

  test("compactScope drops everything that is not a non-empty string", () => {
    assert.deepEqual(compactScope(undefined), {});
    assert.deepEqual(
      compactScope({ runId: "r", groupId: "", roundId: undefined, periodId: "2026-27" }),
      { runId: "r", periodId: "2026-27" },
    );
  });

  test("compactScope carries every declared scope key", () => {
    // The list is the contract, so exercise it rather than a hand-written
    // sample: a key declared on DataExportScope and left out of
    // DATA_EXPORT_SCOPE_KEYS would be silently dropped on the way to
    // Firestore, and the row would understate what the file covered.
    const every = Object.fromEntries(
      DATA_EXPORT_SCOPE_KEYS.map((key) => [key, `${key}-value`]),
    );
    assert.deepEqual(compactScope(every), every);
  });
});

// ---------------------------------------------------------------------------
// §3b Every scope key is RENDERED, or a row lies about what it covered
// ---------------------------------------------------------------------------

describe("the Exports tab renders every scope key", () => {
  test("formatScope has a branch for each entry of DATA_EXPORT_SCOPE_KEYS", () => {
    // `formatScope` falls back to "Whole site" when it recognises none of the
    // keys on a row. That fallback is right for a genuinely unscoped export
    // and actively WRONG for a scoped one it has never heard of: a CSV of one
    // circulation's answers would be displayed as an export of everything, on
    // the one control that survives the file leaving the platform. An
    // overstated audit row is worse than a blank cell, so the two lists are
    // pinned to each other here rather than left to review.
    const tab = readFileSync(
      join(REPO_ROOT, "src/features/admin/DeliverabilityExports.tsx"),
      "utf8",
    );
    for (const key of DATA_EXPORT_SCOPE_KEYS) {
      assert.match(
        tab,
        new RegExp(`scope\\.${key}\\b`),
        `DeliverabilityExports.tsx does not render the "${key}" scope key, so a ` +
          'row scoped by it renders as "Whole site". Add a line to formatScope ' +
          "in the same commit as the key.",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Retention posture: NEITHER cascade deletes from this collection
// ---------------------------------------------------------------------------

/**
 * Pinned against the cascade SOURCES rather than by running them: both are
 * `import "server-only"` Admin SDK modules that cannot be loaded here, and
 * the property being pinned is an absence, which a run could never prove.
 */
const CASCADE_SOURCES = [
  ["src/lib/firestore/accountDeletion.ts", "account deletion"],
  ["src/lib/firestore/courseDeletion.ts", "the run and course DESTROY cascade"],
];

/**
 * A delete addressed at this collection. NARROWED from the original "does not
 * mention dataExports at all": the run cascade now COUNTS these rows for the
 * destroy manifest (`dataExportRows`, fate retained), so a mention is not only
 * allowed, it is required by the house rule that every collection a PR adds is
 * named in the manifest. What must never appear is a delete or a drain.
 */
const DELETE_NEAR_EXPORTS =
  /collection\(\s*(?:DATA_EXPORTS_COLLECTION|"dataExports")\s*\)[\s\S]{0,400}?\.(?:delete|bulkDelete|recursiveDelete)\(/;

/** A cascade stage or drain function named after this collection. */
const EXPORT_DRAIN = /(?:drain|delete|purge|sweep)[A-Za-z]*DataExports?\b/;

const RETENTION_ARGUMENT =
  "Export rows are RETAINED by both cascades on purpose: a row names the " +
  "ACTOR of a staff action and holds no member content (a kind, an actor, a " +
  "scope of ids, a row count, a filename and a time), so erasing it because " +
  "that actor deleted their account, or because the run they exported was " +
  "destroyed, would delete the only evidence the export happened while " +
  "protecting nobody. `emailSends` and `impersonations` are the precedents, " +
  "each evidence about something that already left the platform. " +
  "`courseAudit` is NOT: the run cascade destroys it, because an audit row " +
  "about a register describes a row that same pass is deleting. If this is " +
  "being changed on purpose, change the module comment in " +
  "src/lib/firestore/dataExports.ts and the Retention section of the current " +
  "privacy policy in the same commit.";

describe("retention", () => {
  for (const [path, what] of CASCADE_SOURCES) {
    test(`${what} never deletes or drains dataExports`, () => {
      const source = readFileSync(join(REPO_ROOT, path), "utf8");
      assert.ok(
        !DELETE_NEAR_EXPORTS.test(source),
        `${path} deletes from dataExports. ${RETENTION_ARGUMENT}`,
      );
      assert.ok(
        !EXPORT_DRAIN.test(source),
        `${path} has a drain stage for dataExports. ${RETENTION_ARGUMENT}`,
      );
    });
  }

  test("the destroy manifest counts the rows it is keeping", () => {
    // The other half of the narrowing. A collection absent from the manifest
    // is one the confirmation dialog says nothing about, which leaves an
    // admin to guess whether the log goes with the run.
    const engine = readFileSync(
      join(REPO_ROOT, "src/lib/firestore/courseDeletion.ts"),
      "utf8",
    );
    assert.match(engine, /dataExportRows:\s*number;/);
    assert.match(engine, /DATA_EXPORTS_COLLECTION/);
    const meta = readFileSync(
      join(REPO_ROOT, "src/features/courses/useDestroy.ts"),
      "utf8",
    );
    assert.match(meta, /dataExportRows:\s*\{[\s\S]{0,200}?fate:\s*"retained"/);
  });

  test("the module comment still states the retained posture", () => {
    // The comment is the sentence a reader meets first; the tests above are
    // the guard. If one goes, both go, in the same commit.
    const source = readFileSync(
      join(REPO_ROOT, "src/lib/firestore/dataExports.ts"),
      "utf8",
    );
    assert.match(source, /RETAINED BY BOTH CASCADES/);
  });
});
