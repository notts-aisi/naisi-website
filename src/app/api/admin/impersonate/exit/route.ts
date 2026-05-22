import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { clearSessionCookieOnly } from "@/lib/firebase/session";
import {
  clearImpersonatorCookie,
  getImpersonator,
} from "@/lib/firebase/impersonation";

/**
 * End the current admin "view as" session.
 *
 * Closes the `impersonations/{id}` audit doc (only if its actorUid matches
 * the cookie's marker and endedAt is still null — a stale/forged cookie
 * can't overwrite somebody else's audit record). Clears both the
 * impersonator marker and the borrowed target session cookie on this
 * device, WITHOUT revoking the target's refresh tokens (they may have
 * real sessions on their own devices — those must keep working).
 *
 * The admin's Firebase Auth client state was overwritten by
 * signInWithCustomToken when impersonation started, so on the client they
 * sign out of Firebase Auth and redirect to /login to re-authenticate as
 * themselves. There is no way to "restore" the previous client SDK session.
 */
export async function POST() {
  const marker = await getImpersonator();
  if (!marker) {
    // Idempotent-ish: if there's no marker, also clear any stray session
    // cookie so a half-broken state on the client still resets cleanly.
    await clearSessionCookieOnly();
    return NextResponse.json(
      { error: "Not in a view-as session." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  if (db) {
    try {
      const ref = db.collection("impersonations").doc(marker.auditId);
      const snap = await ref.get();
      if (snap.exists) {
        const data = snap.data() ?? {};
        // Trust-but-verify: only close the doc if its actor matches and it
        // is still open. Stops a tampered cookie from closing an unrelated
        // record or double-closing one that's already ended.
        if (data.actorUid === marker.actorUid && data.endedAt === null) {
          await ref.update({ endedAt: FieldValue.serverTimestamp() });
        }
      }
    } catch (err) {
      console.error("[/api/admin/impersonate/exit] audit close failed:", err);
      // Press on — clearing the cookies matters more than perfect audit on
      // an exotic edge case. The audit doc still records the start.
    }
  }

  await clearImpersonatorCookie();
  await clearSessionCookieOnly();
  return NextResponse.json({ ok: true });
}
