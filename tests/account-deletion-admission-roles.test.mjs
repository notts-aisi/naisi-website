/**
 * `clearAdmissionRoundRoles` from the account-deletion cascade, EXECUTED.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this step gets a real test
 *
 * An admission round outlives the accounts named on it. Until this ran, a
 * deleted reviewer left a uid on the round that nothing could resolve, and the
 * roles section wedged around it: the picker could not draw a name for
 * somebody who is no longer in the member list, the roles route refused a save
 * naming an account that does not exist, and the save that would have taken
 * them off also has to clear `users.admissionsReviewer` on everyone it
 * removes, which is an update to a missing document and therefore a batch that
 * rejects. Three symptoms of one dangling reference.
 *
 * The route was fixed on both halves. This is the half that stops the state
 * arising, so it is worth more than a source pin: the assertions below are the
 * shape of the write (arrayRemove, not a rewritten list; the decider nulled
 * only where it matched; one update for a round that is both).
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
      // The scan is a regex over source text, so a plain string literal can
      // look like an import: `"su-import"`, in the membership module this
      // cascade now reaches, carries the word `import` inside it and the match
      // that follows is not a module specifier at all. Anything that will not
      // resolve is left exactly as it was written.
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
// A Firestore small enough to read: one collection, the two single-field
// queries this function makes, and batched updates that apply together.
// ---------------------------------------------------------------------------

function makeDb(rounds) {
  const docs = new Map(Object.entries(rounds).map(([id, data]) => [id, { ...data }]));
  let batches = 0;

  function apply(target, data) {
    const next = { ...target };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "__op" in value) {
        if (value.__op === "serverTimestamp") next[key] = new Date("2026-09-02T12:00:00Z");
        else if (value.__op === "arrayRemove") {
          const list = Array.isArray(next[key]) ? next[key] : [];
          next[key] = list.filter((v) => !value.values.includes(v));
        } else if (value.__op === "arrayUnion") {
          const list = Array.isArray(next[key]) ? next[key].slice() : [];
          for (const v of value.values) if (!list.includes(v)) list.push(v);
          next[key] = list;
        }
      } else {
        next[key] = value;
      }
    }
    return next;
  }

  function snapshot(entries) {
    return {
      empty: entries.length === 0,
      size: entries.length,
      docs: entries.map(([id, data]) => ({
        id,
        exists: true,
        data: () => ({ ...data }),
      })),
    };
  }

  function collection(name) {
    if (name !== "admissionRounds") throw new Error(`unexpected collection ${name}`);
    return {
      doc: (id) => ({ id, path: id }),
      where(field, op, value) {
        return {
          async get() {
            return snapshot(
              [...docs.entries()].filter(([, data]) => {
                if (op === "array-contains") {
                  return Array.isArray(data[field]) && data[field].includes(value);
                }
                return data[field] === value;
              }),
            );
          },
        };
      },
    };
  }

  return {
    collection,
    batch() {
      const writes = [];
      return {
        update(ref, data) {
          writes.push([ref.path, data]);
        },
        async commit() {
          batches += 1;
          for (const [id, data] of writes) {
            if (!docs.has(id)) throw new Error(`NOT_FOUND: ${id}`);
            docs.set(id, apply(docs.get(id), data));
          }
        },
      };
    },
    raw: docs,
    get batches() {
      return batches;
    },
  };
}

const { clearAdmissionRoundRoles } = await loadTs("lib/firestore/accountDeletion.ts");

test("a deleted account comes off every round that named it", async () => {
  const db = makeDb({
    r1: { reviewerUids: ["gone", "keep"], finalDeciderUid: "keep" },
    r2: { reviewerUids: ["keep"], finalDeciderUid: "gone" },
    r3: { reviewerUids: [], finalDeciderUid: null },
  });

  const cleared = await clearAdmissionRoundRoles(db, "gone");

  assert.equal(cleared, 2, "the round that never named them is left alone");
  assert.deepEqual(db.raw.get("r1").reviewerUids, ["keep"]);
  assert.equal(db.raw.get("r1").finalDeciderUid, "keep", "the other decider stands");
  assert.deepEqual(db.raw.get("r2").reviewerUids, ["keep"]);
  assert.equal(db.raw.get("r2").finalDeciderUid, null);
  assert.deepEqual(db.raw.get("r3"), { reviewerUids: [], finalDeciderUid: null });
});

test("a round that named them twice takes ONE update carrying both fields", async () => {
  const db = makeDb({
    r1: { reviewerUids: ["gone", "keep"], finalDeciderUid: "gone" },
  });

  assert.equal(await clearAdmissionRoundRoles(db, "gone"), 1);
  assert.deepEqual(db.raw.get("r1").reviewerUids, ["keep"]);
  assert.equal(db.raw.get("r1").finalDeciderUid, null);
  assert.equal(db.batches, 1, "one batch, so a partial clear is not a state this can reach");
});

test("nothing to clear writes nothing at all", async () => {
  const db = makeDb({ r1: { reviewerUids: ["keep"], finalDeciderUid: "keep" } });
  assert.equal(await clearAdmissionRoundRoles(db, "gone"), 0);
  assert.equal(db.batches, 0);
});

test("the reviewer list is edited by arrayRemove, never rewritten wholesale", () => {
  const src = readFileSync(
    join(REPO_ROOT, "src", "lib", "firestore", "accountDeletion.ts"),
    "utf8",
  );
  assert.match(
    src,
    /reviewerUids: FieldValue\.arrayRemove\(uid\)/,
    "a rewritten list would drop whatever an admin saved between the read and " +
      "the write; this touches only the entry it is removing.",
  );
  assert.match(
    src,
    /summary\.admissionRoundRolesCleared = await clearAdmissionRoundRoles\(db, uid\)/,
    "the cascade has to actually call it, or the wedge comes back.",
  );
});
