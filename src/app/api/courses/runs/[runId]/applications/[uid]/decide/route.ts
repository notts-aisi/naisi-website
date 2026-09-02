import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { sendCourseApplicationEmail } from "@/lib/email/courseApplicationEmails";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { COURSE_TZ } from "@/lib/courses/weekPlan";
import {
  APPLICATION_FIELD_LIMITS,
  courseApplicationId,
  type CourseApplicationStatus,
} from "@/lib/firestore/courseApplications";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * Decide one application: accept, waitlist, or reject.
 *
 * WHO MAY DECIDE: admins ∪ the run's `admissionsReviewerUids`. Track leads can
 * READ the queue (see the sibling GET route) but not decide it — steering a run
 * and choosing who gets in are different jobs, and the roles route keeps the two
 * arrays apart on purpose. Group facilitators have no standing here at all.
 *
 * DECIDING DOES NOT ENROL ANYONE. There is deliberately no `courseEnrolments`
 * write in this file: allocation (P6) is the step that places accepted
 * applicants into groups, and it owns the no-double-placement invariant (one
 * enrolment doc per (run, uid), a single scalar `groupId`). An "accepted"
 * application is an offer, not a seat — which is also why the accepted email
 * promises a later placement email rather than a group.
 *
 * The paid-membership tag is a badge for the reviewer's judgement and is not
 * read anywhere in this file. Nothing may gate a decision on it.
 */

type Ctx = { params: Promise<{ runId: string; uid: string }> };

type DecisionAction = "accept" | "waitlist" | "reject";

const STATUS_FOR_ACTION: Record<DecisionAction, CourseApplicationStatus> = {
  accept: "accepted",
  waitlist: "waitlisted",
  reject: "rejected",
};

/** The buckets `applicationCounts` tracks. `withdrawn` is never re-entered. */
const COUNTED: CourseApplicationStatus[] = [
  "pending",
  "accepted",
  "waitlisted",
  "rejected",
  "withdrawn",
];

class DecideError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * "Monday 6 October" in Europe/London, from the run's civil start date. Same
 * helper as the apply route's — kept local because route handlers don't import
 * from one another, and it exists only to feed the {startDate} email token.
 */
function formatRunStart(startDate: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return undefined;
  // Noon UTC: far enough from either edge that no DST shift can move the date.
  const at = new Date(`${startDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
}

export async function POST(req: Request, ctx: Ctx) {
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

  let body: { action?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "accept" && action !== "waitlist" && action !== "reject") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const nextStatus = STATUS_FOR_ACTION[action];

  // A reason is recorded for rejections only, and stays INTERNAL: it is the
  // note the queue shows the next reviewer, not email copy. The rejection
  // template has no token for it (courseEmails.ts), so nothing here leaks a
  // reviewer's private wording to the applicant.
  const reason =
    action === "reject" && typeof body.reason === "string"
      ? body.reason.trim().slice(0, APPLICATION_FIELD_LIMITS.decidedReason)
      : "";

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
  const runRef = db.collection("courseRuns").doc(runId);

  let outcome: { changed: boolean; to: string | null; name: string };
  try {
    outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);
      if (!snap.exists) throw new DecideError("Application not found", 404);
      const existing = snap.data() ?? {};

      // The doc id is built from (runId, uid), so this can only fail if a doc
      // was written by hand. Fail closed rather than decide the wrong row.
      if (existing.uid !== uid || existing.runId !== runId) {
        throw new DecideError("Application not found", 404);
      }

      const rawStatus = existing.status as CourseApplicationStatus;
      const from: CourseApplicationStatus = COUNTED.includes(rawStatus)
        ? rawStatus
        : "pending";

      // Withdrawn is TERMINAL: the applicant took themselves out of the running,
      // and a reviewer must not be able to pull them back in behind their back.
      // Reinstating one is a deliberate, human, out-of-band act.
      if (from === "withdrawn") {
        throw new DecideError(
          "This applicant withdrew. Ask them to re-apply rather than deciding it for them.",
          409,
        );
      }

      const patch: Record<string, unknown> = {
        status: nextStatus,
        decidedByUid: actor.uid,
        decidedAt: FieldValue.serverTimestamp(),
        // Opposite-branch clear (the collaborators-decision precedent): the
        // reason belongs to the rejected branch, so accepting or waitlisting
        // REMOVES it rather than leaving a stale rejection note attached to an
        // offer. `FieldValue.delete()`, never `undefined` — Firestore refuses
        // undefined, and an empty string would read as "reason: (blank)".
        decidedReason: reason ? reason : FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.update(appRef, patch);

      // Re-deciding into the SAME status (a double-clicked button, or an edited
      // rejection reason) records the new decider/reason but must not move a
      // counter — and must not re-send the lifecycle email.
      if (from === nextStatus) return { changed: false, to: null, name: "" };

      // Counters move in the same transaction as the status, so the queue's
      // headline numbers can never disagree with the rows beneath them. These
      // are relative increments; if a counter ever drifts (a hand-edited doc),
      // the fix is a recount pass, not a read-modify-write here.
      tx.update(runRef, {
        [`applicationCounts.${from}`]: FieldValue.increment(-1),
        [`applicationCounts.${nextStatus}`]: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        changed: true,
        // Server-sourced address, captured at apply time from the session —
        // never a body field. Absent (a fixture, a deleted address) simply
        // means no email.
        to: (existing.email as string | null | undefined) ?? null,
        name: typeof existing.displayName === "string" ? existing.displayName : "",
      };
    });
  } catch (err) {
    if (err instanceof DecideError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses decide] transaction failed", runId, uid, err);
    return NextResponse.json({ error: "Couldn't save that decision." }, { status: 500 });
  }

  // Post-commit and non-fatal, exactly like the apply route's submitted mail:
  // the decision is saved either way and the applicant must not wait on SMTP.
  if (outcome.changed && outcome.to) {
    void sendCourseApplicationEmail({
      kind:
        nextStatus === "accepted"
          ? "accepted"
          : nextStatus === "waitlisted"
            ? "waitlisted"
            : "rejected",
      to: outcome.to,
      name: outcome.name,
      courseTitle: run.courseTitle,
      runLabel: run.label,
      startDate: formatRunStart(run.startDate),
      uid,
      runId,
    }).catch((err) => {
      console.error("[courses decide] decision email failed", runId, uid, err);
    });
  }

  return NextResponse.json({ ok: true });
}
