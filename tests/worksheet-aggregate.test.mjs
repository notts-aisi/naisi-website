/**
 * What a circulation's answers ADD UP TO: the pure aggregator and the CSV
 * table on their own, and the three routes that serve them, EXECUTED against a
 * fake Firestore.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## Why these get a harness rather than a source pin
 *
 * Three different things here are only visible end to end:
 *
 *  - `GET .../aggregate` is THE ONE PATH by which a recipient learns anything
 *    about another recipient. Everywhere else the rules seal them off by
 *    document id. So its gate is not "does this person have access to the
 *    circulation" but a question about the QUESTION (is it a poll), about the
 *    CALLER'S OWN STATE (has the poll's audience setting let them in yet) and,
 *    for a "before-submit" poll, about whether they have voted at all. Every
 *    wrong answer to it is a privacy failure rather than an inconvenience. It
 *    is exercised as a recipient, at each state, against each visibility,
 *    because an admin takes a resource-independent branch and would prove
 *    nothing;
 *  - the export writes its `dataExports` row BEFORE it hands over the file and
 *    REFUSES the export if that write fails. "Log first" is invisible in the
 *    happy path and is the whole point of the route, so there is a test that
 *    breaks the log and checks no CSV comes back;
 *  - the close touches one document per recipient and has to be idempotent,
 *    survive a task an admin deleted, and leave the circulation open if the
 *    archiving fails. None of that is legible in one call.
 *
 * The pure half (`aggregateQuestion`, `tallyOptions`, `toCsvRows`) is asserted
 * directly, because those functions are the rules about what a number in front
 * of a person MEANS: a denominator, a removed option that is counted rather
 * than dropped, a mean that is null rather than zero over an empty set.
 *
 * ## What is faked, and what is real
 *
 * The handlers, the item and answer model, the normalisers, the aggregator,
 * the CSV helpers, `logExport` and `slugify` are the REAL modules. Faked:
 * `next/server`, `firebase-admin/firestore` (sentinels and `FieldPath`, which
 * this store interprets), the Admin SDK handle, the session and the
 * impersonation guard. Nothing here can reach a Firestore project.
 *
 * The loader is the shared one, `tests/lib/tsLoader.mjs`, as in the other two
 * suites over this tree. Nothing the three routes here load reaches a `.tsx`
 * today. It is on the shared loader anyway, for the reason the fake store is
 * the same one: the routes BESIDE these three (add recipients, submit, return)
 * all import `notify.ts` and the four email templates behind it, and a private
 * loader that cannot read JSX turns the day this file loads one of them into a
 * `SyntaxError` that kills the whole file before a test runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createLoader } from "./lib/tsLoader.mjs";

/** Every write in this file resolves `serverTimestamp()` to this instant. */
const STAMP = new Date("2026-09-06T12:00:00Z");

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
      "};\n" +
      // The real one is a sentinel the SDK recognises in orderBy; the store
      // below sorts by document path whatever it is handed, so the value only
      // has to be something recognisable.
      "export const FieldPath = { documentId: () => '__name__' };",
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
    "export async function assertNotImpersonating() {\n  return globalThis.__blocked ?? null;\n}",
  ],
]);

const { loadTs } = createLoader({ stubs: STUBS });

// ---------------------------------------------------------------------------
// A Firestore small enough to read. The same shape as the one in
// tests/worksheet-routes.test.mjs, plus the three things these routes use and
// that one does not: `orderBy`/`startAfter` paging, `add()` (which is how
// `logExport` writes), and a switch for making that add throw.
// ---------------------------------------------------------------------------

function resolveSentinels(value) {
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if ("__op" in value) {
      if (value.__op === "serverTimestamp") return STAMP;
      if (value.__op === "increment") return value.by;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = resolveSentinels(v);
    return out;
  }
  return value;
}

function matchesFilter(data, filter) {
  const actual = (data ?? {})[filter.field];
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(actual);
  return actual === filter.value;
}

