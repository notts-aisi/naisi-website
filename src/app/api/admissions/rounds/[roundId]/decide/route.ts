import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import {
  admissionApplicationUrl,
  sendAdmissionEmail,
} from "@/lib/email/admissionEmails";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  appointmentDecideBlock,
  appointmentDecideDisposition,
  isAppointableRun,
} from "@/lib/admissions/appointmentQueue";
import { canDecideAppointments } from "@/lib/admissions/appointmentQueueData";
import { ROUNDS_COLLECTION } from "@/lib/admissions/roundRoutes";
import { formatRunStart, formatRunStartShort } from "@/lib/courses/window";
import {
  APPLICATIONS_COLLECTION,
  DECISION_STATUS,
  isAppointmentDecision,
  normalizeAdmissionApplication,
  type AppointmentDecision,
} from "@/lib/firestore/admissionApplications";
import { normalizeAdmissionRound } from "@/lib/firestore/admissionRounds";
import { COURSE_AUDIT_COLLECTION } from "@/lib/firestore/courseAudit";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * Decide one application on an APPOINTMENT round: appoint this person to
 * facilitate a run, or tell them we cannot this time.
 *
 * ## Why the appointment half exists on its own, before the enrolment half
 *
 * A facilitator round closes on 4 October and facilitator training starts on
 * the 5th. The enrolment decide path (scores, coverage, seat rows, fellowship
 * offers, reinstatement) is not needed until the 23rd, and every attempt to
 * build them together scheduled the appointment behind the scoring machinery,
 * which lands eleven days after the training it is supposed to invite people
 * to. So this route serves the appointment branch and answers 400 on an
 * enrolment round, in words that say when the other half arrives.
 *
 * ## What is refused before the transaction opens
 *
 * An enrolment round (400, because that half is not built), and a round that
 * is archived, still a draft or cancelled (409). The last three are the states
 * the stage-release route already refuses on, and they matter more here: a
 * decide on one of them writes a facilitator list, moves two counters and
 * mails somebody about a round that is not running.
 *
 * ## One transaction, and it holds everything that must be true at once
 *
 *  - the application is still `submitted` on THIS round and undecided;
 *  - the target run is one an appointment may still be made onto, and it has
 *    a start date, because the email names the first day;
 *  - the uid joins `courseRuns.runFacilitatorUids`;
 *  - the outcome and the terminal status land on the application;
 *  - the round's counters move `submitted` down one and the new status up one;
 *  - one `courseAudit` row is created for an appointment.
 *
 * The audit row is written INSIDE the transaction rather than before it. The
 * `enrol-mode` precedent writes first, because there a row for a write that
 * then failed is a harmless extra line; here the commonest failure is not a
 * crash but an idempotent no-op (see below), and a row for a decide that
 * changed nothing would put a second "appointed" line in the log for one
 * appointment. Created in the transaction, there is exactly one row per
 * appointment and none for anything else.
 *
 * ## Idempotency, because this button gets pressed twice
 *
 * The queue is worked through in one sitting on a deadline evening, often on a
 * phone, often by two people at once. So:
 *
 *  - the SAME decision on an already-decided row answers 200
 *    `{ alreadyDecided: true }`, moves no counter and sends no email;
 *  - a DIFFERENT decision on an already-decided row is refused with 409,
 *    because the email for the first one has already gone out and silently
 *    overwriting it is not something a queue may do on its own.
 *
 * `appointmentDecideDisposition` is that logic, pure and executed by a test.
 *
 * ## The email is sent AFTER the commit and cannot fail the decision
 *
 * `sendAdmissionEmail` swallows everything (a suppressed address, an SMTP
 * outage, a missing template), so the worst case is a courtesy outstanding
 * rather than a committed appointment answered with a 500 that reads as "it
 * did not save". Nothing below the transaction writes a document.
 */

/** Cap on the decider's note. Their sentence, not an essay. */
const NOTE_MAX = 500;

