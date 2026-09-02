/**
 * POST /api/scheduler/tick: the ONE scheduler endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REQUIRED ENVIRONMENT
 *
 *   SCHEDULER_SECRET   RUNTIME availability only, resolved from Secret
 *                      Manager by name on each backend.
 *
 * The `apphosting.yaml` entry that declares it is owned by the ops PR, not by
 * this file. For the record, it must look exactly like this:
 *
 *   - variable: SCHEDULER_SECRET
 *     secret: SCHEDULER_SECRET
 *     availability: [RUNTIME]
 *
 * RUNTIME and not BUILD, and no `NEXT_PUBLIC_` prefix: only `NEXT_PUBLIC_`
 * vars are inlined into the client bundle, and a bearer token that reaches a
 * browser is not a bearer token. See docs/courses-ops.md for the Secret
 * Manager and Cloud Scheduler steps that go with it.
 *
 * `NEXT_PUBLIC_APP_URL` is also required, for the self re-arm below. The host
 * header is NOT usable here: on App Hosting a server component sees the
 * internal Cloud Run revision URL, not the public domain.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY 404 AND NOT 401. A 401 confirms that the path exists and that the guard
 * is a key check, which is exactly the pair of facts worth knowing before you
 * start guessing. A 404 says nothing. Every rejection here (missing secret,
 * missing header, wrong header) returns the same 404 body.
 *
 * WHY NO RATE LIMIT. `src/lib/rateLimit.ts` is per-instance and fail-open, so
 * against a bearer-token endpoint it is decoration: it cannot slow a
 * distributed guesser and it would happily throttle the legitimate scheduler
 * on a busy instance. The secret is the control.
 *
 * WHY THE SECRET COMPARISON HASHES FIRST. `timingSafeEqual` THROWS when the
 * two buffers differ in length, so comparing raw bytes would turn a truncated
 * header into a 500, and an error page confirms the endpoint exists, which
 * is the one thing the 404 is for. Hashing both sides to a fixed 32 bytes
 * first makes every comparison well-formed and keeps it constant time.
 *
 * IDEMPOTENCY. Two layers, and they answer different questions:
 *   - the RECEIPT (`schedulerRuns/tick__{bucket}__d{depth}`) collapses
 *     duplicate EXTERNAL deliveries of the same nominal tick;
 *   - the MARKERS (`schedulerMarkers`) stop the same unit of WORK being done
 *     twice, whatever the tick topology.
 * The receipt dedupe fires only at depth 0. See src/lib/firestore/
 * schedulerRuns.ts for why a depth-blind receipt id was fatal.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  SCHEDULER_CONFIG_PATH,
  SCHEDULER_LAST_ERROR_MAX,
  jobStateFor,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import {
  MAX_TICK_DEPTH,
  SCHEDULER_RUNS_COLLECTION,
  tickBucketKey,
  tickReceiptId,
  type SchedulerRunJobEntry,
} from "@/lib/firestore/schedulerRuns";
import {
  JOBS,
  policyFor,
  type JobBudget,
  type JobRegistration,
} from "@/lib/scheduler/registry";
import { errorText } from "@/lib/scheduler/markers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ceiling this tick INTENDS to run to. Documentation, not enforcement.
 *
 * What actually stops the request is `apphosting.yaml`'s
 * `runConfig.timeoutSeconds: 60`: Cloud Run kills the container at 60s
 * whatever this export says, and a killed tick leaves a receipt stuck at
 * "running". So this number is here to state the intent (45s, i.e. 15s of
 * headroom under the platform timeout) and to keep any future host that DOES
 * read it from picking something higher than the platform allows.
 *
 * What keeps a real tick inside that ceiling is `JOB_BUDGET_MS` below. The
 * job list is cut off at 28s, and the remainder is wind-down: the receipt
 * write, and the re-arm handoff when there is more to do.
 */
export const maxDuration = 45;

/** Wall clock handed to the job list. The rest of `maxDuration` is wind-down. */
const JOB_BUDGET_MS = 28_000;

