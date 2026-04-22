"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import GraduationSelect from "@/components/ui/GraduationSelect";
import StatusSelect from "@/components/ui/StatusSelect";
import { Field, Input } from "@/components/ui/Input";
import { completeRegistration, signInWithGoogle } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import {
  FIELD_LIMITS,
  STATUSES_WITH_GRADUATION,
  subjectLabel,
  validateUniversityEmail,
  type AffiliationStatus,
} from "@/lib/firestore/users";

export default function RegisterPage() {
  const router = useRouter();
  const { user, role, loading: authLoading } = useAuth();

  // Already approved? Send to dashboard. Already pending? Send to waiting screen.
  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (role === "member" || role === "committee" || role === "admin") {
      router.replace("/dashboard");
    } else if (role === "pending") {
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      router.replace("/");
    }
  }, [authLoading, user, role, router]);

  // Only show the profile form once a user is signed in but has no role yet
  // (i.e. brand-new signups that haven't submitted the profile).
  const [step, setStep] = useState<"sign-in" | "profile">(user && !role ? "profile" : "sign-in");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Profile form state
  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [status, setStatus] = useState<AffiliationStatus | "">("");
  const [statusOther, setStatusOther] = useState("");
  const [subject, setSubject] = useState("");
  const [expectedGraduation, setExpectedGraduation] = useState("");
  const [motivation, setMotivation] = useState("");
  const [interests, setInterests] = useState("");
  const [subscribed, setSubscribed] = useState(true);
  const [deliverGmail, setDeliverGmail] = useState(true);
  const [deliverUni, setDeliverUni] = useState(false);

  const showGraduation = status !== "" && STATUSES_WITH_GRADUATION.includes(status);
  const showStatusOther = status === "other";

  async function handleSignIn() {
    setError(null);
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      if (!result.isNew) {
        // Existing user — server-side (app)/layout.tsx handles role-based routing.
        router.push("/dashboard");
        return;
      }
      setStep("profile");
    } catch (err) {
      console.error(err);
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!preferredName || !universityEmail || !status || !subject || !motivation) {
      setError("Please fill in every required field.");
      return;
    }
    const uniEmailError = validateUniversityEmail(universityEmail);
    if (uniEmailError) {
      setError(uniEmailError);
      return;
    }
    if (showStatusOther && !statusOther.trim()) {
      setError("Please describe your role since you picked Other.");
      return;
    }
    if (showGraduation && !expectedGraduation) {
      setError("Please pick your expected graduation month and year.");
      return;
    }
    if (subscribed && !deliverGmail && !deliverUni) {
      setError("Pick at least one email to send the newsletter to.");
      return;
    }
    setLoading(true);
    try {
      await completeRegistration({
        preferredName,
        universityEmail: universityEmail.trim(),
        status,
        statusOther: showStatusOther ? statusOther.trim() : undefined,
        subject,
        expectedGraduation: showGraduation ? expectedGraduation : undefined,
        motivation,
        interests: interests.trim() || undefined,
        newsletter: {
          subscribed,
          deliverToGmail: subscribed ? deliverGmail : false,
          deliverToUniEmail: subscribed ? deliverUni : false,
        },
      });
      router.push("/pending-approval");
    } catch (err) {
      console.error(err);
      setError("Failed to save your application. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "30rem" }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
        Join NAISI
      </h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
        {step === "sign-in"
          ? "Apply to join the Nottingham AI Safety Initiative. We'll review your application and be in touch."
          : "Tell us a bit about you so the committee can review your application."}
      </p>

      {step === "sign-in" ? (
        <>
          <Button onClick={handleSignIn} fullWidth size="lg" disabled={loading}>
            {loading ? "Signing in…" : "Continue with Google"}
          </Button>
          {error && (
            <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", marginTop: "var(--space-4)" }}>
              {error}
            </p>
          )}
          <p
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
              marginTop: "var(--space-6)",
              textAlign: "center",
            }}
          >
            Already have an account?{" "}
            <Link href="/login" style={{ color: "var(--color-accent)" }}>
              Sign in
            </Link>
          </p>
        </>
      ) : (
        <form onSubmit={handleSubmitProfile} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Field id="preferredName" label="Preferred name">
            <Input
              id="preferredName"
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              placeholder="What should we call you?"
              maxLength={FIELD_LIMITS.preferredName}
              required
            />
          </Field>
          <Field
            id="universityEmail"
            label="University email"
            hint="We accept @nottingham.ac.uk (including subdomains like exmail.nottingham.ac.uk). Staff welcome. If your address is a different format, email ai-safety@uonsu.com and we'll add you manually."
          >
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
              <Input
                id="universityEmail"
                type="email"
                value={universityEmail}
                onChange={(e) => setUniversityEmail(e.target.value)}
                placeholder="you@nottingham.ac.uk"
                maxLength={FIELD_LIMITS.universityEmail}
                pattern="^[^@\s]+@([a-zA-Z0-9-]+\.)*nottingham\.ac\.uk$"
                title="Use your University of Nottingham email address"
                required
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={() => {
                  const local = universityEmail.split("@")[0].trim();
                  if (local) setUniversityEmail(`${local}@nottingham.ac.uk`);
                }}
                title="Append @nottingham.ac.uk to what you've typed"
                style={{
                  padding: "0 var(--space-4)",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-text-muted)",
                  fontSize: "var(--text-sm)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition:
                    "color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--color-text)";
                  e.currentTarget.style.borderColor = "var(--color-accent)";
                  e.currentTarget.style.background = "var(--color-accent-soft)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--color-text-muted)";
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.background = "var(--color-bg-elevated)";
                }}
              >
                @nottingham.ac.uk
              </button>
            </div>
          </Field>
          <Field id="status" label="What do you do at UoN?">
            <StatusSelect id="status" value={status} onChange={setStatus} required />
          </Field>
          {showStatusOther && (
            <Field
              id="statusOther"
              label="Describe your role"
              hint="A short description of what you do at or with the university."
            >
              <Input
                id="statusOther"
                value={statusOther}
                onChange={(e) => setStatusOther(e.target.value)}
                maxLength={FIELD_LIMITS.statusOther}
                required
              />
            </Field>
          )}
          <Field
            id="subject"
            label={subjectLabel(status || undefined)}
            hint={
              status === "postdoc" || status === "employee"
                ? "e.g. Machine learning, department of Computer Science"
                : status === "other"
                  ? "e.g. what field you work or study in"
                  : "e.g. BSc Mathematics, MSc Artificial Intelligence"
            }
          >
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={FIELD_LIMITS.subject}
              required
            />
          </Field>
          {showGraduation && (
            <Field
              id="expectedGraduation"
              label="Expected graduation"
              hint="Month and year you expect to finish."
            >
              <GraduationSelect
                id="expectedGraduation"
                value={expectedGraduation}
                onChange={setExpectedGraduation}
                required
              />
            </Field>
          )}
          <Field
            id="motivation"
            label="Why are you interested in AI safety?"
            hint="A couple of sentences is plenty."
          >
            <CountedTextarea
              id="motivation"
              value={motivation}
              onChange={(e) => setMotivation(e.target.value)}
              max={FIELD_LIMITS.motivation}
              required
            />
          </Field>
          <Field
            id="interests"
            label="Interests within AI safety (optional)"
            hint="e.g. interpretability, alignment, governance, evals — anything that draws you in."
          >
            <CountedTextarea
              id="interests"
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              max={FIELD_LIMITS.interests}
              rows={2}
            />
          </Field>

          <fieldset
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-4)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
            <legend
              style={{
                padding: "0 var(--space-2)",
                fontSize: "var(--text-sm)",
                fontWeight: 500,
                color: "var(--color-text)",
              }}
            >
              Newsletter
            </legend>
            <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", fontSize: "var(--text-sm)" }}>
              <input
                type="checkbox"
                checked={subscribed}
                onChange={(e) => {
                  const next = e.target.checked;
                  setSubscribed(next);
                  // If turning subscription on but nothing's ticked, default to Gmail.
                  if (next && !deliverGmail && !deliverUni) setDeliverGmail(true);
                }}
              />
              <span>Subscribe me to the NAISI newsletter</span>
            </label>
            {subscribed && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  paddingLeft: "var(--space-6)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-muted)",
                }}
              >
                <span>Send to:</span>
                <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={deliverGmail}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setDeliverGmail(next);
                      // Both delivery channels off ⇒ effectively unsubscribed.
                      if (!next && !deliverUni) setSubscribed(false);
                    }}
                  />
                  <span>My Google account email ({user?.email ?? "your sign-in email"})</span>
                </label>
                <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={deliverUni}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setDeliverUni(next);
                      if (!next && !deliverGmail) setSubscribed(false);
                    }}
                  />
                  <span>My university email</span>
                </label>
              </div>
            )}
            <p
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--color-text-subtle)",
                marginTop: "var(--space-1)",
              }}
            >
              You can unsubscribe at any time — every email includes a one-click unsubscribe link.
            </p>
          </fieldset>
          {error && (
            <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>
          )}
          <Button type="submit" fullWidth size="lg" disabled={loading}>
            {loading ? "Submitting…" : "Submit application"}
          </Button>
        </form>
      )}
    </Card>
  );
}