type Ctx = { params: Promise<{ roundId: string }> };

type Body = {
  applicationId?: unknown;
  decision?: unknown;
  runId?: unknown;
  note?: unknown;
  reasonShared?: unknown;
};

export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const applicationId =
    typeof body.applicationId === "string" ? body.applicationId.trim() : "";
  if (!applicationId) {
    return NextResponse.json(
      { error: "Which application? None was named." },
      { status: 400 },
    );
  }
  if (!isAppointmentDecision(body.decision)) {
    return NextResponse.json(
      { error: "A decision here is either an appointment or a decline." },
      { status: 400 },
    );
  }
  const decision: AppointmentDecision = body.decision;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  // An appointment SHARES its note by definition: it is the paragraph naming
  // the training dates, and it goes in the email. A decline shares only what
  // the decider ticked.
  const reasonShared = decision === "appoint" ? true : body.reasonShared === true;

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});

  if (round.kind !== "appointment") {
    return NextResponse.json(
      {
        error:
          "This is an enrolment round, and deciding one of those is not built yet: it needs the review scores, the seat rows and the fellowship offers, which land together later this term. Only facilitator rounds can be decided here for now.",
      },
      { status: 400 },
    );
  }
  // Archived, still a draft, or cancelled. One sentence, shared with the page
  // so the queue never offers a press this will refuse, and the same three
  // states the stage-release route refuses on.
  const roundBlock = appointmentDecideBlock(round);
  if (roundBlock) return NextResponse.json({ error: roundBlock }, { status: 409 });
  if (!canDecideAppointments(user, round)) {
    return NextResponse.json(
      {
        error:
          "Only this round's final decider or an admin can appoint a facilitator. Reviewers can read the queue.",
      },
      { status: 403 },
    );
  }

  if (decision === "appoint" && !runId) {
    return NextResponse.json(
      { error: "Pick the run this person will facilitate." },
      { status: 400 },
    );
  }

  const appRef = db.collection(APPLICATIONS_COLLECTION).doc(applicationId);
  const runRef = decision === "appoint" ? db.collection("courseRuns").doc(runId) : null;

  // Set on every attempt, so a transaction RETRY cannot carry a stale verdict
  // out with it.
  let alreadyDecided = false;
  let conflict: string | null = null;
  let notFound = false;
  let refusal: string | null = null;
  let recipient: { email: string; name: string; uid: string } | null = null;
  let appointedRun: {
    id: string;
    label: string;
    courseTitle: string;
    startDate: string;
  } | null = null;

  try {
    await db.runTransaction(async (tx) => {
      alreadyDecided = false;
      conflict = null;
      notFound = false;
      refusal = null;
      recipient = null;
      appointedRun = null;

      const [appSnap, runSnap] = await Promise.all([
        tx.get(appRef),
        runRef ? tx.get(runRef) : Promise.resolve(null),
      ]);

      if (!appSnap.exists) {
        notFound = true;
        return;
      }
      const application = normalizeAdmissionApplication(
        appSnap.id,
        appSnap.data() ?? {},
        round.availabilityGrid,
      );
      // The id is deterministic, but it arrived in a request body, so the
      // round is checked against the STORED field rather than trusted from the
      // id's shape. A decide on this round may only touch this round's rows.
      if (application.roundId !== roundId) {
        notFound = true;
        return;
      }

      const disposition = appointmentDecideDisposition(
        { status: application.status, decision: application.outcome.decision },
        decision,
      );
      if (disposition.kind === "already-decided") {
        alreadyDecided = true;
        return;
      }
      if (disposition.kind === "conflict") {
        conflict = disposition.reason;
        return;
      }

      if (runRef) {
        if (!runSnap || !runSnap.exists) {
          refusal = "That run does not exist.";
          return;
        }
        const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
        if (!isAppointableRun(run)) {
          refusal =
            "That run has finished, been called off or been archived, so nobody can be appointed onto it.";
          return;
        }
        // THE EMAIL NAMES THE FIRST DAY. `{startDate}` is in the appointment's
        // seed copy and in its subject, and a run that has not been given one
        // yet would send those eleven literal characters to somebody who has
        // just been asked to run it. Refused here rather than papered over at
        // send time: the fix is a date on the run, which is thirty seconds of
        // an editor's time and is going to have to happen anyway.
        if (!run.startDate) {
          refusal =
            "That run has no start date yet, so we cannot tell them when it begins. Give the run a start date, then appoint.";
          return;
        }
        appointedRun = {
          id: run.id,
          label: run.label,
          courseTitle: run.courseTitle,
          startDate: run.startDate,
        };
        tx.update(runRef, {
          runFacilitatorUids: FieldValue.arrayUnion(application.uid),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      const nextStatus = DECISION_STATUS[decision];
      tx.update(appRef, {
        status: nextStatus,
        outcome: {
          decision,
          // The appointment's run, written on the field the outcome already
          // has for exactly this. A decline names none.
          targetRunId: runRef ? runId : null,
          streamId: null,
          decidedByUid: user.uid,
          decidedAt: FieldValue.serverTimestamp(),
          reason: note,
          reasonShared,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(roundRef, {
        "applicationCounts.submitted": FieldValue.increment(-1),
        [`applicationCounts.${nextStatus}`]: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (runRef && appointedRun) {
        tx.create(db.collection(COURSE_AUDIT_COLLECTION).doc(), {
          kind: "facilitator-appointed",
          runId,
          groupId: null,
          subjectUid: application.uid,
          actorUid: user.uid,
          actorName: user.displayName ?? "",
          targetLabel: `${appointedRun.courseTitle} ${appointedRun.label}`.trim(),
          detail: `Appointed ${application.displayName || application.uid} as a facilitator from the ${round.label} round.`,
          at: FieldValue.serverTimestamp(),
        });
      }

      recipient = {
        email: application.email ?? "",
        name: application.displayName,
        uid: application.uid,
      };
    });
  } catch (err) {
    console.error("[admissions decide] transaction failed", roundId, applicationId, err);
    return NextResponse.json(
      { error: "Could not record that decision." },
      { status: 500 },
    );
  }

  if (notFound) {
    return NextResponse.json(
      { error: "No application by that id on this round." },
      { status: 404 },
    );
  }
  if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
  // NO COUNTER MOVED AND NO EMAIL SENT. The row was already where the caller
  // is asking for it to be.
  if (alreadyDecided) return NextResponse.json({ ok: true, alreadyDecided: true });

  // POST-COMMIT AND FIRE-AND-FORGET. See the module comment.
  const to = recipient as { email: string; name: string; uid: string } | null;
  const run = appointedRun as {
    id: string;
    label: string;
    courseTitle: string;
    startDate: string;
  } | null;
  if (to && to.email) {
    if (decision === "appoint" && run) {
      void sendAdmissionEmail({
        kind: "appointed",
        to: to.email,
        name: to.name,
        roundLabel: round.label,
        applicationUrl: admissionApplicationUrl(roundId, "status"),
        courseTitle: run.courseTitle,
        runLabel: run.label,
        startDate: formatRunStart(run.startDate) ?? "",
        note,
        uid: to.uid,
        roundId,
      });
    } else {
      void sendAdmissionEmail({
        kind: "declined",
        to: to.email,
        name: to.name,
        roundLabel: round.label,
        applicationUrl: admissionApplicationUrl(roundId, "status"),
        decisionsBy: round.decisionsByDate
          ? formatRunStartShort(round.decisionsByDate)
          : undefined,
        // THE SHARE GATE, on the send side. An unshared reason is not passed,
        // so it can reach neither the component nor the token map.
        sharedReason: reasonShared ? note : undefined,
        uid: to.uid,
        roundId,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    alreadyDecided: false,
    decision,
    status: DECISION_STATUS[decision],
    runId: run?.id ?? null,
  });
}
