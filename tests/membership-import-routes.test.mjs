/**
 * The import, commit and export routes, EXECUTED against a fake Firestore.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why these three get a harness rather than a source pin
 *
 * What they have to get right is not visible in one call:
 *
 *  - a 600-row list must report 600 and then COMMIT 600, across three calls,
 *    with the cursor picking up where the last one stopped;
 *  - running the commit again must do nothing, and must not overwrite a manual
 *    grant somebody made in between. That is a before-and-after over two
 *    documents and cannot be asserted by reading the source;
 *  - a name-tier row must refuse to commit until it is confirmed, and the
 *    confirmation must be recorded against the row with a name on it;
 *  - the export must write its `dataExports` row BEFORE the CSV file exists,
 *    and must refuse the download when that write fails. It reads the rows
 *    first, because `rowCount` belongs in the record; what the log gates is
 *    the step that hands the file over. Ordering is the whole property, so a
 *    marker goes into the write log when the CSV writer runs and the log write
 *    is separately made to fail.
 *
 * ## What is faked, and what is real
 *
 * The handlers, the pure planners, the id constructors and the tier table are
 * the REAL modules. Faked: `next/server`, `firebase-admin/firestore`
 * (sentinels this store interprets), the Admin SDK handle, the session and the
 * impersonation guard. Nothing here can reach a Firestore project.
 *
 * The loader dance is the one from `membership-grant-route.test.mjs`.
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
    "next/server",
    "export const NextResponse = {\n"
      + "  json(body, init) {\n"
      + "    return { status: (init && init.status) || 200, body };\n  },\n};",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n"
      + "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n"
      + "  increment: (by) => ({ __op: 'increment', by }),\n"
      + "};\n"
      + "export const FieldPath = { documentId: () => '__name__' };",
  ],
  ["@/lib/firebase/admin", "export function getAdminDb() {\n  return globalThis.__fakeDb;\n}"],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() {\n  return globalThis.__fakeUser;\n}",
  ],
  [
    "@/lib/firebase/impersonation",
    "export async function assertNotImpersonating() {\n  return globalThis.__blocked ?? null;\n}",
  ],
  // The real `toCSV`, with a marker dropped into the write log at the moment
  // it runs. That is what turns "the log row is present" into "the log row
  // was written BEFORE the file existed", which is the property the export is
  // built around and the only one worth asserting.
  [
    "@/lib/csv",
    "export function toCSV(...args) {\n"
      + "  const store = globalThis.__fakeDb;\n"
      + "  if (store && store.writeLog) store.writeLog.push(['body', 'csv']);\n"
      + "  return globalThis.__realToCSV(...args);\n"
      + "}\n"
      + "export function escapeCsvCell(v) {\n"
      + "  return globalThis.__realEscapeCsvCell(v);\n"
      + "}",
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
      try {
        rewrites.set(specifier, import.meta.resolve(specifier));
      } catch {
        // Not a module. Leave the source alone.
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
    tsc = (await import("typescript")).default;
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

// ---------------------------------------------------------------------------
// The fake store
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-09T12:00:00Z");

function resolveSentinels(value) {
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value && typeof value === "object") {
    if ("__op" in value) {
      if (value.__op === "serverTimestamp") return NOW;
      if (value.__op === "increment") return value.by;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

function alreadyExists(path) {
  const err = new Error(`ALREADY_EXISTS: ${path}`);
  err.code = 6;
  return err;
}

/**
 * Paths are `collection/doc` or `collection/doc/sub/doc`, which is every shape
 * these routes address. Queries filter on equality and sort by a field or by
 * the document id, which is every shape they run.
 */
