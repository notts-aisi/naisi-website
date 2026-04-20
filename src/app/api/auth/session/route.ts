import { NextResponse, type NextRequest } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { clearSessionCookie, createSessionCookie } from "@/lib/firebase/session";

export async function POST(request: NextRequest) {
  try {
    const { idToken } = await request.json();
    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }
    await createSessionCookie(idToken);

    // Check doc existence server-side with Admin SDK — avoids the client-side
    // race where Firestore reads sometimes fire before the auth state is fully
    // propagated and return stale/missing data.
    const auth = getAdminAuth();
    const db = getAdminDb();
    let exists = false;
    if (auth && db) {
      try {
        const decoded = await auth.verifyIdToken(idToken);
        const doc = await db.collection("users").doc(decoded.uid).get();
        exists = doc.exists;
      } catch (e) {
        console.error("[/api/auth/session] doc existence check failed:", e);
      }
    }

    return NextResponse.json({ ok: true, exists });
  } catch (err) {
    console.error("[/api/auth/session] failed:", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}

export async function DELETE() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
