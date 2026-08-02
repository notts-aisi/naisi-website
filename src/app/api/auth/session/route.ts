import { NextResponse, type NextRequest } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  createSessionCookie,
  revokeAndClearSession,
  type Role,
} from "@/lib/firebase/session";
import { recordGoogleRegistrationCreated } from "@/lib/firestore/registrationWrites";

export async function POST(request: NextRequest) {
  try {
    const { idToken } = await request.json();
    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // Look up the user doc BEFORE minting so the cookie lifetime can be
    // sized to the role. Also doubles as the server-side existence check
    // that exchangeGoogleCredential relies on for the new-vs-existing-user
    // routing decision (client-side Firestore reads race the auth-token
    // attachment).
    //
    // `kind` lets the email-auth callers route without a second round trip:
    // member = has a users doc, collaborator = has a collaborators doc, new =
    // neither (a fresh sign-up that still needs to register / apply). The
    // collaborators doc id is name-slugged, so we probe by the `uid` field.
    let exists = false;
    let role: Role | undefined;
    let kind: "member" | "collaborator" | "new" = "new";
    const auth = getAdminAuth();
    const db = getAdminDb();
    if (auth && db) {
      try {
        const decoded = await auth.verifyIdToken(idToken);
        const doc = await db.collection("users").doc(decoded.uid).get();
        exists = doc.exists;
        if (exists) {
          role = (doc.data()?.role as Role | undefined) ?? "pending";
          kind = "member";
        } else {
          const collab = await db
            .collection("collaborators")
            .where("uid", "==", decoded.uid)
            .limit(1)
            .get();
          if (!collab.empty) kind = "collaborator";
        }

        // Mirror a brand-new Google sign-in into the signup tracker so Google
        // orphans (authenticated but no profile yet) show up alongside email
        // ones. Only for genuinely new accounts — returning members/collaborators
        // are skipped (kind !== "new"), so createdAt is written once. Best-effort
        // (the helper swallows its own errors); never blocks session minting.
        if (kind === "new" && decoded.firebase?.sign_in_provider === "google.com") {
          await recordGoogleRegistrationCreated({
            uid: decoded.uid,
            email: decoded.email ?? "",
          });
        }
      } catch (e) {
        console.error("[/api/auth/session] user lookup failed:", e);
      }
    }

    await createSessionCookie(idToken, role);
    return NextResponse.json({ ok: true, exists, kind });
  } catch (err) {
    console.error("[/api/auth/session] failed:", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}

export async function DELETE() {
  await revokeAndClearSession();
  return NextResponse.json({ ok: true });
}
