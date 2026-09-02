/**
 * POST /api/admin/scheduler/run: the two manual overrides.
 *
 *   { jobId }    run one registered job right now
 *   { markerId } put one failed marker back in play, for the next tick
 *
 * WHY THESE EXIST. The scheduler is a single secret-protected endpoint
 * carrying every time-based send on the platform. If it is down on the
 * morning a deadline reminder is due, the recovery must be a click by
 * somebody with admin, not a redeploy. Every job on the registry is expected
 * to ship with this button working, which is also what makes the whole
 * scheduler lane a survivable thing to cut under time pressure: deadline
 * reminders degrade to a committee click on three named dates.
 *
 * A "Run now" ignores the job's own enable switch (the admin is looking
 * straight at that switch when they click) but NOT the global one: a
 * scheduler switched off site-wide is usually off because something is
 * actively going wrong.
 *
 * No receipt is written. Receipt ids are `tick__{bucket}__d{depth}` and mean
 * "the external scheduler called"; minting a synthetic one to describe a
 * human click would make the panel's "is it running" line lie. The run's
 * outcome lands on the job's `config/scheduler` state, which is what the
 * panel shows per job.
 */
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  SCHEDULER_CONFIG_PATH,
  SCHEDULER_LAST_ERROR_MAX,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import { errorText, retryFailedMarker } from "@/lib/scheduler/markers";
import { findJob, policyFor, type JobBudget } from "@/lib/scheduler/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** Same shape as the tick's budget, a little tighter: no re-arm follows this. */
const MANUAL_BUDGET_MS = 30_000;

/**
 * The shape of a marker id, checked before it reaches Firestore.
 *
 * Marker ids are CONSTRUCT-ONLY: the builders in `schedulerMarkers.ts` mint
 * them from platform ids and this route is the only place a string from a
 * request becomes one. A doc id Firestore refuses (a `/`, a bare `.` or
 * `..`, an empty string, one over the 1500-byte limit) would come back as a
 * thrown 500 rather than an answer, so the character set is checked here and
 * anything else is a plain 400. Nothing is sanitised: a mangled id would
 * address a DIFFERENT unit of work, and the retry would silently clear a
 * marker the admin never asked about.
 */
const MARKER_ID = /^[A-Za-z0-9_.~:@+-]{1,1500}$/;

/** Why a Retry did nothing, in the words the panel shows the admin. */
const RETRY_REFUSALS: Record<"missing" | "sent" | "in-flight", string> = {
  missing: "There is no marker with that id, so there is nothing to retry.",
  sent: "That send already went out. Retrying it would send it a second time.",
  "in-flight":
    "That marker is still in flight: a tick has claimed it and has not finished. Leave it: if the send really is stuck, the next tick re-claims it once the claim goes stale, and it appears under Stuck sends if it runs out of attempts.",
};

export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // ---- Retry one failed marker -------------------------------------------
  if (typeof body.markerId === "string" && body.markerId !== "") {
    const markerId = body.markerId;
    if (!MARKER_ID.test(markerId)) {
      return NextResponse.json(
        { error: "That is not a marker id." },
        { status: 400 },
      );
    }
    let outcome;
    try {
      outcome = await retryFailedMarker(db, markerId, actor.uid);
    } catch (err) {
      // Same treatment as a job that throws below: an unhandled rejection out
      // of a route hands the admin a blank 500 page rather than a sentence.
      console.error(`[scheduler] retry of marker ${markerId} threw:`, err);
      return NextResponse.json(
        { error: `That retry threw: ${errorText(err, SCHEDULER_LAST_ERROR_MAX)}` },
        { status: 500 },
      );
    }
    if (!outcome.retried) {
      return NextResponse.json({ error: RETRY_REFUSALS[outcome.reason] }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      markerId,
      note: "Marker cleared. The next tick will re-derive the work and re-claim it.",
    });
  }

  // ---- Run one job now ----------------------------------------------------
  if (typeof body.jobId !== "string" || body.jobId === "") {
    return NextResponse.json(
      { error: "Send either `jobId` or `markerId`." },
      { status: 400 },
    );
  }
  const job = findJob(body.jobId);
  if (job === null) {
    return NextResponse.json(
      { error: `Unknown scheduler job: ${body.jobId}` },
      { status: 404 },
    );
  }

  const config = await readSchedulerConfig(db);
  if (!config.enabled) {
    return NextResponse.json(
      {
        error:
          "The scheduler is switched off site-wide. Turn it back on before running a job by hand.",
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const deadline = now.getTime() + MANUAL_BUDGET_MS;
  const budget: JobBudget = {
    remainingMs: () => deadline - Date.now(),
    expired: () => Date.now() >= deadline,
  };

  const configRef = db
    .collection(SCHEDULER_CONFIG_PATH.collection)
    .doc(SCHEDULER_CONFIG_PATH.doc);

  try {
    const result = await job.handler({
      now,
      budget,
      log: (message, extra) =>
        console.log(`[scheduler:${job.id}] (manual) ${message}`, extra ?? ""),
      // Identical limits to a scheduled run. A Run now that quietly claimed
      // markers on a different policy would be a second code path through the
      // one thing on this platform that must not double-send.
      policy: policyFor(job),
      maxPerTick: job.maxPerTick,
      maxLateHours: job.maxLateHours,
    });
    await configRef.set(
      {
        jobs: {
          [job.id]: {
            lastRunAt: FieldValue.serverTimestamp(),
            lastProcessed: result.processed,
            lastError: null,
            lastErrorAt: null,
          },
        },
      },
      { merge: true },
    );
    return NextResponse.json({
      ok: true,
      jobId: job.id,
      processed: result.processed,
      hasMore: result.hasMore,
      note: result.note ?? null,
    });
  } catch (err) {
    const message = errorText(err, SCHEDULER_LAST_ERROR_MAX);
    console.error(`[scheduler:${job.id}] manual run threw:`, err);
    await configRef.set(
      {
        jobs: {
          [job.id]: {
            lastRunAt: FieldValue.serverTimestamp(),
            lastError: message,
            lastErrorAt: FieldValue.serverTimestamp(),
          },
        },
      },
      { merge: true },
    );
    return NextResponse.json(
      { error: `That job threw: ${message}` },
      { status: 500 },
    );
  }
}
