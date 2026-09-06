/**
 * WHAT THE ACCOUNT CASCADE KEEPS, EXECUTED.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why a retention gets a test at all
 *
 * Every other suite around `accountDeletion.ts` proves that something GOES.
 * This one proves that three things STAY, which is the owner's decision of
 * 7 September 2026: a deleted account's worksheet responses and the staff
 * reviews of them remain, exactly as its tasks do, and the member record
 * (`memberRecords/{uid}/applications`) remains because it is the committee's
 * record about a person rather than that person's content.
 *
 * A retention is the kind of rule that decays silently. Nothing breaks the day
 * somebody adds a `circulations` sweep to the cascade: the deletion still
 * returns 200, the summary still reads clean, and the loss is noticed months
 * later by a committee looking for what was said about somebody who applied
 * twice. So the sweep is executed against a fake Firestore that records every
 * delete, and the test reads that list rather than trusting the summary.
 *
 * The counts get the same treatment, because a count is the one number that
 * looks identical whether it was measured or defaulted. `worksheetResponses`
 * is derived from the member's worksheet TASKS (the responses live under a
 * circulation and have no uid-keyed query), so the fixture includes a task of
 * another source and a worksheet task belonging to somebody else: a count that
 * dropped either filter would still look plausible.
 *
 * Faked: `firebase-admin/firestore` (sentinels this store can interpret) and
 * `server-only`. The functions under test are the real ones, loaded through
 * the shared loader. Nothing here can reach a Firestore project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { loadTs } = createLoader({
  stubs: [
    ["server-only", "export {};"],
    [
      "firebase-admin/firestore",
      "export const FieldValue = {\n" +
        "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
        "  arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),\n" +
        "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n" +
        "  increment: (by) => ({ __op: 'increment', by }),\n" +
        "  delete: () => ({ __op: 'delete' }),\n" +
        "};\n" +
        // A CLASS rather than an object: `clearCourseAttendanceMarks` builds
        // `new FieldPath("records", uid)`, and a plain object would throw
        // "not a constructor" the first time an enrolment fixture appears.
        "export class FieldPath {\n" +
        "  constructor(...segments) { this.segments = segments; }\n" +
        "  static documentId() { return '__name__'; }\n" +
        "}\n" +
        "export const Timestamp = { fromDate: (d) => d, now: () => new Date() };",
    ],
  ],
});

const { countRetainedMemberWork, deleteAccountCascade } = await loadTs(
  "lib/firestore/accountDeletion.ts",
);

// ---------------------------------------------------------------------------
// A Firestore small enough to read.
//
// Seeded by COLLECTION PATH, so a subcollection is written the way it is
// addressed: `"memberRecords/gone/applications"`. Every delete is recorded by
// full path, which is what the retention tests below actually assert on.
// ---------------------------------------------------------------------------

function makeDb(seed = {}) {
  const store = new Map();
  for (const [path, docs] of Object.entries(seed)) {
    store.set(path, new Map(Object.entries(docs).map(([id, d]) => [id, { ...d }])));
  }
  const deletes = [];
  const updates = [];

  function coll(path) {
    let rows = store.get(path);
    if (!rows) {
      rows = new Map();
      store.set(path, rows);
    }
    return rows;
  }

  function matches(data, { field, op, value }) {
    const actual = data[field];
    if (op === "==") return actual === value;
    if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
    throw new Error(`the fake Firestore does not implement "${op}"`);
  }

  function docRef(path) {
    const cut = path.lastIndexOf("/");
    const collPath = path.slice(0, cut);
    const id = path.slice(cut + 1);
    return {
      id,
      path,
      collection: (name) => query(`${path}/${name}`),
      async get() {
        const data = coll(collPath).get(id);
        return {
          id,
          exists: data !== undefined,
          ref: docRef(path),
          data: () => (data === undefined ? undefined : { ...data }),
        };
      },
      async delete() {
        deletes.push(path);
        coll(collPath).delete(id);
      },
      async update(...args) {
        updates.push([path, args]);
        if (!coll(collPath).has(id)) throw new Error(`NOT_FOUND: ${path}`);
      },
      async set(data) {
        coll(collPath).set(id, { ...data });
      },
    };
  }

  function query(collPath, filters = [], cap = Infinity) {
    const rows = () => {
      const all = [...coll(collPath).entries()].filter(([, data]) =>
        filters.every((f) => matches(data, f)),
      );
      return cap === Infinity ? all : all.slice(0, cap);
    };
    const snapshot = () => {
      const entries = rows();
      return {
        empty: entries.length === 0,
        size: entries.length,
        docs: entries.map(([id, data]) => ({
          id,
          exists: true,
          ref: docRef(`${collPath}/${id}`),
          data: () => ({ ...data }),
        })),
      };
    };
    return {
      where: (field, op, value) => query(collPath, [...filters, { field, op, value }], cap),
      // Ordering and projection change nothing a fake store can observe; they
      // are here so a real call site compiles against this object.
      orderBy: () => query(collPath, filters, cap),
      startAfter: () => query(collPath, filters, cap),
      select: () => query(collPath, filters, cap),
      limit: (n) => query(collPath, filters, n),
      doc: (id) => docRef(`${collPath}/${id}`),
      count: () => ({ get: async () => ({ data: () => ({ count: rows().length }) }) }),
      get: async () => snapshot(),
    };
  }

  return {
    collection: (name) => query(name),
    doc: (path) => docRef(path),
    // Nothing in these fixtures lives in a `rows` subcollection, so the import
    // sweep drains on its first empty page.
    collectionGroup: (name) => query(`__group__/${name}`),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch() {
      const queued = [];
      return {
        delete(ref) {
          queued.push(["delete", ref, []]);
        },
        update(ref, ...args) {
          queued.push(["update", ref, args]);
        },
        set(ref, data) {
          queued.push(["set", ref, [data]]);
        },
        async commit() {
          for (const [kind, ref, args] of queued) {
            if (kind === "delete") await ref.delete();
            else if (kind === "update") await ref.update(...args);
            else await ref.set(...args);
          }
        },
      };
    },
    store,
    deletes,
    updates,
    has: (path) => {
      const cut = path.lastIndexOf("/");
      return coll(path.slice(0, cut)).has(path.slice(cut + 1));
    },
  };
}

/** An Auth that always succeeds, so the cascade runs to its clean ending. */
const auth = {
  async deleteUser() {},
  async revokeRefreshTokens() {},
};

