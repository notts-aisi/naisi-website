import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendEmail } from "@/lib/email/send";
import { randomOpaqueId, signToken } from "@/lib/signedTokens";
import { FIELD_LIMITS } from "@/lib/firestore/users";
import { findVerifiedUniEmailOwner } from "@/lib/firestore/uniEmailOwnership";
import { obfuscateEmail } from "@/lib/obfuscateEmail";
import VerifyUniEmail from "@/emails/VerifyUniEmail";
import AlreadyRegisteredEmail from "@/emails/AlreadyRegisteredEmail";

const COOLDOWN_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes

type Body = {
  email?: string;
  preferredName?: string;
  /** Previous tokenId if the register tab is resending rather than starting fresh. */
  previousTokenId?: string;
};

/**
 * Initiates or resends a uni-email magic-link verification.
 *
 * Design notes:
 * - Requires an authenticated caller (registering users are already Google-signed-in
 *   by this point). Prevents unauthenticated enumeration-via-send-email-flood.
 * - Idempotent: if the same (authUid, email) pair has an active unverified
 *   token, we resend against that token rather than minting a new one, so the
 *   original tab's onSnapshot keeps working.
 * - Rate-limited per-token via `lastSentAt`. The cooldown is enforced here AND
 *   honoured client-side for UX.
 * - Response body is identical shape whether we sent or short-circuited on
 *   cooldown — we return the cooldown remaining so the client knows what to do.
 */
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  // TEMPORARY (revert before re-locking registration): bypass the @nottingham.ac.uk
  // requirement so a demo account can register. Restore by swapping this block back to
  // `const emailError = validateUniversityEmail(email);` and re-importing it.
  const emailError = !email
    ? "Email is required."
    : email.length > FIELD_LIMITS.universityEmail
      ? "That email is too long."
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
        ? "That doesn't look like a valid email."
        : null;
  if (emailError) {
    return NextResponse.json({ error: emailError }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Reuse an existing token for (authUid, email) if one's still unverified and
  // unexpired, otherwise start fresh. This matters if the user clicked send,
  // closed the tab, came back — we don't want to orphan the original link.
  let tokenId: string | null = null;
  const existing = await db
    .collection("emailVerifications")
    .where("authUid", "==", actor.uid)
    .where("email", "==", email)
    .where("verifiedAt", "==", null)
    .limit(1)
    .get();

  const now = Timestamp.now();

  if (!existing.empty) {
    const doc = existing.docs[0];
    const data = doc.data();
    const expiresAt = data.expiresAt as Timestamp | undefined;
    if (expiresAt && expiresAt.toMillis() > now.toMillis()) {
      tokenId = doc.id;
      const lastSent = data.lastSentAt as Timestamp | undefined;
      const elapsed = lastSent ? (now.toMillis() - lastSent.toMillis()) / 1000 : Infinity;
      if (elapsed < COOLDOWN_SECONDS) {
        return NextResponse.json({
          ok: true,
          tokenId,
          cooldownRemaining: Math.ceil(COOLDOWN_SECONDS - elapsed),
          sent: false,
        });
      }
    }
  }

  if (!tokenId) {
    tokenId = randomOpaqueId();
    await db
      .collection("emailVerifications")
      .doc(tokenId)
      .set({
        email,
        authUid: actor.uid,
        createdAt: now,
        lastSentAt: now,
        sendCount: 1,
        verifiedAt: null,
        expiresAt: Timestamp.fromMillis(now.toMillis() + TOKEN_TTL_SECONDS * 1000),
      });
  } else {
    await db
      .collection("emailVerifications")
      .doc(tokenId)
      .update({
        lastSentAt: now,
        sendCount: FieldValue.increment(1),
      });
  }

  // A uni email belongs to at most one NAISI account. If this address is
  // already verified on a different account, the person already has an
  // account — send the "you already have an account" email (no verify
  // link) instead of the verification email. The response below is
  // byte-identical either way, so the frontend stays generic ("check your
  // inbox") and there is no enumeration signal; the differentiated
  // content only reaches the inbox the caller is trying to prove control
  // of. The emailVerifications token is still minted so the register
  // tab's onSnapshot has a doc to watch; it simply never gets verified.
  const existingOwner = await findVerifiedUniEmailOwner(db, email, actor.uid);

  const signed = signToken({ s: "verify-uni-email", v: tokenId }, TOKEN_TTL_SECONDS);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const verifyUrl = `${appUrl}/verify-email/${tokenId}?t=${encodeURIComponent(signed)}`;

  try {
    if (existingOwner) {
      await sendEmail({
        to: email,
        subject: "You already have a NAISI account",
        react: AlreadyRegisteredEmail({
          preferredName: body.preferredName ?? "",
          maskedAccountEmail: obfuscateEmail(existingOwner.googleEmail),
        }),
        kind: "unknown",
        actorUid: actor.uid,
        referenceId: tokenId,
      });
    } else {
      await sendEmail({
        to: email,
        subject: "Verify your university email for NAISI",
        react: VerifyUniEmail({
          preferredName: body.preferredName ?? "",
          verifyUrl,
          expiresInMinutes: Math.floor(TOKEN_TTL_SECONDS / 60),
        }),
        kind: "unknown",
        actorUid: actor.uid,
        referenceId: tokenId,
      });
    }
  } catch (err) {
    console.error("[verify-email send] email dispatch failed", err);
    return NextResponse.json(
      { error: "Could not send verification email. Try again in a moment." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    tokenId,
    cooldownRemaining: COOLDOWN_SECONDS,
    sent: true,
  });
}