function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  let autoId = 0;

  function apply(path, data) {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && "__op" in value) {
        if (value.__op === "serverTimestamp") next[key] = STAMP;
        else if (value.__op === "increment") {
          next[key] = (typeof next[key] === "number" ? next[key] : 0) + value.by;
        }
      } else {
        next[key] = resolveSentinels(value);
      }
    }
    docs.set(path, next);
  }

  function snapshot(path) {
    const data = docs.get(path);
    return {
      id: path.split("/").pop(),
      path,
      ref: docRef(path),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  function docRef(path) {
    return {
      id: path.split("/").pop(),
      path,
      collection: (name) => collectionRef(`${path}/${name}`),
      async get() {
        return snapshot(path);
      },
      async set(data) {
        docs.set(path, resolveSentinels(data));
      },
      async update(data) {
        apply(path, data);
      },
    };
  }

  function query(path, filters, max, after) {
    return {
      where: (field, op, value) => query(path, [...filters, { field, op, value }], max, after),
      // Every query in this feature orders by document id, and the store is
      // sorted by path below, so the field is not read. A test that needed a
      // second ordering would have to teach this fake about it rather than
      // quietly get path order.
      orderBy: () => query(path, filters, max, after),
      limit: (n) => query(path, filters, n, after),
      startAfter: (cursor) => query(path, filters, max, cursor.path ?? cursor),
      async get() {
        const out = [];
        const paths = [...docs.keys()].sort();
        for (const docPath of paths) {
          if (!docPath.startsWith(`${path}/`)) continue;
          // Direct children only.
          if (docPath.slice(path.length + 1).includes("/")) continue;
          if (!filters.every((f) => matchesFilter(docs.get(docPath), f))) continue;
          if (after !== undefined && !(docPath > after)) continue;
          out.push(snapshot(docPath));
        }
        const docsOut = typeof max === "number" ? out.slice(0, max) : out;
        return { docs: docsOut, empty: docsOut.length === 0, size: docsOut.length };
      },
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      async add(data) {
        if (globalThis.__addThrows && globalThis.__addThrows === path) {
          throw new Error(`${path} is unwritable`);
        }
        autoId += 1;
        const id = `auto${autoId}`;
        docs.set(`${path}/${id}`, resolveSentinels(data));
        return docRef(`${path}/${id}`);
      },
      ...query(path, [], undefined, undefined),
    };
  }

  return {
    docs,
    collection: collectionRef,
    doc: (path) => docRef(path),
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    batch() {
      const ops = [];
      return {
        create(ref, data) {
          ops.push({ kind: "create", ref, data });
        },
        set(ref, data) {
          ops.push({ kind: "set", ref, data });
        },
        update(ref, data) {
          ops.push({ kind: "update", ref, data });
        },
        delete(ref) {
          ops.push({ kind: "delete", ref });
        },
        async commit() {
          // A real batch fails WHOLE on an update to a missing document, which
          // is exactly the case the close route reads ahead to avoid.
          for (const op of ops) {
            if (op.kind === "update" && !docs.has(op.ref.path)) {
              const err = new Error("NOT_FOUND");
              err.code = 5;
              throw err;
            }
          }
          for (const op of ops) {
            if (op.kind === "delete") docs.delete(op.ref.path);
            else if (op.kind === "update") apply(op.ref.path, op.data);
            else docs.set(op.ref.path, resolveSentinels(op.data));
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The modules under test
// ---------------------------------------------------------------------------

const API = join("app", "api", "worksheets", "circulations", "[circulationId]");
const { GET: aggregate } = await loadTs(join(API, "aggregate", "route.ts"));
const { POST: exportCsv } = await loadTs(join(API, "export", "route.ts"));
const { POST: close } = await loadTs(join(API, "close", "route.ts"));
const {
  aggregateQuestion,
  tallyOptions,
  toCsvRows,
  REMOVED_OPTION_LABEL,
  UNTITLED_OPTION_LABEL,
} = await loadTs(join("features", "worksheets", "aggregate.ts"));
const { toCSV } = await loadTs(join("lib", "csv.ts"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPTIONS = [
  { id: "o1", label: "Tuesday" },
  { id: "o2", label: "Thursday" },
];

const Q_LIVE_POLL = {
  kind: "question",
  id: "qLive",
  type: "poll",
  title: "Which evening?",
  body: [],
  required: false,
  options: OPTIONS,
  poll: { resultsVisibility: "before-submit" },
};

const Q_LATE_POLL = {
  kind: "question",
  id: "qLate",
  type: "poll",
  title: "Which room?",
  body: [],
  required: false,
  options: OPTIONS,
  poll: { resultsVisibility: "after-submit" },
};

const Q_STAFF_POLL = {
  kind: "question",
  id: "qStaff",
  type: "poll",
  title: "Who should chair?",
  body: [],
  required: false,
  options: OPTIONS,
  poll: { resultsVisibility: "staff" },
};

const Q_CHOICE = {
  kind: "question",
  id: "qChoice",
  type: "singleChoice",
  title: "Your track",
  body: [],
  required: false,
  options: OPTIONS,
};

const Q_TEXT = {
  kind: "question",
  id: "qText",
  type: "shortText",
  title: "Anything else?",
  body: [],
  required: false,
};

const Q_RATING = {
  kind: "question",
  id: "qRating",
  type: "rating",
  title: "How was it?",
  body: [],
  required: false,
  rating: { max: 5 },
};

const ITEMS = [Q_LIVE_POLL, Q_LATE_POLL, Q_STAFF_POLL, Q_CHOICE, Q_TEXT, Q_RATING];

const ACTIVITY = {
  firstOpenedAt: new Date("2026-09-01T09:00:00Z"),
  pageOpens: 3,
  activeMs: 8 * 60 * 1000,
  lastActiveAt: new Date("2026-09-01T09:30:00Z"),
};

function response(uid, extra = {}) {
  return {
    uid,
    circulationId: "c1",
    taskId: `task-${uid}`,
    state: "started",
    answers: {},
    progress: { answered: 0, total: 6, requiredAnswered: 0, required: 0 },
    activity: { ...ACTIVITY },
    submittedAt: null,
    reviewedAt: null,
    returned: null,
    unfrozenAt: null,
    unfrozenByUid: null,
    addedAt: new Date("2026-09-01T08:00:00Z"),
    addedByUid: "sender1",
    updatedAt: new Date("2026-09-01T09:30:00Z"),
    ...extra,
  };
}

function task(uid, extra = {}) {
  return {
    title: "Term plan",
    completerUids: [uid],
    status: "in-progress",
    archived: false,
    artefact: { kind: "worksheet-response", circulationId: "c1" },
    ...extra,
  };
}

function seedWorld(extra = {}) {
  return makeDb({
    "users/sender1": { uid: "sender1", role: "committee", displayName: "Sam Sender" },
    "users/rae": {
      uid: "rae",
      role: "committee",
      displayName: "Rae Account",
      profile: { preferredName: "Rae One" },
    },
    "users/bo": { uid: "bo", role: "committee", displayName: "Bo Two" },
    "circulations/c1": {
      worksheetId: "ws1",
      title: "Term plan",
      description: "",
      items: ITEMS,
      senderUid: "sender1",
      authorUid: "sender1",
      reviewerUids: [],
      staffUids: ["sender1"],
      reviewConfig: {
        perQuestionFeedback: true,
        perQuestionScoring: false,
        overallFeedback: true,
        returnToRecipient: true,
      },
      notifications: {},
      dueDate: null,
      status: "open",
      anonymity: "named",
      source: { kind: "worksheet" },
      recipientCount: 2,
      submittedCount: 0,
      reviewedCount: 0,
      itemsEditedAt: null,
      createdAt: new Date("2026-09-01T08:00:00Z"),
      updatedAt: new Date("2026-09-01T08:00:00Z"),
      closedAt: null,
    },
    "circulations/c1/responses/rae": response("rae", {
      answers: {
        qLive: { type: "choice", optionId: "o1" },
        qLate: { type: "choice", optionId: "o2" },
        qText: { type: "text", text: "More tea." },
        qRating: { type: "rating", value: 4 },
      },
    }),
    "circulations/c1/responses/bo": response("bo", {
      state: "submitted",
      submittedAt: new Date("2026-09-02T10:00:00Z"),
      answers: {
        qLive: { type: "choice", optionId: "o1" },
        qLate: { type: "choice", optionId: "o1" },
        qRating: { type: "rating", value: 2 },
      },
    }),
    "tasks/task-rae": task("rae"),
    "tasks/task-bo": task("bo"),
    ...extra,
  });
}

const STAFF = { uid: "sender1", role: "committee", displayName: "Sam Sender" };
const RECIPIENT = { uid: "rae", role: "committee", displayName: "Rae One" };
const SUBMITTED_RECIPIENT = { uid: "bo", role: "committee", displayName: "Bo Two" };
const OUTSIDER = { uid: "nobody", role: "committee", displayName: "Nia Nobody" };

function context(circulationId) {
  return { params: Promise.resolve({ circulationId }) };
}

function getRequest(questionId) {
  return {
    url: `https://naisi.uk/api/worksheets/circulations/c1/aggregate?questionId=${questionId}`,
  };
}

/** Run `fn` with `console.error` muted, for the paths that log a failure. */
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test.beforeEach(() => {
  globalThis.__fakeUser = { ...STAFF };
  globalThis.__blocked = null;
  globalThis.__addThrows = null;
});

// ---------------------------------------------------------------------------
// aggregateQuestion, on its own
// ---------------------------------------------------------------------------

test("a single choice counts by option id, in the author's order", () => {
  const result = aggregateQuestion(Q_CHOICE, [
    { uid: "a", answer: { type: "choice", optionId: "o1" } },
    { uid: "b", answer: { type: "choice", optionId: "o1" } },
    { uid: "c", answer: { type: "choice", optionId: "o2" } },
    { uid: "d", answer: undefined },
  ]);
  assert.equal(result.kind, "options");
  assert.equal(result.respondents, 3, "the person who did not answer is not a respondent");
  assert.deepEqual(
    result.options.map((o) => [o.label, o.count, o.percent]),
    [
      ["Tuesday", 2, 67],
      ["Thursday", 1, 33],
    ],
  );
});

test("an option removed mid-flight is counted under (option removed), not dropped", () => {
  const result = aggregateQuestion(Q_CHOICE, [
    { uid: "a", answer: { type: "choice", optionId: "o1" } },
    // Two people chose an option the author has since deleted.
    { uid: "b", answer: { type: "choice", optionId: "gone" } },
    { uid: "c", answer: { type: "choice", optionId: "alsoGone" } },
  ]);
  assert.equal(result.respondents, 3);
  const removed = result.options.filter((o) => o.removed);
  assert.equal(removed.length, 1, "every orphaned id lands in ONE bucket");
  assert.equal(removed[0].label, REMOVED_OPTION_LABEL);
  assert.equal(removed[0].count, 2);
  // The counts must still add up to the respondents, or the chart claims two
  // people did not answer when they did.
  assert.equal(
    result.options.reduce((sum, o) => sum + o.count, 0),
    result.respondents,
  );
  assert.equal(result.options[result.options.length - 1].removed, true, "and it comes last");
});

test("an option nobody named is untitled, not removed: they are different facts", () => {
  // `newOption()` creates an option with an empty label and nothing refuses one
  // at circulate time, so a blank label is a LIVE choice. Printing "(option
  // removed)" over it would tell a sender three people chose something they had
  // deleted, and send them looking for an edit they never made.
  const question = { ...Q_CHOICE, options: [{ id: "o3", label: "  " }, ...OPTIONS] };
  const result = aggregateQuestion(question, [
    { uid: "a", answer: { type: "choice", optionId: "o3" } },
  ]);
  assert.equal(result.options[0].label, UNTITLED_OPTION_LABEL);
  assert.equal(result.options[0].removed, false, "it is still a choice anybody can tick");
  assert.notEqual(UNTITLED_OPTION_LABEL, REMOVED_OPTION_LABEL);
});

test("an empty bucket is not drawn: no removed row when nothing was orphaned", () => {
  const result = aggregateQuestion(Q_CHOICE, [
    { uid: "a", answer: { type: "choice", optionId: "o1" } },
  ]);
  assert.equal(result.options.some((o) => o.removed), false);
});

test("multiple choice counts one person once per option, and its percentages pass 100", () => {
  const question = { ...Q_CHOICE, id: "qMulti", type: "multipleChoice" };
  const result = aggregateQuestion(question, [
    { uid: "a", answer: { type: "choices", optionIds: ["o1", "o2"] } },
    { uid: "b", answer: { type: "choices", optionIds: ["o1"] } },
    // A malformed draft repeating an id must not vote twice.
    { uid: "c", answer: { type: "choices", optionIds: ["o2", "o2"] } },
  ]);
  assert.equal(result.respondents, 3);
  assert.deepEqual(
    result.options.map((o) => [o.optionId, o.count, o.percent]),
    [
      ["o1", 2, 67],
      ["o2", 2, 67],
    ],
  );
});

test("a rating gives a distribution over the scale and a mean, and null over nothing", () => {
  const empty = aggregateQuestion(Q_RATING, [{ uid: "a", answer: undefined }]);
  assert.equal(empty.kind, "rating");
  assert.equal(empty.respondents, 0);
  assert.equal(empty.mean, null, "a mean of zero would claim people rated this zero");
  assert.deepEqual(
    empty.bands.map((b) => b.value),
    [1, 2, 3, 4, 5],
    "every band on the scale is present, at zero",
  );

  const result = aggregateQuestion(Q_RATING, [
    { uid: "a", answer: { type: "rating", value: 4 } },
    { uid: "b", answer: { type: "rating", value: 5 } },
    { uid: "c", answer: { type: "rating", value: 2 } },
    // Zero is how a CLEARED rating comes back from the widget: unanswered, not
    // a rating of nought, so it must not drag the mean down.
    { uid: "d", answer: { type: "rating", value: 0 } },
  ]);
  assert.equal(result.respondents, 3);
  assert.equal(result.mean, 11 / 3);
  assert.deepEqual(
    result.bands.filter((b) => b.count > 0).map((b) => [b.value, b.count]),
    [
      [2, 1],
      [4, 1],
      [5, 1],
    ],
  );
});

test("text and image answers keep who said what, and skip the empties", () => {
  const text = aggregateQuestion(Q_TEXT, [
    { uid: "a", answer: { type: "text", text: "Yes" } },
    { uid: "b", answer: { type: "text", text: "   " } },
    { uid: "c", answer: undefined },
  ]);
  assert.equal(text.kind, "text");
  assert.deepEqual(text.texts, [{ uid: "a", text: "Yes" }]);
  assert.equal(text.respondents, 1, "whitespace is not an answer");

  const images = aggregateQuestion({ ...Q_TEXT, id: "qImg", type: "imageUpload" }, [
    { uid: "a", answer: { type: "images", images: [{ url: "u", storagePath: "p" }] } },
    { uid: "b", answer: { type: "images", images: [] } },
  ]);
  assert.equal(images.kind, "images");
  assert.equal(images.rows.length, 1);
  assert.equal(images.rows[0].uid, "a");
});

test("tallyOptions turns wire counts into the same bars the staff view draws", () => {
  // The recipient's road: counts from the route, no answers in hand. It has to
  // produce what `aggregateQuestion` produces from the answers themselves, or
  // a poll reads differently to the two audiences looking at it.
  const fromCounts = tallyOptions(Q_CHOICE, { o1: 2, o2: 1 }, 3);
  const fromAnswers = aggregateQuestion(Q_CHOICE, [
    { uid: "a", answer: { type: "choice", optionId: "o1" } },
    { uid: "b", answer: { type: "choice", optionId: "o1" } },
    { uid: "c", answer: { type: "choice", optionId: "o2" } },
  ]).options;
  assert.deepEqual(fromCounts, fromAnswers);
});

// ---------------------------------------------------------------------------
// toCsvRows
// ---------------------------------------------------------------------------

const NAMES = new Map([
  ["rae", "Rae One"],
  ["bo", "Bo Two"],
]);

function table(responses, names = NAMES) {
  return toCsvRows({ items: ITEMS }, responses, names);
}

/** The normalised shape `toCsvRows` is handed by the route. */
function row(uid, extra = {}) {
  const base = response(uid, extra);
  return { ...base, id: uid };
}

test("the CSV puts who first, then the questions in order, then the response's own columns", () => {
  const { header } = table([row("rae")]);
  assert.deepEqual(header, [
    "uid",
    "name",
    "Which evening?",
    "Which room?",
    "Who should chair?",
    "Your track",
    "Anything else?",
    "How was it?",
    "state",
    "submitted at",
    "first opened at",
    "page opens",
    "active minutes",
  ]);
});

test("each answer type becomes the cell a reader expects", () => {
  const { header, rows } = table([
    row("rae", {
      state: "submitted",
      submittedAt: new Date("2026-09-02T10:00:00Z"),
      answers: {
        qLive: { type: "choice", optionId: "o1" },
        qChoice: { type: "choice", optionId: "gone" },
        qText: { type: "text", text: "More tea." },
        qRating: { type: "rating", value: 4 },
      },
    }),
  ]);
  const cell = (name) => rows[0][header.indexOf(name)];
  assert.equal(cell("uid"), "rae");
  assert.equal(cell("name"), "Rae One");
  assert.equal(cell("Which evening?"), "Tuesday");
  assert.equal(cell("Your track"), REMOVED_OPTION_LABEL, "a dead option id still says so");
  assert.equal(cell("Which room?"), "", "an unanswered question is blank, not 'undefined'");
  assert.equal(cell("Anything else?"), "More tea.");
  assert.equal(cell("How was it?"), "4");
  assert.equal(cell("state"), "Submitted", "the label, not the stored token");
  assert.equal(cell("submitted at"), "2026-09-02T10:00:00.000Z");
  assert.equal(cell("first opened at"), "2026-09-01T09:00:00.000Z");
  assert.equal(cell("page opens"), "3");
  assert.equal(cell("active minutes"), "8");
});

test("a cell for an option with no label says untitled, not removed", () => {
  const items = [{ ...Q_CHOICE, options: [{ id: "o3", label: "" }, ...OPTIONS] }];
  const { rows } = toCsvRows({ items }, [
    row("rae", { answers: { qChoice: { type: "choice", optionId: "o3" } } }),
  ], NAMES);
  // Two different facts, and a spreadsheet is read long after the worksheet is
  // closed: "(option removed)" in this cell would be a claim about an edit.
  assert.equal(rows[0][2], UNTITLED_OPTION_LABEL);
});

test("multiple choices join with a semicolon, in the author's order, and images with a space", () => {
  const items = [
    { ...Q_CHOICE, id: "qMulti", type: "multipleChoice" },
    { ...Q_TEXT, id: "qImg", type: "imageUpload" },
  ];
  const { rows } = toCsvRows(
    { items },
    [
      row("rae", {
        answers: {
          // Ticked the other way round on purpose: the cell must not depend on
          // the order somebody clicked in.
          qMulti: { type: "choices", optionIds: ["o2", "o1", "gone"] },
          qImg: {
            type: "images",
            images: [
              { url: "https://x/1.png", storagePath: "a" },
              { url: "https://x/2.png", storagePath: "b" },
            ],
          },
        },
      }),
    ],
    NAMES,
  );
  assert.equal(rows[0][2], `Tuesday; Thursday; ${REMOVED_OPTION_LABEL}`);
  assert.equal(rows[0][3], "https://x/1.png https://x/2.png");
});

test("rows come out in name order, and a uid with no user document is not an email", () => {
  const { rows } = table([row("rae"), row("bo"), row("ghost")]);
  assert.deepEqual(
    rows.map((r) => [r[0], r[1]]),
    [
      ["bo", "Bo Two"],
      ["ghost", "NAISI member"],
      ["rae", "Rae One"],
    ],
  );
});

test("a formula somebody typed into an answer is neutralised in the built file", () => {
  // The rows themselves are RAW: escaping is `toCSV`'s job, once, at the file
  // boundary. So the guarantee is asserted on the file, which is what leaves
  // the platform and what Excel opens.
  const { header, rows } = table([
    row("rae", {
      answers: { qText: { type: "text", text: `=cmd|'/c calc'!A1` } },
    }),
  ]);
  assert.equal(
    rows[0][header.indexOf("Anything else?")],
    `=cmd|'/c calc'!A1`,
    "the table carries what they typed",
  );
  const file = toCSV(header, rows);
  assert.ok(
    file.includes(`\t=cmd|'/c calc'!A1`),
    "and the file tabs it so a spreadsheet cannot execute it",
  );
  assert.equal(file.includes(`,=cmd`), false, "never as a bare formula cell");
});

test("a comma, a quote and a newline in an answer survive the round trip", () => {
  const { header, rows } = table([
    row("rae", { answers: { qText: { type: "text", text: 'Yes, "loudly"\nand twice' } } }),
  ]);
  const file = toCSV(header, rows);
  assert.ok(file.includes(`"Yes, ""loudly""\nand twice"`));
});

// ---------------------------------------------------------------------------
// GET .../aggregate: who may see the counts
// ---------------------------------------------------------------------------

test("staff read the counts on any question, including a staff-only poll", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  const res = await aggregate(getRequest("qStaff"), context("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.questionId, "qStaff");
  assert.deepEqual(res.body.counts, { o1: 0, o2: 0 });
});

test("a before-submit poll is readable by a recipient who has answered it", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };
  const res = await aggregate(getRequest("qLive"), context("c1"));
  assert.equal(res.status, 200);
  // Both answers count, including the one from a response nobody has submitted:
  // a vote is a vote the moment it is stored.
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.counts, { o1: 2, o2: 0 });
});

test("a before-submit poll tells a recipient nothing until they have voted", async () => {
  // "Before-submit" is about the SUBMISSION it does not wait for, not about the
  // answer it does. Handing the tally to somebody who has not picked yet primes
  // the vote they came to cast, and the respond page prints the same rule
  // ("Results appear once you answer"), so the two must not disagree.
  const db = seedWorld({
    "circulations/c1/responses/cy": response("cy", { answers: {} }),
  });
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "cy", role: "committee", displayName: "Cy Three" };

  const before = await aggregate(getRequest("qLive"), context("c1"));
  assert.equal(before.status, 403, "no answer of their own yet");

  // The same refusal as a staff-only poll: a recipient must not be able to tell
  // "you have not voted" from "this poll is not for you" and read the
  // worksheet's configuration off the difference.
  const staffPoll = await aggregate(getRequest("qStaff"), context("c1"));
  assert.equal(before.body.error, staffPoll.body.error);

  // The vote lands (the store is the Map the fake hands back).
  db.docs.set(
    "circulations/c1/responses/cy",
    response("cy", { answers: { qLive: { type: "choice", optionId: "o2" } } }),
  );
  const after = await aggregate(getRequest("qLive"), context("c1"));
  assert.equal(after.status, 200, "their own vote is what opens it");
  assert.deepEqual(after.body.counts, { o1: 2, o2: 1 });
});

test("submitting without answering an optional poll still opens its results", async () => {
  // The one exception, and the route and the panel make it together: once a
  // response is frozen there is no vote left to prime, and a permanent refusal
  // for somebody who skipped an optional question would buy nothing.
  const db = seedWorld({
    "circulations/c1/responses/cy": response("cy", {
      state: "submitted",
      submittedAt: new Date("2026-09-02T11:00:00Z"),
      answers: {},
    }),
  });
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "cy", role: "committee", displayName: "Cy Three" };
  const res = await aggregate(getRequest("qLive"), context("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2, "and their own blank does not count as a vote");
});

test("a question id that is not there is a 404 for staff and a refusal for anybody else", async () => {
  // The 404 is a fact about the document: staff are editing this worksheet and
  // a wrong id is a bug they need to see. To a recipient it would be a way to
  // tell a real question id from an invented one, one guess at a time.
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };
  const missing = await aggregate(getRequest("nope"), context("c1"));
  assert.equal(missing.status, 403);
  const staffOnly = await aggregate(getRequest("qStaff"), context("c1"));
  assert.equal(missing.body.error, staffOnly.body.error);
});

test("an after-submit poll is refused until that recipient has submitted", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;

  globalThis.__fakeUser = { ...RECIPIENT };
  const early = await aggregate(getRequest("qLate"), context("c1"));
  assert.equal(early.status, 403, "rae is still 'started'");

  globalThis.__fakeUser = { ...SUBMITTED_RECIPIENT };
  const later = await aggregate(getRequest("qLate"), context("c1"));
  assert.equal(later.status, 200, "bo has submitted");
  assert.deepEqual(later.body.counts, { o1: 1, o2: 1 });
});

test("a staff-only poll and a non-poll question are both refused to a recipient", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };

  const staffPoll = await aggregate(getRequest("qStaff"), context("c1"));
  assert.equal(staffPoll.status, 403);

  // A single choice is not a poll however it is spelled: only a poll's author
  // opted into an audience for its aggregate.
  const choice = await aggregate(getRequest("qChoice"), context("c1"));
  assert.equal(choice.status, 403);

  const text = await aggregate(getRequest("qText"), context("c1"));
  assert.equal(text.status, 403);

  // The three refusals are the SAME refusal: telling them apart would let a
  // recipient walk the question ids and learn how each one is configured.
  assert.equal(staffPoll.body.error, choice.body.error);
  assert.equal(choice.body.error, text.body.error);
});

test("somebody who was never sent this worksheet gets nothing from it", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...OUTSIDER };
  const res = await aggregate(getRequest("qLive"), context("c1"));
  assert.equal(res.status, 403);
});

test("the counts carry no names, no uids and no timestamps", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };
  const res = await aggregate(getRequest("qLive"), context("c1"));
  const serialised = JSON.stringify(res.body);
  for (const leak of ["rae", "bo", "Rae One", "Bo Two", "submitted", "addedAt"]) {
    assert.equal(
      serialised.includes(leak),
      false,
      `the aggregate body must never carry "${leak}"`,
    );
  }
  assert.deepEqual(Object.keys(res.body).sort(), ["counts", "questionId", "total", "type"]);
});

