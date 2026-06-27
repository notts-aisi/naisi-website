"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken, updatePassword } from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";
import { Field } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import Button from "@/components/ui/Button";

type Phase = "signing-in" | "set-password" | "saving" | "failed";

/**
 * Client island for the login-email magic link. The account was created at
 * register time with a SERVER-RANDOM throwaway password; the server has now
 * verified the address and minted `customToken`. Here we sign in with it, exchange
 * for the session cookie, then have the user set their REAL password
 * (`updatePassword`) before continuing to the form they started (member profile /
 * collaborator application). Setting the password only here — after proving inbox
 * ownership — is what makes the throwaway-password approach safe.
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
        if (!cancelled) setPhase("set-password");
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
        const auth = getClientAuth();
        if (!auth.currentUser) throw new Error("not signed in");
        // The custom-token sign-in just above counts as a recent login, so
        // updatePassword won't require re-authentication here.
        await updatePassword(auth.currentUser, password);
        router.replace(continueUrl);
      } catch (err) {
        console.error("[verify-login] set password failed", err);
        setError("Couldn't save your password. Please try again.");
        setPhase("set-password");
      }
    },
    [password, router, continueUrl],
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
