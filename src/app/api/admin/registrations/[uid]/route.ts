import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { deleteAccountCascade } from "@/lib/firestore/accountDeletion";

type Ctx = { params: Promise<{ uid: string }> };

/**
 * Admin: delete a registered account straight from the registrations tracker
 * (keyed by uid) via the shared account cascade. Same teardown as the Members
 * delete — used for the orphan / unfinished accounts the tracker surfaces.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { uid } = await ctx.params;
  if (!uid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }
  if (uid === actor.uid) {
    return NextResponse.json(
      { error: "You can't delete your own account here." },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    const summary = await deleteAccountCascade(auth, db, uid);
    return NextResponse.json(
      { ok: true, ...summary },
      summary.warning ? { status: 207 } : undefined,
    );
  } catch (err) {
    console.error("[admin registrations delete] cascade failed:", uid, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 },
    );
  }
}