/**
 * How long the parent waits for the re-arm child before giving up on it.
 *
 * CLOUD RUN CPU THROTTLING, the reason this is awaited at all: outside a
 * request, an instance's CPU is throttled to near zero. A fire-and-forget
 * `void fetch(...)` after the response has been returned may therefore never
 * get enough CPU to open the socket, and the re-arm silently never happens,
 * the classic "it worked locally" failure. Awaiting keeps the parent's
 * request alive, and therefore its CPU allocated, until the child request has
 * at least been accepted.
 *
 * The trade-off, stated plainly: the child does not respond until it has
 * finished its own work, so the parent cannot wait for it (that would chain
 * four full ticks into one 60s request). It waits `REARM_HANDOFF_MS` and then
 * aborts, which Cloud Run MAY propagate to the child as a client
 * disconnection. If it does, the backlog waits for the next 15-minute
 * delivery, which is safe by construction, because every job derives its due
 * state at tick time and every send is marker-guarded. A dropped re-arm costs
 * latency, never correctness.
 *
 * OVERLAPPING TICKS ARE EXPECTED, and this is where they come from. The
 * parent hands off and stops answering, but the child carries on working, so
 * a chain that starts near the end of a 15-minute bucket is still running
 * when the external scheduler delivers the next one. Nothing prevents that
 * and nothing should: the alternative is a lock, and a lock that outlives a
 * crashed container is how a scheduler goes quiet for a day.
 *
 * THE RULE THAT FALLS OUT OF IT, for anyone writing a job handler: EVERY
 * HANDLER MUST BE SAFE TO RUN CONCURRENTLY WITH ITSELF. Claim before you
 * send, one marker per unit of work, and let the `.create()` decide who owns
 * it. A handler that instead reads a list, does the work and writes a "done"
 * flag at the end will double-send the day two ticks overlap.
 */
const REARM_HANDOFF_MS = 8_000;

const SECRET_HEADER = "x-scheduler-key";

/** The single response every rejection returns. Says nothing about why. */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time secret check over fixed-length digests.
 * Returns false for a missing secret, a missing header and a wrong header
 * alike; the caller must not distinguish them in its response.
 */
function keyAccepted(req: Request): boolean {
  const secret = process.env.SCHEDULER_SECRET ?? "";
  if (secret === "") {
    console.warn(
      "[scheduler] SCHEDULER_SECRET is not set, so every tick will 404. " +
        "Provision it in Secret Manager and grant the backend access (docs/courses-ops.md).",
    );
    return false;
  }
  const presented = req.headers.get(SECRET_HEADER);
  if (presented === null) return false;
  return timingSafeEqual(sha256(presented), sha256(secret));
}

function clampDepth(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const depth = Math.floor(raw);
  if (depth < 0) return 0;
  return depth > MAX_TICK_DEPTH ? MAX_TICK_DEPTH : depth;
}

/**
 * Ask the endpoint to carry on where this tick stopped.
 * Returns a one-line note for the receipt; never throws.
 */