function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  let autoId = 0;
  const store = {
    docs,
    failAdd: false,
    failCount: false,
    /** Document paths whose `update` throws, so a best-effort write can be
     *  made to fail without deleting the document it points at. */
    failUpdate: new Set(),
    added: [],
    /** The order writes landed, so an ordering property can be asserted. */
    writeLog: [],
  };

  function setPath(target, path, value) {
    const segments = path.split(".");
    let node = target;
    for (let i = 0; i < segments.length - 1; i += 1) {
      node[segments[i]] = { ...(node[segments[i]] ?? {}) };
      node = node[segments[i]];
    }
    node[segments[segments.length - 1]] = value;
  }

  function readPath(target, path) {
    return path.split(".").reduce((node, key) => (node ?? {})[key], target);
  }

  function applyUpdate(path, data) {
    const next = structuredClone(docs.get(path) ?? {});
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "__op" in value) {
        if (value.__op === "serverTimestamp") setPath(next, key, NOW);
        else if (value.__op === "increment") {
          const current = readPath(next, key);
          setPath(next, key, (typeof current === "number" ? current : 0) + value.by);
        }
      } else {
        setPath(next, key, resolveSentinels(value));
      }
    }
    docs.set(path, next);
  }

  function snapshot(path) {
    const data = docs.get(path);
    return {
      id: path.split("/").pop(),
      ref: docRef(path),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : structuredClone(data)),
    };
  }

  function docRef(path) {
    return {
      id: path.split("/").pop(),
      path,
      async get() {
        return snapshot(path);
      },
      async create(data) {
        if (docs.has(path)) throw alreadyExists(path);
        store.writeLog.push(["create", path]);
        docs.set(path, resolveSentinels(data));
      },
      async set(data) {
        store.writeLog.push(["set", path]);
        docs.set(path, resolveSentinels(data));
      },
      async update(data) {
        if (store.failUpdate.has(path)) {
          throw new Error(`the datastore refused the update: ${path}`);
        }
        if (!docs.has(path)) {
          const err = new Error(`NOT_FOUND: ${path}`);
          err.code = 5;
          throw err;
        }
        store.writeLog.push(["update", path]);
        applyUpdate(path, data);
      },
      collection(name) {
        return collectionRef(`${path}/${name}`);
      },
    };
  }

  function entriesIn(collectionPath) {
    const prefix = `${collectionPath}/`;
    return [...docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({ path, id: path.slice(prefix.length), data }));
  }

  function query(collectionPath, spec) {
    const withSpec = (patch) => query(collectionPath, { ...spec, ...patch });
    return {
      where: (field, op, value) =>
        withSpec({ filters: [...spec.filters, { field, op, value }] }),
      orderBy: (field, direction = "asc") =>
        withSpec({ orders: [...spec.orders, { field, direction }] }),
      limit: (n) => withSpec({ limit: n }),
      startAfter: (value) => withSpec({ after: value }),
      /** The aggregate. Real Firestore bills one read for it whatever the
       *  size of the match; here it is the same filtered scan `get` runs,
       *  reported as a number. `failCount` makes it throw, which is how the
       *  "an unreadable count is not zero" property gets asserted. */
      count() {
        return {
          async get() {
            if (store.failCount) throw new Error("the datastore refused the count");
            const { docs: matched } = await query(collectionPath, {
              ...spec,
              limit: null,
            }).get();
            return { data: () => ({ count: matched.length }) };
          },
        };
      },
      async get() {
        let rows = entriesIn(collectionPath);
        for (const filter of spec.filters) {
          assert.equal(filter.op, "==", "the fake only knows equality filters");
          rows = rows.filter(
            (row) => readPath(row.data, filter.field) === filter.value,
          );
        }
        const orders = spec.orders.length > 0 ? spec.orders : [{ field: "__name__" }];
        rows.sort((a, b) => {
          for (const order of orders) {
            const av = order.field === "__name__" ? a.id : readPath(a.data, order.field);
            const bv = order.field === "__name__" ? b.id : readPath(b.data, order.field);
            if (av === bv) continue;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return order.direction === "desc" ? -cmp : cmp;
          }
          // Ties break on the document id, the way Firestore's implicit
          // __name__ ordering does; without it paging can loop.
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        if (spec.after !== null && spec.after !== undefined) {
          const key = typeof spec.after === "string" ? spec.after : spec.after.id;
          const at = rows.findIndex((row) => row.id === key);
          rows = at === -1 ? rows : rows.slice(at + 1);
        }
        if (spec.limit !== null) rows = rows.slice(0, spec.limit);
        const snaps = rows.map((row) => snapshot(row.path));
        return { empty: snaps.length === 0, size: snaps.length, docs: snaps };
      },
    };
  }

  function collectionRef(path) {
    const base = query(path, { filters: [], orders: [], limit: null, after: null });
    return {
      ...base,
      doc: (id) => docRef(`${path}/${id}`),
      async add(data) {
        if (store.failAdd) throw new Error("the datastore refused the write");
        autoId += 1;
        const id = `auto-${autoId}`;
        store.writeLog.push(["add", `${path}/${id}`]);
        docs.set(`${path}/${id}`, resolveSentinels(data));
        store.added.push({ path: `${path}/${id}`, data: structuredClone(data) });
        return { id };
      },
    };
  }

  Object.assign(store, {
    collection: collectionRef,
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    batch() {
      const queued = [];
      return {
        create(ref, data) {
          queued.push(["create", ref.path, data]);
        },
        delete(ref) {
          queued.push(["delete", ref.path]);
        },
        async commit() {
          for (const [kind, path, data] of queued) {
            if (kind === "delete") docs.delete(path);
            else {
              if (docs.has(path)) throw alreadyExists(path);
              store.writeLog.push(["create", path]);
              docs.set(path, resolveSentinels(data));
            }
          }
        },
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (ref) => ref.get(),
        create: (ref, data) => writes.push(["create", ref.path, data]),
        set: (ref, data) => writes.push(["set", ref.path, data]),
        update: (ref, data) => writes.push(["update", ref.path, data]),
        delete: (ref) => writes.push(["delete", ref.path]),
      };
      const result = await fn(tx);
      for (const [kind, path, data] of writes) {
        if (kind === "delete") docs.delete(path);
        else if (kind === "create") {
          if (docs.has(path)) throw alreadyExists(path);
          store.writeLog.push(["create", path]);
          docs.set(path, resolveSentinels(data));
        } else if (kind === "set") {
          store.writeLog.push(["set", path]);
          docs.set(path, resolveSentinels(data));
        } else {
          store.writeLog.push(["update", path]);
          applyUpdate(path, data);
        }
      }
      return result;
    },
  });

  return store;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

const importRoute = await loadTs(
  join("app", "api", "admin", "membership", "import", "route.ts"),
);
const commitRoute = await loadTs(
  join("app", "api", "admin", "membership", "import", "[batchId]", "commit", "route.ts"),
);
const exportRoute = await loadTs(
  join("app", "api", "admin", "membership", "export", "route.ts"),
);
const listRoute = await loadTs(
  join("app", "api", "admin", "membership", "list", "route.ts"),
);

// Loaded by FILE rather than by the `@/lib/csv` specifier, so this is the real
// module and the stub above is a thin instrumented wrapper over it. The
// export's CSV content assertions are still made against the real writer.
const abandonRoute = await loadTs(
  join("app", "api", "admin", "membership", "import", "[batchId]", "abandon", "route.ts"),
);
const recountRoute = await loadTs(
  join("app", "api", "admin", "membership", "periods", "[periodId]", "recount", "route.ts"),
);

const csvLib = await loadTs(join("lib", "csv.ts"));
globalThis.__realToCSV = csvLib.toCSV;
globalThis.__realEscapeCsvCell = csvLib.escapeCsvCell;

function jsonRequest(body, url = "http://x/api/admin/membership/import") {
  return { url, json: async () => body };
}

function urlRequest(url) {
  return { url, json: async () => ({}) };
}

function ctx(batchId) {
  return { params: Promise.resolve({ batchId }) };
}

function periodCtx(periodId) {
  return { params: Promise.resolve({ periodId }) };
}

test.beforeEach(() => {
  globalThis.__fakeUser = { uid: "admin1", displayName: "Sam Admin", role: "admin", permissions: {} };
  globalThis.__blocked = null;
});

/** A world with one period and `count` accounts, each with a verified uni
 *  address, plus the CSV that names all of them. */
function world(count) {
  const seed = {
    "membershipPeriods/2026-27": {
      year: "2026/27",
      label: "Membership 2026/27",
      totals: { paid: 0, comped: 0, alumni: 0, staff: 0 },
    },
  };
  const lines = ["name,email,university email"];
  for (let i = 0; i < count; i += 1) {
    const uid = `u${String(i).padStart(4, "0")}`;
    seed[`users/${uid}`] = {
      uid,
      role: i % 5 === 0 ? "pending" : "member",
      displayName: `Person ${i}`,
      email: `person${i}@example.com`,
      profile: {
        preferredName: `P${i}`,
        universityEmail: `person${i}@nottingham.ac.uk`,
        uniEmailVerifiedAt: NOW,
      },
    };
    lines.push(`Person ${i},person${i}@example.com,PERSON${i}@nottingham.ac.uk`);
  }
  return { db: makeDb(seed), csv: `${lines.join("\n")}\n` };
}

async function dryRun(csv, over = {}) {
  const res = await importRoute.POST(
    jsonRequest({ periodId: "2026-27", csv, filename: "su.csv", ...over }),
  );
  return res;
}

// ---------------------------------------------------------------------------
// 1. The dry run
// ---------------------------------------------------------------------------

test("a 600-row file reports all 600 and writes 600 rows, granting nothing", async () => {
  const { db, csv } = world(600);
  globalThis.__fakeDb = db;

  const res = await dryRun(csv);
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.total, 600);
  assert.equal(res.body.receipt.uniEmail, 600);
  assert.equal(res.body.receipt.autoCommittable, 600);
  assert.equal(res.body.accountsScanned, 600);

  const batch = db.docs.get(`membershipImports/${res.body.batchId}`);
  assert.equal(batch.totalRows, 600);
  assert.equal(batch.status, "dry-run");
  assert.equal(batch.nextRowSeq, 1);

  const rows = [...db.docs.keys()].filter((path) => path.includes("/rows/"));
  assert.equal(rows.length, 600);
  assert.ok(rows.includes(`membershipImports/${res.body.batchId}/rows/0001`));
  assert.ok(rows.includes(`membershipImports/${res.body.batchId}/rows/0600`));

  const memberships = [...db.docs.keys()].filter((path) => path.startsWith("memberships/"));
  assert.deepEqual(
    memberships,
    [],
    "the dry run must record nothing: it exists so an admin can see the file "
      + "before believing it",
  );
});

test("the batch document is written BEFORE its rows, in a writing state", async () => {
  const { db, csv } = world(5);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  const creates = db.writeLog.filter(([kind]) => kind === "create").map(([, path]) => path);
  const parent = creates.indexOf(`membershipImports/${batchId}`);
  const firstRow = creates.findIndex((path) => path.includes("/rows/"));
  assert.ok(parent >= 0 && firstRow >= 0);
  assert.ok(
    parent < firstRow,
    "rows written under a parent that does not exist yet are orphans if the "
      + "call dies: nothing lists them and nobody can clean them up.",
  );
  assert.equal(
    db.docs.get(`membershipImports/${batchId}`).status,
    "dry-run",
    "a run that finished flips out of `writing`",
  );
});

test("a batch stuck in writing is refused by the commit", async () => {
  const { db, csv } = world(5);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  // What the store looks like when the dry run died between the parent and
  // the last chunk of rows: `totalRows` promises five, and the rows may not
  // be there to keep it.
  db.docs.get(`membershipImports/${batchId}`).status = "writing";
  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /did not finish writing/);
  assert.equal(db.docs.get("memberships/u0000__2026-27"), undefined);
});

