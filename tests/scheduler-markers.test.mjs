/**
 * Unit tests for the FIRESTORE half of the marker lifecycle:
 * `src/lib/scheduler/markers.ts`: `claim`, `stampSent`, `stampError`,
 * `stampSkipped` and `retryFailedMarker`.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists alongside tests/scheduler.test.mjs
 *
 * That suite pins the PURE half: the marker id scheme and
 * `decideMarkerClaim`, the function that answers "claim, skip or give up".
 * Everything that makes the answer stick lives here instead, and none of it
 * is expressible as a pure function:
 *
 *  - the FAST PATH is a `.create()`, and the whole no-duplicate-send property
 *    rests on that call being atomic. A `.set()` would be silently wrong.
 *  - the SLOW PATH re-runs the same decision inside a transaction, because
 *    two ticks that both saw one stale marker must not both send. The
 *    decision function cannot enforce that on its own; the transaction can.
 *  - `retryFailedMarker` is the one write an ADMIN triggers, and it must
 *    refuse a marker that already went out (a "retry" would be a duplicate)
 *    and a marker still in flight (a "retry" would race a live send).
 *
 * ## The fake Firestore
 *
 * A double, not the emulator: this suite runs in `npm test`, which has no
 * emulator and must not reach a project. It implements exactly the four
 * behaviours the code under test depends on, and nothing else:
 *
 *  1. `.create()` throws `code 6` when the document is already there, the
 *     ALREADY_EXISTS that means somebody else owns this unit of work;
 *  2. `.set(..., { merge: true })` merges;
 *  3. `runTransaction` REPLAYS its body when a document it read changed
 *     underneath it, which is the property the concurrent-re-claim test is
 *     actually about;
 *  4. `FieldValue.serverTimestamp()` resolves to the fake's clock at write
 *     time, so a re-claimed marker's `claimedAt` really does move.
 *
 * ## The loader dance
 *
 * Same as tests/course-deletion.test.mjs: this repo's Node is v20 and cannot
 * import `.ts`, so the module is transpiled in memory with the `typescript`
 * devDependency, `@/…` is resolved by hand, and `server-only` plus
 * `firebase-admin/firestore` are stubbed.
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
  DEFAULT_MARKER_POLICY,
  SCHEDULER_MARKERS_COLLECTION,
  SCHEDULER_MARKER_RETENTION_DAYS,
  breakReturnMarker,
  claim,
  errorText,
  retryFailedMarker,
  schedulerMarkerExpiry,
  stampError,
  stampSent,
  stampSkipped,
} = await loadTs("lib/scheduler/markers.ts");
const { JOBS, MIN_RECLAIM_AFTER_MINUTES, policyFor } =
  await loadTs("lib/scheduler/registry.ts");
const { heartbeatJob } = await loadTs("lib/scheduler/jobs/heartbeat.ts");

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

/**
 * The fake's clock, and it has to be the REAL one.
 *
 * `claim()` reads `new Date()` itself when it re-runs the decision, and
 * deliberately so: the re-claim rule is about elapsed wall-clock time and
 * a job handler must not be able to pass a "now" that makes a live send
 * look stale. A pinned literal here would sit in the future or the past of
 * that call and every age in this file would be nonsense.
 */
const NOW = new Date();
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000);

/** ALREADY_EXISTS, exactly as the Admin SDK raises it. */
function alreadyExists(id) {
  const err = new Error(`already exists: ${id}`);
  err.code = 6;
  return err;
}

