/**
 * The grant route, EXECUTED, against a fake Firestore.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this route gets a harness rather than a source pin
 *
 * It is the only writer of `users.paidMembershipYears`, and what it has to get
 * right is not visible in one call: the membership row, the badge cache and
 * the period's per-tier totals move TOGETHER, a tier change has to move the
 * cache in both directions, and an eleventh year has to come back as a named
 * refusal rather than as a silent truncation. Every one of those is a
 * before-and-after over two documents, so the requests are made and the store
 * is read afterwards.
 *
 * ## What is faked, and what is real
 *
 * The handler, the pure cache helpers, the tier table and the id constructors
 * are the REAL modules. Faked: `next/server`, `firebase-admin/firestore`
 * (sentinels this store interprets), the Admin SDK handle, the session, and
 * the impersonation guard. Nothing here can reach a Firestore project.
 *
 * The loader dance is the one from `admissions-stage-ids.test.mjs`.
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
    "export const NextResponse = {\n" +
      "  json(body, init) {\n" +
      "    return { status: (init && init.status) || 200, body };\n  },\n};",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
      "  increment: (by) => ({ __op: 'increment', by }),\n" +
      "};",
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
      // A string literal can look like an import to a regex: "su-import"
      // carries the word inside it. Anything unresolvable is left alone.
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
// A Firestore small enough to read: addressed documents, one transaction at a
// time, and the two sentinels this route writes.
// ---------------------------------------------------------------------------

/**
 * Resolve sentinels anywhere in a document, nested maps included: a real
 * `serverTimestamp()` inside `provenance` becomes a time, and a fake that only
 * looked at top-level keys would leave the sentinel sitting in the store and
 * pass a test the real thing would fail.
 */
function resolveSentinels(value) {
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value && typeof value === "object") {
    if ("__op" in value) {
      if (value.__op === "serverTimestamp") return new Date("2026-09-02T12:00:00Z");
      if (value.__op === "increment") return value.by;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));

  function setPath(target, path, value) {
    // Only the dotted `totals.<tier>` form is used here, so one level is
    // enough, and a real Firestore update() treats it as a nested path in
    // exactly this way.
    const [head, tail] = path.split(".");
    if (tail === undefined) {
      target[head] = value;
      return;
    }
    const nested = { ...(target[head] ?? {}) };
    nested[tail] = value;
    target[head] = nested;
  }

  function readPath(target, path) {
    const [head, tail] = path.split(".");
    return tail === undefined ? target[head] : (target[head] ?? {})[tail];
  }

  function apply(path, data) {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "__op" in value) {
        if (value.__op === "serverTimestamp") {
          setPath(next, key, new Date("2026-09-02T12:00:00Z"));
        } else if (value.__op === "increment") {
          const current = readPath(next, key);
          setPath(next, key, (typeof current === "number" ? current : 0) + value.by);
        }
      } else {
        setPath(next, key, value);
      }
    }
    docs.set(path, next);
  }

  function docRef(path) {
    return {
      id: path.split("/").pop(),
      path,
      async get() {
        const data = docs.get(path);
        return {
          id: path.split("/").pop(),
          exists: data !== undefined,
          data: () => (data === undefined ? undefined : { ...data }),
        };
      },
    };
  }

  return {
    docs,
    collection(name) {
      return { doc: (id) => docRef(`${name}/${id}`) };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data) => writes.push({ kind: "set", ref, data }),
        update: (ref, data) => writes.push({ kind: "update", ref, data }),
        delete: (ref) => writes.push({ kind: "delete", ref }),
      };
      // The handler throws before any write when it refuses, so a throw must
      // leave the store untouched: writes are collected and applied at the end,
      // which is what makes "the row and the cache move together" testable.
      const result = await fn(tx);
      for (const write of writes) {
        if (write.kind === "delete") docs.delete(write.ref.path);
        else if (write.kind === "set") docs.set(write.ref.path, resolveSentinels(write.data));
        else apply(write.ref.path, write.data);
      }
      return result;
    },
  };
}

const { POST } = await loadTs(
  join("app", "api", "admin", "membership", "grant", "route.ts"),
);

function request(body) {
  return { json: async () => body };
}

function seedWorld(userData = {}, periodData = {}) {
  return makeDb({
    "membershipPeriods/2026-27": { year: "2026/27", label: "Membership 2026/27", ...periodData },
    "users/member1": { uid: "member1", role: "member", ...userData },
  });
}

test.beforeEach(() => {
  globalThis.__fakeUser = { uid: "admin1", role: "admin", permissions: {} };
  globalThis.__blocked = null;
});

test("a grant writes the row AND the cache, and moves the period's totals", async () => {
  const db = makeDb({
    "membershipPeriods/2026-27": {
      year: "2026/27",
      totals: { paid: 2, comped: 0, alumni: 0, staff: 0 },
    },
    "users/member1": { uid: "member1", role: "member" },
  });
  globalThis.__fakeDb = db;

  const res = await POST(request({ uid: "member1", periodId: "2026-27", tier: "paid" }));
  assert.equal(res.status, 200);

  const row = db.docs.get("memberships/member1__2026-27");
  assert.equal(row.uid, "member1");
  assert.equal(row.periodId, "2026-27");
  assert.equal(row.tier, "paid");
  assert.equal(row.source, "manual");
  assert.equal(row.matchedOn, "manual");
  assert.equal(row.provenance.byUid, "admin1");
  assert.ok(row.provenance.at instanceof Date);

  assert.deepEqual(db.docs.get("users/member1").paidMembershipYears, ["2026/27"]);
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 3);
});