test("a file with no matchable column is refused before anything is written", async () => {
  const { db } = world(1);
  globalThis.__fakeDb = db;
  const res = await dryRun("membership number,paid on\n123,2026-10-01\n");
  assert.equal(res.status, 400);
  assert.equal([...db.docs.keys()].filter((p) => p.startsWith("membershipImports")).length, 0);
});

test("the dry run refuses a period that does not exist", async () => {
  const { db, csv } = world(1);
  globalThis.__fakeDb = db;
  const res = await importRoute.POST(jsonRequest({ periodId: "1999-00", csv }));
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 2. The chunked commit
// ---------------------------------------------------------------------------

test("600 rows commit across three calls, and the fourth is a no-op", async () => {
  const { db, csv } = world(600);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  const first = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(first.status, 200);
  assert.equal(first.body.committed, 200);
  assert.equal(first.body.remaining, 400);
  assert.equal(first.body.status, "committing");

  const second = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(second.body.committed, 200);
  assert.equal(second.body.remaining, 200);

  const third = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(third.body.committed, 200);
  assert.equal(third.body.remaining, 0);
  assert.equal(third.body.status, "committed");

  const memberships = [...db.docs.keys()].filter((path) => path.startsWith("memberships/"));
  assert.equal(memberships.length, 600);
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 600);
  assert.deepEqual(db.docs.get("users/u0000").paidMembershipYears, ["2026/27"]);
  assert.deepEqual(db.docs.get("users/u0599").paidMembershipYears, ["2026/27"]);

  const row = db.docs.get(`membershipImports/${batchId}/rows/0001`);
  assert.equal(row.state, "committed");
  const membership = db.docs.get("memberships/u0000__2026-27");
  assert.equal(membership.source, "su-import");
  assert.equal(membership.matchedOn, "uni-email");
  assert.equal(membership.provenance.batchId, batchId);

  const fourth = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(fourth.body.committed, 0);
  assert.equal(fourth.body.skipped, 0);
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 600);
});

