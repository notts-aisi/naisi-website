import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  MemberRecordWriteError,
  RoundDestroyBlockedError,
  destroyRoundCascade,
} from "@/lib/admissions/destroy";
import { DestroyPassInFlightError } from "@/lib/firestore/destroyAudit";
import {
  ROUNDS_COLLECTION,
  normalizeAdmissionRound,
} from "@/lib/firestore/admissionRounds";

/**
 * DESTROY an admission round. The engine (`src/lib/admissions/destroy.ts`)
 * owns the cascade, its ordering, the audit row and resumability; this route
 * owns WHO and WHETHER:
 *
 *  - ADMIN ONLY, not `approveCourse`. An `approveCourse` holder authors the
 *    round they will run; destroying it removes other people's applications,
 *    the access-requirements answers beside them and the reviewers' written
 *    assessments, which is above a content permission. Authorization runs
 *    BEFORE the existence check, so a non-admin cannot enumerate round ids.
 *  - TYPED CONFIRMATION: `confirmName` must equal the round's label EXACTLY,
 *    byte for byte, with nothing trimmed on the way in (whatever the browser
 *    normalises is the browser's business; the server compares what arrives).
 *    The check runs on a resume too, because the round document survives
 *    until the cascade's last step and the label is still there to hold the
 *    admin to. An UNLABELLED round is refused before the comparison: `"" ===
 *    ""` is a confirmation that passes by typing nothing.
 *  - BLOCKERS → 409 with the engine's sentences. Evaluated on a fresh destroy
 *    only: a resume must never be re-blocked or an interrupted cascade wedges.
 *  - A PASS ALREADY RUNNING → 409 with its own sentence, so the dialog offers
 *    Resume rather than reporting a broken destroy.
 *  - THE MEMBER RECORD FAILING → 409, and NOTHING is deleted. The whole
 *    reason an intake may be destroyed is that what the committee keeps about
 *    a person survives it; if that cannot be written the destroy does not
 *    happen.
 *
 * RESPONSE CONTRACT: `{ ok, deleted, complete, auditId }`. `deleted` is the
 * audit row's ACCUMULATED totals for this destroy rather than this
 * invocation's page, because the client renders it as a running total and a
 * resume can be driven from a tab that knows nothing about earlier passes.
 * `complete: false` means the page budget ran out and the client repeats the
 * SAME call with the SAME confirmName until it is true.
 *
 * `writes` rides alongside it and is NOT part of that contract. It carries the
 * three counts that are not deletions (member records written, records already
 * on file that were left alone, reviewer nav flags cleared), kept out of
 * `deleted` because the client's receipt prints every key of `deleted` under
 * the sentence "and the records listed below no longer exist" and the member
 * record is the one thing this destroy exists to preserve.
 *
 * NOBODY IS EMAILED. There is no honest message to send an applicant whose
 * application has been deleted, and if one is owed it is a conversation a
 * person has rather than a template.
 */
/** How many applicants a record-failure refusal names before it says "and N more". */
const FAILED_NAMES_SHOWN = 5;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Only an admin can destroy a round. It removes other people's applications, the access-requirements answers beside them and the reviewers' notes.",
      },
      { status: 403 },
    );
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { confirmName?: unknown };
  try {
    body = (await req.json()) as { confirmName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.confirmName !== "string") {
    return NextResponse.json({ error: "confirmName is required" }, { status: 400 });
  }

  const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});

  // An unnamed thing cannot be confirmed by name. Refused as a state to fix
  // rather than as a permission problem, which is why it reads as a 409 and
  // names the fix.
  if (round.label.length === 0) {
    return NextResponse.json(
      {
        error:
          "This round has no label, so there is nothing to type as confirmation. Give it one under Round details before destroying it.",
      },
      { status: 409 },
    );
  }

  // Byte equality on the raw strings. Nothing is trimmed or case-folded.
  if (body.confirmName !== round.label) {
    return NextResponse.json(
      { error: "That doesn't match the round's label. Type it exactly to confirm." },
      { status: 400 },
    );
  }

  try {
    const result = await destroyRoundCascade(db, roundId, round, {
      actorUid: actor.uid,
      // Display name only, because the audit row is PII-light on purpose: the
      // admissions convention of never recording an address.
      actorName: actor.displayName?.trim() || "NAISI admin",
    });
    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      writes: result.writes,
      complete: result.complete,
      auditId: result.auditId,
    });
  } catch (err) {
    if (err instanceof RoundDestroyBlockedError) {
      return NextResponse.json(
        { error: err.blockers[0], blockers: err.blockers },
        { status: 409 },
      );
    }
    if (err instanceof DestroyPassInFlightError) {
      // Not a failure: a pass IS running.
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof MemberRecordWriteError) {
      // Nothing has been deleted at this point, by construction: the record
      // sweep runs before the first delete and this is how it refuses.
      //
      // NAME THE PEOPLE, IN `error`. A count tells an admin to give up and a
      // list of uids tells them to open the Firestore console; the display name
      // off each application is what lets them go and look at the applicant the
      // destroy is stuck on. It goes in `error` rather than only in
      // `failedRecords` because `error` is the field the dialog renders.
      //
      // Names only, never addresses, the same rule the audit row follows, and
      // capped: a round whose whole record sweep failed would otherwise put
      // three hundred names into one refusal sentence.
      const names = err.failed.map((entry) => entry.name);
      const shown = names.slice(0, FAILED_NAMES_SHOWN).join(", ");
      const rest = names.length - FAILED_NAMES_SHOWN;
      const message =
        `${err.message} Still to record: ${shown}` +
        (rest > 0 ? ` and ${rest} more.` : ".");
      return NextResponse.json(
        { error: message, blockers: [message], failedRecords: err.failed },
        { status: 409 },
      );
    }
    // A mid-cascade failure left the audit row open, so the same call
    // resumes. Log the real error; the client gets the retry cue.
    console.error("[destroy-round] cascade failed (resumable):", roundId, err);
    return NextResponse.json(
      { error: "The destroy was interrupted. Run it again to resume." },
      { status: 500 },
    );
  }
}