test("a rating aggregate answers with a distribution and a mean", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  const res = await aggregate(getRequest("qRating"), context("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.mean, 3);
  assert.equal(res.body.distribution["4"], 1);
  assert.equal(res.body.distribution["2"], 1);
  assert.equal(res.body.distribution["1"], 0);
});

test("a question id nobody asked is a 404, and a missing one is a 400", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  assert.equal((await aggregate(getRequest("nope"), context("c1"))).status, 404);
  assert.equal(
    (await aggregate({ url: "https://naisi.uk/x/aggregate" }, context("c1"))).status,
    400,
  );
});

// ---------------------------------------------------------------------------
// POST .../export
// ---------------------------------------------------------------------------

test("staff export the answers, and the file is logged before it is handed over", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  const res = await exportCsv({}, context("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.match(res.headers.get("Content-Disposition"), /worksheet-term-plan-\d{4}-\d{2}-\d{2}\.csv/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  const body = await res.text();
  assert.ok(body.startsWith("uid,name,Which evening?"));
  assert.ok(body.includes("Rae One"), "the preferred name wins over the account name");
  assert.ok(body.includes("More tea."));

  const logged = [...db.docs.entries()].filter(([path]) => path.startsWith("dataExports/"));
  assert.equal(logged.length, 1);
  const [, entry] = logged[0];
  assert.equal(entry.kind, "worksheet-responses");
  assert.equal(entry.actorUid, "sender1");
  assert.deepEqual(entry.scope, { circulationId: "c1" });
  assert.equal(entry.rowCount, 2, "the real count, not an estimate");
  assert.equal(entry.viaImpersonation, false);
});

test("no email address is anywhere in the exported file", async () => {
  const db = seedWorld({
    "users/rae": {
      uid: "rae",
      role: "committee",
      displayName: "Rae One",
      email: "rae@example.com",
      profile: { universityEmail: "rae@nottingham.ac.uk" },
    },
  });
  globalThis.__fakeDb = db;
  const body = await (await exportCsv({}, context("c1"))).text();
  assert.equal(body.includes("@"), false, "the file carries names, never addresses");
});

test("a log write that fails REFUSES the export: no file, no rows", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__addThrows = "dataExports";
  const res = await quietly(() => exportCsv({}, context("c1")));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /could not be recorded/);
  assert.equal(typeof res.body.error, "string");
  assert.equal(res.headers, undefined, "a refusal is JSON, never a CSV body");
  assert.equal(
    [...db.docs.keys()].some((path) => path.startsWith("dataExports/")),
    false,
  );
});