const UID = "gone";
const OTHER = "stays";

/**
 * A member with two worksheets answered, one ordinary task, a record of two
 * applications, and the response and review documents that the owner's
 * decision says must survive them.
 */
function seedWithWork() {
  return {
    users: { [UID]: { uid: UID, role: "member" } },
    tasks: {
      "task-ws-1": { completerUids: [UID], source: "worksheet" },
      "task-ws-2": { completerUids: [UID], source: "worksheet" },
      "task-committee": { completerUids: [UID], source: "committee" },
      "task-ws-other": { completerUids: [OTHER], source: "worksheet" },
    },
    [`memberRecords/${UID}/applications`]: {
      "round-1": { roundId: "round-1", roundTitle: "Autumn intake" },
      "round-2": { roundId: "round-2", roundTitle: "Facilitator round" },
    },
    "circulations/circ-1/responses": {
      [UID]: { uid: UID, state: "submitted", answers: { q1: { type: "text", text: "Yes" } } },
    },
    "circulations/circ-1/reviews": {
      [UID]: { overall: "Thorough.", updatedByUid: OTHER },
    },
  };
}

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

test("the summary reports what was kept, not what was removed", async () => {
  const db = makeDb(seedWithWork());

  const summary = await deleteAccountCascade(auth, db, UID);

  assert.equal(
    summary.worksheetResponsesRetained,
    2,
    "two worksheet tasks name this member as completer, and each one stands " +
      "for one response; a count that dropped the source filter would say 3 " +
      "and one that dropped the completer filter would say 3 as well",
  );
  assert.equal(summary.memberRecordApplicationsRetained, 2);
  assert.equal(summary.warning, undefined, "a clean teardown carries no warning");
});

test("the counter reads the two collections and touches neither", async () => {
  const db = makeDb(seedWithWork());

  const counts = await countRetainedMemberWork(db, UID);

  assert.deepEqual(counts, { worksheetResponses: 2, memberRecordApplications: 2 });
  assert.deepEqual(db.deletes, [], "counting is a read");
});

test("a member with no worksheet work and no record counts zero, honestly", async () => {
  // The interesting case, because zero is also what a failed count would
  // report. Here it is measured: the collections exist and hold somebody
  // else's rows.
  const db = makeDb({
    users: { [UID]: { uid: UID, role: "member" } },
    tasks: { "task-ws-other": { completerUids: [OTHER], source: "worksheet" } },
    [`memberRecords/${OTHER}/applications`]: { "round-1": { roundId: "round-1" } },
  });

  const summary = await deleteAccountCascade(auth, db, UID);

  assert.equal(summary.worksheetResponsesRetained, 0);
  assert.equal(summary.memberRecordApplicationsRetained, 0);
  assert.equal(summary.userDocDeleted, true, "the account itself still went");
});

// ---------------------------------------------------------------------------
// The retention itself
// ---------------------------------------------------------------------------

