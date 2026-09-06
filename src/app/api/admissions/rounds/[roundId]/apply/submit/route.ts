import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  admissionApplicationUrl,
  sendAdmissionEmail,
} from "@/lib/email/admissionEmails";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { formatRoundDeadline } from "@/lib/admissions/window";
import { formatRunStartShort } from "@/lib/courses/window";
import { hasPaidMembership, normalizeUser } from "@/lib/firestore/users";
import {
  normalizeAdmissionApplication,
  type AdmissionApplicationStatus,
} from "@/lib/firestore/admissionApplications";
import {
  releasedStages,
  serialiseApplicationForOwner,
} from "@/lib/admissions/applyRoutes";
import {
  ApplyError,
  applicationRef,
  applicationsPaused,
  loadOwnApplication,
  loadRound,
  loadStages,
  readJson,
  requireApplicant,
  requireRecaptcha,
  roundRef,
  throttleIp,
  throttleUid,
  windowRefusal,
} from "@/lib/admissions/applyContext";

/**
 * Submit an application: the one act that turns a private draft into
 * somebody's work in a reviewer's queue.
 *
 * ## One transaction, and it validates what is STORED
 *
 * The submit re-reads the row inside the transaction and validates the answers
 * that are actually on it, with `enforceRequired: true`. It does not take a
 * fresh payload: the client saves first (an explicit PATCH) and then submits,
 * so what gets reviewed is exactly what the applicant last saw the site say it
 * had saved. Accepting answers on this route as well would mean two writers of
 * the same field with different validation contracts, and the version that
 * reached the reviewer would depend on which request landed second.
 *
 * Everything that has to be true at once is inside the one transaction:
 *
 *  - every RELEASED stage passes with required questions enforced;
 *  - each of those stages gets its `stageSubmittedAt` frozen;
 *  - `membershipAtApply` is snapshotted from the user document against the
 *    ROUND's academic year, so the decisions surface shows what was true when
 *    they applied rather than what is true when it is read;
 *  - the round's counters move `draft` down one and `submitted` up one.
 *
 * A counter that drifts is a review queue that lies, and a status that moved
 * without its counter is exactly the drift the `applicationCounts` recount
 * route exists to repair. Doing all four in one transaction is why it should
 * never need to.
 *
 * ## Membership is a badge, never a gate
 *
 * `membershipAtApply` is recorded and shown to the final decider and to
 * admins. No branch here reads it as a condition, and none may: an unpaid
 * applicant is emailed about membership, not refused.
 *
 * ## The receipt is sent AFTER the commit, and cannot fail the submission
 *
 * `admissions-submitted` goes out below the transaction, fire and forget. The
 * send helper swallows everything (suppressed address, SMTP outage, missing
 * template), so the worst case is a courtesy outstanding rather than a
 * submitted application answered with a 500 the applicant reads as "it did not
 * go through". Nothing after the transaction writes a document.
 */

type Ctx = { params: Promise<{ roundId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  // Throttles before any datastore read (see `applyContext.throttle`).
  const ipBlocked = throttleIp(req, "create");
  if (ipBlocked) return ipBlocked;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidBlocked = throttleUid(user.uid, "create");
  if (uidBlocked) return uidBlocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const captcha = await requireRecaptcha(body, "submit", {
    headers: req.headers,
    email: user.email,
  });
  if (captcha) return captcha;

  try {
    const now = new Date();
    const round = await loadRound(db, roundId);

    const closed = windowRefusal(round, now);
    if (closed) return NextResponse.json({ error: closed }, { status: 403 });

    const paused = await applicationsPaused(db);
    if (paused) return NextResponse.json({ error: paused }, { status: 503 });

    const stages = await loadStages(db, roundId);
    const open = releasedStages(stages, round, now);
    if (open.length === 0) {
      return NextResponse.json(
        { error: "There is nothing to submit yet: no part of this form has been released." },
        { status: 400 },
      );
    }

    const appRef = applicationRef(db, roundId, user.uid);
    const ref = roundRef(db, roundId);
    const userRef = db.collection("users").doc(user.uid);

    await db.runTransaction(async (tx) => {
      const [snap, userSnap] = await Promise.all([tx.get(appRef), tx.get(userRef)]);
      if (!snap.exists) throw new ApplyError("No application found.", 404);

      const application = normalizeAdmissionApplication(
        snap.id,
        snap.data() ?? {},
        round.availabilityGrid,
      );
      if (application.status === "submitted") {
        // Idempotent enough for a double tap: the row is already where the
        // caller is asking for it to be, and moving the counters again would
        // be the drift this transaction exists to prevent.
        throw new ApplyError("You have already submitted this application.", 409);
      }
      if (application.status !== "draft") {
        throw new ApplyError(
          application.status === "withdrawn"
            ? "You withdrew this application. Start it again to submit it."
            : "This application has already been decided.",
          409,
        );
      }

      const update: Record<string, unknown> = {};
      for (const stage of open) {
        const result = validateAnswers(stage.questions, application.stageAnswers[stage.id] ?? {}, {
          enforceRequired: true,
        });
        if ("error" in result) {
          throw new ApplyError(result.error, 400, {
            questionId: result.questionId,
            stageId: stage.id,
          });
        }
        // Freeze THIS stage. A stage released later is frozen by its own
        // submit route, so an applicant who answers stage 2 in November does
        // not have their stage 1 timestamp rewritten.
        update[`stageSubmittedAt.${stage.id}`] = FieldValue.serverTimestamp();
      }

      const membershipAtApply = userSnap.exists
        ? hasPaidMembership(
            normalizeUser(userSnap.id, userSnap.data() ?? {}),
            round.academicYear,
          )
        : false;

      tx.update(appRef, {
        ...update,
        status: "submitted" satisfies AdmissionApplicationStatus,
        submittedAt: FieldValue.serverTimestamp(),
        membershipAtApply,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(ref, {
        "applicationCounts.draft": FieldValue.increment(-1),
        "applicationCounts.submitted": FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    const loaded = await loadOwnApplication(db, round, user.uid);

    // POST-COMMIT AND FIRE-AND-FORGET. The transaction above is the
    // submission; this is the receipt. `sendAdmissionEmail` never throws and
    // never awaits the caller's response, so a suppressed address, an SMTP
    // hiccup or a missing template cannot turn a submitted application into a
    // 500 that reads as "it did not go through". Nothing below the transaction
    // may move a document, and nothing here does.
    if (user.email) {
      void sendAdmissionEmail({
        kind: "submitted",
        to: user.email,
        name: loaded?.application.displayName || user.displayName?.trim() || "",
        roundLabel: round.label,
        applicationUrl: admissionApplicationUrl(roundId, "status"),
        deadline: round.closesAt ? formatRoundDeadline(round.closesAt) : undefined,
        decisionsBy: round.decisionsByDate
          ? formatRunStartShort(round.decisionsByDate)
          : undefined,
        // Only on a round that asks in parts. On a single-stage round the
        // stage IS the form, so naming it would be noise, and the token stays
        // literal for an admin who put it in the copy anyway.
        stageLabel:
          round.stageIds.length > 1
            ? open.map((stage) => stage.label).join(", ")
            : undefined,
        uid: user.uid,
        roundId,
      });
    }

    return NextResponse.json({
      ok: true,
      application: loaded
        ? serialiseApplicationForOwner(loaded.application, round, loaded.accessRequirements)
        : null,
    });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    console.error("[admissions apply] submit failed", roundId, err);
    return NextResponse.json(
      { error: "Could not submit your application." },
      { status: 500 },
    );
  }
}
