import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail } from "@/lib/email/send";
import { signToken } from "@/lib/signedTokens";
import VerifyLoginEmail from "@/emails/VerifyLoginEmail";

const COOLDOWN_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 30;

type Body = { email?: string };

/**
 * Resend the registration verification email. Enumeration-safe and abuse-gated:
 * it only ever sends to a genuine UNVERIFIED login-email registration, and only
 * after the 60s cooldown — and it returns the SAME response whether or not
 * anything was sent. So it's neither an oracle (the response never reveals
 * whether the email is registered) nor an open relay (it can't email an address
 * that isn't a pending registration). The client drives its own 60s progress bar
 * off `cooldownSeconds`; the server is the real gate.
 *
 * No reCAPTCHA here (the register route carries the v2 invisible check): the
 * cooldown + pending-registration-only constraint already bound abuse, and a
 * second widget on the check-inbox screen isn't worth the wiring.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const db = getAdminDb();
  // Uniform OK regardless — even a bad email / failed reCAPTCHA / unconfigured
  // server returns the same shape so nothing is inferable from the response.
  const uniform = NextResponse.json({ ok: true, cooldownSeconds: COOLDOWN_SECONDS });
  if (!email || !db) return uniform;

  try {
    const snap = await db
      .collection("emailVerifications")
      .where("kind", "==", "login-email")
      .where("email", "==", email)
      .where("verifiedAt", "==", null)
      .limit(1)
      .get();
    if (snap.empty) return uniform; // no pending registration → send nothing

    const doc = snap.docs[0];
    const data = doc.data();
    const now = Timestamp.now();

    const expiresAt = data.expiresAt as Timestamp | undefined;
    if (expiresAt && expiresAt.toMillis() <= now.toMillis()) return uniform; // expired

    const lastSent = data.lastSentAt as Timestamp | undefined;
    const elapsed = lastSent ? (now.toMillis() - lastSent.toMillis()) / 1000 : Infinity;
    if (elapsed < COOLDOWN_SECONDS) return uniform; // still cooling down → don't spam

    await doc.ref.update({ lastSentAt: now, sendCount: FieldValue.increment(1) });

    const signed = signToken({ s: "verify-login-email", v: doc.id }, TOKEN_TTL_SECONDS);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const verifyUrl = `${appUrl}/verify-email/${doc.id}?t=${encodeURIComponent(signed)}`;
    await sendEmail({
      to: email,
      subject: "Confirm your email to finish joining NAISI",
      react: VerifyLoginEmail({
        verifyUrl,
        expiresInMinutes: Math.floor(TOKEN_TTL_SECONDS / 60),
      }),
      kind: "unknown",
      actorUid: (data.uid as string | undefined) ?? undefined,
      referenceId: doc.id,
    });
  } catch (err) {
    console.error("[/api/register/resend] failed", err);
  }

  return uniform;
}