function makeDb({ clock = () => NOW } = {}) {
  const store = new Map();
  const stats = { creates: 0, sets: 0, transactionRuns: 0, transactionReplays: 0 };

  const resolveValue = (value) =>
    value !== null &&
    typeof value === "object" &&
    value.__sentinel === SERVER_TIMESTAMP
      ? clock()
      : value;

  function applyWrite(id, data, merge) {
    const resolved = {};
    for (const [key, value] of Object.entries(data)) resolved[key] = resolveValue(value);
    const current = store.get(id);
    store.set(id, {
      data: merge && current ? { ...current.data, ...resolved } : resolved,
      version: (current?.version ?? 0) + 1,
    });
  }

  const snapshotOf = (id) => {
    const row = store.get(id);
    return {
      id,
      exists: row !== undefined,
      data: () => (row === undefined ? undefined : { ...row.data }),
    };
  };

  const versionOf = (id) => store.get(id)?.version ?? 0;

  function docRef(id) {
    return {
      id,
      async create(data) {
        stats.creates += 1;
        await Promise.resolve();
        if (store.has(id)) throw alreadyExists(id);
        applyWrite(id, data, false);
      },
      async set(data, options) {
        stats.sets += 1;
        await Promise.resolve();
        applyWrite(id, data, options?.merge === true);
      },
      async get() {
        await Promise.resolve();
        return snapshotOf(id);
      },
    };
  }

  return {
    collection(name) {
      assert.equal(
        name,
        SCHEDULER_MARKERS_COLLECTION,
        "the marker layer must only ever touch its own collection",
      );
      return { doc: docRef };
    },
    async runTransaction(body) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        stats.transactionRuns += 1;
        const reads = new Map();
        const writes = [];
        const result = await body({
          async get(ref) {
            await Promise.resolve();
            reads.set(ref.id, versionOf(ref.id));
            return snapshotOf(ref.id);
          },
          set(ref, data, options) {
            writes.push([ref.id, data, options?.merge === true]);
          },
        });
        // A commit is not instantaneous, and this yield is what lets two
        // concurrent transactions interleave the way two ticks would.
        await Promise.resolve();
        let stale = false;
        for (const [id, version] of reads) {
          if (versionOf(id) !== version) stale = true;
        }
        if (stale) {
          stats.transactionReplays += 1;
          continue;
        }
        for (const [id, data, merge] of writes) applyWrite(id, data, merge);
        return result;
      }
      throw new Error("fake firestore: the transaction never committed");
    },
    stats,
    read: (id) => {
      const row = store.get(id);
      return row === undefined ? null : { ...row.data };
    },
    seed: (id, data) => store.set(id, { data: { ...data }, version: 1 }),
  };
}

/** The `breakret__` family: the one whose id carries a run AND a group. */
const REF = breakReturnMarker("incubator__ff00ee11", "tuesdays-1800__aa11bb22", "20270201");
const JOB = "courses-break-return";