test("a pending account is imported like anybody else", async () => {
  // Membership is a badge and a record, and the SU takes money from people
  // whose account here is still waiting for approval.
  const { db, csv } = world(10);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(db.docs.get("users/u0000").role, "pending");
  assert.ok(db.docs.get("memberships/u0000__2026-27"));
});

test("a re-run does NOT overwrite a manual comped grant made in between", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  // An admin records a bursary by hand between the upload and the commit.
  const granted = new Date("2026-10-08T09:00:00Z");
  db.docs.set("memberships/u0001__2026-27", {
    uid: "u0001",
    periodId: "2026-27",
    tier: "comped",
    source: "manual",
    matchedOn: "manual",
    provenance: { at: granted, byUid: "admin2" },
  });

  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.body.committed, 2);
  assert.equal(res.body.skipped, 1);

  const kept = db.docs.get("memberships/u0001__2026-27");
  assert.equal(kept.tier, "comped", "the SU list must not overrule a bursary");
  assert.equal(kept.source, "manual");
  assert.deepEqual(
    kept.provenance.at,
    granted,
    "a set() re-run would have rewritten the date the grant was made",
  );

  const skippedRow = db.docs.get(`membershipImports/${batchId}/rows/0002`);
  assert.equal(skippedRow.state, "skipped");
  assert.match(skippedRow.skipReason, /comped/);
  assert.match(
    res.body.results.find((r) => r.rowId === "0002").reason,
    /comped/,
    "the receipt says WHY, or an admin has to guess which two of three landed",
  );
});

test("an alumni row records a membership and no badge", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv, { defaultTier: "alumni" })).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));

  assert.equal(db.docs.get("memberships/u0000__2026-27").tier, "alumni");
  assert.equal(
    db.docs.get("users/u0000").paidMembershipYears,
    undefined,
    "alumni is a record that somebody was with us, not a membership this "
      + "year, and a cache that never changed keeps the field ABSENT rather "
      + "than gaining an empty array",
  );
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.alumni, 2);
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 0);
});

