"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import SigningIn from "@/components/SigningIn";
import CollaboratorApplicationForm from "@/components/CollaboratorApplicationForm";
import VerifyEmailStep from "./VerifyEmailStep";
import { signUpWithEmailPassword, startOver } from "@/auth/signInWithEmailPassword";
import DeleteAccountButton from "@/components/DeleteAccountButton";
import { signOut } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import { useSiteNotice } from "@/features/maintenance/useSiteNotice";
import { isSurfacePaused } from "@/lib/siteNotice";
import { getClientDb } from "@/lib/firebase/client";
import type { CollaboratorInput } from "@/lib/firestore/collaborators";

type Step = "account" | "verify-email" | "application";

/**
 * Apply-as-collaborator flow (reached via /register?type=collaborator). Two
 * steps: create an email/password account, then fill the application. Kept
 * entirely separate from the Google/uni RegisterPageInner FSM. The ambient
 * SigningIn surge activates on input focus (per the login/register refinement).
 */
export default function CollaboratorApply() {
  const router = useRouter();
  const { user, role, loading: authLoading } = useAuth();
  // Maintenance notice: a paused collaboratorApplications surface disables the
  // final submit with the notice's copy inline (client-side only — see
  // src/lib/siteNotice.ts). Account creation stays open: it is a
  // browser→Firebase call this app cannot gate, and stranding someone before
  // the pausable step helps nobody.
  const siteNotice = useSiteNotice();
  const applicationsPaused = isSurfacePaused(siteNotice, "collaboratorApplications");

  // Whether the signed-in user already has a collaborator application doc.
  // null = still resolving.
  const [hasCollabDoc, setHasCollabDoc] = useState<boolean | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [manualVerified, setManualVerified] = useState(false);

  useEffect(() => {
    // No user → nothing to resolve; the render guards key off `user` first, so
    // hasCollabDoc's value is irrelevant while signed out.
    if (!user) return;
    const db = getClientDb();
    const q = query(collection(db, "collaborators"), where("uid", "==", user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => setHasCollabDoc(!snap.empty),
      () => setHasCollabDoc(false),
    );
    return unsub;
  }, [user]);

  // Already applied → the collaborator area.
  useEffect(() => {
    if (user && hasCollabDoc === true) router.replace("/collaborator");
  }, [user, hasCollabDoc, router]);

  // Email/password accounts must verify before the application form. `user
  // .emailVerified` is the cached value (true for an already-verified returning
  // user → skip the gate); manualVerified is the live flip from VerifyEmailStep.
  const emailVerified = manualVerified || Boolean(user?.emailVerified);
  const handleVerified = useCallback(() => setManualVerified(true), []);
  // Signed out → account; signed in but unverified → verify-email; verified →
  // application. (Member / already-applied cases handled by the render guards.)
  const effectiveStep: Step = !user
    ? "account"
    : emailVerified
      ? "application"
      : "verify-email";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [surge, setSurge] = useState(false);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setAccountError(null);
    if (!email.trim() || !password) {
      setAccountError("Enter an email and a password.");
      return;
    }
    if (password.length < 6) {
      setAccountError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setAccountError("Those passwords don't match.");
      return;
    }
    setAccountBusy(true);
    try {
      await signUpWithEmailPassword(email.trim(), password);
      // → verify-email step (derived: the new account's email is unverified).
    } catch (err) {
      setAccountError(
        err instanceof Error ? err.message : "Couldn't create your account.",
      );
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleStartOver() {
    setResetBusy(true);
    try {
      await startOver(); // signs out (+ deletes the orphan account) → back to step 1
      setManualVerified(false);
      setEmail("");
      setPassword("");
      setConfirm("");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleSubmitApplication(input: CollaboratorInput) {
    setSubmitError(null);
    if (applicationsPaused) {
      // Belt and braces behind the disabled submit — never a silent block.
      setSubmitError(siteNotice.bannerMessage);
      return;
    }
    // During a declared incident the notice copy beats the generic fallback
    // (a server-provided error body still wins below).
    const genericError = siteNotice.bannerVisible
      ? siteNotice.bannerMessage
      : "Couldn't submit your application.";
    setSubmitBusy(true);
    try {
      const res = await fetch("/api/collaborators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, agreedToPolicies: true }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? genericError);
      router.push("/collaborator");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : genericError);
      setSubmitBusy(false);
    }
  }

  const calm = () => {
    if (!email.trim() && !password && !confirm) setSurge(false);
  };
  const surgeOn = () => setSurge(true);

  // Resolving the session, or already a collaborator (redirecting) → hold.
  if (authLoading || (user !== null && hasCollabDoc === null) || (user && hasCollabDoc)) {
    return (
      <Card padding="lg" style={{ width: "100%", maxWidth: "30rem" }}>
        <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
      </Card>
    );
  }

  // Signed in as a UoN member → they can't apply as a collaborator on that
  // account; offer a sign-out (NOT a delete — it's a real account).
  if (user && role) {
    return (
      <Card padding="lg" style={{ width: "100%", maxWidth: "30rem" }}>
        <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
          You&apos;re signed in as a member
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-5)" }}>
          You&apos;re signed in as a University of Nottingham member ({user.email}).
          To apply as an external collaborator, sign out and start again.
        </p>
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Card>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: effectiveStep === "application" ? "40rem" : "30rem" }}>
      <Card padding="lg" style={{ width: "100%" }}>
        <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
          Collaborate with NAISI
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
          {effectiveStep === "account"
            ? "Create an account to apply as an external collaborator — no University of Nottingham email needed."
            : effectiveStep === "verify-email"
              ? "Verify your email address to continue your application."
              : "Tell us about you and the project you'd like to work on. This should take no more than 30 minutes."}
        </p>

        {effectiveStep === "account" ? (
          <>
            <form
              onSubmit={handleCreateAccount}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
            >
              <Field
                id="collab-email"
                label="Email"
                hint="Use a personal email you'll keep — not a university address."
              >
                <Input
                  id="collab-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={surgeOn}
                  onMouseDown={surgeOn}
                  onBlur={calm}
                  autoComplete="email"
                  placeholder="you@gmail.com"
                  required
                />
              </Field>
              <Field id="collab-password" label="Password" hint="At least 6 characters.">
                <Input
                  id="collab-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={surgeOn}
                  onMouseDown={surgeOn}
                  onBlur={calm}
                  autoComplete="new-password"
                  required
                />
              </Field>
              <Field id="collab-confirm" label="Confirm password">
                <Input
                  id="collab-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onFocus={surgeOn}
                  onMouseDown={surgeOn}
                  onBlur={calm}
                  autoComplete="new-password"
                  required
                />
              </Field>
              {accountError && (
                <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>
                  {accountError}
                </p>
              )}
              <Button type="submit" fullWidth size="lg" disabled={accountBusy}>
                {accountBusy ? "Creating account…" : "Create account & continue"}
              </Button>
            </form>
            <SigningIn active={surge} />
            <p
              style={{
                color: "var(--color-text-muted)",
                fontSize: "var(--text-sm)",
                marginTop: "var(--space-6)",
                textAlign: "center",
              }}
            >
              Already applied?{" "}
              <Link href="/login" style={{ color: "var(--color-accent)" }}>
                Sign in
              </Link>
            </p>
          </>
        ) : effectiveStep === "verify-email" ? (
          <VerifyEmailStep
            email={user?.email ?? null}
            onVerified={handleVerified}
            onStartOver={() => void handleStartOver()}
            startingOver={resetBusy}
          />
        ) : (
          <>
            {user && (
              <p
                style={{
                  color: "var(--color-text-subtle)",
                  fontSize: "var(--text-sm)",
                  marginBottom: "var(--space-4)",
                }}
              >
                Signed up as {user.email}. Not you?{" "}
                <button
                  type="button"
                  onClick={() => void handleStartOver()}
                  disabled={resetBusy}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: "var(--color-accent)",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  {resetBusy ? "Starting over…" : "Start over with a different email"}
                </button>
                {" · "}
                <DeleteAccountButton />
              </p>
            )}
            {applicationsPaused && (
              <p
                style={{
                  color: "var(--color-warning)",
                  fontSize: "var(--text-sm)",
                  marginBottom: "var(--space-4)",
                }}
              >
                {siteNotice.bannerMessage} Your answers will stay on this page.
              </p>
            )}
            <CollaboratorApplicationForm
              requireConsent
              submitLabel="Submit application"
              busyLabel="Submitting…"
              busy={submitBusy}
              disabled={applicationsPaused}
              externalError={submitError}
              onSubmit={handleSubmitApplication}
              intro={
                <p
                  style={{
                    color: "var(--color-text-subtle)",
                    fontSize: "var(--text-sm)",
                    margin: 0,
                  }}
                >
                  You can edit this later from your collaborator space.
                </p>
              }
            />
          </>
        )}
      </Card>
    </div>
  );
}
