import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendEmail } from "@/lib/email/send";
import { randomOpaqueId, signToken } from "@/lib/signedTokens";
import { validateUniversityEmail } from "@/lib/firestore/users";
import { findVerifiedUniEmailOwner } from "@/lib/firestore/uniEmailOwnership";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { obfuscateEmail } from "@/lib/obfuscateEmail";
import VerifyUniEmail from "@/emails/VerifyUniEmail";
import AlreadyRegisteredEmail from "@/emails/AlreadyRegisteredEmail";

const COOLDOWN_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes

// Abuse throttle (see lib/rateLimit). This route sends a NAISI-signed email to
// a caller-chosen @nottingham.ac.uk address, so without a volume cap one
// session (or one IP) could pump the domain's sending reputation across an
// unbounded list of addresses. The 60s per-(authUid, email) cooldown below
// only bounds re-sends to the SAME address; these bound distinct ones. Generous
// per-IP for shared campus NAT, tighter per-actor. Cost only, never a state
// oracle: the limits key on caller identity, not on the target address.
const RL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RL_IP_MAX = 30;
const RL_ACTOR_MAX = 10;
/** Cap the caller-supplied greeting name rendered into the email body. */
const PREFERRED_NAME_MAX = 80;

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

  // Volume throttle before any work. A 429 here is caller-volume-based, not
  // target-state-based, so it leaks nothing about the address in the body.
  const ip = clientIp(req);
  const ipLimit = rateLimit(`verify-email-send:ip:${ip}`, RL_IP_MAX, RL_WINDOW_MS);
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }
  const actorLimit = rateLimit(`verify-email-send:actor:${actor.uid}`, RL_ACTOR_MAX, RL_WINDOW_MS);
  if (!actorLimit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(actorLimit.retryAfterSeconds) } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  // The university-email magic link is what proves UoN affiliation, so the
  // address it is sent to must itself be a Nottingham address. This is the
  // authoritative server-side eligibility gate (the register form mirrors it
  // client-side for UX).
  const emailError = validateUniversityEmail(email);
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

  // Caller-supplied greeting, trimmed and length-capped before it is rendered
  // into a NAISI-signed email body.
  const preferredName = (body.preferredName ?? "").trim().slice(0, PREFERRED_NAME_MAX);

  try {
    if (existingOwner) {
      await sendEmail({
        to: email,
        subject: "You already have a NAISI account",
        react: AlreadyRegisteredEmail({
          preferredName,
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
          preferredName,
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
