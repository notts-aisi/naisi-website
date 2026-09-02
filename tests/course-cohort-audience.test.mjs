/**
 * THE COHORT AUDIENCE, and the group scope the attendance push resolves it
 * with (`resolveCohortAudience` in `src/lib/email/courseFacilitatorEmails.ts`).
 *
 * The property under test is an ORDERING one, and it is the kind that fails
 * silently in production: the recipient ceiling has to be counted on the
 * audience actually being mailed. The push mails ONE GROUP. If the ceiling is
 * counted on the whole run and the group filter runs afterwards, a 250-person
 * pre-course spread over a dozen groups refuses every group's reminder while
 * every register locks correctly, and nobody notices until a cohort says the
 * emails stopped.
 *
 * ## The loader dance
 *
 * Same shape as `course-nudge.test.mjs`. `courseFacilitatorEmails.ts` reaches
 * for React email components, the Admin SDK singleton and the transport, none
 * of which a unit test may touch, so each is stubbed by specifier. Nothing in
 * `STUBS` is reachable from an assertion here: the audience derivation itself
 * is real, and so are the subscription and suppression readers it calls, which
 * run against a fake Firestore built in this file.
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
  // React email components. Only the send path renders them.
  [
    join(SRC, "emails", "ApplicationEmail.tsx"),
    "export default function ApplicationEmail() { throw new Error('stubbed'); }",
  ],
  [
    join(SRC, "emails", "NewsletterEmail.tsx"),
    "export default function NewsletterEmail() { throw new Error('stubbed'); }",
  ],
  // The Admin SDK singleton and the session reader. This test hands the
  // audience its own db and never authenticates anybody.
  [
    join(SRC, "lib", "firebase", "admin.ts"),
    "export function getAdminDb() { return null; }\nexport function getAdminAuth() { return null; }",
  ],
  [
    join(SRC, "lib", "firebase", "session.ts"),
    "export async function getCurrentUser() { return null; }",
  ],
  // nodemailer + the deliverability log. A unit test must not send mail.
  [
    join(SRC, "lib", "email", "send.ts"),
    "export function sendEmail() { throw new Error('sendEmail is stubbed in tests'); }",
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
        "the `typescript` devDependency is not installed, run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const { MAX_COHORT_RECIPIENTS, resolveCohortAudience } = await loadTs(
  "lib/email/courseFacilitatorEmails.ts",
);
const { courseEnrolmentId } = await loadTs("lib/firestore/courseEnrolments.ts");

const LANE = { logTag: "test lane", overCapAdvice: "split the group" };
const RUN_ID = "ai-safety-pre-course__k3f9a2b1";

// ---------------------------------------------------------------------------
// A fake Firestore: enough for one addressed read and one equality query
// ---------------------------------------------------------------------------

/**
 * `store` is `collection -> docId -> data`. Only the two shapes the audience
 * derivation actually uses are implemented: `collection().where().get()` for
 * the subscription rows, and `getAll(...refs)` for the enrolments, the users
 * and the suppression list. Anything else throws rather than answering
 * plausibly, so a future read that this fake cannot honestly serve fails the
 * test instead of quietly returning nothing.
 */
function fakeDb(store) {
  const snapOf = (collection, id) => {
    const data = store[collection]?.[id];
    return {
      id,
      exists: data !== undefined,
      data: () => data,
      ref: { id },
    };
  };
  return {
    collection(name) {
      const filters = [];
      const chain = {
        doc: (id) => ({ id, __collection: name }),
        where(field, op, value) {
          if (op !== "==") throw new Error(`unsupported operator ${op}`);
          filters.push([field, value]);
          return chain;
        },
        async get() {
          const docs = Object.entries(store[name] ?? {})
            .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
            .map(([id, data]) => ({ id, exists: true, data: () => data }));
          return { docs, empty: docs.length === 0 };
        },
      };
      return chain;
    },
    async getAll(...refs) {
      return refs.map((ref) => snapOf(ref.__collection, ref.id));
    },
  };
}

