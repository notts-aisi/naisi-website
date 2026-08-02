import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { clearSessionCookieOnly, getSessionUid } from "@/lib/firebase/session";
import { deleteAccountCascade } from "@/lib/firestore/accountDeletion";

/**
 * Self-service deletion of the SIGNED-IN user's OWN account — scoped to
 * UNFINISHED registrations: someone who registered and set a password but never
 * submitted a profile (no users doc) or application (no collaborators doc). This
 * is the "registered but don't want to finish" exit.
 *
 * Finished members/collaborators are refused (409): their content cascade isn't
 * built, and account deletion for them is handled separately (admin / a future
 * full-erasure flow). The unfinished-only scope is enforced HERE server-side —
 * the button is only shown to unfinished accounts, but the client is never
 * trusted. Cascade matches the admin delete.
 */
export async function POST() {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const uid = session.uid;

  // Enforce the unfinished-only scope: no users doc AND no collaborators doc.
  const [userSnap, collabSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("collaborators").where("uid", "==", uid).limit(1).get(),
  ]);
  if (userSnap.exists || !collabSnap.empty) {
    return NextResponse.json(
      {
        error:
          "This account has a submitted profile or application, so it can't be self-deleted here. Please contact us to remove it.",
      },
      { status: 409 },
    );
  }

  try {
    const summary = await deleteAccountCascade(auth, db, uid);
    // The account is gone — drop the (now-orphaned) session cookie on this device.
    await clearSessionCookieOnly();
    return NextResponse.json(
      { ok: true, ...summary },
      summary.warning ? { status: 207 } : undefined,
    );
  } catch (err) {
    console.error("[account delete] cascade failed:", uid, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 },
    );
  }
}