/** A marker as it sits mid-flight, before whichever field a test is about. */
function seededMarker(extra) {
  return {
    job: JOB,
    family: REF.family,
    ...REF.fields,
    claimedAt: minutesAgo(1),
    attempts: 1,
    sentAt: null,
    failedAt: null,
    skippedReason: null,
    lastError: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

describe("claim", () => {
  test("the fast path is a .create(), writes attempts 1, and stores every id component as a field", async () => {
    const db = makeDb();
    const outcome = await claim(db, REF, { job: JOB });

    assert.deepEqual(outcome, { claimed: true, attempts: 1, reclaimed: false });
    assert.equal(db.stats.creates, 1);
    assert.equal(
      db.stats.transactionRuns,
      0,
      "fresh work must not pay for a transaction: .create() is already atomic",
    );

    const stored = db.read(REF.id);
    assert.equal(stored.job, JOB);
    assert.equal(stored.family, "breakret");
    assert.equal(stored.attempts, 1);
    assert.equal(stored.sentAt, null);
    assert.equal(stored.failedAt, null);
    assert.equal(stored.skippedReason, null);
    assert.deepEqual(stored.claimedAt, NOW);
    // The panel and the destroy cascade both query markers by these fields
    // rather than parsing ids, so every component is stored top level.
    assert.equal(stored.runId, "incubator__ff00ee11");
    assert.equal(stored.groupId, "tuesdays-1800__aa11bb22");
    assert.equal(stored.slotStartKey, "20270201");
  });

  test("a second claim on fresh work is refused by ALREADY_EXISTS, not by a read", async () => {
    const db = makeDb();
    await claim(db, REF, { job: JOB });
    const second = await claim(db, REF, { job: JOB });

    assert.deepEqual(second, { claimed: false, reason: "in-flight" });
    assert.equal(db.stats.creates, 2, "the second call still tries the atomic path first");
    assert.equal(db.read(REF.id).attempts, 1, "a refused claim must not touch the marker");
  });

  test("a stale marker at attempts 2 is re-claimed at 3, with the claim clock moved on", async () => {
    const db = makeDb();
    db.seed(
      REF.id,
      seededMarker({
        attempts: 2,
        claimedAt: minutesAgo(DEFAULT_MARKER_POLICY.reclaimAfterMinutes * 3),
      }),
    );

    const outcome = await claim(db, REF, { job: JOB });

    assert.deepEqual(outcome, { claimed: true, attempts: 3, reclaimed: true });
    assert.equal(db.stats.transactionRuns, 1, "recovery goes through a transaction");
    const stored = db.read(REF.id);
    assert.equal(stored.attempts, 3);
    assert.deepEqual(stored.claimedAt, NOW, "the re-claim resets the in-flight window");
    assert.equal(stored.sentAt, null);
  });

  test("at attempts 3 it gives up: failedAt is stamped inside the transaction and nothing is claimed", async () => {
    const db = makeDb();
    db.seed(
      REF.id,
      seededMarker({
        attempts: DEFAULT_MARKER_POLICY.maxAttempts,
        claimedAt: minutesAgo(DEFAULT_MARKER_POLICY.reclaimAfterMinutes * 3),
        lastError: null,
      }),
    );

    const outcome = await claim(db, REF, { job: JOB });

    assert.deepEqual(outcome, { claimed: false, reason: "gave-up" });
    const stored = db.read(REF.id);
    assert.deepEqual(stored.failedAt, NOW, "a marker out of attempts must become VISIBLE");
    assert.match(stored.lastError, /Gave up after 3 claims/);
    assert.equal(stored.sentAt, null);
    assert.equal(
      stored.attempts,
      DEFAULT_MARKER_POLICY.maxAttempts,
      "giving up must not consume a further attempt",
    );
  });

  test("an existing lastError survives the give-up, because it is the reason", async () => {
    const db = makeDb();
    db.seed(
      REF.id,
      seededMarker({
        attempts: DEFAULT_MARKER_POLICY.maxAttempts,
        claimedAt: minutesAgo(60),
        lastError: "Resend answered 503",
      }),
    );
    await claim(db, REF, { job: JOB });
    assert.equal(db.read(REF.id).lastError, "Resend answered 503");
  });

  test("two ticks racing one STALE marker produce exactly one claim", async () => {
    // The reason the slow path is a transaction at all. Both ticks see the
    // same stale marker, both decide "reclaim", and without the re-read the
    // decision authorises two sends of the same thing.
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, claimedAt: minutesAgo(60) }));

    const outcomes = await Promise.all([
      claim(db, REF, { job: JOB }),
      claim(db, REF, { job: JOB }),
    ]);

    const claimed = outcomes.filter((o) => o.claimed === true);
    assert.equal(claimed.length, 1, `two winners: ${JSON.stringify(outcomes)}`);
    assert.equal(claimed[0].attempts, 2);
    assert.equal(outcomes.find((o) => o.claimed === false).reason, "in-flight");
    assert.ok(
      db.stats.transactionReplays >= 1,
      "the loser must have re-read the marker rather than trusting its first snapshot",
    );
    assert.equal(db.read(REF.id).attempts, 2, "the attempt counter moved exactly once");
  });

  test("a per-job policy overrides the default", async () => {
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, claimedAt: minutesAgo(7) }));

    // Six minutes is in flight under the default 20 and reclaimable under 5.
    assert.deepEqual(await claim(db, REF, { job: JOB }), {
      claimed: false,
      reason: "in-flight",
    });
    assert.deepEqual(
      await claim(db, REF, {
        job: JOB,
        policy: { reclaimAfterMinutes: 5, maxAttempts: 3 },
      }),
      { claimed: true, attempts: 2, reclaimed: true },
    );
  });

  test("a non-ALREADY_EXISTS failure is rethrown, never swallowed into a false claim", async () => {
    // Only code 6 means "somebody else has this". Anything else is a real
    // fault, and treating it as a lost race would report the work as claimed
    // by another tick that does not exist.
    const broken = {
      collection: () => ({
        doc: () => ({
          create: async () => {
            const err = new Error("permission denied");
            err.code = 7;
            throw err;
          },
        }),
      }),
      runTransaction: async () => assert.fail("a hard failure must not reach the slow path"),
    };
    await assert.rejects(() => claim(broken, REF, { job: JOB }), /permission denied/);
  });
});

