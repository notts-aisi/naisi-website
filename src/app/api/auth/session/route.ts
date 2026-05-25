import { NextResponse, type NextRequest } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  createSessionCookie,
  revokeAndClearSession,
  type Role,
} from "@/lib/firebase/session";

export async function POST(request: NextRequest) {
  try {
    const { idToken } = await request.json();
    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // Look up the user doc BEFORE minting so the cookie lifetime can be
    // sized to the role. Also doubles as the server-side existence check
    // that signInWithGoogle / consumeGoogleRedirect rely on for the
    // new-vs-existing-user routing decision (client-side Firestore reads
    // race the auth-token attachment).
    let exists = false;
    let role: Role | undefined;
    const auth = getAdminAuth();
    const db = getAdminDb();
    if (auth && db) {
      try {
        const decoded = await auth.verifyIdToken(idToken);
        const doc = await db.collection("users").doc(decoded.uid).get();
        exists = doc.exists;
        if (exists) {
          role = (doc.data()?.role as Role | undefined) ?? "pending";
        }
      } catch (e) {
        console.error("[/api/auth/session] user lookup failed:", e);
      }
    }

    await createSessionCookie(idToken, role);
    return NextResponse.json({ ok: true, exists });
  } catch (err) {
    console.error("[/api/auth/session] failed:", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}

export async function DELETE() {
  await revokeAndClearSession();
  return NextResponse.json({ ok: true });
}
