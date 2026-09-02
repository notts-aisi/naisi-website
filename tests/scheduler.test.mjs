/**
 * Unit tests for the scheduler's pure logic:
 *   - `src/lib/firestore/schedulerRuns.ts`  (the receipt id scheme)
 *   - `src/lib/firestore/schedulerMarkers.ts` (marker ids + the re-claim rule)
 * plus source-level guards on `src/app/api/scheduler/tick/route.ts` for the
 * two properties that are policy rather than logic (404 not 401, and an
 * explicit maxDuration under the platform timeout).
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why there is a loader dance at the top
 *
 * Same reason as tests/week-plan.test.mjs: this repo's Node is v20, which
 * cannot import a `.ts` file, so the modules are transpiled in memory with
 * the `typescript` devDependency. Both modules under test are deliberately
 * free of RUNTIME imports (they use `import type` only) so a standalone
 * transpile has nothing to resolve. Keep them that way, or this suite starts
 * failing with an unresolved specifier rather than with a real assertion.
 *
 * ## What is being pinned
 *
 * 1. THE DEPTH SUFFIX. `tick__{bucket}` alone was fatal: the self re-arm
 *    fires seconds after its parent, floors to the SAME 15-minute bucket,
 *    hits ALREADY_EXISTS and returns having done nothing, so depth could
 *    never leave 0 and a backlog waited a full 15 minutes. The tests below
 *    model both halves: two depth-0 deliveries in one bucket collapse onto
 *    one receipt, and a depth-1 re-arm in that same bucket does not.
 *
 * 2. THE RE-CLAIM BOUNDARY. Exactly at `reclaimAfterMinutes` a marker is
 *    still in flight; past it, it is reclaimable. Reclaiming ON the equality
 *    is how a rounded millisecond turns into two sends.
 *
 * 3. GIVING UP AT THREE. A marker that has been claimed three times without
 *    a stamp stops being retried automatically and becomes a visible failure.
 *    Without the cap the tick loops on it forever; without the visibility the
 *    send is silently gone.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNS_URL = new URL("../src/lib/firestore/schedulerRuns.ts", import.meta.url);
const MARKERS_URL = new URL(
  "../src/lib/firestore/schedulerMarkers.ts",
  import.meta.url,
);
const TICK_ROUTE_URL = new URL(
  "../src/app/api/scheduler/tick/route.ts",
  import.meta.url,
);

/** Node errors that mean "this runtime cannot load .ts on its own". */
const NO_TYPE_STRIPPING = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

