import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Ctx = RouteContext<"/api/admin/users/[uid]">;

/**
 * Hard-delete a user: removes the Firestore user doc AND their Firebase Auth account.
 * Admin-only. If the Auth account is already gone, we still remove the doc.
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
      { error: "You can't delete yourself. Ask another admin." },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    await db.collection("users").doc(uid).delete();
  } catch (err) {
    console.error("[admin delete] Firestore delete failed:", err);
    return NextResponse.json({ error: "Failed to delete user record" }, { status: 500 });
  }

  try {
    await auth.deleteUser(uid);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== "auth/user-not-found") {
      console.error("[admin delete] Auth delete failed:", err);
      // Firestore doc is already gone; report partial success.
      return NextResponse.json(
        { ok: true, warning: "User doc deleted but Auth account could not be removed." },
        { status: 207 },
      );
    }
  }

  return NextResponse.json({ ok: true });
}
