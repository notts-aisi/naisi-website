"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import GraduationSelect from "@/components/ui/GraduationSelect";
import StatusSelect from "@/components/ui/StatusSelect";
import Switch from "@/components/ui/Switch";
import { Field, Input } from "@/components/ui/Input";
import {
  completeRegistration,
  exchangeGoogleCredential,
} from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  FIELD_LIMITS,
  STATUSES_WITH_GRADUATION,
  subjectLabel,
  validateUniversityEmail,
  type AffiliationStatus,
} from "@/lib/firestore/users";
import {
  ALL_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  isSubscribedToAnything,
  setCategory,
  setChannel,
  type NotificationPrefs,
} from "@/lib/firestore/notifications";

type VerificationState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; tokenId: string; nextSendAt: number }
  | { status: "verified"; tokenId: string; verifiedAt: Date }
  | { status: "error"; message: string };

export default function RegisterPage() {
  // Next 16 requires `useSearchParams()` consumers to live under a Suspense
  // boundary so the bailout-to-CSR semantics are explicit at build time.
  return (
    <Suspense fallback={null}>
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromSubscriber = searchParams.get("from") === "subscriber";
  const { user, role, loading: authLoading } = useAuth();

  const [step, setStep] = useState<"sign-in" | "profile">(
    user && !role ? "profile" : "sign-in",
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Already signed in? Bounce away based on role. The `loading` guard
  // keeps the bounce from racing the inline credential-exchange path:
  // signInWithCredential fires onAuthStateChanged before the cookie POST
  // completes, and we don't want to navigate before /api/auth/session
  // mints the cookie.
  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (loading) return;
    if (role === "member" || role === "committee" || role === "admin") {
      router.replace("/dashboard");
    } else if (role === "pending") {
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      router.replace("/");
    }
  }, [authLoading, user, role, router, loading]);

  // Profile state
  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [status, setStatus] = useState<AffiliationStatus | "">("");
  const [statusOther, setStatusOther] = useState("");
  const [subject, setSubject] = useState("");
  const [expectedGraduation, setExpectedGraduation] = useState("");
  const [motivation, setMotivation] = useState("");
  const [interests, setInterests] = useState("");
  const [prefs, setPrefs] = useState<NotificationPrefs>({
    channels: { gmail: true, uniEmail: false },
    categories: { newsletter: true, events: true },
  });

  // Verification state
  const [verification, setVerification] = useState<VerificationState>({ status: "idle" });
  const [cooldown, setCooldown] = useState(0);
  const [allowUnverifiedSubmit, setAllowUnverifiedSubmit] = useState(false);
  const lastVerifiedEmailRef = useRef<string | null>(null);

  const showGraduation = status !== "" && STATUSES_WITH_GRADUATION.includes(status);
  const showStatusOther = status === "other";
  const anyCategoryOn = isSubscribedToAnything(prefs);

  // Subscribe to the outstanding verification doc. Firestore rules gate read
  // to authUid == request.auth.uid, so only this tab (signed in as the
  // initiator) can see the doc update.
  useEffect(() => {
    if (verification.status !== "sent") return;
    if (!user) return;
    const tokenId = verification.tokenId;
    const db = getClientDb();
    const unsub = onSnapshot(doc(db, "emailVerifications", tokenId), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.verifiedAt) {
        const verifiedAt =
          data.verifiedAt instanceof Date
            ? data.verifiedAt
            : typeof (data.verifiedAt as { toDate?: () => Date }).toDate === "function"
              ? (data.verifiedAt as { toDate: () => Date }).toDate()
              : new Date();
        lastVerifiedEmailRef.current = (data.email as string) ?? universityEmail.trim().toLowerCase();
        setVerification({ status: "verified", tokenId, verifiedAt });
      }
    });
    return unsub;
  }, [verification, user, universityEmail]);

  // Cooldown ticker - drives the resend button countdown. The initial value
  // is seeded in sendVerification when the "sent" state is set; this effect
  // only keeps it ticking, so it never has to setState synchronously.
  useEffect(() => {
    if (verification.status !== "sent") return;
    const { nextSendAt } = verification;
    const id = setInterval(() => {
      setCooldown(Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000)));
    }, 500);
    return () => clearInterval(id);
  }, [verification]);

  // If user edits the uni email after a successful verification, the stamp
  // no longer applies — reset verification state. They need to re-verify.
  useEffect(() => {
    if (verification.status !== "verified") return;
    const current = universityEmail.trim().toLowerCase();
    if (current !== lastVerifiedEmailRef.current) {
      setVerification({ status: "idle" });
    }
  }, [universityEmail, verification]);

  const sendVerification = useCallback(async () => {
    setError(null);
    const emailError = validateUniversityEmail(universityEmail);
    if (emailError) {
      setError(emailError);
      return;
    }
    setVerification({ status: "sending" });
    try {
      const res = await fetch("/api/verify-email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: universityEmail.trim().toLowerCase(),
          preferredName: preferredName.trim(),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; tokenId: string; cooldownRemaining: number }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body && "error" in body && body.error) ||
          "Couldn't send the verification email. Try again in a moment.";
        throw new Error(msg);
      }
      const nextSendAt = Date.now() + body.cooldownRemaining * 1000;
      setCooldown(body.cooldownRemaining);
      setVerification({ status: "sent", tokenId: body.tokenId, nextSendAt });
    } catch (err) {
      console.error(err);
      setVerification({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [universityEmail, preferredName]);

  const onCredential = useCallback(
    async (idToken: string) => {
      setError(null);
      setLoading(true);
      try {
        const result = await exchangeGoogleCredential(idToken);
        if (result.isNew) {
          setStep("profile");
        } else {
          router.push("/dashboard");
        }
      } catch (err) {
        console.error(err);
        setError("Sign-in failed. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const onScriptError = useCallback((message: string) => {
    setError(message);
  }, []);

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
    if (anyCategoryOn && !prefs.channels.gmail && !prefs.channels.uniEmail) {
      setError("Pick at least one email to send messages to, or turn off all subscriptions.");
      return;
    }

    const verified = verification.status === "verified";
    if (!verified && !allowUnverifiedSubmit) {
      setError(
        "Please verify your university email first. We sent a link to your inbox. If you're stuck, click 'I'm having trouble' below.",
      );
      return;
    }

    setLoading(true);
    try {
      await completeRegistration({
        preferredName,
        universityEmail: universityEmail.trim(),
        status: status as AffiliationStatus,
        statusOther: showStatusOther ? statusOther.trim() : undefined,
        subject,
        expectedGraduation: showGraduation ? expectedGraduation : undefined,
        motivation,
        interests: interests.trim() || undefined,
        notifications: prefs,
        verifiedTokenId: verified ? verification.tokenId : undefined,
        uniEmailVerifiedAt: verified ? verification.verifiedAt : undefined,
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
    <Card padding="lg" style={{ width: "100%", maxWidth: "32rem" }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
        Join NAISI
      </h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
        {step === "sign-in"
          ? "Apply to join the Nottingham AI Safety Initiative. We'll review your application and be in touch."
          : "Tell us a bit about you so the committee can review your application."}
      </p>

      {fromSubscriber && (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-3) var(--space-4)",
            marginBottom: "var(--space-5)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
          }}
        >
          We noticed you&apos;ve subscribed to NAISI emails before. Completing
          registration will move your subscription onto your member account so
          you don&apos;t get duplicate emails.
        </div>
      )}

      {step === "sign-in" ? (
        <>
          <GoogleSignInButton onCredential={onCredential} onScriptError={onScriptError} />
          {loading && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-4)" }}>
              Signing in…
            </p>
          )}
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
              {/* TEMPORARY (revert before re-locking registration): pattern + title removed so any email passes the client-side check during a demo. */}
              <Input
                id="universityEmail"
                type="email"
                value={universityEmail}
                onChange={(e) => setUniversityEmail(e.target.value)}
                placeholder="you@nottingham.ac.uk"
                maxLength={FIELD_LIMITS.universityEmail}
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
                }}
              >
                @nottingham.ac.uk
              </button>
            </div>

            <VerificationPanel
              state={verification}
              cooldown={cooldown}
              hasEmail={Boolean(universityEmail.trim())}
              onSend={sendVerification}
              allowUnverifiedSubmit={allowUnverifiedSubmit}
              onToggleAllowUnverified={() => setAllowUnverifiedSubmit((v) => !v)}
            />
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
            hint="e.g. interpretability, alignment, governance, evals. Anything that draws you in."
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
              gap: "var(--space-4)",
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
              Email preferences
            </legend>
            {ALL_CATEGORIES.map((cat) => (
              <Switch
                key={cat}
                checked={prefs.categories[cat]}
                onChange={(next) => setPrefs((p) => setCategory(p, cat, next))}
                label={CATEGORY_LABELS[cat]}
                description={CATEGORY_DESCRIPTIONS[cat]}
              />
            ))}
            {anyCategoryOn && (
              <div
                style={{
                  padding: "var(--space-3)",
                  background: "var(--color-bg-elevated)",
                  borderRadius: "var(--radius-md)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--color-text-muted)",
                  }}
                >
                  Deliver to
                </span>
                <Switch
                  checked={prefs.channels.gmail}
                  onChange={(next) => setPrefs((p) => setChannel(p, "gmail", next))}
                  label={`Google account email (${user?.email ?? "your sign-in email"})`}
                />
                <Switch
                  checked={prefs.channels.uniEmail}
                  onChange={(next) => setPrefs((p) => setChannel(p, "uniEmail", next))}
                  label="University email"
                />
              </div>
            )}
            <p
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--color-text-subtle)",
              }}
            >
              You can change these at any time from your profile page, and every
              email includes a one-click unsubscribe link.
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

