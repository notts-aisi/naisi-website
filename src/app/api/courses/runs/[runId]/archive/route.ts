import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * Soft-archive a run — the EVERYDAY half of the deletion protocol (destroy
 * is the other, and it is a different route with a different bar).
 *
 * `archived` is a boolean on the run doc, orthogonal to `status` and
 * mirroring `courseGroups.archived` (see CourseRunDoc for why it is not a
 * status member). Archived runs drop out of the admin default list, the
 * public catalogue, /me live sections and application windows; member
 * history keeps reading — nothing is deleted, and un-archiving is one call.
 *
 * Gated to admins + approveCourse holders — the status route's bar, because
 * archiving changes what the world sees exactly like a status move does.
 *
 * A run mid-DESTROY refuses both directions with 409: un-archiving it would
 * re-surface a half-deleted cohort, and re-archiving is meaningless — the
 * destroy transaction already set the flag and owns it until the run doc is
 * gone.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId } = await ctx.params;

  // Authorization before the existence check.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveCourse)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { archived?: unknown };
  try {
    body = (await req.json()) as { archived?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.archived !== "boolean") {
    return NextResponse.json({ error: "archived must be a boolean" }, { status: 400 });
  }

  const ref = db.collection("courseRuns").doc(runId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const raw = snap.data() ?? {};

  if (raw.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and can't be archived or un-archived." },
      { status: 409 },
    );
  }

  // Idempotent: re-sending the state the run already has is a no-op, not an
  // error (the status route's double-click convention).
  if ((raw.archived === true) === body.archived) {
    return NextResponse.json({ ok: true, archived: body.archived });
  }

  await ref.update({
    archived: body.archived,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, archived: body.archived });
}