test("an alumni row will not strip a badge year with no membership behind it", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  // A badge set before the membership rows existed, or by hand: the year is
  // in the cache and there is no `memberships` document to account for it.
  db.docs.get("users/u0000").paidMembershipYears = ["2026/27", "2025/26"];

  const { batchId } = (await dryRun(csv, { defaultTier: "alumni" })).body;
  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));

  assert.deepEqual(
    db.docs.get("users/u0000").paidMembershipYears,
    ["2026/27", "2025/26"],
    "one line in a file must not take away a badge nothing else can restore",
  );
  assert.equal(db.docs.get("memberships/u0000__2026-27"), undefined);
  assert.equal(
    db.docs.get(`membershipImports/${batchId}/rows/0001`).state,
    "skipped",
  );
  assert.match(
    db.docs.get(`membershipImports/${batchId}/rows/0001`).skipReason,
    /no membership row behind it/,
  );

  // The skip is in the receipt the console renders, not only on the row.
  const skipped = (res.body.results ?? []).find((r) => r.rowId === "0001");
  assert.equal(skipped.action, "skipped");
  assert.match(skipped.reason, /Settle it from the Members page/);

  // The person with no such badge is recorded as normal: this refuses ONE
  // row, and a job never throws for one bad item.
  assert.equal(db.docs.get("memberships/u0001__2026-27").tier, "alumni");
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.alumni, 1);
});

// ---------------------------------------------------------------------------
// 3. The name tier
// ---------------------------------------------------------------------------

/** One account with no addresses the file can match, so the only route to it
 *  is the name. */
function nameWorld() {
  const db = makeDb({
    "membershipPeriods/2026-27": {
      year: "2026/27",
      totals: { paid: 0, comped: 0, alumni: 0, staff: 0 },
    },
    "users/u-ada": {
      uid: "u-ada",
      role: "member",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      profile: {},
    },
  });
  return { db, csv: "name,email\nAda Lovelace,different@elsewhere.com\n" };
}

test("a name-tier row cannot commit without a per-row confirmation", async () => {
  const { db, csv } = nameWorld();
  globalThis.__fakeDb = db;
  const dry = await dryRun(csv);
  assert.equal(dry.body.receipt.needsConfirm, 1);
  assert.equal(dry.body.rows.length, 1);
  assert.equal(dry.body.rows[0].matchKind, "name");
  const { batchId } = dry.body;

  const refused = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(refused.body.committed, 0);
  assert.equal(refused.body.awaitingConfirm, 1);
  assert.equal(
    refused.body.status,
    "committing",
    "a file with a row still waiting on a person is not finished",
  );
  assert.equal(db.docs.get("memberships/u-ada__2026-27"), undefined);
  assert.equal(
    db.docs.get(`membershipImports/${batchId}/rows/0001`).state,
    "pending",
    "stamping it skipped would make a later confirmation useless",
  );

  const confirmed = await commitRoute.POST(
    jsonRequest({ confirmedRowIds: ["0001"] }),
    ctx(batchId),
  );
  assert.equal(confirmed.body.committed, 1);
  assert.equal(confirmed.body.awaitingConfirm, 0);
  assert.equal(confirmed.body.status, "committed");

  const membership = db.docs.get("memberships/u-ada__2026-27");
  assert.equal(membership.matchedOn, "name-confirmed");

  const row = db.docs.get(`membershipImports/${batchId}/rows/0001`);
  assert.equal(row.state, "committed");
  assert.equal(
    row.confirmedByName,
    "Sam Admin",
    "the record has to say who vouched for a name match",
  );
  assert.equal(row.confirmedByUid, "admin1");
  assert.deepEqual(confirmed.body.confirmed, [
    { rowId: "0001", name: "Ada Lovelace", byName: "Sam Admin" },
  ]);
});

/** Six accounts matchable only by name, and the CSV that names all six with
 *  addresses none of them use. Every row lands on the `name` tier, so the
 *  whole file is confirm-only. */
function sixNameWorld() {
  const seed = {
    "membershipPeriods/2026-27": {
      year: "2026/27",
      totals: { paid: 0, comped: 0, alumni: 0, staff: 0 },
    },
  };
  const lines = ["name,email"];
  for (let i = 1; i <= 6; i += 1) {
    seed[`users/u${i}`] = {
      uid: `u${i}`,
      role: "member",
      displayName: `Person ${i}`,
      email: `person${i}@example.com`,
      profile: {},
    };
    lines.push(`Person ${i},nobody${i}@elsewhere.com`);
  }
  return { db: makeDb(seed), csv: `${lines.join("\n")}\n` };
}

