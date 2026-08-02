import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getSessionUid } from "@/lib/firebase/session";
import { stampVerifiedUniEmailForUser } from "@/lib/firestore/uniEmailOwnership";

/**
 * Stamp the signed-in user's `profile.uniEmailVerifiedAt` from the server-side
 * proof of verification (the `emailVerifications` record), if one exists.
 *
 * Called by `completeRegistration` right after the user doc is created: during
 * the verify-first register flow the user may have clicked their uni-email magic
 * link BEFORE the user doc existed, so `confirmUniEmailVerification` couldn't
 * stamp the doc then. This closes that gap SERVER-SIDE, so the client no longer
 * has to (and can no longer) write the trusted flag itself.
 *
 * Authenticated as the user themselves and only ever acts on the caller's own
 * uid; the stamp value comes from server-only data, so there's no oracle and
 * nothing the client can forge. Idempotent — safe to call repeatedly.
 */
export async function POST() {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    const { stamped } = await stampVerifiedUniEmailForUser(db, session.uid);
    return NextResponse.json({ ok: true, stamped });
  } catch (err) {
    console.error("[/api/verify-email/reconcile] stamp failed", err);
    return NextResponse.json({ error: "Reconcile failed" }, { status: 500 });
  }
}