test("no response, review or record document is deleted by the cascade", async () => {
  const db = makeDb(seedWithWork());

  await deleteAccountCascade(auth, db, UID);

  const kept = [
    `circulations/circ-1/responses/${UID}`,
    `circulations/circ-1/reviews/${UID}`,
    `memberRecords/${UID}/applications/round-1`,
    `memberRecords/${UID}/applications/round-2`,
  ];
  for (const path of kept) {
    assert.ok(db.has(path), `${path} was deleted by the cascade, and must not be`);
  }
  assert.deepEqual(
    db.deletes.filter(
      (path) =>
        path.startsWith("circulations/") ||
        path.startsWith("memberRecords/") ||
        path.startsWith("tasks/"),
    ),
    [],
    "the cascade deleted worksheet work, a member record entry or a task. " +
      "All three are retained by decision: the member record is the " +
      "committee's record about a person, and the worksheet rows are " +
      "substantive content held under a circulation rather than under them.",
  );
});

test("the tasks that index the responses survive, so the count stays re-derivable", async () => {
  // The count is only honest for as long as its input exists. If a later
  // change sweeps a member's tasks, this number silently becomes zero for
  // every account deleted afterwards.
  const db = makeDb(seedWithWork());

  await deleteAccountCascade(auth, db, UID);

  assert.ok(db.has("tasks/task-ws-1"));
  assert.ok(db.has("tasks/task-ws-2"));
  assert.equal(
    (await countRetainedMemberWork(db, UID)).worksheetResponses,
    2,
    "the same count run after the teardown must still answer 2",
  );
});

// ---------------------------------------------------------------------------
// The warning, when the counts and something real both fail
// ---------------------------------------------------------------------------

test("a failed count never swallows the sentence about data left behind", async () => {
  // THE CO-FAILURE, which is the likely one: a count is a Firestore call in the
  // same request as every best-effort sweep, so it fails for the same transient
  // causes (deadline exceeded, unavailable, quota) and the two arrive together.
  // If the count's sentence took the warning field, the admin would read a note
  // about a missing number while the registration row was deliberately kept for
  // a re-run, and the one sentence that tells them to re-run would be gone.
  const db = makeDb(seedWithWork());
  const realCollection = db.collection;
  // Two collections refused by one fault. `memberConductFlags` is a best-effort
  // step whose catch sets the residue flag and writes no warning of its own;
  // `tasks` is half of the retention count. A real deadline-exceeded or
  // unavailable would take both, because they are consecutive calls in one
  // request against one project.
  const unavailable = new Set(["memberConductFlags", "tasks"]);
  db.collection = (name) => {
    if (unavailable.has(name)) throw new Error(`UNAVAILABLE: ${name}`);
    return realCollection(name);
  };

  const summary = await deleteAccountCascade(auth, db, UID);

  assert.match(
    summary.warning ?? "",
    /registration row was kept/,
    "the residue sentence is the one that changes what the admin does next, " +
      "so it must survive a count failure landing in the same request",
  );
  assert.match(
    summary.warning ?? "",
    /could not be read/,
    "and the count's own sentence still gets said, because a summary reporting " +
      "zero retained rows reads as 'there was nothing to keep'",
  );
  assert.ok(
    summary.warning.indexOf("registration row was kept") <
      summary.warning.indexOf("could not be read"),
    "residue first: it is the actionable half",
  );
  assert.equal(summary.worksheetResponsesRetained, 0);
  assert.equal(summary.memberRecordApplicationsRetained, 0);
});

test("the cascade actually calls the counter", () => {
  const src = readFileSync(
    join(REPO_ROOT, "src", "lib", "firestore", "accountDeletion.ts"),
    "utf8",
  );
  assert.match(
    src,
    /const kept = await countRetainedMemberWork\(db, uid\)/,
    "the two retained-data numbers are the owner's evidence for a retention " +
      "policy; a summary that always reports zero reads as 'there was nothing " +
      "to keep'.",
  );
  // A SOURCE READ, and weaker than the runtime assertions above on purpose: it
  // catches the shape somebody would type on the way to sweeping worksheet
  // rows, before the sweep is written and while the diff is still small. It
  // matches any collection or collection-group call naming a circulation or a
  // response rather than one spelling of one literal, so a `CIRCULATIONS_...`
  // constant is caught too, but a determined indirection would still slip past
  // it. The tests that execute the cascade and read `db.deletes` are the
  // guarantee; this one is the early warning.
  assert.doesNotMatch(
    src,
    /\bcollection(?:Group)?\(\s*[^)]*(?:circulation|CIRCULATION|response|RESPONSE)/,
    "account deletion must not reach into the circulations tree at all: " +
      "responses and reviews stay by decision, and the only thing this file " +
      "may do with them is count, which it does through the member's tasks.",
  );
});