test("a reviewer who is not staff of this circulation cannot export it", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };
  const res = await exportCsv({}, context("c1"));
  assert.equal(res.status, 403);
  assert.equal(
    [...db.docs.keys()].some((path) => path.startsWith("dataExports/")),
    false,
    "a refused export writes no audit row either",
  );
});

test("an admin is staff of every circulation, and a view-as session is not", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { uid: "adminx", role: "admin", displayName: "Al Admin" };
  assert.equal((await exportCsv({}, context("c1"))).status, 200);

  globalThis.__blocked = { status: 403, body: { error: "viewing as somebody" } };
  const blocked = await exportCsv({}, context("c1"));
  assert.equal(blocked.status, 403);
  assert.equal(
    [...db.docs.keys()].filter((path) => path.startsWith("dataExports/")).length,
    1,
    "the blocked call wrote nothing",
  );
});

// ---------------------------------------------------------------------------
// POST .../close
// ---------------------------------------------------------------------------

test("closing stops the answers and archives a card on every recipient's board", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  const res = await close({}, context("c1"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, archivedTasks: 2 });

  const circulation = db.docs.get("circulations/c1");
  assert.equal(circulation.status, "closed");
  assert.deepEqual(circulation.closedAt, STAMP);
  assert.equal(db.docs.get("tasks/task-rae").archived, true);
  assert.equal(db.docs.get("tasks/task-bo").archived, true);
  // The response documents are untouched: closing takes no answers away.
  assert.equal(db.docs.get("circulations/c1/responses/rae").state, "started");
});

