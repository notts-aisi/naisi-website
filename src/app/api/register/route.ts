import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { sendEmail } from "@/lib/email/send";
import { randomOpaqueId, signToken } from "@/lib/signedTokens";
import { isAcademicEmail, isNottinghamEmail } from "@/lib/firestore/users";
import { verifyRecaptcha } from "@/lib/recaptcha/server";
import VerifyLoginEmail from "@/emails/VerifyLoginEmail";

const COOLDOWN_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes

type Body = {
  email?: string;
  recaptchaToken?: string;
  /** Which form to resume after the email is verified. Stored on the token doc
   *  so the post-verify redirect lands on the right flow. */
  audience?: "member" | "collaborator";
};

/**
 * Enumeration-safe, reCAPTCHA-gated, server-side registration. The form collects
 * EMAIL ONLY — the account is created with a SERVER-RANDOM throwaway password, and
 * the user sets their real password only after clicking the verification link
 * (updatePassword). Keeping the register-time password server-random — never
 * client-supplied — is what makes creating the account up front safe: if someone
 * registers an email that isn't theirs, they can't know the password and can never
 * sign in; only the inbox owner, who sets their own password after verifying, ends
 * up controlling the account. (Defends both the "register right after you" race
 * and "attacker registers first" pre-hijacking.)
 *
 * Branches, all server-side so the response stays byte-uniform either way:
 *   - VERIFIED account   → send nothing (a real account; sign in / reset instead).
 *   - UNVERIFIED account → (brand new, or an abandoned/returning registration) →
 *       (re)send the verification link, cooldown-gated on re-sends so a flood of
 *       register POSTs can't email-bomb the address. An abandoned registration
 *       leaves only a BENIGN orphan (random password, unverified, no profile) —
 *       re-registering just re-sends, so there's no dead-end and no password to
 *       conflict (the real one is set once, post-verify).
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();

  // Format + policy validation. These depend only on the SUBMITTED email, not on
  // whether it's registered, so surfacing them leaks nothing.
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (isAcademicEmail(email)) {
    return NextResponse.json(
      {
        error: isNottinghamEmail(email)
          ? "That's a University of Nottingham email. Use a personal email (e.g. you@gmail.com) to sign in — university addresses stop working after you graduate. Students and staff confirm their university email separately during registration."
          : "Please use a personal email you'll keep long-term (e.g. you@gmail.com) rather than an academic address.",
      },
      { status: 400 },
    );
  }

  if (!(await verifyRecaptcha(body.recaptchaToken))) {
    return NextResponse.json(
      { error: "Couldn't verify you're human. Please try again." },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Server-random throwaway password — the user replaces it with their own after
  // verifying their email (see the header comment for why this is the safe part).
  const throwawayPassword = randomBytes(24).toString("base64");

  let pendingUid: string | null = null;
  let isNewAccount = false;
  try {
    const user = await auth.createUser({ email, password: throwawayPassword });
    pendingUid = user.uid;
    isNewAccount = true;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "auth/email-already-exists") {
      try {
        const existing = await auth.getUserByEmail(email);
        // Verified → real account → send nothing. Unverified → re-send (below).
        // The password is left untouched; the user sets it post-verify regardless.
        if (!existing.emailVerified) pendingUid = existing.uid;
      } catch (lookupErr) {
        // A failure here must NOT change the response shape (would leak).
        console.error("[/api/register] existing-account lookup failed", lookupErr);
      }
    } else if (code === "auth/invalid-email") {
      return NextResponse.json({ error: "That email isn't valid." }, { status: 400 });
    } else {
      console.error("[/api/register] createUser failed", err);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  }

  if (pendingUid) {
    const uid = pendingUid;
    // Best-effort: (re)send the verification magic link. A failure here must NOT
    // change the response shape (that would leak), so we log and still return OK.
    try {
      const now = Timestamp.now();
      const expiresAt = Timestamp.fromMillis(now.toMillis() + TOKEN_TTL_SECONDS * 1000);
      const sendFor = async (tokenId: string) => {
        const signed = signToken({ s: "verify-login-email", v: tokenId }, TOKEN_TTL_SECONDS);
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const verifyUrl = `${appUrl}/verify-email/${tokenId}?t=${encodeURIComponent(signed)}`;
        await sendEmail({
          to: email,
          subject: "Confirm your email to finish joining NAISI",
          react: VerifyLoginEmail({
            verifyUrl,
            expiresInMinutes: Math.floor(TOKEN_TTL_SECONDS / 60),
          }),
          kind: "unknown",
          actorUid: uid,
          referenceId: tokenId,
        });
      };

      if (!isNewAccount) {
        // Existing unverified account → reuse its pending token and cooldown-gate
        // the re-send so repeated register POSTs can't email-bomb the address.
        const snap = await db
          .collection("emailVerifications")
          .where("kind", "==", "login-email")
          .where("email", "==", email)
          .where("verifiedAt", "==", null)
          .limit(1)
          .get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          const lastSent = doc.data().lastSentAt as Timestamp | undefined;
          const elapsed = lastSent
            ? (now.toMillis() - lastSent.toMillis()) / 1000
            : Infinity;
          if (elapsed >= COOLDOWN_SECONDS) {
            await doc.ref.update({
              lastSentAt: now,
              sendCount: FieldValue.increment(1),
              expiresAt,
            });
            await sendFor(doc.id);
          }
          // within cooldown → skip the send (anti email-bomb)
          return NextResponse.json({ ok: true, cooldownSeconds: COOLDOWN_SECONDS });
        }
        // No surviving token for the account (edge) → fall through to mint one.
      }

      const tokenId = randomOpaqueId();
      await db
        .collection("emailVerifications")
        .doc(tokenId)
        .set({
          kind: "login-email",
          email,
          uid,
          authUid: uid,
          audience: body.audience === "collaborator" ? "collaborator" : "member",
          createdAt: now,
          lastSentAt: now,
          sendCount: 1,
          verifiedAt: null,
          expiresAt,
        });
      await sendFor(tokenId);
    } catch (err) {
      console.error("[/api/register] verification email send failed", err);
    }
  }

  // Uniform response — identical for new and already-registered emails.
  return NextResponse.json({ ok: true, cooldownSeconds: COOLDOWN_SECONDS });
}
