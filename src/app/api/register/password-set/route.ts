import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getSessionUid } from "@/lib/firebase/session";
import { markRegistrationPasswordSet } from "@/lib/firestore/registrationWrites";

const MIN_PASSWORD_LENGTH = 6;

/**
 * Set the signed-in user's REAL password and mark their registration "completed"
 * — SERVER-SIDE and atomically. The verify-first register flow creates the
 * account with a server-random throwaway password; this is where the user
 * replaces it (after proving inbox ownership via the magic link).
 *
 * Doing the password set on the server (Admin SDK updateUser) rather than a
 * client `updatePassword` + a separate best-effort flip is what makes the tracker
 * reliable: the credential and the `passwordSet` flag are written in the SAME
 * request, so the "completed" status can't be lost to navigation, a dropped
 * fetch, or a closed tab — the bug that stranded finished accounts at
 * "verified-no-password". Authenticated as the user themselves; only ever acts on
 * the caller's own uid (no oracle, can't touch anyone else).
 */
export async function POST(req: Request) {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  if (!auth) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    await auth.updateUser(session.uid, { password });
  } catch (err) {
    console.error("[/api/register/password-set] updateUser failed", err);
    return NextResponse.json(
      { error: "Couldn't save your password. Please try again." },
      { status: 500 },
    );
  }

  // Flip the tracker to "completed". Same request as the password set, so it
  // can't be lost client-side; best-effort (the password — the durable part — is
  // already saved, and the row update on an existing doc won't realistically fail).
  await markRegistrationPasswordSet(session.uid);

  return NextResponse.json({ ok: true });
}