/** One member: a confirmed cohort subscription, an enrolment, a user doc. */
function member(store, { uid, groupId, status = "active" }) {
  store.subscriptions[`sub_${uid}`] = {
    email: `${uid}@example.test`,
    channel: `cohort:${RUN_ID}`,
    audience: "user",
    audienceId: uid,
    confirmed: true,
    subscribed: true,
  };
  store.courseEnrolments[courseEnrolmentId(RUN_ID, uid)] = {
    runId: RUN_ID,
    uid,
    groupId,
    status,
  };
  store.users[uid] = { displayName: `Member ${uid}`, profile: {} };
}

function cohort({ groups, perGroup }) {
  const store = { subscriptions: {}, courseEnrolments: {}, users: {}, suppressedEmails: {} };
  for (let g = 0; g < groups; g += 1) {
    for (let i = 0; i < perGroup; i += 1) {
      member(store, { uid: `g${g}m${i}`, groupId: `group-${g}` });
    }
  }
  return store;
}

// ---------------------------------------------------------------------------
// The group scope
// ---------------------------------------------------------------------------

test("a group's audience is that group, not the run", async () => {
  const db = fakeDb(cohort({ groups: 3, perGroup: 4 }));
  const audience = await resolveCohortAudience(db, RUN_ID, LANE, {
    groupId: "group-1",
  });

  assert.equal(audience.refusal, null);
  assert.equal(audience.members.length, 4);
  assert.deepEqual(
    [...new Set(audience.members.map((m) => m.groupId))],
    ["group-1"],
  );
  assert.equal(audience.enrolledCount, 4, "the count judged by the cap is the group's");
});

test("members of the run's OTHER groups are not counted as skipped", async () => {
  // They were never this send's audience. Counting them would have a group of
  // four report eight recipients dropped, which reads as a fault.
  const db = fakeDb(cohort({ groups: 3, perGroup: 4 }));
  const audience = await resolveCohortAudience(db, RUN_ID, LANE, {
    groupId: "group-1",
  });
  assert.equal(audience.skipped, 0);
});

test("THE CAP IS COUNTED ON THE GROUP, NOT THE RUN", async () => {
  // The regression this test exists for: a run far over the ceiling, split
  // into groups that are all comfortably under it. Every group must still be
  // mailable, or every push locks a register and sends nothing.
  const perGroup = 10;
  const groups = Math.ceil((MAX_COHORT_RECIPIENTS * 1.25) / perGroup);
  const store = cohort({ groups, perGroup });
  const db = fakeDb(store);

  assert.ok(
    Object.keys(store.subscriptions).length > MAX_COHORT_RECIPIENTS,
    "the fixture run has to be over the ceiling for this to be a test",
  );

  const scoped = await resolveCohortAudience(db, RUN_ID, LANE, { groupId: "group-2" });
  assert.equal(scoped.refusal, null, "a ten-person group is not over a 200-person cap");
  assert.equal(scoped.members.length, perGroup);

  // And the unscoped lane still refuses: the run really is too big for one
  // send, and the group scope must not have weakened that answer.
  const wholeRun = await resolveCohortAudience(db, RUN_ID, LANE);
  assert.ok(wholeRun.refusal, "the run-wide lane still refuses over the cap");
  assert.equal(wholeRun.members.length, 0);
});

test("an unallocated member is in no group's audience", async () => {
  const store = cohort({ groups: 1, perGroup: 2 });
  member(store, { uid: "waiting", groupId: null });
  const db = fakeDb(store);

  const audience = await resolveCohortAudience(db, RUN_ID, LANE, {
    groupId: "group-0",
  });
  assert.equal(audience.members.length, 2);
  assert.ok(!audience.members.some((m) => m.uid === "waiting"));
});

test("a withdrawn member of the group is dropped, and counted", async () => {
  const store = cohort({ groups: 1, perGroup: 2 });
  member(store, { uid: "gone", groupId: "group-0", status: "withdrawn" });
  const db = fakeDb(store);

  const audience = await resolveCohortAudience(db, RUN_ID, LANE, {
    groupId: "group-0",
  });
  assert.equal(audience.members.length, 2);
  assert.equal(
    audience.skipped,
    1,
    "a subscribed row with no ACTIVE enrolment is the case `skipped` is for",
  );
});

test("no scope is the whole run, unchanged", async () => {
  const db = fakeDb(cohort({ groups: 3, perGroup: 4 }));
  const audience = await resolveCohortAudience(db, RUN_ID, LANE);
  assert.equal(audience.members.length, 12);
  assert.equal(audience.enrolledCount, 12);
});
