import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendEmail } from "@/lib/email/send";
import { signToken } from "@/lib/signedTokens";
import VerifyLoginEmail from "@/emails/VerifyLoginEmail";
import { recordRegistrationResend } from "@/lib/firestore/registrationWrites";
import { rateLimit, clientIp } from "@/lib/rateLimit";

const COOLDOWN_SECONDS = 60;
/** Mirrors TOKEN_TTL_SECONDS in ../route.ts, whose comment says why it is ten. */
const TOKEN_TTL_SECONDS = 60 * 10;

// Abuse throttle (see lib/rateLimit). Generous per-IP for shared campus NAT.
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_IP_MAX = 30;
const RL_EMAIL_MAX = 5;

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

  // Throttle silently — return the same uniform OK (so nothing leaks) while
  // skipping the Firestore read + email send for floods.
  const ip = clientIp(req);
  if (!rateLimit(`resend:ip:${ip}`, RL_IP_MAX, RL_WINDOW_MS).ok) return uniform;
  if (!rateLimit(`resend:email:${email}`, RL_EMAIL_MAX, RL_WINDOW_MS).ok) return uniform;

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

    // An EXPIRED token is the ordinary reason somebody presses this button, so
    // it must not be a reason to refuse: the expired-link page sends the reader
    // straight here ("head back to your registration tab and click Resend"),
    // and at a ten-minute life that page is where most slow readers land. The
    // send below revives the document the way the register route's own resend
    // branch already does; what is never revivable is a REDEEMED token, and the
    // `verifiedAt == null` filter on the query above is what excludes those.
    const lastSent = data.lastSentAt as Timestamp | undefined;
    const elapsed = lastSent ? (now.toMillis() - lastSent.toMillis()) / 1000 : Infinity;
    if (elapsed < COOLDOWN_SECONDS) return uniform; // still cooling down → don't spam

    // The document's own expiry moves with the send, the way the register
    // route's resend branch already moves it. Without this the fresh link
    // inherits the original window while its copy promises a full one, so a
    // resend near the end of that window hands the reader a link that dies
    // minutes after it says it will.
    await doc.ref.update({
      lastSentAt: now,
      sendCount: FieldValue.increment(1),
      expiresAt: Timestamp.fromMillis(now.toMillis() + TOKEN_TTL_SECONDS * 1000),
    });

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

    // Mirror the resend onto the registrations tracker row so its sendCount /
    // lastSentAt match real volume (the inline /api/register resend path does the
    // same). No-ops when there's no tracker row (pre-tracker accounts).
    const trackedUid = data.uid as string | undefined;
    if (trackedUid) await recordRegistrationResend(trackedUid);
  } catch (err) {
    console.error("[/api/register/resend] failed", err);
  }

  return uniform;
}
