import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendCollaboratorEmail } from "@/lib/email/collaboratorEmails";

// Explicit Promise params (Next 16) rather than the generated RouteContext
// helper, so this typechecks independent of typegen state.
type Ctx = { params: Promise<{ id: string }> };

const REASON_MAX = 2000;

/**
 * Admin actions on a single collaborator application (admin-gated, Admin SDK).
 *  POST   — { action: "approve" | "reject", reason? }: set status + lifecycle email
 *  DELETE — remove the application doc AND the Firebase Auth account (mirrors
 *           the admin user-delete route).
 * `id` is the collaborators doc id ("<name-slug>__<uid>").
 */
export async function POST(req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  let body: { action?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, REASON_MAX) : undefined;

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  const ref = db.collection("collaborators").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const data = snap.data() ?? {};

  if (action === "approve") {
    await ref.update({
      status: "approved",
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: actor.uid,
      rejectedAt: FieldValue.delete(),
      rejectedBy: FieldValue.delete(),
      rejectionReason: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else {
    await ref.update({
      status: "rejected",
      rejectedAt: FieldValue.serverTimestamp(),
      rejectedBy: actor.uid,
      rejectionReason: reason ?? FieldValue.delete(),
      approvedAt: FieldValue.delete(),
      approvedBy: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const to = (data.email as string | null | undefined) ?? null;
  if (to) {
    try {
      await sendCollaboratorEmail({
        kind: action === "approve" ? "approved" : "rejected",
        to,
        name: (data.fullName as string) ?? "",
        uid: (data.uid as string) ?? "",
        actorUid: actor.uid,
        rejectionReason: action === "reject" ? reason : undefined,
      });
    } catch (e) {
      console.error("[collaborators decision] email failed", e);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  const auth = getAdminAuth();
  if (!db || !auth) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("collaborators").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const uid = (snap.data()?.uid as string | undefined) ?? "";

  await ref.delete();

  if (uid) {
    try {
      await auth.deleteUser(uid);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "auth/user-not-found") {
        console.error("[collaborators delete] Auth delete failed:", err);
        return NextResponse.json(
          {
            ok: true,
            warning:
              "Application deleted but the Auth account could not be removed.",
          },
          { status: 207 },
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}
