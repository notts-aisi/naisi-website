import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyToken } from "@/lib/signedTokens";

/**
 * Confirms a uni-email verification by setting `verifiedAt` on the backing
 * `emailVerifications/{tokenId}` doc. Called by the magic-link landing page
 * (`/verify-email/[tokenId]`) after it pulls the signed `?t=` param.
 *
 * Idempotent: verifying a token that's already verified returns OK.
 */
export async function POST(req: Request) {
  const { signed } = (await req.json().catch(() => ({}))) as { signed?: string };
  if (!signed) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const payload = verifyToken(signed, "verify-uni-email");
  if (!payload || payload.s !== "verify-uni-email") {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("emailVerifications").doc(payload.v);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Verification request not found" }, { status: 404 });
  }

  const data = snap.data()!;
  const expiresAt = data.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    return NextResponse.json({ error: "Link has expired" }, { status: 410 });
  }

  if (!data.verifiedAt) {
    await ref.update({ verifiedAt: Timestamp.now() });
  }

  return NextResponse.json({ ok: true, email: data.email });
}
