import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Server-only transition from "approved" to "published". Firestore rules block
 * clients from writing status == "published" directly (mirrors the newsletter
 * "sent" gate). Gated to approvers + admins.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const allowed = actor.role === "admin" || actor.permissions.approveEvent;
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const current = snap.data() ?? {};
  if (current.status !== "approved") {
    return NextResponse.json(
      { error: `Can only publish from "approved", not "${current.status}"` },
      { status: 400 },
    );
  }

  await ref.update({
    status: "published",
    publishedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
