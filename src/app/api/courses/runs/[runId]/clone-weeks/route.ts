import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentReference } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";
import {
  COURSE_FIELD_LIMITS,
  normalizeCourseWeek,
  sanitizeWeekPlan,
} from "@/lib/firestore/courses";

/**
 * Copy-forward: clone one run's `weeks` subcollection into another run of the
 * SAME course.
 *
 * ## Where this sits now (updated in V2-2 — the old rule here was abandoned)
 *
 * This comment used to argue that there was deliberately NO curriculum
 * template collection, and that a course's most recent run WAS the master
 * copy. That is no longer the design and must not be read as guidance:
 * `courseTemplates` exists (v2 decision 2) as append-only frozen SNAPSHOTS —
 * a saved iteration is what a finished cohort was actually taught, and it
 * cannot be edited afterwards, which is exactly the property a live run
 * cannot offer. `POST /api/courses/runs/[runId]/apply-template` is the
 * template-shaped counterpart of this route.
 *
 * Copy-forward SURVIVES alongside it, deliberately, because the two answer
 * different questions:
 *
 *  - a TEMPLATE answers "start next year from the version we agreed was
 *    finished", and carries its retrospective evidence with it;
 *  - THIS ROUTE answers "start from what that other delivery has right now",
 *    which is what an author wants mid-term, between snapshots, or when the
 *    run worth copying was never frozen.
 *
 * The old objection — a third place curriculum can live — is answered by
 * making every copy go through ONE id-preserving shape
 * (`templateWeekFields()`, which both directions of the snapshot copy and the
 * apply route also use) rather than by refusing to have a second place. Note
 * the one real difference in behaviour: `apply-template` REMOVES target weeks
 * its snapshot has no counterpart for, and refuses outright while any member
 * work exists on the run; this route only skips or overwrites and has no such
 * gate. A caller choosing between them is choosing between those guarantees.
 *
 * Two properties make this route safe to press twice:
 *
 *  - **Id-preserving.** Week doc ids ("w01".."w60") are copied verbatim, and so
 *    is every `material.id` / `exercise.id` / `checklist.id` inside them.
 *    Member progress is keyed on those ids — `courseProgress/{runId}__{uid}__
 *    {itemId}` and `courseExerciseResponses/{runId}__{uid}__{weekId}__
 *    {exerciseId}` — so a copy that re-minted ids would silently orphan every
 *    check-off and submission on a re-run of the same material. Nothing here
 *    may generate an id.
 *  - **Idempotent.** A week id that already exists in the target is skipped
 *    unless the caller asks to overwrite, so re-running the copy after
 *    authoring three weeks by hand doesn't wipe them.
 */

/**
 * Writes per batch. Firestore's hard limit is 500; 300 leaves headroom and a
 * run can hold at most 60 weeks (`maxWeekPlanEntries`), so in practice this
 * commits once — the chunking is here so a future longer-form course can't
 * turn into a 500-write failure.
 */
const MAX_DOCS_PER_BATCH = 300;

type WeekWrite = { ref: DocumentReference; data: Record<string, unknown> };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { fromRunId?: unknown; overwrite?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fromRunId = typeof body.fromRunId === "string" ? body.fromRunId.trim() : "";
  if (!fromRunId) {
    return NextResponse.json({ error: "Choose a run to copy from." }, { status: 400 });
  }
  if (fromRunId === runId) {
    return NextResponse.json(
      { error: "That's this run — pick a different one to copy from." },
      { status: 400 },
    );
  }
  const overwrite = body.overwrite === true;

  const runsCol = db.collection("courseRuns");
  const [targetSnap, sourceSnap] = await Promise.all([
    runsCol.doc(runId).get(),
    runsCol.doc(fromRunId).get(),
  ]);
  if (!targetSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (!sourceSnap.exists) {
    return NextResponse.json(
      { error: "The run you're copying from no longer exists." },
      { status: 404 },
    );
  }
  const target = targetSnap.data() ?? {};
  const source = sourceSnap.data() ?? {};

  // Admins, approvers, and the TARGET run's track leads — the people who own
  // this run's curriculum. Authority over the source run isn't required
  // separately because of the same-course check below: a track lead can only
  // ever pull content out of a run of the course they already lead.
  const isTrackLead = asUidList(target.trackLeadUids).includes(actor.uid);
  if (!(actor.role === "admin" || actor.permissions.approveCourse || isTrackLead)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const courseId = typeof target.courseId === "string" ? target.courseId : "";
  if (!courseId || courseId !== source.courseId) {
    return NextResponse.json(
      { error: "Both runs must belong to the same course." },
      { status: 400 },
    );
  }

  const sourceWeeks = await runsCol.doc(fromRunId).collection("weeks").get();
  if (sourceWeeks.empty) {
    return NextResponse.json(
      { error: "That run has no weeks to copy yet." },
      { status: 400 },
    );
  }

  const targetWeeks = runsCol.doc(runId).collection("weeks");
  // `select()` with no fields fetches ids only — this is an existence check,
  // not a read of the content we may be about to replace.
  const existingIds = new Set(
    (await targetWeeks.select().get()).docs.map((d) => d.id),
  );

  /**
   * The TARGET run's plan decides what number a copied week carries: the same
   * `w03` can be week 3 in a run with no breaks and week 3 of a differently
   * shaped plan elsewhere, and the number the cohort sees must match the plan
   * they're being paced by. Falls back to the source's own number when the
   * target plan has no slot for that id yet (copy-first, plan-later is a normal
   * order to work in).
   */
  const planNumbers = new Map<string, number>();
  for (const entry of sanitizeWeekPlan(target.weekPlan)) {
    if (entry.kind === "week") planNumbers.set(entry.weekId, entry.weekNumber);
  }

  const pending: WeekWrite[] = [];
  let skipped = 0;

  for (const docSnap of sourceWeeks.docs) {
    if (existingIds.has(docSnap.id) && !overwrite) {
      skipped += 1;
      continue;
    }

    // Normalising on the way through caps every array at the authored limits
    // and drops anything stale — and, critically, preserves the ids INSIDE
    // materials / exercises / checklist items (see the module comment).
    const week = normalizeCourseWeek(docSnap.id, docSnap.data() ?? {});
    const rawNumber = planNumbers.get(docSnap.id) ?? week.weekNumber;
    const weekNumber = Math.min(
      COURSE_FIELD_LIMITS.maxWeekPlanEntries,
      Math.max(1, Math.floor(rawNumber) || 1),
    );

    pending.push({
      ref: targetWeeks.doc(docSnap.id),
      data: {
        weekNumber,
        title: week.title,
        summary: week.summary,
        guideBlocks: week.guideBlocks,
        materials: week.materials,
        exercises: week.exercises,
        checklist: week.checklist,
        estimatedMinutes: week.estimatedMinutes,
        // Carried verbatim: the copy is a faithful clone of authored state, and
        // publication is scoped to this run anyway (the public catalogue reads
        // the course's showcase run, the cohort reads its own).
        published: week.published,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
      },
    });
  }

  for (let i = 0; i < pending.length; i += MAX_DOCS_PER_BATCH) {
    const batch = db.batch();
    for (const write of pending.slice(i, i + MAX_DOCS_PER_BATCH)) {
      // `set` (not `update`): most targets don't exist yet, and an overwrite
      // must replace the week wholesale rather than merge two curricula.
      batch.set(write.ref, write.data);
    }
    await batch.commit();
  }

  return NextResponse.json({ ok: true, created: pending.length, skipped });
}