async function loadModule(url, label) {
  try {
    return await import(url.href);
  } catch (err) {
    if (!NO_TYPE_STRIPPING.has(err?.code)) throw err;
    let ts;
    try {
      ts = (await import("typescript")).default;
    } catch {
      throw new Error(
        `Node ${process.version} cannot import .ts (needs >= 22.18) and the ` +
          "`typescript` devDependency is not installed. Run `npm install`, " +
          "or run this suite on a newer Node.",
        { cause: err },
      );
    }
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: `${label}.ts`,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`;
    return import(dataUrl);
  }
}

const {
  MAX_TICK_DEPTH,
  TICK_BUCKET_MINUTES,
  formatBucketKey,
  normalizeSchedulerRun,
  parseTickReceiptId,
  tickBucketKey,
  tickReceiptId,
} = await loadModule(RUNS_URL, "schedulerRuns");

const {
  DEFAULT_MARKER_POLICY,
  breakReturnMarker,
  decideMarkerClaim,
  isStaleWork,
  markerFamilyOf,
  normalizeSchedulerMarker,
  reminderMarker,
  stageReleaseMarker,
  unmarkedRegisterMarker,
} = await loadModule(MARKERS_URL, "schedulerMarkers");

const iso = (s) => new Date(s);

// ---------------------------------------------------------------------------
// The receipt id scheme
// ---------------------------------------------------------------------------

describe("tickBucketKey", () => {
  test("floors to the 15-minute UTC boundary", () => {
    assert.equal(tickBucketKey(iso("2026-09-02T14:00:00.000Z")), "20260902T1400Z");
    assert.equal(tickBucketKey(iso("2026-09-02T14:00:00.001Z")), "20260902T1400Z");
    assert.equal(tickBucketKey(iso("2026-09-02T14:14:59.999Z")), "20260902T1400Z");
    assert.equal(tickBucketKey(iso("2026-09-02T14:15:00.000Z")), "20260902T1415Z");
    assert.equal(tickBucketKey(iso("2026-09-02T14:44:59.999Z")), "20260902T1430Z");
    assert.equal(tickBucketKey(iso("2026-09-02T14:59:59.999Z")), "20260902T1445Z");
  });

  test("is UTC, not London, so a bucket cannot repeat or vanish at a clock change", () => {
    // BST -> GMT, 2026-10-25: 01:00-01:59 London happens twice. A London-local
    // bucket key would collide across that hour (an hour of ticks silently
    // deduped away) and skip an hour in the spring.
    const first = tickBucketKey(iso("2026-10-25T00:30:00Z")); // 01:30 BST
    const second = tickBucketKey(iso("2026-10-25T01:30:00Z")); // 01:30 GMT
    assert.notEqual(first, second);
    assert.equal(first, "20261025T0030Z");
    assert.equal(second, "20261025T0130Z");
  });

  test("pads every component, so ids sort lexicographically by time", () => {
    assert.equal(tickBucketKey(iso("2026-01-05T04:07:00Z")), "20260105T0400Z");
    const early = tickReceiptId(tickBucketKey(iso("2026-01-05T04:07:00Z")), 0);
    const late = tickReceiptId(tickBucketKey(iso("2026-11-30T22:52:00Z")), 0);
    assert.ok(early < late);
  });

  test("TICK_BUCKET_MINUTES is the 15-minute cadence the ops runbook arms", () => {
    assert.equal(TICK_BUCKET_MINUTES, 15);
  });
});

describe("tickReceiptId / parseTickReceiptId", () => {
  test("round trips", () => {
    for (const depth of [0, 1, 2, 3]) {
      const id = tickReceiptId("20260902T1415Z", depth);
      assert.equal(id, `tick__20260902T1415Z__d${depth}`);
      assert.deepEqual(parseTickReceiptId(id), {
        bucket: "20260902T1415Z",
        depth,
      });
    }
  });

  test("rejects anything that is not a receipt id", () => {
    assert.equal(parseTickReceiptId("tick__20260902T1415Z"), null);
    assert.equal(parseTickReceiptId("remind__r1__u1__20260911"), null);
    assert.equal(parseTickReceiptId("tick__nonsense__d0"), null);
    assert.equal(parseTickReceiptId(""), null);
  });

  test("formats a bucket for the panel", () => {
    assert.equal(formatBucketKey("20260902T1415Z"), "2026-09-02 14:15 UTC");
    assert.equal(formatBucketKey("not-a-bucket"), "not-a-bucket");
  });

  test("MAX_TICK_DEPTH bounds the self re-arm chain", () => {
    assert.equal(MAX_TICK_DEPTH, 3);
  });
});

/**
 * A stand-in for `DocumentReference.create()`: succeeds once per id, then
 * throws Firestore's ALREADY_EXISTS. That single behaviour IS the dedupe, so
 * modelling it here is modelling the real thing.
 */
function fakeReceiptStore() {
  const docs = new Map();
  return {
    docs,
    create(id, data) {
      if (docs.has(id)) {
        const err = new Error(`Document already exists: ${id}`);
        err.code = 6;
        throw err;
      }
      docs.set(id, data);
    },
  };
}

/** The tick's receipt handling, reduced to the branch under test. */
function runTick(store, { now, depth }) {
  const bucket = tickBucketKey(now);
  const id = tickReceiptId(bucket, depth);
  try {
    store.create(id, { bucket, depth });
    return { id, deduped: false, ranJobs: true };
  } catch (err) {
    if (err.code !== 6) throw err;
    // The deduped early return applies ONLY at depth 0.
    if (depth === 0) return { id, deduped: true, ranJobs: false };
    return { id, deduped: false, ranJobs: true, receiptCollision: true };
  }
}

describe("receipt dedupe", () => {
  test("two concurrent depth-0 calls in one bucket collapse to one receipt", () => {
    const store = fakeReceiptStore();
    // Two deliveries of the same nominal tick, seconds apart, both at depth 0.
    const first = runTick(store, { now: iso("2026-09-02T14:15:02Z"), depth: 0 });
    const second = runTick(store, { now: iso("2026-09-02T14:15:04Z"), depth: 0 });

    assert.equal(first.id, second.id, "same bucket must resolve to the same id");
    assert.equal(first.deduped, false);
    assert.equal(first.ranJobs, true);
    assert.equal(second.deduped, true, "the loser returns 200 {deduped:true}");
    assert.equal(second.ranJobs, false, "and must not run the job list");
    assert.equal(store.docs.size, 1, "exactly one receipt for the bucket");
  });

  test("a re-arm in the SAME bucket gets its own receipt and runs", () => {
    // This is the regression the depth suffix exists for. Without it the
    // re-arm below would dedupe against its own parent and do nothing.
    const store = fakeReceiptStore();
    const parent = runTick(store, { now: iso("2026-09-02T14:15:02Z"), depth: 0 });
    const child = runTick(store, { now: iso("2026-09-02T14:15:31Z"), depth: 1 });

    assert.notEqual(parent.id, child.id);
    assert.equal(child.deduped, false);
    assert.equal(child.ranJobs, true, "a re-arm must always do real work");
    assert.equal(store.docs.size, 2);
  });

  test("a collision at depth above 0 proceeds rather than short-circuiting", () => {
    const store = fakeReceiptStore();
    runTick(store, { now: iso("2026-09-02T14:15:31Z"), depth: 1 });
    const again = runTick(store, { now: iso("2026-09-02T14:15:44Z"), depth: 1 });
    assert.equal(again.deduped, false);
    assert.equal(again.ranJobs, true);
    assert.equal(again.receiptCollision, true);
  });

  test("the chain gets a distinct receipt at every depth up to the cap", () => {
    const store = fakeReceiptStore();
    const now = iso("2026-09-02T14:15:02Z");
    for (let depth = 0; depth <= MAX_TICK_DEPTH; depth += 1) {
      const result = runTick(store, { now, depth });
      assert.equal(result.deduped, false, `depth ${depth} must not dedupe`);
    }
    assert.equal(store.docs.size, MAX_TICK_DEPTH + 1);
  });
});

describe("normalizeSchedulerRun", () => {
  test("recovers bucket and depth from the id when the fields are missing", () => {
    const run = normalizeSchedulerRun("tick__20260902T1415Z__d2", undefined);
    assert.equal(run.bucket, "20260902T1415Z");
    assert.equal(run.depth, 2);
    assert.deepEqual(run.jobs, []);
    assert.equal(run.hasMore, false);
    assert.equal(run.skipped, null);
  });

  test("drops job entries that carry no id and keeps the rest", () => {
    const run = normalizeSchedulerRun("tick__20260902T1415Z__d0", {
      jobs: [
        { id: "heartbeat", processed: 1, hasMore: false, durationMs: 3 },
        { processed: 9 },
        null,
      ],
      skipped: "made-up",
    });
    assert.equal(run.jobs.length, 1);
    assert.equal(run.jobs[0].id, "heartbeat");
    assert.equal(run.skipped, null, "an unrecognised skip reason is dropped");
  });
});

// ---------------------------------------------------------------------------
// Marker ids
// ---------------------------------------------------------------------------

describe("marker ids", () => {
  test("build the four families and store every component as a field", () => {
    // The round id is a real slugId, `__` suffix and all: rejecting that
    // separator would reject every id this platform mints.
    const remind = reminderMarker("autumn-2026-intake__k3f9a2b1", "uid1", "20261011");
    assert.equal(remind.id, "remind__autumn-2026-intake__k3f9a2b1__uid1__20261011");
    assert.equal(remind.family, "remind");
    assert.deepEqual(remind.fields, {
      roundId: "autumn-2026-intake__k3f9a2b1",
      uid: "uid1",
      dueAtKey: "20261011",
    });

    const stagerel = stageReleaseMarker("autumn-2026-intake__k3f9a2b1", "s2");
    assert.equal(stagerel.id, "stagerel__autumn-2026-intake__k3f9a2b1__s2");
    assert.deepEqual(stagerel.fields, {
      roundId: "autumn-2026-intake__k3f9a2b1",
      stageId: "s2",
    });

    const unmarked = unmarkedRegisterMarker("tuesdays-1800__aa11bb22", "w03-1");
    assert.equal(unmarked.id, "unmarked__tuesdays-1800__aa11bb22__w03-1");
    assert.deepEqual(unmarked.fields, {
      groupId: "tuesdays-1800__aa11bb22",
      sessionKey: "w03-1",
    });

    const breakret = breakReturnMarker(
      "incubator-autumn__ff00ee11",
      "tuesdays-1800__aa11bb22",
      "20270201",
    );
    assert.equal(
      breakret.id,
      "breakret__incubator-autumn__ff00ee11__tuesdays-1800__aa11bb22__20270201",
    );
    assert.deepEqual(breakret.fields, {
      runId: "incubator-autumn__ff00ee11",
      groupId: "tuesdays-1800__aa11bb22",
      slotStartKey: "20270201",
    });
  });

  test("refuse a component Firestore would reject or that we compose ourselves", () => {
    // "/" and "." are illegal in a doc id. "__" is refused only in the
    // components this platform composes (keys), never in the doc ids it was
    // handed, since every slugId carries one.
    assert.throws(() => reminderMarker("round1", "uid__1", "20261011"), /uid/);
    assert.throws(() => stageReleaseMarker("round1", "s1/s2"), /stageId/);
    assert.throws(() => unmarkedRegisterMarker("g1", "w03.1"), /sessionKey/);
    assert.throws(() => breakReturnMarker("", "g1", "20270201"), /runId/);
    assert.throws(() => unmarkedRegisterMarker("g/1", "w03"), /groupId/);
  });

  test("family is recoverable from a stored id", () => {
    assert.equal(markerFamilyOf("remind__r__u__d"), "remind");
    assert.equal(markerFamilyOf(stageReleaseMarker("r1", "s1").id), "stagerel");
    assert.equal(markerFamilyOf(unmarkedRegisterMarker("g1", "w03").id), "unmarked");
    assert.equal(
      markerFamilyOf(breakReturnMarker("run1", "g1", "20270201").id),
      "breakret",
    );
    assert.equal(markerFamilyOf("gnudge__run1__g1__x"), null);
    assert.equal(markerFamilyOf("anything-else"), null);
  });
});

// ---------------------------------------------------------------------------
// The re-claim rule
// ---------------------------------------------------------------------------

/** A marker as `normalizeSchedulerMarker` would produce it. */
function marker(overrides = {}) {
  return normalizeSchedulerMarker("remind__r1__u1__20261011", {
    job: "admissions-deadline-reminders",
    attempts: 1,
    claimedAt: null,
    sentAt: null,
    failedAt: null,
    skippedReason: null,
    ...overrides,
  });
}

const NOW = iso("2026-10-04T12:00:00Z");
const { reclaimAfterMinutes, maxAttempts } = DEFAULT_MARKER_POLICY;

/** `minutes` before NOW. */
function ago(minutes) {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("decideMarkerClaim", () => {
  test("no marker at all is a fresh claim", () => {
    assert.deepEqual(decideMarkerClaim(null, NOW), {
      action: "claim",
      attempts: 1,
      reclaimed: false,
    });
  });

  test("an already-sent marker is skipped, which is the suppression", () => {
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(600), sentAt: ago(599) }),
      NOW,
    );
    assert.deepEqual(decision, { action: "skip", reason: "sent" });
  });

  test("a marker claimed just now is in flight, not stolen", () => {
    const decision = decideMarkerClaim(marker({ claimedAt: ago(1) }), NOW);
    assert.deepEqual(decision, { action: "skip", reason: "in-flight" });
  });

  test("EXACTLY at the boundary the marker is still in flight", () => {
    // Deliberately exclusive. Reclaiming on the equality is how a rounded
    // millisecond becomes two sends; waiting one more tick costs 15 minutes
    // on a send that has already failed.
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(reclaimAfterMinutes) }),
      NOW,
    );
    assert.deepEqual(decision, { action: "skip", reason: "in-flight" });
  });

  test("one millisecond past the boundary it is reclaimable", () => {
    const claimedAt = new Date(
      NOW.getTime() - reclaimAfterMinutes * 60_000 - 1,
    );
    assert.deepEqual(decideMarkerClaim(marker({ claimedAt }), NOW), {
      action: "claim",
      attempts: 2,
      reclaimed: true,
    });
  });

  test("attempts climb one per re-claim up to the cap", () => {
    const stale = { claimedAt: ago(reclaimAfterMinutes * 3) };
    assert.equal(
      decideMarkerClaim(marker({ ...stale, attempts: 1 }), NOW).attempts,
      2,
    );
    assert.equal(
      decideMarkerClaim(marker({ ...stale, attempts: 2 }), NOW).attempts,
      3,
    );
  });

  test(`at ${maxAttempts} attempts it gives up instead of looping`, () => {
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(reclaimAfterMinutes * 3), attempts: maxAttempts }),
      NOW,
    );
    assert.deepEqual(decision, { action: "give-up", attempts: maxAttempts });
  });

  test("a marker already stamped failedAt is left alone for a human", () => {
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(900), attempts: 3, failedAt: ago(880) }),
      NOW,
    );
    assert.deepEqual(decision, { action: "skip", reason: "failed" });
  });

  test("a consciously skipped marker is terminal too", () => {
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(900), skippedReason: "stale" }),
      NOW,
    );
    assert.deepEqual(decision, { action: "skip", reason: "skipped" });
  });

  test("a marker with no claimedAt is treated as infinitely old, not fresh", () => {
    // Corrupt rather than in flight. Treating it as fresh would wedge the
    // work forever, which is the failure mode the whole rule exists to stop.
    const decision = decideMarkerClaim(marker({ claimedAt: null }), NOW);
    assert.equal(decision.action, "claim");
    assert.equal(decision.reclaimed, true);
  });

  test("an admin Retry (attempts back to 0) puts a marker straight back in play", () => {
    const decision = decideMarkerClaim(
      marker({ claimedAt: ago(900), attempts: 0, failedAt: null }),
      NOW,
    );
    assert.deepEqual(decision, { action: "claim", attempts: 1, reclaimed: true });
  });

  test("a tighter policy is honoured", () => {
    const policy = { reclaimAfterMinutes: 5, maxAttempts: 2 };
    const claimedAt = ago(6);
    assert.equal(
      decideMarkerClaim(marker({ claimedAt, attempts: 1 }), NOW, policy).action,
      "claim",
    );
    assert.equal(
      decideMarkerClaim(marker({ claimedAt, attempts: 2 }), NOW, policy).action,
      "give-up",
    );
  });
});

describe("isStaleWork", () => {
  test("work inside the late window is still sendable", () => {
    assert.equal(isStaleWork(ago(23 * 60), NOW, 24), false);
    assert.equal(isStaleWork(ago(24 * 60), NOW, 24), false);
  });

  test("work past the late window is stale and must be skipped, not sent", () => {
    // A "your application closes in 7 days" email that lands nine days after
    // the deadline is worse than no email.
    assert.equal(isStaleWork(ago(24 * 60 + 1), NOW, 24), true);
    assert.equal(isStaleWork(ago(72 * 60 + 1), NOW, 72), true);
  });

  test("work due in the future is never stale", () => {
    assert.equal(isStaleWork(new Date(NOW.getTime() + 60_000), NOW, 24), false);
  });
});

// ---------------------------------------------------------------------------
// Source-level guards on the tick route
// ---------------------------------------------------------------------------

describe("POST /api/scheduler/tick source guards", () => {
  const source = readFileSync(fileURLToPath(TICK_ROUTE_URL), "utf8");

  test("answers 404, never 401 or 403, on a bad key", () => {
    // A 401 confirms both that the path exists and that the guard is a key
    // check. A 404 says nothing. The guard is asserted on the source because
    // the alternative is booting a Next route handler in the unit suite.
    assert.match(source, /status:\s*404/);
    assert.ok(
      !/status:\s*401/.test(source),
      "the tick must never answer 401, which confirms the endpoint exists",
    );
    assert.ok(
      !/status:\s*403/.test(source),
      "the tick must never answer 403, the same disclosure as a 401",
    );
  });

  test("hashes both sides before the timing-safe compare", () => {
    // timingSafeEqual throws on a length mismatch, so a truncated header
    // would 500, and an error page confirms the endpoint exists.
    assert.match(source, /createHash\("sha256"\)/);
    assert.match(source, /timingSafeEqual\(sha256\(presented\), sha256\(secret\)\)/);
  });

  test("declares an explicit maxDuration under the 60s platform timeout", () => {
    const match = /export const maxDuration = (\d+)/.exec(source);
    assert.ok(match, "the tick must declare maxDuration explicitly");
    const seconds = Number(match[1]);
    assert.ok(
      seconds > 0 && seconds < 60,
      `maxDuration ${seconds} must sit under apphosting.yaml's timeoutSeconds: 60`,
    );
  });

  test("reads the secret from the environment and never from a literal", () => {
    assert.match(source, /process\.env\.SCHEDULER_SECRET/);
  });

  test("does not reach for the per-instance rate limiter", () => {
    // It is per-instance and fail-open: decoration against a bearer token,
    // and a throttle on the one caller that is meant to be there.
    assert.ok(
      !/from "@\/lib\/rateLimit"/.test(source),
      "the tick must not import the rate limiter",
    );
  });

  test("re-arms through NEXT_PUBLIC_APP_URL, never the host header", () => {
    // On App Hosting the host header is the internal Cloud Run revision URL,
    // not the public domain.
    assert.match(source, /NEXT_PUBLIC_APP_URL/);
    assert.ok(!/headers\.get\("host"\)/.test(source));
  });
});

