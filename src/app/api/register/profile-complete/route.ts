import { NextResponse } from "next/server";
import { getSessionUid } from "@/lib/firebase/session";
import { markRegistrationProfileComplete } from "@/lib/firestore/registrationWrites";

/**
 * Flip the signed-in user's signup-tracker row to "profile complete" once their
 * members/{uid} profile has been written. The registrations collection is
 * Admin-SDK-only, so this client-triggered flip has to run server-side.
 *
 * Best-effort by design: completeRegistration has already written the account +
 * profile (the durable state); this only mirrors them onto the admin tracker so a
 * finished Google signup stops showing as an orphan. Only ever touches the
 * caller's own uid — no oracle, can't affect anyone else.
 */
export async function POST() {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  await markRegistrationProfileComplete(session.uid);
  return NextResponse.json({ ok: true });
}
