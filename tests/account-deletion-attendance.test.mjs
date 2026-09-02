/**
 * `clearCourseAttendanceMarks` from the account-deletion cascade, EXECUTED.
 *
 * ## Why this step gets a real test
 *
 * A register is SHARED: one document per (group, session), with the member's
 * uid as a MAP KEY in two different maps. `records` holds their marks;
 * `participantNotes` holds a facilitator's prose ABOUT them, which is personal
 * data written by another student and reachable by a subject access request.
 * Deleting an account has to take both, and it has to take them WITHOUT
 * deleting the document, because the document is the whole group's session.
 *
 * Three ways that goes wrong, each of them silent:
 *  · Clearing only `records` leaves the notes behind in a collection that is
 *    `read, write: if false`, with nothing naming the uid: unreachable and
 *    undeletable.
 *  · Deleting the document erases the marks of everyone else in the room.
 *  · Using a dotted `"participantNotes.<uid>"` string re-interprets a uid as a
 *    nested field PATH, so a uid containing a dot would clear the wrong key
 *    (or nothing). It has to be a `FieldPath`.
 *
 * Faked: `firebase-admin/firestore` (sentinels this store can interpret) and
 * `server-only`. The function under test is the real one. Nothing here can
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

/** A field path, kept as an object so an assertion can read its segments. */
const FIRESTORE_STUB =
  "export const FieldValue = {\n" +
  "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
  "  arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),\n" +
  "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n" +
  "  increment: (by) => ({ __op: 'increment', by }),\n" +
  "  delete: () => ({ __op: 'delete' }),\n" +
  "};\n" +
  "export class FieldPath {\n" +
  "  constructor(...segments) { this.segments = segments; }\n" +
  "  static documentId() { return '__name__'; }\n" +
  "}\n" +
  "export const Timestamp = { fromDate: (d) => d, now: () => new Date() };";