// ---------------------------------------------------------------------------
// The stamps
// ---------------------------------------------------------------------------

describe("stampSent / stampError / stampSkipped", () => {
  test("stampSent writes sentAt and clears the last error", async () => {
    const db = makeDb();
    await claim(db, REF, { job: JOB });
    await stampError(db, REF.id, new Error("Resend answered 503"));
    assert.equal(db.read(REF.id).lastError, "Resend answered 503");

    const sentAt = new Date(NOW.getTime() + 1_000);
    await stampSent(db, REF.id, sentAt);

    const stored = db.read(REF.id);
    assert.deepEqual(stored.sentAt, sentAt);
    assert.equal(stored.lastError, null);
    assert.equal(stored.attempts, 1, "a stamp must not disturb the claim it belongs to");
    // Settled, so the retention clock starts. Inert until the collection
    // group's TTL policy exists, which is an owner step per project.
    assert.deepEqual(stored.expiresAt, schedulerMarkerExpiry(sentAt));
  });

  test("stampError leaves sentAt null, because a failure is not terminal", async () => {
    const db = makeDb();
    await claim(db, REF, { job: JOB });
    await stampError(db, REF.id, new Error("boom"));

    const stored = db.read(REF.id);
    assert.equal(stored.lastError, "boom");
    assert.equal(stored.sentAt, null, "the re-claim rule needs this marker back");
    assert.equal(stored.failedAt, null, "one failure is not giving up");
    assert.equal(
      stored.expiresAt,
      undefined,
      "a marker still in play must not be given an expiry to vanish on",
    );
  });

  test("stampSkipped is terminal and its reason is bounded", async () => {
    const db = makeDb();
    await claim(db, REF, { job: JOB });
    await stampSkipped(db, REF.id, "x".repeat(500));

    const stored = db.read(REF.id);
    assert.equal(stored.skippedReason.length, 200);
    assert.equal(stored.sentAt, null, "skipped is not sent, and must not read as sent");
    assert.ok(stored.expiresAt instanceof Date, "a skip settles the marker");
  });

  test("a marker that gives up is NOT given an expiry", async () => {
    // It is waiting for a human under Stuck sends. A TTL on it would delete
    // the evidence of the send that never happened.
    const db = makeDb();
    db.seed(
      REF.id,
      seededMarker({
        attempts: DEFAULT_MARKER_POLICY.maxAttempts,
        claimedAt: minutesAgo(60),
      }),
    );
    await claim(db, REF, { job: JOB });
    assert.ok(db.read(REF.id).failedAt instanceof Date);
    assert.equal(db.read(REF.id).expiresAt, undefined);
  });

  test("the horizons are the ones the runbook's TTL policies are written for", () => {
    assert.equal(SCHEDULER_MARKER_RETENTION_DAYS, 180);
    const from = new Date("2026-10-11T09:00:00.000Z");
    assert.equal(
      schedulerMarkerExpiry(from).toISOString(),
      "2027-04-09T09:00:00.000Z",
    );
  });

  test("errorText trims a thrown value to something safe to store", () => {
    assert.equal(errorText(new Error("nope")), "nope");
    assert.equal(errorText("plain string"), "plain string");
    assert.equal(errorText(new Error("y".repeat(400))).length, 300);
    assert.equal(errorText(null), "null");
  });
});

// ---------------------------------------------------------------------------
// retryFailedMarker
// ---------------------------------------------------------------------------

