import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import {
  EXERCISE_LIMITS,
  normalizeExerciseResponse,
  REVIEW_STATUSES,
  type ExerciseReviewStatus,
} from "@/lib/firestore/courseExercises";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import type { ExerciseResponseWire } from "@/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route";

/**
 * A facilitator recording a verdict on one exercise response: a review status
 * and, optionally, feedback the member reads.
 *
 * ── SETTING A STATUS IS WHAT LOCKS THE MEMBER OUT ───────────────────────────
 * There is no separate "locked" flag. The submit route refuses (409) to write
 * any row whose `reviewStatus` is not `"unreviewed"`, so the moment this route
 * writes `seen`, `needs-work` or `approved`, the member's answer becomes
 * read-only — deliberately, so a verdict can't be invalidated by an edit made
 * after it. Setting the status BACK to `"unreviewed"` is the only way to hand
 * editing back, which is exactly how "needs work, have another go" is meant to
 * be run: leave the comment, set `unreviewed`, and the member can revise.
 * `reviewerComment` survives that round trip on purpose — the feedback is what
 * they are revising against.
 *
 * ── WHO MAY REVIEW ──────────────────────────────────────────────────────────
 * A facilitator of the group the RESPONSE OWNER is placed in ∪ admins. The
 * group is derived server-side from the response's own `runId` + `uid`, so the
 * caller names no group and cannot review across group lines. Admissions
 * reviewers and track leads are NOT here: admissions is a separate lane from
 * the cohort (locked decision), and staffing a run is not facilitating a group.
 *
 * `responseId` is the opaque deterministic doc id carried by the queue payload.
 * It is used VERBATIM as a doc id and NEVER parsed: `runId` can itself contain
 * the `__` separator, so every part is read from the document's fields instead.
 * Deterministic also means GUESSABLE, so the gate below answers "may you?"
 * before it ever answers "does it exist?" — see the access block.
 *
 * PII: `reviewerName` is a display name, never an email.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw — a 500 out of a facilitator action. Same
 * guard as `runAccess.ts`, deliberately identical so the gate and the routes
 * agree about what counts as an addressable id.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address. The reviewer's name is shown to
 * the MEMBER, so this is the PII boundary for this route. (Duplicated per route
 * by house convention.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * `weekNumber` is stored on the response doc but is not part of
 * `CourseExerciseResponseDoc`, so it is read from the raw data.
 *
 * THE INVARIANT: the submit route is the ONLY writer of this collection
 * (`allow write: if false` in firestore.rules) and it always stores the number
 * DERIVED FROM `weekId`, never the week doc's own field — so the echo below
 * matches what the queue and the member's own page filter on, and the fallback
 * can never contradict a stored value.
 *
 * Unlike the two list routes, the fallback here is genuinely reachable: this
 * row is ADDRESSED BY DOC ID, not found by a `weekNumber ==` filter (which
 * would exclude a field-less doc outright). A hand-edited or half-migrated row
 * therefore still echoes a usable week number rather than 0.
 */
