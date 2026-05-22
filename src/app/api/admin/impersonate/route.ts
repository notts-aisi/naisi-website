import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  clearImpersonatorCookie,
  getImpersonator,
  setImpersonatorCookie,
} from "@/lib/firebase/impersonation";

/**
 * Start an admin "view as" impersonation session (full impersonation: the
 * admin's session cookie is replaced with the target's, so request.auth
 * becomes the target everywhere — Firestore rules included).
 *
 * Server flow:
 *   1. Verify the caller is currently a real admin (no nested impersonation).
 *   2. Refuse self / admin / pending / rejected targets.
 *   3. Write an `impersonations/{id}` audit doc FIRST (so a mint failure can't
 *      leave an untracked session in flight; we close it with failed:true on
 *      error below).
 *   4. Mint a Firebase custom token for the target via the Admin SDK.
 *   5. Set the __impersonator marker cookie holding actor identity + audit id.
 *
 * Client flow (see src/auth/impersonation.ts):
 *   - signInWithCustomToken(target) → getIdToken → POST /api/auth/session
 *     to swap __session to the target's, then full-page navigate.
 *
 * Exit is at /api/admin/impersonate/exit.
 */
export async function POST(request: NextRequest) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Block nested impersonation. getCurrentUser() above already returns the
  // target's identity once impersonation is active, so this branch is the
  // belt-and-braces match — the role check above would also fail unless the
  // target happened to also be an admin (which we refuse below regardless).
  //
  // Self-heal stale markers: if a previous start half-failed (cookie set,
  // session swap didn't land) the marker survives but its actorUid matches
  // the live admin's uid. In that case treat it as junk, clear it, and
  // let the new start proceed.
  const existingMarker = await getImpersonator();
  if (existingMarker) {
    if (existingMarker.actorUid === actor.uid) {
      await clearImpersonatorCookie();
    } else {
      return NextResponse.json(
        { error: "Already in a view-as session. Exit it first." },
        { status: 409 },
      );
    }
  }

  let body: { uid?: unknown };
  try {
    body = (await request.json()) as { uid?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const targetUid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!targetUid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }
  if (targetUid === actor.uid) {
    return NextResponse.json({ error: "Can't view as yourself." }, { status: 400 });
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const targetSnap = await db.collection("users").doc(targetUid).get();
  if (!targetSnap.exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const targetData = targetSnap.data() ?? {};
  const targetRole = (targetData.role as string | undefined) ?? "pending";
  if (targetRole === "admin") {
    return NextResponse.json(
      { error: "Can't view as another admin." },
      { status: 400 },
    );
  }
  if (targetRole === "pending" || targetRole === "rejected") {
    return NextResponse.json(
      { error: `Can't view as a ${targetRole} user.` },
      { status: 400 },
    );
  }

  const targetName =
    (targetData.displayName as string | undefined)
    ?? (targetData.profile as { preferredName?: string } | undefined)?.preferredName
    ?? (targetData.email as string | undefined)
    ?? targetUid;

  // Audit-first: write the start record before minting the token. If the
  // mint or any later step fails, we close the doc with failed:true below
  // so no impersonation is ever in flight without a matching audit entry.
  const auditRef = await db.collection("impersonations").add({
    actorUid: actor.uid,
    actorEmail: actor.email ?? null,
    actorName: actor.displayName ?? actor.email ?? actor.uid,
    targetUid,
    targetEmail: (targetData.email as string | undefined) ?? null,
    targetName,
    targetRole,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
  });

  let customToken: string;
  try {
    customToken = await auth.createCustomToken(targetUid);
  } catch (err) {
    console.error("[/api/admin/impersonate] createCustomToken failed:", err);
    try {
      await auditRef.update({
        endedAt: FieldValue.serverTimestamp(),
        failed: true,
      });
    } catch {
      // Best-effort cleanup; the doc already records actor + target.
    }
    return NextResponse.json(
      { error: "Failed to mint impersonation token" },
      { status: 500 },
    );
  }

  await setImpersonatorCookie({
    actorUid: actor.uid,
    actorName: actor.displayName ?? actor.email ?? "Admin",
    actorEmail: actor.email ?? null,
    auditId: auditRef.id,
  });

  return NextResponse.json({
    ok: true,
    customToken,
    auditId: auditRef.id,
    target: { uid: targetUid, name: targetName, role: targetRole },
  });
}