// ---------------------------------------------------------------------------
// Source-level guards on the admin manual-override route
// ---------------------------------------------------------------------------

describe("POST /api/admin/scheduler/run source guards", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/app/api/admin/scheduler/run/route.ts", import.meta.url),
    ),
    "utf8",
  );

  test("admin only, and the check is the session, not a header", () => {
    assert.match(source, /getCurrentUser\(\)/);
    assert.match(source, /actor\.role !== "admin"/);
  });

  test("validates the marker id before it reaches Firestore", () => {
    // Marker ids are construct-only everywhere else. This route is the only
    // place a request string becomes one, so the character set is checked
    // here: an id Firestore refuses outright would otherwise surface as a
    // thrown 500 instead of an answer.
    assert.match(source, /\/\^\[A-Za-z0-9_\.~:@\+-\]\{1,1500\}\$\//);
    assert.match(source, /MARKER_ID\.test\(markerId\)/);
    assert.match(source, /status: 400/);
  });

  test("the retry cannot throw out of the route", () => {
    // An unhandled rejection out of a route handler is a blank 500 page. The
    // job branch below already had a try/catch; the marker branch needs the
    // same, because it is the one an admin reaches during an incident.
    const branch = source.slice(
      source.indexOf("Retry one failed marker"),
      source.indexOf("Run one job now"),
    );
    assert.ok(branch.length > 0, "the marker branch is gone");
    assert.match(branch, /try \{/);
    assert.match(branch, /catch \(err\)/);
    assert.match(branch, /status: 500/);
  });

  test("an in-flight marker is refused, not reset", () => {
    // The refusal itself lives in retryFailedMarker (see
    // tests/scheduler-markers.test.mjs); what is pinned here is that the
    // route reports it as its own outcome rather than collapsing all three
    // refusals into one sentence about a marker being "gone or already sent".
    assert.match(source, /RETRY_REFUSALS/);
    assert.match(source, /"in-flight"/);
    assert.match(source, /status: 409/);
  });
});

// ---------------------------------------------------------------------------
// Source-level guards on the admin panel
// ---------------------------------------------------------------------------

describe("SchedulerPanel source guards", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/features/admin/SchedulerPanel.tsx", import.meta.url)),
    "utf8",
  );

  test("renders every instant in UTC, and says so", () => {
    // The receipt buckets on this panel are floored in UTC and labelled UTC
    // by formatBucketKey, and the external scheduler is armed on Etc/UTC. An
    // unlabelled local time beside them reads as a tick that fired an hour
    // late for the half of the year London is ahead.
    assert.match(source, /timeZone: "UTC"/);
    assert.match(source, /`\$\{rendered\} UTC`/);
    assert.equal(
      [...source.matchAll(/toLocaleString\(/g)].length,
      1,
      "a second time formatter on this panel needs the same UTC treatment",
    );
    assert.equal(
      [...source.matchAll(/toLocaleTimeString\(|toLocaleDateString\(/g)].length,
      0,
    );
  });

  test("the bucket label it shares with the receipt id is UTC too", () => {
    assert.equal(formatBucketKey("20260902T1415Z"), "2026-09-02 14:15 UTC");
    assert.match(source, /formatBucketKey/);
  });
});
