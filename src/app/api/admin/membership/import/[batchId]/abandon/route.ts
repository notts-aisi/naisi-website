import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIP_IMPORTS_COLLECTION,
  normalizeMembershipImport,
} from "@/lib/firestore/membershipImports";

/**
 * Close an import an admin is not going to finish.
 *
 * ## What it does not do
 *
 * IT DELETES NOTHING. The rows stay, and so does the batch: they are the
 * record of what the file said, who it matched and who vouched for a name, and
 * every membership an earlier chunk committed still points at this batch as
 * its provenance. Abandoning is a LABEL, not a rollback. Memberships already
 * written stay written, because taking somebody's membership away is a
 * separate decision made from the table, one person at a time.
 *
 * ## What it is for
 *
 * Two states leave an admin stuck. A dry run that was never committed sits in
 * the resume list forever, and a run that died between writing the batch and
 * writing its rows sits there in `writing`, uncommittable by design. Both need
 * a way to say "I am not going back to this one" that clears the list without
 * touching the record.
 *
 * A batch already `committed` is refused: it is finished, and relabelling a
 * finished import as abandoned would make the receipt lie about work that
 * really happened.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function POST(
  _req: Request,
  ctx: RouteContext<"/api/admin/membership/import/[batchId]/abandon">,
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canManageMembership(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { batchId } = await ctx.params;

  try {
    const ref = db.collection(MEMBERSHIP_IMPORTS_COLLECTION).doc(batchId);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "No such import" }, { status: 404 });
    }
    const batch = normalizeMembershipImport(snap.id, snap.data() ?? {});

    if (batch.status === "committed") {
      return NextResponse.json(
        { error: "That import finished. There is nothing to abandon." },
        { status: 409 },
      );
    }
    // Already abandoned: say so and stop, rather than restamping who did it.
    if (batch.status === "abandoned") {
      return NextResponse.json({ batchId, status: "abandoned" });
    }

    await ref.update({
      status: "abandoned",
      abandonedAt: FieldValue.serverTimestamp(),
      abandonedByUid: user.uid,
      abandonedByName: user.displayName ?? "",
    });

    return NextResponse.json({ batchId, status: "abandoned" });
  } catch (err) {
    console.error("[membership/abandon] failed:", batchId, err);
    return NextResponse.json(
      { error: "That import could not be abandoned." },
      { status: 500 },
    );
  }
}
