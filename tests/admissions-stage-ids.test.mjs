/**
 * The stage route, EXECUTED, against a fake Firestore.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this one route gets a real harness rather than a source pin
 *
 * The rest of the round console is pinned at the source
 * (`admissions-round-console.test.mjs`), because a route handler drags
 * `next/server` and `firebase-admin` in with it. This one earned the harness:
 * the bug it is written against was a stage id derived from `stageIds.length`
 * while DELETE leaves holes in the sequence, so on a round that had lost a
 * stage the NEXT stage added landed on an id that was still in use, and the
 * merging PUT behind it blanked that stage's questions. Nothing about that is
 * visible in a single call, or in the shape of the source: it takes four
 * requests in order (create, create, delete the first, create again) and a
 * look at what survived. So the requests are made.
 *
 * ## What is faked, and what is real
 *
 * The handler, the id derivation, the normalisers and the validators are the
 * REAL modules. Faked: `next/server` (a response is a plain object here),
 * `firebase-admin/firestore` (sentinels this store can interpret), the Admin
 * SDK handle, the session, and the impersonation guard. Nothing in this file
 * can reach a Firestore project.
 *
 * The loader dance is the one from `course-offer.test.mjs`: this repo's Node
 * predates native TypeScript stripping, so the module graph is transpiled in
 * memory with the `typescript` devDependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * The fake database and the fake session both hang off globals, because a
 * stub module is a fixed string: this is how a test decides per case what the
 * handler finds when it looks.
 */
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
      "  arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),\n" +
      "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n" +
      "  increment: (by) => ({ __op: 'increment', by }),\n" +
      "};",
  ],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() {\n  return globalThis.__fakeDb;\n}",
  ],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() {\n  return globalThis.__fakeUser;\n}",
  ],
  [
    "@/lib/firebase/impersonation",
    "export async function assertNotImpersonating() {\n  return null;\n}",
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

// ---------------------------------------------------------------------------
// A Firestore small enough to read, and exact about the parts that matter:
// batched writes apply together, a merge keeps the fields it is not given, and
// arrayUnion / arrayRemove are set operations rather than list rewrites.
// ---------------------------------------------------------------------------

function makeDb() {
  /** path -> document data. A path is "col/doc" or "col/doc/sub/doc". */
  const docs = new Map();

  function apply(target, data) {
    const next = { ...target };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "__op" in value) {
        if (value.__op === "serverTimestamp") next[key] = new Date("2026-09-02T12:00:00Z");
        else if (value.__op === "arrayUnion") {
          const list = Array.isArray(next[key]) ? next[key].slice() : [];
          for (const v of value.values) if (!list.includes(v)) list.push(v);
          next[key] = list;
        } else if (value.__op === "arrayRemove") {
          const list = Array.isArray(next[key]) ? next[key].slice() : [];
          next[key] = list.filter((v) => !value.values.includes(v));
        } else if (value.__op === "increment") {
          next[key] = (typeof next[key] === "number" ? next[key] : 0) + value.by;
        }
      } else {
        next[key] = value;
      }
    }
    return next;
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
      collection(name) {
        return collectionRef(`${path}/${name}`);
      },
    };
  }

  function collectionRef(path) {
    return {
      doc(id) {
        return docRef(`${path}/${id}`);
      },
      async get() {
        const prefix = `${path}/`;
        const rows = [...docs.entries()].filter(
          ([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"),
        );
        return {
          empty: rows.length === 0,
          size: rows.length,
          docs: rows.map(([key, data]) => ({
            id: key.split("/").pop(),
            exists: true,
            data: () => ({ ...data }),
          })),
        };
      },
    };
  }

  return {
    collection: collectionRef,
    batch() {
      const writes = [];
      return {
        set(ref, data, options) {
          writes.push({ kind: options && options.merge ? "merge" : "set", ref, data });
        },
        update(ref, data) {
          writes.push({ kind: "update", ref, data });
        },
        delete(ref) {
          writes.push({ kind: "delete", ref });
        },
        async commit() {
          // Firestore rejects a whole batch when an `update` names a document
          // that is not there, and that all-or-nothing is load-bearing in more
          // than one place, so the fake does it too.
          for (const write of writes) {
            if (write.kind === "update" && !docs.has(write.ref.path)) {
              throw new Error(`NOT_FOUND: no document to update at ${write.ref.path}`);
            }
          }
          for (const write of writes) {
            if (write.kind === "delete") docs.delete(write.ref.path);
            else if (write.kind === "set") docs.set(write.ref.path, apply({}, write.data));
            else {
              docs.set(write.ref.path, apply(docs.get(write.ref.path) ?? {}, write.data));
            }
          }
        },
      };
    },
    /** Test-side reads, so an assertion never goes through the handler. */
    raw: docs,
  };
}

const { PUT, DELETE } = await loadTs(
  "app/api/admissions/rounds/[roundId]/stages/[stageId]/route.ts",
);
const { nextAdmissionStageId } = await loadTs("lib/firestore/admissionRounds.ts");

const ROUND_ID = "autumn-2026-intake__k3f9a2b1";

function question(id) {
  return { id, type: "shortText", label: `Question ${id}`, required: false };
}

function seed() {
  const db = makeDb();
  db.raw.set(`admissionRounds/${ROUND_ID}`, {
    label: "Autumn 2026 intake",
    kind: "enrolment",
    status: "draft",
    stageIds: ["s1"],
    applicationCounts: {},
  });
  db.raw.set(`admissionRounds/${ROUND_ID}/stages/s1`, {
    roundId: ROUND_ID,
    label: "Stage 1",
    intro: "",
    questions: [question("q1")],
    releaseAt: null,
    releaseTimeLocal: "09:00",
    closesAt: null,
    locksOnSubmit: false,
    order: 0,
  });
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "admin-1", role: "admin", permissions: {} };
  return db;
}

