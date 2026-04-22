import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Ctx = RouteContext<"/api/admin/deliverability/suppressed/[docId]">;

/**
 * Admin-only: remove an address from the suppression list (un-suppress). Used
 * for recovering false-positive bounces or addresses that asked to opt back
 * in after complaining. Re-suppression is automatic on the next bounce.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { docId } = await ctx.params;
  if (!docId) {
    return NextResponse.json({ error: "Missing docId" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  await db.collection("suppressedEmails").doc(docId).delete();
  return NextResponse.json({ ok: true });
}
