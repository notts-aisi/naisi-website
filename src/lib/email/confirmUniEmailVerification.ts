import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { verifyToken } from "@/lib/signedTokens";

export type ConfirmUniEmailResult =
  | { ok: true; email: string }
  | { ok: false; error: string; status: number };

/**
 * Shared confirmation logic for the uni-email magic link. Called both by the
 * `/api/verify-email/confirm` route (client-side POST path, used by other
 * consumers) and directly from the `/verify-email/[tokenId]` server component
 * (no internal HTTP roundtrip — dodges the Cloud Run revision-URL auth
 * gotcha where the page's `host` header is the internal revision hostname,
 * not the public one, and internal URLs require IAM auth we don't have).
 */
export async function confirmUniEmailVerification(
  db: Firestore,
  signed: string | undefined | null,
): Promise<ConfirmUniEmailResult> {
  if (!signed) {
    return { ok: false, error: "Missing token", status: 400 };
  }

  const payload = verifyToken(signed, "verify-uni-email");
  if (!payload || payload.s !== "verify-uni-email") {
    return { ok: false, error: "Invalid or expired link", status: 400 };
  }

  const ref = db.collection("emailVerifications").doc(payload.v);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn("[confirmUniEmail] Firestore doc missing", { tokenId: payload.v });
    return { ok: false, error: "Verification request not found", status: 404 };
  }

  const data = snap.data()!;
  const expiresAt = data.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    console.warn("[confirmUniEmail] Firestore doc expiresAt in past", {
      tokenId: payload.v,
      expiresAt: expiresAt.toDate().toISOString(),
      now: new Date().toISOString(),
    });
    return { ok: false, error: "Link has expired", status: 410 };
  }

  if (!data.verifiedAt) {
    await ref.update({ verifiedAt: Timestamp.now() });
  }

  console.log("[confirmUniEmail] verified", { tokenId: payload.v, email: data.email });
  return { ok: true, email: (data.email as string) ?? "" };
}