describe("retryFailedMarker", () => {
  test("puts a failed marker back in play with a full attempt budget and an actor", async () => {
    const db = makeDb();
    db.seed(
      REF.id,
      seededMarker({
        attempts: 3,
        failedAt: minutesAgo(30),
        lastError: "Resend answered 503",
      }),
    );

    assert.deepEqual(await retryFailedMarker(db, REF.id, "admin1"), { retried: true });

    const stored = db.read(REF.id);
    assert.equal(stored.failedAt, null);
    assert.equal(stored.skippedReason, null);
    assert.equal(stored.lastError, null);
    assert.equal(stored.expiresAt, null, "back in play means back to no expiry");
    // Back to 0, not decremented: the counter exists to stop an UNATTENDED
    // loop, and an admin clicking Retry is attendance.
    assert.equal(stored.attempts, 0);
    assert.deepEqual(stored.retriedAt, NOW);
    assert.equal(stored.retriedByUid, "admin1");
  });

  test("refuses a marker that actually went out", async () => {
    // The one refusal that matters: clearing a sent marker would let the next
    // tick re-derive the work and send it a second time.
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, sentAt: minutesAgo(30) }));

    assert.deepEqual(await retryFailedMarker(db, REF.id, "admin1"), {
      retried: false,
      reason: "sent",
    });

    const stored = db.read(REF.id);
    assert.deepEqual(stored.sentAt, minutesAgo(30), "the marker is untouched");
    assert.equal(stored.retriedAt, undefined);
  });

  test("refuses a marker still IN FLIGHT, which is neither failed nor skipped", async () => {
    // A tick may be between its claim and its stamp right now. Resetting
    // `attempts` in front of it hands the same unit of work to the next tick
    // while the first one is still doing it, which is the duplicate this
    // whole module is arranged to avoid. A genuinely stuck claim needs no
    // button: the re-claim rule collects it once it goes stale.
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, claimedAt: minutesAgo(2) }));

    assert.deepEqual(await retryFailedMarker(db, REF.id, "admin1"), {
      retried: false,
      reason: "in-flight",
    });
    assert.equal(db.read(REF.id).attempts, 1, "the claim is left alone");
    assert.equal(db.read(REF.id).retriedAt, undefined);
  });

  test("refuses a marker that is not there", async () => {
    const db = makeDb();
    assert.deepEqual(await retryFailedMarker(db, REF.id, "admin1"), {
      retried: false,
      reason: "missing",
    });
  });

  test("clears a consciously skipped marker, which is the admin overruling the skip", async () => {
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, skippedReason: "stale" }));
    assert.deepEqual(await retryFailedMarker(db, REF.id, "admin1"), { retried: true });
    assert.equal(db.read(REF.id).skippedReason, null);
  });
});

// ---------------------------------------------------------------------------
// policyFor: the registry's numbers reaching claim()
// ---------------------------------------------------------------------------

describe("policyFor", () => {
  test("carries a job's re-claim window through to a claim", async () => {
    const db = makeDb();
    db.seed(REF.id, seededMarker({ attempts: 1, claimedAt: minutesAgo(9) }));

    const policy = policyFor({ ...heartbeatJob, reclaimAfterMinutes: 8 });
    assert.equal(policy.reclaimAfterMinutes, 8);
    assert.deepEqual(await claim(db, REF, { job: JOB, policy }), {
      claimed: true,
      attempts: 2,
      reclaimed: true,
    });
  });

  test("floors the window, because 0 means re-claim immediately", () => {
    // Not a tuning knob. A window under the time one send can legitimately
    // take is a second tick racing the first, which is a duplicate send with
    // extra steps.
    assert.equal(
      policyFor({ ...heartbeatJob, reclaimAfterMinutes: 0 }).reclaimAfterMinutes,
      MIN_RECLAIM_AFTER_MINUTES,
    );
    assert.ok(MIN_RECLAIM_AFTER_MINUTES >= 5);
  });

  test("does not let a job set its own attempt cap", () => {
    // Three claims with no stamp means the WORK is wrong, not the timing. A
    // per-job cap would eventually be set high enough to loop on it.
    assert.equal(
      policyFor(heartbeatJob).maxAttempts,
      DEFAULT_MARKER_POLICY.maxAttempts,
    );
  });

  test("every registered job survives the floor", () => {
    for (const job of JOBS) {
      const policy = policyFor(job);
      assert.ok(
        policy.reclaimAfterMinutes >= MIN_RECLAIM_AFTER_MINUTES,
        `${job.id} would re-claim after ${policy.reclaimAfterMinutes} minutes`,
      );
      assert.ok(job.maxPerTick > 0, `${job.id} may do no work at all`);
    }
  });

  test("the heartbeat claims nothing, and is still not registered with a zero window", () => {
    // Nothing reads the heartbeat's window. It is a real number anyway,
    // because it is the entry the next job author copies.
    assert.equal(heartbeatJob.id, JOBS[0].id, "the heartbeat is registered first");
    assert.ok(heartbeatJob.reclaimAfterMinutes > 0);
  });
});
