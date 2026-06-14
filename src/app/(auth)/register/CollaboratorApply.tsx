"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import SigningIn from "@/components/SigningIn";
import CollaboratorApplicationForm from "@/components/CollaboratorApplicationForm";
import { signUpWithEmailPassword } from "@/auth/signInWithEmailPassword";
import { useAuth } from "@/auth/AuthProvider";
import type { CollaboratorInput } from "@/lib/firestore/collaborators";

type Step = "account" | "application";

/**
 * Apply-as-collaborator flow (reached via /register?type=collaborator). Two
 * steps: create an email/password account, then fill the application. Kept
 * entirely separate from the Google/uni RegisterPageInner FSM. The ambient
 * SigningIn surge activates on input focus (per the login/register refinement).
 */
export default function CollaboratorApply() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [step, setStep] = useState<Step>("account");
  // Already signed in (created an account, then navigated back)? Skip to the
  // application step. Render-phase derived bump, run once.
  const [synced, setSynced] = useState(false);
  if (!authLoading && user && !synced) {
    setSynced(true);
    setStep("application");
  }

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
      setStep("application");
    } catch (err) {
      setAccountError(
        err instanceof Error ? err.message : "Couldn't create your account.",
      );
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleSubmitApplication(input: CollaboratorInput) {
    setSubmitError(null);
    setSubmitBusy(true);
    try {
      const res = await fetch("/api/collaborators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Couldn't submit your application.");
      router.push("/collaborator");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Couldn't submit your application.",
      );
      setSubmitBusy(false);
    }
  }

  const calm = () => {
    if (!email.trim() && !password && !confirm) setSurge(false);
  };
  const surgeOn = () => setSurge(true);

  return (
    <div style={{ width: "100%", maxWidth: step === "application" ? "40rem" : "30rem" }}>
      <Card padding="lg" style={{ width: "100%" }}>
        <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
          Collaborate with NAISI
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
          {step === "account"
            ? "Create an account to apply as an external collaborator — no University of Nottingham email needed."
            : "Tell us about you and the project you'd like to work on. This should take no more than 30 minutes."}
        </p>

        {step === "account" ? (
          <>
            <form
              onSubmit={handleCreateAccount}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
            >
              <Field id="collab-email" label="Email">
                <Input
                  id="collab-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={surgeOn}
                  onMouseDown={surgeOn}
                  onBlur={calm}
                  autoComplete="email"
                  placeholder="you@example.com"
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
        ) : (
          <CollaboratorApplicationForm
            submitLabel="Submit application"
            busyLabel="Submitting…"
            busy={submitBusy}
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
        )}
      </Card>
    </div>
  );
}