test("six name matches with three ticked leaves three waiting, not finished", async () => {
  const { db, csv } = sixNameWorld();
  globalThis.__fakeDb = db;
  const dry = await dryRun(csv);
  assert.equal(dry.body.receipt.needsConfirm, 6);
  const { batchId } = dry.body;

  // THE NORMAL FIRST PRESS: the confirmations arrive with the first commit,
  // before anything has ever counted a row as waiting. The old running delta
  // subtracted three here and the walk added three back, so the batch came out
  // at zero waiting and was stamped `committed` with three people unrecorded.
  const first = await commitRoute.POST(
    jsonRequest({ confirmedRowIds: ["0001", "0002", "0003"] }),
    ctx(batchId),
  );
  assert.equal(first.body.committed, 3);
  assert.equal(
    first.body.awaitingConfirm,
    3,
    "three rows nobody has answered are still waiting",
  );
  assert.equal(
    first.body.status,
    "committing",
    "a file with three people still to vouch for is not finished",
  );
  assert.equal(db.docs.get(`membershipImports/${batchId}`).status, "committing");
  assert.equal(db.docs.get(`membershipImports/${batchId}`).awaitingConfirm, 3);
  for (const seq of ["0004", "0005", "0006"]) {
    assert.equal(
      db.docs.get(`membershipImports/${batchId}/rows/${seq}`).state,
      "pending",
      "an unticked name row stays pending so it can still be confirmed",
    );
    assert.equal(db.docs.get(`memberships/u${Number(seq)}__2026-27`), undefined);
  }

  const second = await commitRoute.POST(
    jsonRequest({ confirmedRowIds: ["0004", "0005", "0006"] }),
    ctx(batchId),
  );
  assert.equal(second.body.committed, 3);
  assert.equal(second.body.awaitingConfirm, 0);
  assert.equal(second.body.status, "committed");
  for (let i = 1; i <= 6; i += 1) {
    assert.equal(db.docs.get(`memberships/u${i}__2026-27`).matchedOn, "name-confirmed");
  }
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 6);
});

test("a count that cannot be read is unknown, so the batch is not stamped finished", async () => {
  const { db, csv } = sixNameWorld();
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  db.failCount = true;
  const res = await commitRoute.POST(
    jsonRequest({ confirmedRowIds: ["0001", "0002", "0003", "0004", "0005", "0006"] }),
    ctx(batchId),
  );
  assert.equal(res.body.committed, 6, "the rows are written whatever the count does");
  assert.equal(
    res.body.status,
    "committing",
    "an unreadable count is unknown, and a batch is never declared finished on it",
  );

  db.failCount = false;
  const again = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(again.body.committed, 0);
  assert.equal(again.body.awaitingConfirm, 0);
  assert.equal(again.body.status, "committed");
});

test("confirming a DIFFERENT row does not release the one in hand", async () => {
  const { db, csv } = nameWorld();
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  const res = await commitRoute.POST(
    jsonRequest({ confirmedRowIds: ["0002"] }),
    ctx(batchId),
  );
  assert.equal(res.body.committed, 0);
  assert.equal(db.docs.get("memberships/u-ada__2026-27"), undefined);
});

test("the commit reads the row from Firestore, so a posted match is ignored", async () => {
  const { db, csv } = nameWorld();
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  // A browser asserting its own match and its own confirmation in one request.
  const res = await commitRoute.POST(
    jsonRequest({
      rows: [{ rowId: "0001", matchKind: "uni-email", matchedUid: "u-ada", tier: "staff" }],
    }),
    ctx(batchId),
  );
  assert.equal(res.body.committed, 0);
  assert.equal(db.docs.get("memberships/u-ada__2026-27"), undefined);
});

// ---------------------------------------------------------------------------
// 3b. Resuming, abandoning, and repairing the totals
// ---------------------------------------------------------------------------

test("the GET lists the unfinished imports on a period, newest first", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const dry = await dryRun(csv);
  const { batchId } = dry.body;

  const res = await importRoute.GET(
    urlRequest("http://x/api/admin/membership/import?periodId=2026-27"),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.batches.length, 1);
  assert.equal(res.body.batches[0].id, batchId);
  assert.equal(res.body.batches[0].status, "dry-run");

  // Committed is finished, so it drops out of the list an admin has work in.
  await commitRoute.POST(jsonRequest({}), ctx(batchId));
  const after = await importRoute.GET(
    urlRequest("http://x/api/admin/membership/import?periodId=2026-27"),
  );
  assert.deepEqual(after.body.batches, []);
});

test("the rows GET pages, and the last page says there is no more", async () => {
  // The page is 200. The panel follows `nextCursor` to the end, because a name
  // match on page two is one somebody has to be able to tick, and reading one
  // page meant a file with more pending rows than that could never finish.
  const { db, csv } = world(300);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  const first = await importRoute.GET(
    urlRequest(`http://x/api?batchId=${batchId}`),
  );
  assert.equal(first.body.rows.length, 200);
  assert.equal(first.body.nextCursor, "0200");

  const second = await importRoute.GET(
    urlRequest(`http://x/api?batchId=${batchId}&cursor=0200`),
  );
  assert.equal(second.body.rows.length, 100);
  assert.equal(second.body.nextCursor, null);
  assert.equal(second.body.rows[99].rowId, "0300");
});

