"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken, signInWithEmailAndPassword } from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";
import { Field } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import Button from "@/components/ui/Button";

type Phase = "signing-in" | "set-password" | "saving" | "failed" | "stale-session";

/**
 * Signs back in with the newly-set password and exchanges a fresh session
 * cookie. Returns false if either leg fails, so the caller can stop rather
 * than send the user into an authenticated form with a dead session.
 */
async function refreshSession(email: string | null, password: string): Promise<boolean> {
  if (!email) return false;
  try {
    const auth = getClientAuth();
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await cred.user.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[verify-login] session refresh after password-set failed", err);
    return false;
  }
}

/**
 * Client island for the login-email magic link. The account was created at
 * register time with a SERVER-RANDOM throwaway password; the server has now
 * verified the address and minted `customToken`. Here we sign in with it, exchange
 * for the session cookie, then have the user set their REAL password (server-side
 * via `/api/register/password-set`) before continuing to the form they started
 * (member profile / collaborator application). Setting the password only here —
 * after proving inbox ownership — is what makes the throwaway-password approach safe.
 */
export default function LoginEmailVerified({
  customToken,
  audience,
}: {
  customToken: string;
  audience: "member" | "collaborator";
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("signing-in");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Captured from the custom-token sign-in so the re-authentication below has
  // an address to use (the user never types their email on this screen).
  const [email, setEmail] = useState<string | null>(null);

  const continueUrl =
    audience === "collaborator" ? "/register?type=collaborator" : "/register";

  // Sign in with the custom token + establish the session, then ask for a password.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const auth = getClientAuth();
        const cred = await signInWithCustomToken(auth, customToken);
        const idToken = await cred.user.getIdToken();
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        if (!res.ok) throw new Error("session exchange failed");
        if (!cancelled) {
          setEmail(cred.user.email);
          setPhase("set-password");
        }
      } catch (err) {
        console.error("[verify-login] auto sign-in failed", err);
        if (!cancelled) setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customToken]);

  const onSetPassword = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
      setPhase("saving");
      try {
        // Set the password AND mark the registration completed SERVER-SIDE in a
        // single request (Admin SDK updateUser + the tracker flip), authenticated
        // by the custom-token session established above. Server-side is what makes
        // "completed" reliable — a client updatePassword + a separate flip could
        // lose the flip to the navigation below, stranding finished accounts at
        // "verified-no-password".
        const res = await fetch("/api/register/password-set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Couldn't save your password.");
        }

        // Re-establish the session before navigating. Setting a password bumps
        // the user's `validSince` in Firebase Auth, which revokes BOTH the
        // refresh token behind the client SDK and the `__session` cookie minted
        // above — and every server-side session check verifies with
        // `checkRevoked: true`. Everything the continuation does is
        // authenticated, so without this the user reaches the next form already
        // signed out. Confirmed on dev: a collaborator fills in the whole
        // application and is told they are not signed in when they submit; a
        // member's `/api/verify-email/reconcile` call 401s and the
        // `profile.uniEmailVerifiedAt` stamp is silently lost.
        //
        // The credentials are both in hand — the address from the custom-token
        // sign-in, the password just chosen — so this is invisible when it
        // works.
        const refreshed = await refreshSession(email, password);
        if (!refreshed) {
          // Do NOT continue: the password IS saved, but the next screen is a
          // form that will reject the submission. Sending them to sign in with
          // the password they just chose is the honest outcome — far better
          // than losing a filled-in application to a 401.
          setPhase("stale-session");
          return;
        }

        router.replace(continueUrl);
      } catch (err) {
        console.error("[verify-login] set password failed", err);
        setError(
          err instanceof Error ? err.message : "Couldn't save your password. Please try again.",
        );
        setPhase("set-password");
      }
    },
    [password, router, continueUrl, email],
  );

  if (phase === "failed") {
    return (
      <>
        <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
          Email confirmed
        </h1>
        <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
          Your email is confirmed, but we couldn&apos;t sign you in automatically.
          Head to the{" "}
          <a href="/login" style={{ color: "var(--color-accent)" }}>
            sign-in page
          </a>{" "}
          and use &quot;Forgot password?&quot; to set a password and continue.
        </p>
      </>
    );
  }

  // Password saved, but signing back in afterwards failed. Continuing would
  // drop them onto an authenticated form that rejects the submission, so stop
  // here and point them at sign-in with the password they just chose.
  if (phase === "stale-session") {
    return (
      <>
        <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
          Password saved
        </h1>
        <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
          Your password is set, but we couldn&apos;t keep you signed in. Head to the{" "}
          <a href="/login" style={{ color: "var(--color-accent)" }}>
            sign-in page
          </a>{" "}
          and sign in with the password you just chose to finish your application.
        </p>
      </>
    );
  }

  if (phase === "signing-in") {
    return (
      <>
        <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
          Email confirmed
        </h1>
        <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
          Signing you in…
        </p>
      </>
    );
  }

  // set-password / saving
  return (
    <>
      <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
        Set your password
      </h1>
      <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-5)" }}>
        Your email is confirmed. Choose a password to finish setting up your
        account.
      </p>
      <form
        onSubmit={onSetPassword}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          textAlign: "left",
        }}
      >
        <div>
          <Field id="set-password" label="Password">
            <PasswordInput
              id="set-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <p
            style={{
              marginTop: "var(--space-2)",
              fontSize: "var(--text-sm)",
              color: "var(--color-text-muted)",
            }}
          >
            At least 6 characters.
          </p>
        </div>
        {error && (
          <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>
            {error}
          </p>
        )}
        <Button type="submit" fullWidth size="lg" disabled={phase === "saving"}>
          {phase === "saving" ? "Saving…" : "Set password & continue"}
        </Button>
      </form>
    </>
  );
}
