"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";

/**
 * Client island for the login-email magic link (option A). The server already
 * verified the address and minted `customToken`; here we sign in with it,
 * exchange for the session cookie, and continue registration on the form the
 * user started (member profile / collaborator application).
 */
export default function LoginEmailVerified({
  customToken,
  audience,
}: {
  customToken: string;
  audience: "member" | "collaborator";
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

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
        if (cancelled) return;
        router.replace(
          audience === "collaborator" ? "/register?type=collaborator" : "/register",
        );
      } catch (err) {
        console.error("[verify-login] auto sign-in failed", err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customToken, audience, router]);

  return (
    <>
      <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
        Email confirmed
      </h1>
      {failed ? (
        <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
          Your email is confirmed, but we couldn&apos;t sign you in automatically.
          Head to the{" "}
          <a href="/login" style={{ color: "var(--color-accent)" }}>
            sign-in page
          </a>{" "}
          and log in with your email and password to continue.
        </p>
      ) : (
        <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
          Signing you in…
        </p>
      )}
    </>
  );
}
