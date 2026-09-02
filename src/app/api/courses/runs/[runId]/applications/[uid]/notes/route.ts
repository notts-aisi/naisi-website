import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  APPLICATION_FIELD_LIMITS,
  courseApplicationId,
} from "@/lib/firestore/courseApplications";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * The reviewer's private working notes on one application: a free-text note,
 * plus a preferred group and/or preferred facilitator that the allocation board
 * (P6) reads as a suggestion.
 *
 * THE APPLICANT NEVER PICKS THESE. The apply form deliberately has no group or
 * facilitator picker (P4's route hard-codes `facilitatorPreferenceUids: []`) —
 * placement is admissions' judgement, informed by the availability the applicant
 * did tick. These three fields are reviewer-owned end to end.
 *
 * Gate is the decide route's, not the queue's: admins ∪ the run's
 * `admissionsReviewerUids`. A track lead may read the queue but not annotate it;
 * a note that steers allocation is part of deciding.
 *
 * Recording a preference is NOT an allocation and enrols nobody — it is a
 * suggestion the allocation step may follow or ignore. Validation exists so the
 * suggestion is coherent (a group that belongs to this run, a facilitator who
 * actually works on it), never to reserve a seat.
 */

type Ctx = { params: Promise<{ runId: string; uid: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId, uid } = await ctx.params;
  if (!runId || !uid) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: {
    reviewerNotes?: unknown;
    reviewerPreferredGroupId?: unknown;
    reviewerPreferredFacilitatorUid?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const isAdmin = actor.role === "admin";
  const isReviewer = run.admissionsReviewerUids.includes(actor.uid);
  if (!isAdmin && !isReviewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const appRef = db
    .collection("courseApplications")
    .doc(courseApplicationId(runId, uid));
  const appSnap = await appRef.get();
  if (!appSnap.exists) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }
  const existing = appSnap.data() ?? {};
  // Structural (the doc id is built from the pair), asserted anyway so a
  // hand-written doc fails closed instead of being annotated by mistake.
  if (existing.uid !== uid || existing.runId !== runId) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  // Only the keys the caller actually sent are written — omitting a field leaves
  // it untouched rather than clearing it (the roles route's convention).
  const patch: Record<string, unknown> = {};

  if (body.reviewerNotes !== undefined) {
    if (typeof body.reviewerNotes !== "string") {
      return NextResponse.json({ error: "Notes look malformed." }, { status: 400 });
    }
    const notes = body.reviewerNotes.trim().slice(0, APPLICATION_FIELD_LIMITS.reviewerNotes);
    // Clearing the box removes the field rather than storing "" — the
    // normaliser treats empty as absent, so this keeps the doc honest.
    patch.reviewerNotes = notes ? notes : FieldValue.delete();
  }

  // ---- Preferred group -----------------------------------------------------
  const groupKeySent = body.reviewerPreferredGroupId !== undefined;
  let requestedGroupId: string | null = null;
  if (groupKeySent) {
    const raw = body.reviewerPreferredGroupId;
    if (raw !== null && typeof raw !== "string") {
      return NextResponse.json({ error: "Preferred group looks malformed." }, { status: 400 });
    }
    requestedGroupId = typeof raw === "string" && raw ? raw : null;
    patch.reviewerPreferredGroupId = requestedGroupId ?? FieldValue.delete();
  }

  // The group the facilitator preference is checked against: the one being set
  // in this request, or the one already stored when the caller isn't changing it.
  const effectiveGroupId = groupKeySent
    ? requestedGroupId
    : typeof existing.reviewerPreferredGroupId === "string" &&
        existing.reviewerPreferredGroupId
      ? existing.reviewerPreferredGroupId
      : null;

  let groupFacilitatorUids: string[] = [];
  if (effectiveGroupId) {
    const groupSnap = await db.collection("courseGroups").doc(effectiveGroupId).get();
    const group = groupSnap.exists
      ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
      : null;
    if (group && group.runId === runId && !group.archived) {
      groupFacilitatorUids = group.facilitatorUids;
    } else if (groupKeySent) {
      // A group from ANOTHER run is rejected as hard as a nonexistent one: the
      // allocation board reads this field as "place them here", and a cross-run
      // id would be a placement into a cohort this applicant never applied to.
      return NextResponse.json(
        {
          error:
            group && group.runId === runId
              ? "That group has been archived."
              : "That group isn't part of this run.",
        },
        { status: 400 },
      );
    }
    // Otherwise the id is a STALE STORED one (the group was deleted or archived
    // after the preference was recorded). That must not block someone from
    // saving a note — it just offers no facilitators to validate against.
  }

  // ---- Preferred facilitator ----------------------------------------------
  if (body.reviewerPreferredFacilitatorUid !== undefined) {
    const raw = body.reviewerPreferredFacilitatorUid;
    if (raw !== null && typeof raw !== "string") {
      return NextResponse.json(
        { error: "Preferred facilitator looks malformed." },
        { status: 400 },
      );
    }
    const wanted = typeof raw === "string" && raw ? raw : null;
    if (wanted) {
      // Valid if they facilitate the preferred group, or sit in the run-level
      // facilitator pool (a preference can precede the group being staffed).
      const allowed =
        groupFacilitatorUids.includes(wanted) || run.runFacilitatorUids.includes(wanted);
      if (!allowed) {
        return NextResponse.json(
          { error: "That person doesn't facilitate on this run." },
          { status: 400 },
        );
      }
    }
    patch.reviewerPreferredFacilitatorUid = wanted ?? FieldValue.delete();
  } else if (groupKeySent) {
    // The group moved and the caller left the facilitator alone: drop a stored
    // preference that the new group can't honour, rather than leaving the
    // allocation board a contradiction to resolve.
    const stored =
      typeof existing.reviewerPreferredFacilitatorUid === "string"
        ? existing.reviewerPreferredFacilitatorUid
        : "";
    if (
      stored &&
      !groupFacilitatorUids.includes(stored) &&
      !run.runFacilitatorUids.includes(stored)
    ) {
      patch.reviewerPreferredFacilitatorUid = FieldValue.delete();
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  // Reviewer fields + `updatedAt` only. Status, the counters, the email, and the
  // paid-membership snapshot are all unreachable from this route.
  patch.updatedAt = FieldValue.serverTimestamp();
  await appRef.update(patch);

  return NextResponse.json({ ok: true });
}