test("closing twice is agreement, not a conflict", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  await close({}, context("c1"));
  const again = await close({}, context("c1"));
  assert.equal(again.status, 200);
  assert.deepEqual(
    again.body,
    { ok: true, archivedTasks: 0 },
    "the count is what THIS call moved",
  );
});

test("a task an admin deleted does not stop the close", async () => {
  const db = seedWorld();
  db.docs.delete("tasks/task-bo");
  globalThis.__fakeDb = db;
  const res = await close({}, context("c1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.archivedTasks, 1, "only the card that was there");
  assert.equal(db.docs.get("circulations/c1").status, "closed");
});

test("an already-archived task is not counted twice", async () => {
  const db = seedWorld({ "tasks/task-bo": task("bo", { archived: true }) });
  globalThis.__fakeDb = db;
  const res = await close({}, context("c1"));
  assert.equal(res.body.archivedTasks, 1);
});

test("a recipient cannot close the worksheet they were sent", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  globalThis.__fakeUser = { ...RECIPIENT };
  const res = await close({}, context("c1"));
  assert.equal(res.status, 403);
  assert.equal(db.docs.get("circulations/c1").status, "open");
  assert.equal(db.docs.get("tasks/task-rae").archived, false);
});

test("a circulation that is not there answers 404, not a permission error", async () => {
  const db = seedWorld();
  globalThis.__fakeDb = db;
  assert.equal((await close({}, context("nope"))).status, 404);
  assert.equal((await exportCsv({}, context("nope"))).status, 404);
  assert.equal((await aggregate(getRequest("qLive"), context("nope"))).status, 404);
});