function stageBody(overrides = {}) {
  return {
    label: "A stage",
    intro: "",
    questions: [],
    releaseAt: null,
    releaseTimeLocal: "09:00",
    closesAt: null,
    locksOnSubmit: false,
    ...overrides,
  };
}

function request(body) {
  return { json: async () => body };
}

function params(stageId) {
  return { params: Promise.resolve({ roundId: ROUND_ID, stageId }) };
}

function stageIds(db) {
  return db.raw.get(`admissionRounds/${ROUND_ID}`).stageIds;
}

function questionsOn(db, stageId) {
  const stage = db.raw.get(`admissionRounds/${ROUND_ID}/stages/${stageId}`);
  return stage ? stage.questions.map((q) => q.id) : null;
}

// ---------------------------------------------------------------------------
// The bug, reproduced as the sequence that caused it
// ---------------------------------------------------------------------------

test("create, add, delete the first, add again: nothing lands on a surviving stage", async () => {
  const db = seed();

  const second = await PUT(
    request(stageBody({ label: "Stage 2", questions: [question("q2")], create: true })),
    params("s2"),
  );
  assert.equal(second.status, 200);
  assert.deepEqual(stageIds(db), ["s1", "s2"]);

  const third = await PUT(
    request(stageBody({ label: "Stage 3", questions: [question("q3")], create: true })),
    params("s3"),
  );
  assert.equal(third.status, 200);
  assert.deepEqual(stageIds(db), ["s1", "s2", "s3"]);

  const removed = await DELETE(request({}), params("s1"));
  assert.equal(removed.status, 200);
  assert.deepEqual(stageIds(db), ["s2", "s3"]);
  assert.equal(db.raw.has(`admissionRounds/${ROUND_ID}/stages/s1`), false);
  // `order` is the position in `stageIds`, so the survivors are renumbered.
  assert.equal(db.raw.get(`admissionRounds/${ROUND_ID}/stages/s2`).order, 0);
  assert.equal(db.raw.get(`admissionRounds/${ROUND_ID}/stages/s3`).order, 1);

  // The list is now two long, so the OLD derivation would have called this new
  // stage "s2" and merged an empty question list over a stage that is still
  // there. Both survivors keep their questions.
  assert.equal(nextAdmissionStageId(stageIds(db)), "s4");
  const fourth = await PUT(
    request(stageBody({ label: "Stage 4", questions: [question("q4")], create: true })),
    params("s4"),
  );
  assert.equal(fourth.status, 200);
  assert.deepEqual(stageIds(db), ["s2", "s3", "s4"]);
  assert.deepEqual(questionsOn(db, "s2"), ["q2"]);
  assert.deepEqual(questionsOn(db, "s3"), ["q3"]);
  assert.deepEqual(questionsOn(db, "s4"), ["q4"]);
});