test("a batch stuck in writing IS listed, so somebody can close it", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  db.docs.get(`membershipImports/${batchId}`).status = "writing";

  const res = await importRoute.GET(
    urlRequest("http://x/api/admin/membership/import?periodId=2026-27"),
  );
  assert.equal(res.body.batches.length, 1);
  assert.equal(res.body.batches[0].status, "writing");

  const closed = await abandonRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(closed.status, 200);
  assert.equal(db.docs.get(`membershipImports/${batchId}`).status, "abandoned");

  const after = await importRoute.GET(
    urlRequest("http://x/api/admin/membership/import?periodId=2026-27"),
  );
  assert.deepEqual(after.body.batches, []);
});

test("abandoning keeps every row and every membership already recorded", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  await abandonRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(db.docs.has(`membershipImports/${batchId}/rows/0001`), true);
  assert.equal(db.docs.get(`membershipImports/${batchId}`).abandonedByUid, "admin1");

  // And it is closed to commits, so it cannot half-restart.
  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /abandoned/);
});

test("a finished import cannot be relabelled abandoned", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(db.docs.get(`membershipImports/${batchId}`).status, "committed");

  const res = await abandonRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.status, 409);
  assert.equal(db.docs.get(`membershipImports/${batchId}`).status, "committed");
});

test("a commit whose totals update fails says so, and Recount repairs it", async () => {
  const { db, csv } = world(4);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;

  db.failUpdate.add("membershipPeriods/2026-27");
  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.body.committed, 4, "the memberships are the record and are written");
  assert.equal(
    res.body.totalsMoved,
    false,
    "a cache that silently stopped agreeing with the rows is a console lying "
      + "about a headcount, so the response has to say it happened",
  );
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 0);

  db.failUpdate.clear();
  const fixed = await recountRoute.POST({}, periodCtx("2026-27"));
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.body.totals, { paid: 4, comped: 0, alumni: 0, staff: 0 });
  assert.deepEqual(fixed.body.corrected, [{ tier: "paid", was: 0, now: 4 }]);
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 4);
});

test("a recount on a period that was already right writes nothing", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  const res = await commitRoute.POST(jsonRequest({}), ctx(batchId));
  assert.equal(res.body.totalsMoved, true);

  const before = db.writeLog.length;
  const recounted = await recountRoute.POST({}, periodCtx("2026-27"));
  assert.deepEqual(recounted.body.corrected, []);
  assert.equal(
    db.writeLog.length,
    before,
    "checking a period should not stamp it as changed",
  );
});

// ---------------------------------------------------------------------------
// 4. Gates
// ---------------------------------------------------------------------------

test("a view-as session is refused by every mutating route, before any write", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  globalThis.__blocked = { status: 403, body: { error: "no" } };

  assert.equal((await dryRun(csv)).status, 403);
  assert.equal((await commitRoute.POST(jsonRequest({}), ctx("x"))).status, 403);
  assert.equal((await abandonRoute.POST({}, ctx("x"))).status, 403);
  assert.equal((await recountRoute.POST({}, periodCtx("2026-27"))).status, 403);
  assert.equal(
    (await exportRoute.POST(urlRequest("http://x/api?periodId=2026-27"))).status,
    403,
  );
  assert.equal([...db.docs.keys()].filter((p) => p.startsWith("membershipImports")).length, 0);
  assert.deepEqual(
    db.docs.get("membershipPeriods/2026-27").totals,
    { paid: 0, comped: 0, alumni: 0, staff: 0 },
    "the recount rewrites a headcount, so it is refused before it reads",
  );
});

test("a member without manageMembership is refused everywhere", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "m1", role: "member", permissions: {} };

  assert.equal((await dryRun(csv)).status, 403);
  assert.equal((await commitRoute.POST(jsonRequest({}), ctx("x"))).status, 403);
  assert.equal((await abandonRoute.POST({}, ctx("x"))).status, 403);
  assert.equal((await recountRoute.POST({}, periodCtx("2026-27"))).status, 403);
  assert.equal(
    (await exportRoute.POST(urlRequest("http://x/api?periodId=2026-27"))).status,
    403,
  );
  assert.equal(
    (await listRoute.GET(urlRequest("http://x/api?periodId=2026-27"))).status,
    403,
  );
  assert.equal(
    (await importRoute.GET(urlRequest("http://x/api?periodId=2026-27"))).status,
    403,
  );
});

test("a manageMembership holder who is not an admin may do all four", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = {
    uid: "keeper",
    displayName: "Kit Keeper",
    role: "member",
    permissions: { manageMembership: true },
  };

  const dry = await dryRun(csv);
  assert.equal(dry.status, 200);
  assert.equal(
    (await commitRoute.POST(jsonRequest({}), ctx(dry.body.batchId))).status,
    200,
  );
  assert.equal(
    (await listRoute.GET(urlRequest("http://x/api?periodId=2026-27"))).status,
    200,
  );
  const exported = await exportRoute.POST(urlRequest("http://x/api?periodId=2026-27"));
  assert.equal(exported.status, 200);
  assert.equal((await recountRoute.POST({}, periodCtx("2026-27"))).status, 200);
  assert.equal(
    (await importRoute.GET(urlRequest("http://x/api?periodId=2026-27"))).status,
    200,
  );
});