const STUBS = new Map([
  ["server-only", "export {};"],
  ["firebase-admin/firestore", FIRESTORE_STUB],
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
// A Firestore small enough to read: one collection, the one query this
// function makes, and batched field-path updates that apply together.
// ---------------------------------------------------------------------------

function makeDb(registers) {
  const docs = new Map(
    Object.entries(registers).map(([id, data]) => [id, structuredClone(data)]),
  );
  const deletedDocs = [];

  function snapshot(entries) {
    return {
      empty: entries.length === 0,
      size: entries.length,
      docs: entries.map(([id, data]) => ({
        id,
        exists: true,
        ref: { id },
        data: () => structuredClone(data),
      })),
    };
  }

  function collection(name) {
    if (name !== "courseAttendance") throw new Error(`unexpected collection ${name}`);
    const query = (filters) => ({
      where(field, op, value) {
        return query([...filters, [field, op, value]]);
      },
      orderBy() {
        return query(filters);
      },
      limit() {
        return query(filters);
      },
      startAfter() {
        // Every fixture here fits in one page, so a cursor would only be
        // exercising the fake rather than the function.
        return query([["__none__", "==", "__none__"]]);
      },
      async get() {
        return snapshot(
          [...docs.entries()].filter(([, data]) =>
            filters.every(([field, , value]) => data[field] === value),
          ),
        );
      },
    });
    return query([]);
  }

  return {
    collection,
    batch() {
      const writes = [];
      return {
        update(ref, fieldPath, value) {
          writes.push([ref.id, fieldPath, value]);
        },
        delete(ref) {
          deletedDocs.push(ref.id);
        },
        async commit() {
          for (const [id, fieldPath, value] of writes) {
            const doc = docs.get(id);
            if (!doc) throw new Error(`NOT_FOUND: ${id}`);
            // A FieldPath is the ONLY form this fake honours, which is the
            // point: a dotted string would silently do nothing here, exactly
            // as it would silently do the wrong thing in Firestore.
            if (!fieldPath || !Array.isArray(fieldPath.segments)) {
              throw new Error(
                "a map key must be cleared with a FieldPath, not a dotted string",
              );
            }
            const [map, key] = fieldPath.segments;
            if (value?.__op !== "delete") throw new Error("expected a delete sentinel");
            if (doc[map] && typeof doc[map] === "object") delete doc[map][key];
          }
        },
      };
    },
    raw: docs,
    deletedDocs,
  };
}

const { clearCourseAttendanceMarks } = await loadTs("lib/firestore/accountDeletion.ts");

function register(overrides = {}) {
  return {
    runId: "run1",
    groupId: "grp1",
    records: { gone: "present", stays: "absent" },
    participantNotes: { gone: "Asked a good question about deceptive alignment." },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test("both map keys go, and the rest of the register stays", async () => {
  const db = makeDb({ run1__grp1__w01: register() });

  const cleared = await clearCourseAttendanceMarks(db, ["run1"], "gone");

  assert.equal(cleared, 1);
  const doc = db.raw.get("run1__grp1__w01");
  assert.equal("gone" in doc.records, false, "their mark is gone");
  assert.equal("gone" in doc.participantNotes, false, "and so is the note about them");
  assert.equal(doc.records.stays, "absent", "everyone else's session is untouched");
  assert.deepEqual(db.deletedDocs, [], "the register document itself is never deleted");
});

test("a note with no mark is still cleared", async () => {
  // A facilitator writes notes about the people they have something to say
  // about, so a register can hold a note for somebody it never marked. Testing
  // the two keys separately is what stops a `records`-shaped filter from
  // deciding this document does not qualify.
  const db = makeDb({
    run1__grp1__w02: register({
      records: { stays: "present" },
      participantNotes: { gone: "Quiet this week, worth checking in." },
    }),
  });

  assert.equal(await clearCourseAttendanceMarks(db, ["run1"], "gone"), 1);
  assert.deepEqual(db.raw.get("run1__grp1__w02").participantNotes, {});
  assert.deepEqual(db.raw.get("run1__grp1__w02").records, { stays: "present" });
});

test("a mark with no note is cleared without inventing a notes map", async () => {
  const db = makeDb({
    run1__grp1__w03: register({ participantNotes: {} }),
  });

  assert.equal(await clearCourseAttendanceMarks(db, ["run1"], "gone"), 1);
  assert.deepEqual(db.raw.get("run1__grp1__w03").records, { stays: "absent" });
  assert.deepEqual(db.raw.get("run1__grp1__w03").participantNotes, {});
});

test("a register naming nobody relevant is not written to at all", async () => {
  const db = makeDb({
    run1__grp1__w04: register({
      records: { stays: "present" },
      participantNotes: { other: "Led the discussion." },
    }),
  });

  assert.equal(await clearCourseAttendanceMarks(db, ["run1"], "gone"), 0);
  assert.deepEqual(db.raw.get("run1__grp1__w04").participantNotes, {
    other: "Led the discussion.",
  });
});

test("a hand-edited register with a malformed map is survivable", async () => {
  // `uid in map` throws on a non-object, and this collection is written by
  // routes today but was hand-editable in the console yesterday.
  const db = makeDb({
    run1__grp1__w05: register({ participantNotes: "not a map" }),
  });

  assert.equal(await clearCourseAttendanceMarks(db, ["run1"], "gone"), 1);
  assert.equal("gone" in db.raw.get("run1__grp1__w05").records, false);
});

test("occurrence-2 registers are swept by the same scan", async () => {
  // The scan is a query on `runId` plus a document-id page, never a list of
  // week ids, so a second session in a week is reached with no change: the
  // exact reason the occurrence dimension kept register ids constructable.
  const db = makeDb({
    "run1__grp1__w01": register(),
    "run1__grp1__w01-2": register(),
  });

  assert.equal(await clearCourseAttendanceMarks(db, ["run1"], "gone"), 2);
  for (const id of ["run1__grp1__w01", "run1__grp1__w01-2"]) {
    assert.equal("gone" in db.raw.get(id).records, false, id);
    assert.equal("gone" in db.raw.get(id).participantNotes, false, id);
  }
});