test("a create aimed at a stage the round already has is refused, not merged", async () => {
  const db = seed();
  await PUT(
    request(stageBody({ label: "Stage 2", questions: [question("q2")], create: true })),
    params("s2"),
  );

  // Exactly what a stale console would send after somebody else deleted s1:
  // the id a length-derived guess produces, on a stage that is still live.
  const collision = await PUT(
    request(stageBody({ label: "Stage 2 again", questions: [], create: true })),
    params("s2"),
  );
  assert.equal(collision.status, 409);
  assert.match(collision.body.error, /already has a stage s2/);
  assert.deepEqual(questionsOn(db, "s2"), ["q2"], "the live stage keeps its questions");
  assert.deepEqual(stageIds(db), ["s1", "s2"], "and the round keeps its list");
});

test("stageIds cannot pick up a duplicate even if the same create arrives twice", async () => {
  const db = seed();
  await PUT(request(stageBody({ create: true })), params("s2"));
  db.raw.set(`admissionRounds/${ROUND_ID}`, {
    ...db.raw.get(`admissionRounds/${ROUND_ID}`),
    stageIds: ["s1"],
  });
  // The round has forgotten s2 but the document is still there: a create on
  // that id would overwrite it, so it is refused rather than written.
  const again = await PUT(request(stageBody({ create: true })), params("s2"));
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already a stage document at s2/);
});

test("an edit to a stage the round no longer has is refused rather than recreated", async () => {
  const db = seed();
  await PUT(request(stageBody({ create: true })), params("s2"));
  await DELETE(request({}), params("s2"));

  const stale = await PUT(request(stageBody({ label: "Edited" })), params("s2"));
  assert.equal(stale.status, 404);
  assert.equal(db.raw.has(`admissionRounds/${ROUND_ID}/stages/s2`), false);
});

test("a create has to use the next id, and the next id is one past the highest", async () => {
  seed();
  const skipped = await PUT(request(stageBody({ create: true })), params("s9"));
  assert.equal(skipped.status, 400);
  assert.match(skipped.body.error, /next stage on this round is s2/);
});

test("an edit merges, so a manual release survives a change of wording", async () => {
  const db = seed();
  db.raw.set(`admissionRounds/${ROUND_ID}/stages/s1`, {
    ...db.raw.get(`admissionRounds/${ROUND_ID}/stages/s1`),
    manualReleasedAt: new Date("2026-09-01T09:00:00Z"),
  });

  const edited = await PUT(
    request(stageBody({ label: "Renamed", questions: [question("q1")] })),
    params("s1"),
  );
  assert.equal(edited.status, 200);
  assert.ok(
    db.raw.get(`admissionRounds/${ROUND_ID}/stages/s1`).manualReleasedAt instanceof Date,
    "a release cannot be taken back by renaming the stage it is on",
  );
});

test("nextAdmissionStageId is monotonic, never the length of the list", () => {
  assert.equal(nextAdmissionStageId([]), "s1");
  assert.equal(nextAdmissionStageId(["s1"]), "s2");
  assert.equal(nextAdmissionStageId(["s2", "s3"]), "s4");
  assert.equal(nextAdmissionStageId(["s3"]), "s4");
  assert.equal(nextAdmissionStageId(["s10", "s2"]), "s11");
  assert.equal(nextAdmissionStageId(["nonsense"]), "s1");
});
