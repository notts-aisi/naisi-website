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
import { findJob, type JobBudget } from "@/lib/scheduler/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/** Same shape as the tick's budget, a little tighter: no re-arm follows this. */
const MANUAL_BUDGET_MS = 30_000;

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
    const reset = await retryFailedMarker(db, body.markerId, actor.uid);
    if (!reset) {
      return NextResponse.json(
        {
          error:
            "That marker is gone or already sent, so there is nothing to retry.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      markerId: body.markerId,
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