async function rearm(depth: number): Promise<string> {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (base === "") return "not re-armed: NEXT_PUBLIC_APP_URL is unset";
  const secret = process.env.SCHEDULER_SECRET ?? "";
  if (secret === "") return "not re-armed: SCHEDULER_SECRET is unset";
  try {
    const res = await fetch(`${base}/api/scheduler/tick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SECRET_HEADER]: secret,
      },
      body: JSON.stringify({ depth }),
      signal: AbortSignal.timeout(REARM_HANDOFF_MS),
      cache: "no-store",
    });
    return `re-armed at depth ${depth} (child answered ${res.status})`;
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === "TimeoutError";
    if (aborted) {
      // Expected on any re-arm that has real work to do: the child is still
      // running when the handoff window closes. Handed off, outcome unknown.
      return `re-armed at depth ${depth} (handed off, still running at ${REARM_HANDOFF_MS}ms)`;
    }
    return `re-arm at depth ${depth} failed: ${errorText(err, 120)}`;
  }
}

export async function POST(req: Request) {
  if (!keyAccepted(req)) return notFound();

  const db = getAdminDb();
  if (!db) {
    console.error("[scheduler] Admin SDK unavailable, so the tick cannot run.");
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const depth = clampDepth(body?.depth);
  const startedAt = new Date();
  const bucket = tickBucketKey(startedAt);
  const receiptId = tickReceiptId(bucket, depth);
  const receiptRef = db.collection(SCHEDULER_RUNS_COLLECTION).doc(receiptId);
  const trigger = depth === 0 ? "external" : "self";

  // Audit-first: the receipt opens BEFORE any job runs, so a tick that dies
  // mid-list still leaves a record naming the bucket it was working on.
  let receiptCollision = false;
  try {
    await receiptRef.create({
      bucket,
      depth,
      trigger,
      startedAt: FieldValue.serverTimestamp(),
      finishedAt: null,
      durationMs: 0,
      jobs: [],
      hasMore: false,
      rearmed: false,
      rearmNote: null,
      skipped: null,
      receiptCollision: false,
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const exists = code === 6 || code === "already-exists";
    if (!exists) throw err;
    if (depth === 0) {
      // A duplicate EXTERNAL delivery inside one 15-minute bucket. This is the
      // only place the receipt is allowed to short-circuit a tick.
      return NextResponse.json({ ok: true, deduped: true, bucket, depth });
    }
    // Depth > 0: not a duplicate delivery, since every re-arm increments the
    // depth in the id. Something anomalous produced a collision; proceed
    // anyway (marker claims are what actually stop double work) and flag it.
    receiptCollision = true;
    await receiptRef.set(
      { receiptCollision: true, trigger, startedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  const config = await readSchedulerConfig(db);

  async function finish(
    entries: SchedulerRunJobEntry[],
    opts: { hasMore: boolean; skipped: "disabled" | "no-jobs" | null },
  ) {
    let rearmed = false;
    let rearmNote: string | null = null;
    if (opts.hasMore && depth < MAX_TICK_DEPTH) {
      rearmNote = await rearm(depth + 1);
      rearmed = rearmNote.startsWith("re-armed");
    } else if (opts.hasMore) {
      rearmNote = `depth cap ${MAX_TICK_DEPTH} reached; the next scheduled tick picks it up`;
    }
    const finishedAt = new Date();
    await receiptRef.set(
      {
        finishedAt: FieldValue.serverTimestamp(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        jobs: entries,
        hasMore: opts.hasMore,
        rearmed,
        rearmNote,
        skipped: opts.skipped,
        receiptCollision,
      },
      { merge: true },
    );
    return NextResponse.json({
      ok: true,
      deduped: false,
      bucket,
      depth,
      hasMore: opts.hasMore,
      rearmed,
      skipped: opts.skipped,
      jobs: entries,
    });
  }

  if (!config.enabled) {
    // The global kill switch. Still writes a receipt: "the scheduler is off"
    // has to be visible on the panel, or an admin reads the silence as a
    // scheduler that has stopped calling.
    return finish([], { hasMore: false, skipped: "disabled" });
  }

  const jobDeadline = startedAt.getTime() + JOB_BUDGET_MS;
  const budget: JobBudget = {
    remainingMs: () => jobDeadline - Date.now(),
    expired: () => Date.now() >= jobDeadline,
  };

  const entries: SchedulerRunJobEntry[] = [];
  const configUpdate: Record<string, Record<string, unknown>> = {};
  let hasMore = false;
  let ranSomething = false;

  for (const job of JOBS as readonly JobRegistration[]) {
    const state = jobStateFor(config, job.id);
    if (!state.enabled) {
      entries.push({
        id: job.id,
        processed: 0,
        hasMore: false,
        durationMs: 0,
        error: null,
        skipped: "disabled",
      });
      continue;
    }
    if (budget.expired()) {
      // Out of time before this job started. Report it as outstanding so the
      // re-arm picks the list up from the top.
      entries.push({
        id: job.id,
        processed: 0,
        hasMore: true,
        durationMs: 0,
        error: null,
        skipped: "budget",
      });
      hasMore = true;
      continue;
    }

    const jobStartedMs = Date.now();
    try {
      const result = await job.handler({
        now: startedAt,
        budget,
        log: (message, extra) =>
          console.log(`[scheduler:${job.id}] ${message}`, extra ?? ""),
        // The job's own limits, handed to it rather than left for it to look
        // up: a handler that has to find its registration to honour its own
        // re-claim window is a handler that stops honouring it.
        policy: policyFor(job),
        maxPerTick: job.maxPerTick,
        maxLateHours: job.maxLateHours,
      });
      ranSomething = true;
      if (result.hasMore) hasMore = true;
      entries.push({
        id: job.id,
        processed: result.processed,
        hasMore: result.hasMore,
        durationMs: Date.now() - jobStartedMs,
        error: null,
        skipped: null,
      });
      configUpdate[job.id] = {
        lastRunAt: FieldValue.serverTimestamp(),
        lastProcessed: result.processed,
        lastError: null,
        lastErrorAt: null,
      };
    } catch (err) {
      // One job throwing must not stop the rest of the list: a broken
      // newsletter drain cannot be allowed to hold up a deadline reminder.
      const message = errorText(err, SCHEDULER_LAST_ERROR_MAX);
      console.error(`[scheduler:${job.id}] threw:`, err);
      ranSomething = true;
      entries.push({
        id: job.id,
        processed: 0,
        hasMore: false,
        durationMs: Date.now() - jobStartedMs,
        error: message,
        skipped: null,
      });
      configUpdate[job.id] = {
        lastRunAt: FieldValue.serverTimestamp(),
        lastError: message,
        lastErrorAt: FieldValue.serverTimestamp(),
      };
    }
  }

  if (Object.keys(configUpdate).length > 0) {
    await db
      .collection(SCHEDULER_CONFIG_PATH.collection)
      .doc(SCHEDULER_CONFIG_PATH.doc)
      .set({ jobs: configUpdate }, { merge: true });
  }

  return finish(entries, {
    hasMore,
    skipped: ranSomething ? null : "no-jobs",
  });
}
