import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
// The in-flight error belongs to the shared audit module, because the claim it
// reports is a field on the audit row rather than anything a cascade owns. One
// class, so one `instanceof` branch works in every destroy route.
import { DestroyPassInFlightError } from "@/lib/firestore/destroyAudit";
import { isAddressableId, loadCirculation } from "@/lib/worksheets/access";
import { DestroyBlockedError, destroyCirculationCascade } from "@/lib/worksheets/destroy";

/**
 * DESTROY a circulation. The engine (`src/lib/worksheets/destroy.ts`) owns the
 * cascade, its ordering, the audit row and resumability; this route owns WHO
 * and WHETHER, and it mirrors `POST /api/courses/runs/[runId]/destroy` line
 * for line because a second destroy protocol with different habits would be a
 * second thing to learn before anybody could trust it:
 *
 *  - ADMIN ONLY, never the sender. That is the owner's decision of 7 September
 *    2026, and it is not a matter of who owns the circulation: what dies is
 *    other people's answers. Authorisation runs BEFORE the existence check, so
 *    a non-admin learns nothing about which circulation ids exist.
 *  - TYPED CONFIRMATION: `confirmName` must equal the circulation's title
 *    EXACTLY, byte for byte, with no server-side trimming (whatever
 *    normalisation the UI applies is the UI's business; the server compares
 *    what arrives). The check runs on a resume too, because the circulation
 *    document survives until the cascade's last write, so the title is still
 *    there to hold the admin to. An UNTITLED circulation is refused outright,
 *    before the comparison: confirming "" against "" is a ritual that passes
 *    by typing nothing, which is not a confirmation at all.
 *  - BLOCKERS to 409 with the sentences intact. Nothing about the circulation
 *    itself refuses a destroy (see `circulationDestroyBlockers`); what does is
 *    a Storage folder that would not list, because the manifest cannot then say
 *    how many of somebody's uploaded answers are about to go. The engine
 *    re-checks that on every FRESH pass, so a request made without reading the
 *    manifest is refused here rather than proceeding, and a resume is never
 *    re-blocked.
 *  - ONE PASS AT A TIME to 409: a second invocation arriving while another
 *    holds the claim is refused rather than allowed to count the same pages
 *    into the same totals twice.
 *
 * RESPONSE CONTRACT: `{ ok, deleted, complete, auditId }`. `deleted` is the
 * audit row's ACCUMULATED totals for this destroy, not just this invocation's
 * page, because the client renders it as the running total and a resume may be
 * running in a tab that knows nothing about earlier passes. `complete: false`
 * means the page budget ran out and the client repeats the SAME call (same
 * `confirmName`) until `complete: true`. The circulation is unreachable
 * throughout: the engine's opening write set `destroying` and `closed` before
 * anything died, and both the respond page and the circulation page read them.
 *
 * NO EMAIL IS SENT. Nobody is told their answers have been destroyed, by the
 * owner's decision that no destroy sends mail. An admin who needs the
 * recipients to know tells them.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
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

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  // An unnamed thing cannot be confirmed by name. Refused as a state to fix
  // rather than as a permission problem, which is why it reads as a 409 and
  // names the fix.
  if (circulation.title.length === 0) {
    return NextResponse.json(
      {
        error:
          "This circulation has no title, so there is nothing to type as confirmation. Give it one under Settings before destroying it.",
      },
      { status: 409 },
    );
  }

  // Byte equality on the raw strings, nothing normalised away.
  if (body.confirmName !== circulation.title) {
    return NextResponse.json(
      { error: "That doesn't match the circulation's title. Type it exactly to confirm." },
      { status: 400 },
    );
  }

  try {
    const result = await destroyCirculationCascade(
      db,
      getAdminStorage() ?? null,
      circulation,
      {
        actorUid: actor.uid,
        // Display name only: the audit row is PII-light on purpose.
        actorName: actor.displayName?.trim() || "NAISI admin",
      },
    );
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
      // Not a failure: a pass IS running. 409 with the sentence intact, so the
      // dialog offers Resume rather than reporting a broken destroy.
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // A mid-cascade failure left the marker and the open audit row in place, so
    // the same call resumes. Log the real error; the client gets the retry cue.
    console.error("[destroy-circulation] cascade failed (resumable):", circulationId, err);
    return NextResponse.json(
      { error: "The destroy was interrupted. Run it again to resume." },
      { status: 500 },
    );
  }
}