test("an alumni grant writes a row and NO cache entry", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  await POST(request({ uid: "member1", periodId: "2026-27", tier: "alumni" }));

  assert.equal(db.docs.get("memberships/member1__2026-27").tier, "alumni");
  assert.deepEqual(
    db.docs.get("users/member1").paidMembershipYears,
    [],
    "an alumni row records that somebody was with us, not that they are a member",
  );
});

test("re-granting a paid row as alumni CLEARS the badge in the same write", async () => {
  const db = seedWorld(
    { paidMembershipYears: ["2026/27"] },
    { totals: { paid: 1, comped: 0, alumni: 0, staff: 0 } },
  );
  db.docs.set("memberships/member1__2026-27", {
    uid: "member1",
    periodId: "2026-27",
    tier: "paid",
  });
  globalThis.__fakeDb = db;

  await POST(request({ uid: "member1", periodId: "2026-27", tier: "alumni" }));

  assert.deepEqual(db.docs.get("users/member1").paidMembershipYears, []);
  const totals = db.docs.get("membershipPeriods/2026-27").totals;
  assert.equal(totals.paid, 0);
  assert.equal(totals.alumni, 1);
});

test("a revoke removes both the row and the cache entry", async () => {
  const db = seedWorld(
    { paidMembershipYears: ["2026/27", "2025/26"] },
    { totals: { paid: 3, comped: 0, alumni: 0, staff: 0 } },
  );
  db.docs.set("memberships/member1__2026-27", {
    uid: "member1",
    periodId: "2026-27",
    tier: "paid",
  });
  globalThis.__fakeDb = db;

  const res = await POST(request({ uid: "member1", periodId: "2026-27", revoke: true }));
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, true);

  assert.equal(db.docs.has("memberships/member1__2026-27"), false);
  assert.deepEqual(
    db.docs.get("users/member1").paidMembershipYears,
    ["2025/26"],
    "revoking one year must leave the others alone",
  );
  assert.equal(db.docs.get("membershipPeriods/2026-27").totals.paid, 2);
});

test("a revoke clears a LEGACY cache entry that has no row behind it", async () => {
  // Every member tagged before this PR looks exactly like this: the deleted
  // `setPaidMembership` wrote the year client-direct and wrote no row. If
  // revoke needed a row to clear the cache, those badges could never come off.
  const db = seedWorld({ paidMembershipYears: ["2026/27"] });
  globalThis.__fakeDb = db;

  const res = await POST(request({ uid: "member1", periodId: "2026-27", revoke: true }));
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, false);
  assert.deepEqual(db.docs.get("users/member1").paidMembershipYears, []);
});

test("an eleventh membership year is refused by name, and nothing is written", async () => {
  const existing = Array.from({ length: 10 }, (_, i) => {
    const start = 2010 + i;
    return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
  });
  const db = seedWorld({ paidMembershipYears: existing });
  globalThis.__fakeDb = db;

  const res = await POST(request({ uid: "member1", periodId: "2026-27", tier: "paid" }));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already has 10 membership years/);
  assert.match(res.body.error, /Revoke an older one/);

  assert.equal(
    db.docs.has("memberships/member1__2026-27"),
    false,
    "the refusal must leave no row behind a badge that was never written",
  );
  assert.deepEqual(db.docs.get("users/member1").paidMembershipYears, existing);
});

test("a member already at the cap can still be re-granted a year they hold", async () => {
  const existing = Array.from({ length: 9 }, (_, i) => {
    const start = 2010 + i;
    return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
  }).concat("2026/27");
  const db = seedWorld({ paidMembershipYears: existing });
  globalThis.__fakeDb = db;

  const res = await POST(request({ uid: "member1", periodId: "2026-27", tier: "comped" }));
  assert.equal(res.status, 200);
  assert.equal(db.docs.get("memberships/member1__2026-27").tier, "comped");
  assert.equal(db.docs.get("users/member1").paidMembershipYears.length, 10);
});

test("a missing period, a missing member and an unknown tier are all refused", async () => {
  globalThis.__fakeDb = seedWorld();
  assert.equal(
    (await POST(request({ uid: "member1", periodId: "2099-00", tier: "paid" }))).status,
    404,
  );
  assert.equal(
    (await POST(request({ uid: "ghost", periodId: "2026-27", tier: "paid" }))).status,
    404,
  );
  assert.equal(
    (await POST(request({ uid: "member1", periodId: "2026-27", tier: "founder" }))).status,
    400,
  );
});

test("a member without manageMembership is refused, and an admin is not", async () => {
  globalThis.__fakeDb = seedWorld();
  globalThis.__fakeUser = { uid: "member2", role: "member", permissions: {} };
  assert.equal(
    (await POST(request({ uid: "member1", periodId: "2026-27", tier: "paid" }))).status,
    403,
  );

  globalThis.__fakeUser = {
    uid: "member2",
    role: "member",
    permissions: { manageMembership: true },
  };
  assert.equal(
    (await POST(request({ uid: "member1", periodId: "2026-27", tier: "paid" }))).status,
    200,
  );
});

test("the guard refuses before anything is read during a view-as session", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__blocked = { status: 403, body: { error: "blocked" } };

  const res = await POST(request({ uid: "member1", periodId: "2026-27", tier: "paid" }));
  assert.equal(res.status, 403);
  assert.equal(db.docs.has("memberships/member1__2026-27"), false);
});
