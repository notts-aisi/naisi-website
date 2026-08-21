import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { normalizeExerciseResponse } from "@/lib/firestore/courseExercises";
import type { ExerciseResponseWire } from "@/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route";

/**
 * The member's OWN exercise responses for one week — what the week page hydrates
 * its answer boxes from, and how it knows which rows are still editable.
 *
 * OWN ROWS ONLY, structurally: the query pins `uid` to the caller's own uid,
 * which comes from the session and never from a parameter. There is no code
 * path here that can widen it, and nothing about anyone else's submission
 * reaches this payload — the facilitator queue is the only cohort-wide exercise
 * surface and it lives behind a group-facilitator gate.
 *
 * ── WHY A ROUTE, NOT A CLIENT QUERY ─────────────────────────────────────────
 * `courseExerciseResponses` IS own-row readable in firestore.rules, so a client
 * query would work. It comes through a route anyway because `reviewerName` has
 * to be resolved from a `users` doc the member cannot read (member PII is
 * SU-committee-and-admin only), and a member seeing "reviewed by <uid>" is not
 * a feature. Resolving it here keeps the one join server-side and keeps the
 * wire shape identical to the queue's.
 *
 * WHO MAY READ: the caller, about themselves — a live enrolment (active or
 * completed, matching the run overview's read boundary) or an admin. Note the
 * asymmetry with the submit route, which requires an ACTIVE learner enrolment:
 * a completed cohort is the member's own history to re-read but not to rewrite.
 *
 * PII: display names only, never an email (see `displayNameOf`).
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the week page's exercise section renders from)
// ---------------------------------------------------------------------------

export type MyExercisesPayload = {
  /**
   * The caller's rows for the requested week, in `exerciseId` order. DISPLAY
   * order is the week doc's `exercises` array, which the page already holds —
   * a response can outlive a reordering, or the exercise itself.
   */
  responses: ExerciseResponseWire[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/**
 * A week can hold at most `COURSE_FIELD_LIMITS.maxExercises` (15) exercises, so
 * 15 is the structural row count. The headroom covers rows orphaned by an
 * exercise being deleted after it was answered — the member should still see
 * what they wrote.
 */
const MAX_ROWS = 30;

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator. Same guard as `runAccess.ts`.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address. (Duplicated per route by house
 * convention; route handlers don't import from one another.)
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

/** `?week=N` — a positive integer inside the plan's bounds, or null. */
function parseWeek(raw: string | null): number | null {
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_WEEK_NUMBER ? n : null;
}

/**
 * ── THE `weekNumber` INVARIANT (why this route needs no fallback) ────────────
 * `weekNumber` is stored on the response doc but is not part of
 * `CourseExerciseResponseDoc`. It never has to be re-derived here: the SUBMIT
 * ROUTE IS THE ONLY WRITER of that collection (`allow write: if false` in
 * firestore.rules) and it always stores the number derived from `weekId`, and
 * the query below FILTERS on `weekNumber == week`. So every row this route can
 * see carries exactly `week`, and the echoed value is `week` itself.
 *
 * An id-derived fallback would be dead code, not a safety net: Firestore
 * excludes docs missing a filtered field, so a field-less row could never reach
 * one. Such a row would be invisible to this route entirely — the page would
 * render an empty writable box over a stored answer — which is why the single
 * writer stamping the field is the invariant that matters, and the only place
 * it can be broken.
 */

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  if (!isAddressableId(runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const week = parseWeek(new URL(req.url).searchParams.get("week"));
  if (week === null) {
    return NextResponse.json(
      { error: `week must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }

  const isAdmin = actor.role === "admin";

  // The enrolment is ADDRESSED, never queried: `courseEnrolmentId` binds
  // (run, uid), so there is no way to spell another member's row. The run doc
  // is not read at all — this payload contains nothing about the run, and the
  // enrolment's existence already establishes that the run exists.
  if (!isAdmin) {
    const enrolSnap = await db
      .collection("courseEnrolments")
      .doc(courseEnrolmentId(runId, actor.uid))
      .get();
    const enrolment = enrolSnap.exists
      ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
      : null;
    // Withdrawn / removed enrolments lose access the moment they are written,
    // whatever the member's open tab still shows.
    const live =
      enrolment && (enrolment.status === "active" || enrolment.status === "completed");
    if (!live) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Three equality filters, served by the EXISTING
  // (runId, weekNumber, uid) composite — an equality-only query matches an index
  // holding exactly those fields whatever order the clauses are written in. No
  // new index. `uid` is the session's, so this is own-rows-only by construction.
  //
  // `week` is the id-derived number, which is exactly what the submit route
  // stores (see the invariant above) — the page asking for week N and the row
  // written on /weeks/N agree by construction.
  const snap = await db
    .collection("courseExerciseResponses")
    .where("runId", "==", runId)
    .where("weekNumber", "==", week)
    .where("uid", "==", actor.uid)
    .limit(MAX_ROWS)
    .get();

  const rows = snap.docs.map((d) => normalizeExerciseResponse(d.id, d.data() ?? {}));

  // One `getAll` for the reviewer names — usually zero or one distinct
  // facilitator across a week's rows. Names only.
  const reviewerUids = [
    ...new Set(rows.map((r) => r.reviewerUid).filter((u): u is string => Boolean(u))),
  ];
  const userDocs = reviewerUids.length
    ? await db.getAll(...reviewerUids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  const responses: ExerciseResponseWire[] = rows
    .map((doc) => ({
      id: doc.id,
      weekId: doc.weekId,
      // The queried number, echoed straight back: the filter above is an
      // equality on this field, so every row here holds exactly it.
      weekNumber: week,
      exerciseId: doc.exerciseId,
      responseType: doc.responseType,
      text: doc.text ?? null,
      linkUrl: doc.linkUrl ?? null,
      submittedAt: iso(doc.submittedAt),
      reviewStatus: doc.reviewStatus,
      reviewerName: doc.reviewerUid
        ? (nameByUid.get(doc.reviewerUid) ?? "NAISI member")
        : null,
      reviewerComment: doc.reviewerComment ?? null,
      reviewedAt: iso(doc.reviewedAt),
    }))
    .sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));

  const payload: MyExercisesPayload = { responses };
  return NextResponse.json(payload);
}
