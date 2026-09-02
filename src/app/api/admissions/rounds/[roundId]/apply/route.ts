import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { normalizeUser } from "@/lib/firestore/users";
import {
  EMPTY_APPLICATION_PROGRAMME_PREFERENCE,
  EMPTY_OUTCOME,
  type AdmissionApplicationStatus,
} from "@/lib/firestore/admissionApplications";
import { emptyMask } from "@/lib/admissions/availability";
import {
  isFieldError,
  readAccessRequirements,
  readAvailability,
  readProgrammePreference,
  readStageAnswers,
  serialiseApplicationForOwner,
  serialiseRoundForApplicant,
  serialiseStageForApplicant,
} from "@/lib/admissions/applyRoutes";
import {
  ApplyError,
  applicationRef,
  applicationsPaused,
  loadOwnApplication,
  loadRound,
  loadStages,
  privateRef,
  readJson,
  requireApplicant,
  requireRecaptcha,
  roundRef,
  throttle,
  windowRefusal,
  type Db,
} from "@/lib/admissions/applyContext";
import type { SessionUser } from "@/lib/firebase/session";

/**
 * The applicant's own row on an admission round: read it, start it, save it,
 * withdraw it.
 *
 *   GET    - the caller's own application, projected for its owner
 *   POST   - start a draft, or re-open a withdrawn one while the window is open
 *   PATCH  - the explicit Save and the form's two-minute autosave
 *   DELETE - withdraw
 *
 * Submitting is deliberately somewhere else (`POST .../apply/submit`), because
 * it is a different act with a different validation contract: a save accepts a
 * half-written form, a submit does not.
 *
 * ## Everything server-side, and the draft is a real row
 *
 * `admissionApplications` is `allow read, write: if false`. The row carries a
 * server-sourced email, a paid-membership snapshot, reviewer-only evidence and
 * a decision, and the round's counters have to move in the same transaction as
 * the status. So there is no client-direct write anywhere in this feature, and
 * the draft an applicant is halfway through IS the document, which is what
 * makes it survive a refresh, a backgrounded phone and a flat battery.
 *
 * ## Withdrawal is not terminal
 *
 * While the window is open, withdrawing and applying again reuses the SAME
 * row: status goes back to `draft`, `reapplyCount` goes up by one, and the
 * answers already written are still there. A second row was never an option
 * (the doc id is `${roundId}__${uid}`, which is the one-per-person invariant),
 * and deleting the first would throw away answers somebody may have spent an
 * evening on because they pressed a button meaning "not right now".
 *
 * Once the window closes, a withdrawal is final: re-opening it would let
 * somebody re-enter a queue after the deadline everyone else met.
 */

type Ctx = { params: Promise<{ roundId: string }> };

