import { NextResponse } from "next/server";
import { getSessionUid } from "@/lib/firebase/session";
import { markRegistrationPasswordSet } from "@/lib/firestore/registrationWrites";

/**
 * Flip the signup-tracker row to "completed" once the user sets their real
 * password (called by LoginEmailVerified right after `updatePassword`).
 *
 * Authenticated as the user themselves via the session cookie, and it only ever
 * marks the CALLER'S OWN registration row — so it's neither an oracle nor a way
 * to touch anyone else's record. Best-effort: the password is already set
 * client-side by this point, so this only updates the admin console; it returns
 * ok even when there's no row (e.g. an account that predates the tracker).
 */
export async function POST() {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  await markRegistrationPasswordSet(session.uid);
  return NextResponse.json({ ok: true });
}
