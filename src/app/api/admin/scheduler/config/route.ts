/**
 * POST /api/admin/scheduler/config: the kill switches.
 *
 * One global `enabled` plus one per job. A missing global switch means
 * enabled; a missing per-job row falls to that job's own `enabledByDefault`
 * (see src/lib/firestore/schedulerConfig.ts and jobDefaultEnabled in the
 * registry), so this route only ever writes the explicit values an admin has
 * chosen; it never seeds defaults, or a later PR's newly registered job would
 * arrive with a choice nobody made when the doc was written.
 *
 * A POST, never a write on a GET.
 */
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  SCHEDULER_CONFIG_PATH,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import { isSchedulerJobId } from "@/lib/scheduler/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const update: Record<string, unknown> = {};

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "`enabled` must be a boolean" },
        { status: 400 },
      );
    }
    update.enabled = body.enabled;
  }

  if ("jobs" in body) {
    const jobs = body.jobs;
    if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
      return NextResponse.json(
        { error: "`jobs` must be an object keyed by job id" },
        { status: 400 },
      );
    }
    const jobUpdate: Record<string, { enabled: boolean }> = {};
    for (const [id, value] of Object.entries(jobs as Record<string, unknown>)) {
      // Reject unknown ids rather than storing them: a typo that silently
      // lands in the doc reads on the panel as a job that does not exist and,
      // worse, as a switch that has no effect on the one that does.
      if (!isSchedulerJobId(id)) {
        return NextResponse.json(
          { error: `Unknown scheduler job: ${id}` },
          { status: 400 },
        );
      }
      const enabled = (value as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== "boolean") {
        return NextResponse.json(
          { error: `\`jobs.${id}.enabled\` must be a boolean` },
          { status: 400 },
        );
      }
      jobUpdate[id] = { enabled };
    }
    if (Object.keys(jobUpdate).length > 0) update.jobs = jobUpdate;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No recognised fields in body" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  await db
    .collection(SCHEDULER_CONFIG_PATH.collection)
    .doc(SCHEDULER_CONFIG_PATH.doc)
    .set(
      {
        ...update,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
      },
      { merge: true },
    );

  const config = await readSchedulerConfig(db);
  return NextResponse.json({
    ok: true,
    enabled: config.enabled,
    jobs: Object.fromEntries(
      Object.entries(config.jobs).map(([id, state]) => [
        id,
        { enabled: state.enabled },
      ]),
    ),
  });
}
