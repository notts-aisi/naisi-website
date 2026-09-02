/**
 * The membership half of the account-deletion cascade, EXECUTED.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this step gets a real test
 *
 * A membership row is one person in one period, and the period carries a
 * cached per-tier count that the membership console renders as a headcount.
 * The first version of this sweep deleted the rows and left the counts alone,
 * so deleting an account silently made the console lie by one, in a number
 * nobody can reconcile against anything. The arithmetic that fixes it is
 * `increment(-1)` per tier per period, which is the same arithmetic the grant
 * route does when somebody presses revoke, and it is worth executing rather
 * than pinning: an off-by-one in the accumulation reads exactly like a
 * correct sweep.
 *
 * Faked: `firebase-admin/firestore` (sentinels this store can interpret) and
 * `server-only`. The functions under test are the real ones. Nothing here can
 * reach a Firestore project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
      "  arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),\n" +
      "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n" +
      "  increment: (by) => ({ __op: 'increment', by }),\n" +
      "};\n" +
      "export const FieldPath = { documentId: () => '__name__' };\n" +
      "export const Timestamp = { fromDate: (d) => d, now: () => new Date() };",
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
      // A plain string literal can look like an import ("su-import" carries
      // the word inside it). Anything that will not resolve is left alone.
      try {
        rewrites.set(specifier, import.meta.resolve(specifier));
      } catch {
        // Not a module.
      }
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

// ---------------------------------------------------------------------------
// A Firestore small enough to read: the memberships query this sweep makes,
// batched deletes, and addressed updates on the periods that carry the totals.
// ---------------------------------------------------------------------------

function makeDb({ memberships = {}, periods = {} } = {}) {
  const rows = new Map(Object.entries(memberships).map(([id, d]) => [id, { ...d }]));
  const periodDocs = new Map(
    Object.entries(periods).map(([id, d]) => [id, { ...d, totals: { ...d.totals } }]),
  );
  const updates = [];
  let batches = 0;

  function collection(name) {
    if (name === "memberships") {
      return {
        where(field, op, value) {
          assert.equal(field, "uid");
          assert.equal(op, "==");
          return {
            limit(n) {
              return {
                async get() {
                  const entries = [...rows.entries()]
                    .filter(([, data]) => data.uid === value)
                    .slice(0, n);
                  return {
                    empty: entries.length === 0,
                    size: entries.length,
                    docs: entries.map(([id, data]) => ({
                      id,
                      ref: { path: id },
                      exists: true,
                      data: () => ({ ...data }),
                    })),
                  };
                },
              };
            },
          };
        },
      };
    }
    if (name === "membershipPeriods") {
      return {
        doc: (id) => ({
          async update(data) {
            updates.push([id, data]);
            const period = periodDocs.get(id);
            if (!period) throw new Error(`NOT_FOUND: ${id}`);
            for (const [key, value] of Object.entries(data)) {
              const tier = key.replace("totals.", "");
              const by = value && value.__op === "increment" ? value.by : 0;
              period.totals[tier] = (period.totals[tier] ?? 0) + by;
            }
          },
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  }

  return {
    collection,
    batch() {
      const queued = [];
      return {
        delete(ref) {
          queued.push(ref.path);
        },
        async commit() {
          batches += 1;
          for (const id of queued) rows.delete(id);
        },
      };
    },
    rows,
    periods: periodDocs,
    updates,
    get batches() {
      return batches;
    },
  };
}

const { deleteMembershipsAndAdjustTotals, membershipTotalsGivenBack } = await loadTs(
  join("lib", "firestore", "accountDeletion.ts"),
);

// ---------------------------------------------------------------------------
// The accumulation, on its own
// ---------------------------------------------------------------------------

test("rows are accumulated per period AND per tier", () => {
  const back = membershipTotalsGivenBack([
    { periodId: "2025-26", tier: "paid" },
    { periodId: "2026-27", tier: "comped" },
    { periodId: "2026-27", tier: "comped" },
    { periodId: "2026-27", tier: "staff" },
  ]);
  assert.deepEqual(back.get("2025-26"), { paid: 1 });
  assert.deepEqual(back.get("2026-27"), { comped: 2, staff: 1 });
});

test("alumni is given back like any other tier", () => {
  // The period's totals carry a count per tier, alumni included, and the grant
  // route increments that count when the row is written. A sweep that skipped
  // alumni would leave the one tier that never enters paidMembershipYears
  // permanently over-counted.
  const back = membershipTotalsGivenBack([{ periodId: "2026-27", tier: "alumni" }]);
  assert.deepEqual(back.get("2026-27"), { alumni: 1 });
});

test("a row with no readable period or tier is counted nowhere", () => {
  const back = membershipTotalsGivenBack([
    { periodId: "", tier: "paid" },
    { periodId: "2026-27", tier: "associate" },
    { periodId: "2026-27" },
    { periodId: 7, tier: "paid" },
    { tier: "paid" },
  ]);
  assert.equal(
    back.size,
    0,
    "totals only ever moved for a recognised tier on the way in, so a " +
      "decrement here would be one no increment matches",
  );
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test("the rows go, and every period they were on gets its count back", async () => {
  const db = makeDb({
    memberships: {
      "gone__2025-26": { uid: "gone", periodId: "2025-26", tier: "paid" },
      "gone__2026-27": { uid: "gone", periodId: "2026-27", tier: "comped" },
      "stays__2026-27": { uid: "stays", periodId: "2026-27", tier: "paid" },
    },
    periods: {
      "2025-26": { totals: { paid: 4, comped: 1, alumni: 0, staff: 0 } },
      "2026-27": { totals: { paid: 9, comped: 3, alumni: 2, staff: 1 } },
    },
  });

  assert.equal(await deleteMembershipsAndAdjustTotals(db, "gone"), 2);

  assert.deepEqual([...db.rows.keys()], ["stays__2026-27"], "somebody else's row stands");
  assert.deepEqual(db.periods.get("2025-26").totals, {
    paid: 3,
    comped: 1,
    alumni: 0,
    staff: 0,
  });
  assert.deepEqual(db.periods.get("2026-27").totals, {
    paid: 9,
    comped: 2,
    alumni: 2,
    staff: 1,
  });
});

test("the totals move by increment, never by a rewritten number", async () => {
  const db = makeDb({
    memberships: { "gone__2026-27": { uid: "gone", periodId: "2026-27", tier: "paid" } },
    periods: { "2026-27": { totals: { paid: 5, comped: 0, alumni: 0, staff: 0 } } },
  });

  await deleteMembershipsAndAdjustTotals(db, "gone");

  assert.equal(db.updates.length, 1, "one update per period, not one per row");
  const [, data] = db.updates[0];
  assert.deepEqual(data, { "totals.paid": { __op: "increment", by: -1 } });
});

test("an account with no memberships writes nothing at all", async () => {
  const db = makeDb({
    memberships: { "stays__2026-27": { uid: "stays", periodId: "2026-27", tier: "paid" } },
    periods: { "2026-27": { totals: { paid: 1, comped: 0, alumni: 0, staff: 0 } } },
  });

  assert.equal(await deleteMembershipsAndAdjustTotals(db, "gone"), 0);
  assert.equal(db.batches, 0);
  assert.equal(db.updates.length, 0);
});

test("a period that is no longer there does not fail the teardown", async () => {
  const db = makeDb({
    memberships: { "gone__2019-20": { uid: "gone", periodId: "2019-20", tier: "paid" } },
    periods: {},
  });

  // The rows are already gone, which is the part that matters for the person
  // being deleted. A count that cannot be corrected is logged, not thrown.
  assert.equal(await deleteMembershipsAndAdjustTotals(db, "gone"), 1);
  assert.equal(db.rows.size, 0);
});

test("the cascade actually calls the sweep that maintains the totals", () => {
  const src = readFileSync(
    join(REPO_ROOT, "src", "lib", "firestore", "accountDeletion.ts"),
    "utf8",
  );
  assert.match(
    src,
    /summary\.membershipsDeleted = await deleteMembershipsAndAdjustTotals\(db, uid\)/,
    "a generic row sweep here would delete the rows and leave the console " +
      "reporting members who no longer exist.",
  );
});
