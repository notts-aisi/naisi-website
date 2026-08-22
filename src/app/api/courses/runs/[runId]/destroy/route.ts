import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  DestroyBlockedError,
  DestroyPassInFlightError,
  destroyRunCascade,
} from "@/lib/firestore/courseDeletion";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * DESTROY a course run — the irreversible half of the deletion protocol.
 * The engine (courseDeletion.ts) owns the cascade, its ordering rationale,
 * the audit row, and resumability; this route owns WHO and WHETHER:
 *
 *  - ADMIN ONLY, not approveCourse: the cascade deletes member work
 *    (progress, exercise answers, attendance marks), which is above a
 *    content permission by locked decision. Authorization runs before the
 *    existence check, so non-admins can't enumerate run ids.
 *  - TYPED CONFIRMATION: `confirmName` must equal the run's label EXACTLY —
 *    byte equality, no server-side trimming (whatever normalisation the UI
 *    applies is the UI's business; the server compares what arrives). The
 *    check runs on resume too: the run doc survives until the cascade's
 *    final batch, so the label is still there to hold the admin to.
 *    An UNLABELLED run is refused outright, before the comparison: a
 *    confirmation of "" against "" is a ritual that passes by typing
 *    nothing, which is not a confirmation at all.
 *  - BLOCKERS → 409 with the human sentences from the manifest. The engine
 *    evaluates them (fresh destroys only — a resume must never re-block, or
 *    an interrupted cascade wedges forever).
 *  - ONE PASS AT A TIME → 409: a second invocation arriving while another
 *    holds the audit row's lease is refused rather than allowed to
 *    double-count the same pages into the same totals.
 *
 * RESPONSE CONTRACT: `{ ok, deleted, complete, auditId }`. `deleted` is the
 * audit row's ACCUMULATED totals for this destroy, not just this
 * invocation's page — the client renders it as the running total and a
 * resume may be running in a tab that knows nothing about earlier passes.
 * `complete: false` means the page budget ran out — the client repeats the
 * SAME call (same confirmName) until `complete: true`. The run stays
 * unreachable throughout: the engine's opening transaction set `archived` +
 * `destroying` before anything died, and every discovery surface (catalogue,
 * apply, /me live sections, the learning-space gate) reads them.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  // An unnamed thing cannot be confirmed by name. With an empty label the
  // byte-equality check below reduces to "" === "", so the typed
  // confirmation — the last gate in front of an irreversible cascade — would
  // pass on an empty request body. Refused as a state to fix, not a
  // permission problem, which is why it reads as a 409 and names the fix.
  if (run.label.length === 0) {
    return NextResponse.json(
      {
        error:
          "This run has no label, so there is nothing to type as confirmation — give it one under Run details before destroying it.",
      },
      { status: 409 },
    );
  }

  // Byte equality — `!==` on the raw strings, nothing normalised away.
  if (body.confirmName !== run.label) {
    return NextResponse.json(
      { error: "That doesn't match the run's label. Type it exactly to confirm." },
      { status: 400 },
    );
  }

  try {
    const result = await destroyRunCascade(db, getAdminStorage() ?? null, runId, {
      actorUid: actor.uid,
      // Display name only — the audit row is PII-light on purpose (the
      // admissions routes' displayName convention: never an email).
      actorName: actor.displayName?.trim() || "NAISI admin",
    });
    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      complete: result.complete,
      auditId: result.auditId,
    });
  } catch (err) {
    if (err instanceof DestroyBlockedError) {
      return NextResponse.json(
        { error: err.blockers[0], blockers: err.blockers },
        { status: 409 },
      );
    }
    if (err instanceof DestroyPassInFlightError) {
      // Not a failure: a pass IS running. 409 with the sentence intact, so
      // the dialog offers Resume rather than reporting a broken destroy.
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // A mid-cascade failure left the marker + open audit row in place — the
    // same call resumes. Log the real error; the client gets the retry cue.
    console.error("[destroy-run] cascade failed (resumable):", runId, err);
    return NextResponse.json(
      { error: "The destroy was interrupted. Run it again to resume." },
      { status: 500 },
    );
  }
}
