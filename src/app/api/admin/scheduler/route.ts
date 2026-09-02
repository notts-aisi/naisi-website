/**
 * GET /api/admin/scheduler — everything the scheduler panel renders.
 *
 * The panel exists to answer five questions from a SURFACE rather than from
 * Cloud Logging: is the scheduler running, which jobs are on, when did each
 * last run, did anything throw, and is a send stuck. Cloud Logging can answer
 * all five, but only for someone who already knows what to grep for at 23:00
 * during an incident. This route is the shape of those answers.
 *
 * `schedulerRuns` and `schedulerMarkers` are both `allow read, write: if
 * false` in firestore.rules, so the panel cannot stream them the way the
 * admin Subscriptions tab streams its collection. Everything comes through
 * here on the Admin SDK.
 */
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { jobStateFor, readSchedulerConfig } from "@/lib/firestore/schedulerConfig";
import {
  SCHEDULER_MARKERS_COLLECTION,
  normalizeSchedulerMarker,
} from "@/lib/firestore/schedulerMarkers";
import {
  SCHEDULER_RUNS_COLLECTION,
  normalizeSchedulerRun,
} from "@/lib/firestore/schedulerRuns";
import { JOBS, isSchedulerJobId } from "@/lib/scheduler/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECEIPT_LIMIT = 20;
const FAILED_MARKER_LIMIT = 50;
const JOB_MARKER_LIMIT = 20;

export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const config = await readSchedulerConfig(db);

  const [receiptSnap, failedSnap] = await Promise.all([
    db
      .collection(SCHEDULER_RUNS_COLLECTION)
      .orderBy("startedAt", "desc")
      .limit(RECEIPT_LIMIT)
      .get(),
    // Single-field query: Firestore indexes `failedAt` automatically, so this
    // needs no entry in firestore.indexes.json.
    db
      .collection(SCHEDULER_MARKERS_COLLECTION)
      .where("failedAt", "!=", null)
      .orderBy("failedAt", "desc")
      .limit(FAILED_MARKER_LIMIT)
      .get(),
  ]);

  // Optional drill-down: the markers one job has claimed most recently. Served
  // by the (job ASC, claimedAt ASC) composite index, scanned in reverse.
  const requestedJob = new URL(req.url).searchParams.get("job");
  let jobMarkers: unknown[] = [];
  if (requestedJob !== null && isSchedulerJobId(requestedJob)) {
    const snap = await db
      .collection(SCHEDULER_MARKERS_COLLECTION)
      .where("job", "==", requestedJob)
      .orderBy("claimedAt", "desc")
      .limit(JOB_MARKER_LIMIT)
      .get();
    jobMarkers = snap.docs.map((doc) => {
      const marker = normalizeSchedulerMarker(
        doc.id,
        doc.data() as Record<string, unknown>,
      );
      return {
        id: marker.id,
        job: marker.job,
        claimedAt: marker.claimedAt?.toISOString() ?? null,
        sentAt: marker.sentAt?.toISOString() ?? null,
        failedAt: marker.failedAt?.toISOString() ?? null,
        attempts: marker.attempts,
        skippedReason: marker.skippedReason,
        lastError: marker.lastError,
      };
    });
  }

  return NextResponse.json({
    enabled: config.enabled,
    updatedAt: config.updatedAt?.toISOString() ?? null,
    updatedByUid: config.updatedByUid,
    jobs: JOBS.map((job) => {
      const state = jobStateFor(config, job.id);
      return {
        id: job.id,
        label: job.label,
        description: job.description,
        maxPerTick: job.maxPerTick,
        maxLateHours: job.maxLateHours,
        reclaimAfterMinutes: job.reclaimAfterMinutes,
        enabled: state.enabled,
        lastRunAt: state.lastRunAt?.toISOString() ?? null,
        lastProcessed: state.lastProcessed,
        lastError: state.lastError,
        lastErrorAt: state.lastErrorAt?.toISOString() ?? null,
      };
    }),
    receipts: receiptSnap.docs.map((doc) => {
      const run = normalizeSchedulerRun(
        doc.id,
        doc.data() as Record<string, unknown>,
      );
      return {
        id: run.id,
        bucket: run.bucket,
        depth: run.depth,
        trigger: run.trigger,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        durationMs: run.durationMs,
        hasMore: run.hasMore,
        rearmed: run.rearmed,
        rearmNote: run.rearmNote,
        skipped: run.skipped,
        receiptCollision: run.receiptCollision,
        jobs: run.jobs,
      };
    }),
    failedMarkers: failedSnap.docs.map((doc) => {
      const marker = normalizeSchedulerMarker(
        doc.id,
        doc.data() as Record<string, unknown>,
      );
      return {
        id: marker.id,
        job: marker.job,
        family: marker.family,
        attempts: marker.attempts,
        claimedAt: marker.claimedAt?.toISOString() ?? null,
        failedAt: marker.failedAt?.toISOString() ?? null,
        lastError: marker.lastError,
        components: marker.components,
      };
    }),
    jobMarkers,
  });
}
