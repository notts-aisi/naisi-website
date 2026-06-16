import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { sendEmail } from "@/lib/email/send";
import { randomOpaqueId, signToken } from "@/lib/signedTokens";
import { isAcademicEmail, isNottinghamEmail } from "@/lib/firestore/users";
import { verifyRecaptcha } from "@/lib/recaptcha/server";
import VerifyLoginEmail from "@/emails/VerifyLoginEmail";

const COOLDOWN_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes
const MIN_PASSWORD = 6;

type Body = {
  email?: string;
  password?: string;
  recaptchaToken?: string;
  /** Which form to resume after the email is verified. Stored on the token doc
   *  so the post-verify redirect lands on the right flow. */
  audience?: "member" | "collaborator";
};

/**
 * Enumeration-safe server-side registration. Creates the email/password account
 * with the Admin SDK; if the email is ALREADY registered, the error is
 * SWALLOWED and nothing is sent — the response is byte-identical to a fresh
 * signup. So neither the on-screen state nor the network tab reveals whether the
 * address was already registered; the only differing side effect (a verification
 * email arriving, or not) is observable solely by the inbox's true owner.
 *
 * Doing this server-side is what makes it uniform: the free client path
 * (createUserWithEmailAndPassword + sendEmailVerification) leaks via the network
 * tab — the create errors and no send fires for an existing email.
 *
 * Continuation (verifying the email + establishing a session) is driven off the
 * emailed magic link, NOT this response, so the response carries no token that
 * would differ between the new and existing cases.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  // Format + policy validation. These depend only on the SUBMITTED values, not
  // on whether the address is registered, so surfacing them leaks nothing.
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
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD} characters.` },
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

  // Create the account. An existing email is swallowed (see header comment).
  let createdUid: string | null = null;
  try {
    const user = await auth.createUser({ email, password });
    createdUid = user.uid;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code === "auth/email-already-exists") {
      // Already registered → send nothing; fall through to the uniform OK.
    } else if (code === "auth/invalid-password" || code === "auth/invalid-email") {
      // Deterministic on the submitted values, not on existence → safe to show.
      return NextResponse.json(
        { error: "That email or password isn't valid." },
        { status: 400 },
      );
    } else {
      console.error("[/api/register] createUser failed", err);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  }

  if (createdUid) {
    // Best-effort: mint the verification token + send the magic link. A failure
    // here must NOT change the response shape (that would leak), so we log and
    // still return OK — the user can hit "resend".
    try {
      const now = Timestamp.now();
      const tokenId = randomOpaqueId();
      await db
        .collection("emailVerifications")
        .doc(tokenId)
        .set({
          kind: "login-email",
          email,
          uid: createdUid,
          authUid: createdUid,
          audience: body.audience === "collaborator" ? "collaborator" : "member",
          createdAt: now,
          lastSentAt: now,
          sendCount: 1,
          verifiedAt: null,
          expiresAt: Timestamp.fromMillis(now.toMillis() + TOKEN_TTL_SECONDS * 1000),
        });
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
        actorUid: createdUid,
        referenceId: tokenId,
      });
    } catch (err) {
      console.error("[/api/register] verification email send failed", err);
    }
  }

  // Uniform response — identical for new and already-registered emails.
  return NextResponse.json({ ok: true, cooldownSeconds: COOLDOWN_SECONDS });
}
