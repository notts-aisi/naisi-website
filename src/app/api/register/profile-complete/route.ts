import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getSessionUid } from "@/lib/firebase/session";
import { hasProfile } from "@/lib/firestore/registrationProfiles";
import { markRegistrationProfileComplete } from "@/lib/firestore/registrationWrites";

/**
 * Flip the signed-in user's signup-tracker row to "profile complete" once their
 * users/{uid} profile has been written. The registrations collection is
 * Admin-SDK-only, so this client-triggered flip has to run server-side.
 *
 * THE BROWSER SAYS A PROFILE EXISTS; THIS ROUTE LOOKS. The flag it sets is what
 * the admin tracker's counts call a finished registration, so it is set only
 * when the document is really there. A call that arrives with no profile
 * behind it (a stale tab, a request replayed by hand) changes nothing and gets
 * the same answer, so the response says nothing about the caller's state that
 * the caller does not already know.
 *
 * Best-effort by design: completeRegistration has already written the account +
 * profile (the durable state); this only mirrors them onto the admin tracker so a
 * finished signup stops showing as unfinished. Only ever touches the caller's
 * own uid — no oracle, can't affect anyone else.
 */
export async function POST() {
  // Never inside a view-as session: this flips the session account's own
  // registration-tracker row, and during view-as that is the target member's
  // row, written as them. Refused at the top, in step with the sibling
  // register/account routes.
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const db = getAdminDb();
  if (db) {
    let profiled = false;
    try {
      profiled = await hasProfile(db, session.uid);
    } catch (err) {
      // A failed lookup leaves the row as it is: unfinished is the safe thing
      // for the tracker to go on saying.
      console.error("[/api/register/profile-complete] profile lookup failed", err);
    }
    if (profiled) await markRegistrationProfileComplete(session.uid);
  }
  return NextResponse.json({ ok: true });
}