/** `preferredName` wins: it is what the member asked to be called. */
async function applicantName(db: Db, user: SessionUser): Promise<string> {
  try {
    const snap = await db.collection("users").doc(user.uid).get();
    if (snap.exists) {
      const doc = normalizeUser(snap.id, snap.data() ?? {});
      return (
        doc.profile?.preferredName?.trim() ||
        doc.displayName?.trim() ||
        user.displayName?.trim() ||
        ""
      );
    }
  } catch (err) {
    console.warn("[admissions apply] user doc read failed", user.uid, err);
  }
  return user.displayName?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// GET - the caller's own row
// ---------------------------------------------------------------------------

/**
 * The applicant's own application, or `{ application: null }`.
 *
 * NOT a general read of the collection: the doc id is built from the session
 * uid, so a caller can only ever address their own row, and the projection
 * (`serialiseApplicationForOwner`) leaves out the reviewer evidence and the
 * decision reason that are the reason the collection is `read: if false` in
 * the first place. `accessRequirements` is joined in from the private
 * collection only here, only for the person who wrote it.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { roundId } = await ctx.params;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  try {
    const now = new Date();
    const round = await loadRound(db, roundId);
    const [stages, loaded] = await Promise.all([
      loadStages(db, roundId),
      loadOwnApplication(db, round, user.uid),
    ]);
    return NextResponse.json({
      round: serialiseRoundForApplicant(round, now),
      stages: stages.map((stage) => serialiseStageForApplicant(stage, round, now)),
      application: loaded
        ? serialiseApplicationForOwner(loaded.application, loaded.accessRequirements)
        : null,
    });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    console.error("[admissions apply] read failed", roundId, err);
    return NextResponse.json({ error: "Could not load your application." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST - start a draft, or re-open a withdrawn one
// ---------------------------------------------------------------------------

export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  // Throttles BEFORE any datastore read: the point of throttling is to cap
  // cost, so a limiter after the reads has already paid for the request it is
  // about to refuse. The IP axis runs before the session lookup for the same
  // reason.
  const ipBlocked = throttle(req, null, "create");
  if (ipBlocked) return ipBlocked;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidBlocked = throttle(req, user.uid, "create");
  if (uidBlocked) return uidBlocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const captcha = await requireRecaptcha(body, "create");
  if (captcha) return captcha;

  try {
    const now = new Date();
    const round = await loadRound(db, roundId);

    const closed = windowRefusal(round, now);
    if (closed) return NextResponse.json({ error: closed }, { status: 403 });

    const paused = await applicationsPaused(db);
    if (paused) return NextResponse.json({ error: paused }, { status: 503 });

    const displayName = await applicantName(db, user);
    const appRef = applicationRef(db, roundId, user.uid);
    const ref = roundRef(db, roundId);

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);

      if (!snap.exists) {
        // `tx.create` at the deterministic id IS the one-application-per-
        // (round, person) rule. The read above only exists to turn the
        // resulting ALREADY_EXISTS into something a person can act on.
        tx.create(appRef, {
          roundId,
          uid: user.uid,
          // From the SESSION, never the body: an applicant must not be able to
          // plant somebody else's address on a row the team will email.
          email: user.email ?? null,
          displayName,
          stageAnswers: {},
          stageSubmittedAt: {},
          // The empty mask carries the round's geometry from the first save,
          // so no reader ever has to guess which grid an answer was drawn on.
          availability: emptyMask(round.availabilityGrid),
          availabilityConfigVersion: round.availabilityGrid.version,
          programmePreference: { ...EMPTY_APPLICATION_PROGRAMME_PREFERENCE },
          evidence: null,
          membershipAtApply: false,
          reapplyCount: 0,
          status: "draft" satisfies AdmissionApplicationStatus,
          submittedAt: null,
          withdrawnAt: null,
          outcome: { ...EMPTY_OUTCOME },
          seatApplicationId: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(ref, {
          "applicationCounts.draft": FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "created" as const;
      }

      const status = (snap.data() ?? {}).status as AdmissionApplicationStatus;
      if (status === "withdrawn") {
        // Re-apply on the SAME row. The window is open (checked above), so
        // this is a person changing their mind inside the deadline, not
        // somebody re-entering a queue after it.
        tx.update(appRef, {
          status: "draft" satisfies AdmissionApplicationStatus,
          withdrawnAt: null,
          submittedAt: null,
          reapplyCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(ref, {
          "applicationCounts.withdrawn": FieldValue.increment(-1),
          "applicationCounts.draft": FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "reopened" as const;
      }

      return "exists" as const;
    });

    const loaded = await loadOwnApplication(db, round, user.uid);
    const application = loaded
      ? serialiseApplicationForOwner(loaded.application, loaded.accessRequirements)
      : null;

    if (outcome === "exists") {
      // 409 CARRYING THE ROW. A double tap on "Start your application" (or a
      // second tab) must open the draft that already exists rather than show
      // an error about a form the applicant can see in front of them.
      return NextResponse.json(
        {
          error: "You have already started an application to this round.",
          application,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, created: outcome === "created", application });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    // Lost the race between the read and the commit.
    if ((err as { code?: number }).code === 6) {
      return NextResponse.json(
        { error: "You have already started an application to this round." },
        { status: 409 },
      );
    }
    console.error("[admissions apply] create failed", roundId, err);
    return NextResponse.json(
      { error: "Could not start your application." },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH - the explicit Save, and the autosave
// ---------------------------------------------------------------------------

/**
 * Save a draft.
 *
 * ## What "released only" means here
 *
 * Answers are validated against the RELEASED stages, with
 * `enforceRequired: false`. A draft is half written by definition, so refusing
 * it on a blank required question would mean the applicant could not save
 * until they had finished, which is the opposite of what a draft is for.
 * Everything else stays enforced, so a saved draft can never hold a value the
 * submit path would then have to reject.
 *
 * A body naming a stage that is not released, or one already frozen, is
 * REFUSED and names the stage. Silently dropping it is the failure that costs
 * somebody their essay: they type, they watch "Saved" appear, and the box is
 * empty tomorrow.
 *
 * ## Not gated on the maintenance pause, on purpose
 *
 * The pause exists to stop new work landing while something is being fixed.
 * Stranding somebody mid-sentence with an unsaveable form for that helps
 * nobody, and the row already exists, so a save costs one document write. The
 * DEADLINE is a different promise and is enforced: once the window shuts, the
 * form is view-only.
 *
 * ## Access requirements never touch the application row
 *
 * The answer goes to `admissionApplicationPrivate` in the SAME batch, and the
 * update below cannot write it: the field is not in the object. That is the
 * structural half of the promise the privacy notice makes.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  const ipBlocked = throttle(req, null, "save");
  if (ipBlocked) return ipBlocked;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidBlocked = throttle(req, user.uid, "save");
  if (uidBlocked) return uidBlocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  try {
    const now = new Date();
    const round = await loadRound(db, roundId);

    const closed = windowRefusal(round, now);
    if (closed) {
      return NextResponse.json(
        {
          error:
            "Applications for this round have closed, so this one cannot be edited now. You can still read it, and withdraw it if your plans have changed.",
        },
        { status: 403 },
      );
    }

    const loaded = await loadOwnApplication(db, round, user.uid);
    if (!loaded) {
      return NextResponse.json({ error: "No application found." }, { status: 404 });
    }
    const { application } = loaded;
    if (application.status !== "draft") {
      return NextResponse.json(
        {
          error:
            application.status === "withdrawn"
              ? "You have withdrawn this application, so it cannot be edited."
              : "This application has been submitted, so it cannot be edited.",
        },
        { status: 403 },
      );
    }

    const stages = await loadStages(db, roundId);

    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

    if (body.stageAnswers !== undefined) {
      const answers = readStageAnswers(
        body.stageAnswers,
        stages,
        round,
        now,
        application.stageSubmittedAt,
        false,
      );
      if (isFieldError(answers)) {
        return NextResponse.json(answers, { status: 400 });
      }
      // Merged per stage rather than replaced wholesale: a client that sends
      // only the stage it is showing must not blank the other one.
      for (const [stageId, stageAnswers] of Object.entries(answers)) {
        update[`stageAnswers.${stageId}`] = stageAnswers;
      }
    }

    if (body.availability !== undefined) {
      const mask = readAvailability(body.availability, round.availabilityGrid);
      if (isFieldError(mask)) return NextResponse.json(mask, { status: 400 });
      update.availability = mask;
      // Denormalised out of the mask so a staleness scan is one equality
      // filter rather than a read of every application. A copy, never truth.
      update.availabilityConfigVersion = mask.version;
    }

    if (body.programmePreference !== undefined) {
      const preference = readProgrammePreference(body.programmePreference, round);
      if (isFieldError(preference)) return NextResponse.json(preference, { status: 400 });
      update.programmePreference = preference;
    }

    let accessRequirements: string | null = null;
    if (body.accessRequirements !== undefined) {
      const value = readAccessRequirements(body.accessRequirements);
      if (isFieldError(value)) return NextResponse.json(value, { status: 400 });
      accessRequirements = value;
    }

    const batch = db.batch();
    batch.update(applicationRef(db, roundId, user.uid), update);
    if (accessRequirements !== null) {
      batch.set(
        privateRef(db, roundId, user.uid),
        { accessRequirements },
        { merge: true },
      );
    }
    await batch.commit();

    const saved = await loadOwnApplication(db, round, user.uid);
    return NextResponse.json({
      ok: true,
      savedAt: new Date().toISOString(),
      application: saved
        ? serialiseApplicationForOwner(saved.application, saved.accessRequirements)
        : null,
    });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    console.error("[admissions apply] save failed", roundId, err);
    return NextResponse.json({ error: "Could not save your application." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE - withdraw
// ---------------------------------------------------------------------------

/** What the confirmation box asks for, compared case-insensitively. */
const WITHDRAW_CONFIRMATION = "WITHDRAW";

/**
 * Withdraw.
 *
 * Deliberately reachable by a `rejected` account too, and deliberately not
 * gated on the window: trapping somebody in a queue with no self-service exit
 * helps nobody, and a withdrawal takes work off the team rather than changing
 * it underneath them.
 *
 * Typed confirmation, but a single word rather than the round's whole label.
 * The irreversible course drop-out asks for the course title because there is
 * no way back from it; a withdrawal inside an open window is reversible in one
 * press, so the bar is "deliberate", not "arduous".
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  const ipBlocked = throttle(req, null, "create");
  if (ipBlocked) return ipBlocked;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { db, user } = caller;

  const body = (await readJson(req)) ?? {};
  const typed = typeof body.confirm === "string" ? body.confirm.trim().toUpperCase() : "";
  if (typed !== WITHDRAW_CONFIRMATION) {
    return NextResponse.json(
      { error: `Type ${WITHDRAW_CONFIRMATION} to confirm.` },
      { status: 400 },
    );
  }

  const appRef = applicationRef(db, roundId, user.uid);
  const ref = roundRef(db, roundId);

  try {
    const round = await loadRound(db, roundId);

    const already = await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);
      if (!snap.exists) throw new ApplyError("No application found.", 404);
      const status = (snap.data() ?? {}).status as AdmissionApplicationStatus;

      // Idempotent: a double-tapped confirm must not move a counter twice.
      if (status === "withdrawn") return true;
      if (status !== "draft" && status !== "submitted") {
        throw new ApplyError(
          "This application has already been decided, so it cannot be withdrawn here. Reply to any email from us and we will sort it out.",
          409,
        );
      }

      tx.update(appRef, {
        status: "withdrawn" satisfies AdmissionApplicationStatus,
        withdrawnAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(ref, {
        [`applicationCounts.${status}`]: FieldValue.increment(-1),
        "applicationCounts.withdrawn": FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    });

    const loaded = await loadOwnApplication(db, round, user.uid);
    return NextResponse.json({
      ok: true,
      alreadyWithdrawn: already,
      application: loaded
        ? serialiseApplicationForOwner(loaded.application, loaded.accessRequirements)
        : null,
    });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    console.error("[admissions apply] withdraw failed", roundId, err);
    return NextResponse.json(
      { error: "Could not withdraw your application." },
      { status: 500 },
    );
  }
}