// ---------------------------------------------------------------------------
// 5. The list
// ---------------------------------------------------------------------------

test("the list joins every account, pending included, to its membership", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));

  // The admin has an account of their own, which is how the provenance
  // tooltip resolves a name rather than showing a uid.
  db.docs.set("users/admin1", { uid: "admin1", role: "admin", displayName: "Sam Admin" });

  const res = await listRoute.GET(urlRequest("http://x/api?periodId=2026-27"));
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 4);
  const first = res.body.rows.find((row) => row.uid === "u0000");
  assert.equal(first.role, "pending", "the Members list cannot show this person");
  assert.equal(first.tier, "paid");
  assert.equal(first.source, "su-import");
  assert.equal(first.matchedOn, "uni-email");
  assert.equal(first.recordedByName, "Sam Admin");
  assert.equal(first.lapsed, false);
  assert.deepEqual(res.body.totals, { paid: 3, comped: 0, alumni: 0, staff: 0 });
});

test("somebody recorded last period and not this one reads as lapsed", async () => {
  const { db } = world(1);
  globalThis.__fakeDb = db;
  db.docs.set("membershipPeriods/2025-26", {
    year: "2025/26",
    totals: { paid: 1, comped: 0, alumni: 0, staff: 0 },
  });
  db.docs.set("memberships/u0000__2025-26", {
    uid: "u0000",
    periodId: "2025-26",
    tier: "paid",
    source: "manual",
    matchedOn: "manual",
    provenance: { at: NOW, byUid: "admin1" },
  });

  const res = await listRoute.GET(urlRequest("http://x/api?periodId=2026-27"));
  const row = res.body.rows.find((r) => r.uid === "u0000");
  assert.equal(row.tier, null);
  assert.equal(row.lapsed, true);
  assert.equal(res.body.previousPeriodId, "2025-26");
});

// ---------------------------------------------------------------------------
// 6. The export
// ---------------------------------------------------------------------------

test("the export writes the dataExports row BEFORE the body", async () => {
  const { db, csv } = world(3);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));

  const res = await exportRoute.POST(urlRequest("http://x/api?periodId=2026-27"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.match(res.headers.get("Content-Disposition"), /naisi-membership-2026-27\.csv/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  assert.equal(db.added.length, 1);
  const logged = db.added[0];
  assert.equal(logged.path.startsWith("dataExports/"), true);
  assert.equal(logged.data.kind, "membership");
  assert.equal(logged.data.actorUid, "admin1");
  assert.equal(logged.data.rowCount, 3);
  assert.deepEqual(logged.data.scope, { periodId: "2026-27" });

  const body = await res.text();
  const lines = body.trim().split("\n");
  assert.equal(lines.length, 4, "a header and three people");
  assert.match(lines[0], /^uid,name,email/);
  assert.match(body, /Person 0/);

  // THE ORDERING, not just the presence. The write log carries a `body` marker
  // dropped the moment `toCSV` runs, so this pins the real property: the
  // `dataExports` row is in the store before the file exists, and a refusal to
  // log therefore refuses the download rather than reporting it late.
  //
  // What it does NOT claim: that nothing was read first. The route resolves
  // the membership rows and the names before it logs, because `rowCount` is
  // part of the record and an estimate would make the log worth less than it
  // is. Those rows are in memory, not in a file and not on their way anywhere;
  // the log gates the only step that hands them over.
  const addIndex = db.writeLog.findIndex(([kind]) => kind === "add");
  const bodyIndex = db.writeLog.findIndex(([kind]) => kind === "body");
  assert.notEqual(addIndex, -1, "the export was never logged");
  assert.notEqual(bodyIndex, -1, "the CSV writer never ran");
  assert.ok(
    addIndex < bodyIndex,
    "the file was built before the log row landed, so a log failure could "
      + "hand over a download nobody recorded",
  );
});

test("the export REFUSES when the log write fails, and hands over no file", async () => {
  const { db, csv } = world(2);
  globalThis.__fakeDb = db;
  const { batchId } = (await dryRun(csv)).body;
  await commitRoute.POST(jsonRequest({}), ctx(batchId));

  db.failAdd = true;
  const res = await exportRoute.POST(urlRequest("http://x/api?periodId=2026-27"));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /could not be recorded/);
  assert.equal(typeof res.text, "undefined", "no CSV body may come back");
  assert.equal(db.added.length, 0);
});

test("the export refuses a period that does not exist", async () => {
  const { db } = world(1);
  globalThis.__fakeDb = db;
  const res = await exportRoute.POST(urlRequest("http://x/api?periodId=1999-00"));
  assert.equal(res.status, 404);
  assert.equal(db.added.length, 0);
});