function weekNumberOf(data: Record<string, unknown>, weekId: string): number {
  const n = data.weekNumber;
  if (typeof n === "number" && Number.isFinite(n) && n >= 1) return Math.floor(n);
  const m = /^w(\d{2})$/.exec(weekId);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  ctx: { params: Promise<{ responseId: string }> },
) {
  const { responseId } = await ctx.params;
  if (!isAddressableId(responseId)) {
    return NextResponse.json({ error: "Response not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { reviewStatus?: unknown; reviewerComment?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reviewStatus = body.reviewStatus as ExerciseReviewStatus;
  if (!REVIEW_STATUSES.includes(reviewStatus)) {
    return NextResponse.json(
      { error: `reviewStatus must be one of: ${REVIEW_STATUSES.join(", ")}.` },
      { status: 400 },
    );
  }

  const commentSent = body.reviewerComment !== undefined && body.reviewerComment !== null;
  if (commentSent && typeof body.reviewerComment !== "string") {
    return NextResponse.json({ error: "Feedback looks malformed." }, { status: 400 });
  }
  const reviewerComment = commentSent ? (body.reviewerComment as string).trim() : "";
  // Rejected, not truncated: silently binning the tail of a facilitator's
  // feedback is worse than a clear error, and the client counter means a
  // well-behaved caller never reaches this.
  if (reviewerComment.length > EXERCISE_LIMITS.reviewerComment) {
    return NextResponse.json(
      {
        error: `That feedback is too long (maximum ${EXERCISE_LIMITS.reviewerComment} characters).`,
      },
      { status: 400 },
    );
  }

  const ref = db.collection("courseExerciseResponses").doc(responseId);
  const snap = await ref.get();
  const data = snap.data() ?? {};
  const existing = snap.exists ? normalizeExerciseResponse(snap.id, data) : null;

  // ---- Access: facilitator of the OWNER's group, or admin ------------------
  // Two addressed reads, no queries and no caller-supplied ids: the owner's
  // enrolment (bound to (runId, uid) by `courseEnrolmentId`) names the group,
  // and the group names its facilitators. A withdrawn or completed enrolment
  // still resolves — work submitted while someone was in your group stays yours
  // to review after they leave it.
  //
  // AUTHORIZATION BEFORE EXISTENCE. `responseId` is DETERMINISTIC
  // (`runId__uid__weekId__exerciseId`), so anyone holding a run id and a uid can
  // spell a plausible one. Every refusal below is therefore the SAME 403 —
  // missing row, unreadable row, unplaced owner, someone else's group — so the
  // status code never becomes an oracle for "did that member submit that
  // exercise". Only an admin, who is past the gate on their role alone and may
  // read any of these rows anyway, is told a row is genuinely missing.
  const isAdmin = actor.role === "admin";
  if (!isAdmin) {
    let allowed = false;
    // A row that can't say whose it is can't be access-checked. Fail closed.
    if (existing?.runId && existing.uid) {
      const enrolSnap = await db
        .collection("courseEnrolments")
        .doc(courseEnrolmentId(existing.runId, existing.uid))
        .get();
      const enrolment = enrolSnap.exists
        ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
        : null;
      // An unplaced (or un-enrolled) owner has no facilitator, so only an admin
      // can act — which falls through to the shared refusal below.
      if (enrolment?.groupId) {
        const groupSnap = await db
          .collection("courseGroups")
          .doc(enrolment.groupId)
          .get();
        const group = groupSnap.exists
          ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
          : null;
        // Archiving a group unstaffs it — the same rule the exercises queue and
        // its page gate enforce. A verdict is not cosmetic: any non-unreviewed
        // status makes the submit route 409, locking the member out of editing
        // their own answer, so a stale open queue must not be able to land one.
        allowed = Boolean(
          group && !group.archived && group.facilitatorUids.includes(actor.uid),
        );
      }
    }
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Reachable only by an admin (every other caller is authorised against a row
  // that exists and names its owner), so it discloses nothing they could not
  // already read.
  if (!existing || !existing.runId || !existing.uid) {
    return NextResponse.json({ error: "Response not found" }, { status: 404 });
  }

  const now = new Date();
  // `reviewedAt` and `reviewerUid` are stamped for EVERY verdict, including a
  // reset to "unreviewed" — they record the last review ACTION, which is the
  // audit trail. The member's edit lock keys off `reviewStatus` alone (see the
  // module comment), so a stamped `reviewedAt` on an "unreviewed" row does not
  // keep them locked out.
  await ref.update({
    reviewStatus,
    reviewerUid: actor.uid,
    // Clearing the box removes the field rather than storing "" — the
    // normaliser treats empty as absent, so this keeps the doc honest. Omitting
    // `reviewerComment` from the body entirely leaves existing feedback in
    // place: a status-only change (the queue's one-tap "Seen") is not a
    // retraction of what was already said.
    ...(commentSent
      ? { reviewerComment: reviewerComment ? reviewerComment : FieldValue.delete() }
      : {}),
    reviewedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const reviewerSnap = await db.collection("users").doc(actor.uid).get();
  const reviewerName = reviewerSnap.exists
    ? displayNameOf(reviewerSnap.data() ?? {})
    : "NAISI member";

  // Echoed from what was just written rather than re-read — the stored server
  // timestamps are the authoritative ones and differ from `now` by
  // milliseconds. The member's content fields are untouched by this route, so
  // they come straight off the row as it was read.
  const response: ExerciseResponseWire = {
    id: existing.id,
    weekId: existing.weekId,
    weekNumber: weekNumberOf(data, existing.weekId),
    exerciseId: existing.exerciseId,
    responseType: existing.responseType,
    text: existing.text ?? null,
    linkUrl: existing.linkUrl ?? null,
    submittedAt: iso(existing.submittedAt),
    reviewStatus,
    reviewerName,
    reviewerComment: commentSent
      ? (reviewerComment || null)
      : (existing.reviewerComment ?? null),
    reviewedAt: iso(now),
  };

  return NextResponse.json({ ok: true, response });
}