function VerificationPanel({
  state,
  cooldown,
  hasEmail,
  onSend,
  allowUnverifiedSubmit,
  onToggleAllowUnverified,
}: {
  state: VerificationState;
  cooldown: number;
  hasEmail: boolean;
  onSend: () => void;
  allowUnverifiedSubmit: boolean;
  onToggleAllowUnverified: () => void;
}) {
  if (!hasEmail) return null;

  if (state.status === "verified") {
    return (
      <div
        style={{
          marginTop: "var(--space-3)",
          padding: "var(--space-3)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-success-soft)",
          color: "var(--color-success)",
          fontSize: "var(--text-sm)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <Badge tone="success">Verified</Badge>
        <span>You&apos;re all set. This email is confirmed.</span>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "var(--space-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <Badge tone={state.status === "sent" ? "accent" : "neutral"}>
          {state.status === "sent" ? "Check your inbox" : "Not verified"}
        </Badge>
        {state.status === "sent" ? (
          <button
            type="button"
            onClick={onSend}
            disabled={cooldown > 0}
            style={{
              padding: "0.35rem 0.7rem",
              background: "transparent",
              color: cooldown > 0 ? "var(--color-text-muted)" : "var(--color-accent)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              cursor: cooldown > 0 ? "not-allowed" : "pointer",
            }}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={state.status === "sending"}
            style={{
              padding: "0.35rem 0.7rem",
              background: "var(--color-accent)",
              color: "white",
              border: "none",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            {state.status === "sending" ? "Sending…" : "Send verification email"}
          </button>
        )}
      </div>
      {state.status === "sent" && (
        <p style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
          We&apos;ve sent a link to your university email. Click it and
          this page will update automatically when we see the click.
          Check spam if it doesn&apos;t land in a minute.
        </p>
      )}
      {state.status === "error" && (
        <p style={{ fontSize: "var(--text-xs)", color: "var(--color-danger)" }}>
          {state.message}
        </p>
      )}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--space-2)",
          fontSize: "var(--text-xs)",
          color: "var(--color-text-subtle)",
          marginTop: "var(--space-1)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={allowUnverifiedSubmit}
          onChange={onToggleAllowUnverified}
        />
        <span>
          I&apos;m having trouble with the verification email. Let me
          submit without verifying. The committee will check my email
          manually before approving.
        </span>
      </label>
    </div>
  );
}
