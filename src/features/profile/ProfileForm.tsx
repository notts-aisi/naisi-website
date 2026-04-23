"use client";

import { useEffect, useMemo, useState } from "react";
import { deleteField, doc, onSnapshot, Timestamp, updateDoc } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Switch from "@/components/ui/Switch";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  FIELD_LIMITS,
  normalizeUser,
  validateUniversityEmail,
  type UserDoc,
} from "@/lib/firestore/users";
import {
  ALL_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  DEFAULT_NOTIFICATION_PREFS,
  isSubscribedToAnything,
  normaliseNotifications,
  serialiseNotifications,
  setCategory,
  setChannel,
  type NotificationPrefs,
} from "@/lib/firestore/notifications";
import styles from "./ProfileForm.module.css";

const UNI_EMAIL_LOCK_MS = 24 * 60 * 60 * 1000;

const LOCK_MESSAGE =
  "To prevent abuse, we've temporarily locked email changes on this account. If you need to update your university email before it unlocks, email ai-safety@uonsu.com from the address you'd like us to use and we'll verify and make the change manually.";

function asDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate: () => Date }).toDate();
    } catch {
      return null;
    }
  }
  return null;
}

export default function ProfileForm() {
  const { user } = useAuth();
  const [me, setMe] = useState<UserDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const db = getClientDb();
    const unsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) {
        setLoading(false);
        return;
      }
      const normalized = normalizeUser(snap.id, snap.data());
      setMe(normalized);
      setPreferredName(normalized.profile?.preferredName ?? "");
      setUniversityEmail(normalized.profile?.universityEmail ?? "");
      setPrefs(normaliseNotifications(normalized.profile ?? {}));
      setLoading(false);
    });
    return unsub;
  }, [user]);

  const anyCategoryOn = useMemo(() => isSubscribedToAnything(prefs), [prefs]);
  const hasUniEmail = universityEmail.trim().length > 0;
  const uniEmailVerified = Boolean(
    (me?.profile as { uniEmailVerifiedAt?: unknown } | undefined)?.uniEmailVerifiedAt,
  );
  const uniEmailChanged = universityEmail.trim() !== (me?.profile?.universityEmail ?? "");

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const uniEmailTrimmed = universityEmail.trim();
    if (uniEmailTrimmed) {
      const emailError = validateUniversityEmail(uniEmailTrimmed);
      if (emailError) {
        setError(emailError);
        return;
      }
    }
    if (anyCategoryOn && !prefs.channels.gmail && !prefs.channels.uniEmail) {
      setError("Pick at least one inbox to deliver to, or turn off all subscriptions.");
      return;
    }
    if (anyCategoryOn && prefs.channels.uniEmail && !hasUniEmail) {
      setError("Add your university email above, or turn off 'University email' delivery.");
      return;
    }

    const previousUniEmail = me?.profile?.universityEmail ?? "";
    const uniEmailChanging = uniEmailTrimmed !== previousUniEmail;
    if (uniEmailChanging) {
      const lockUntil = asDate(
        (me?.profile as { universityEmailLockUntil?: unknown } | undefined)
          ?.universityEmailLockUntil,
      );
      if (lockUntil && lockUntil > new Date()) {
        setError(LOCK_MESSAGE);
        return;
      }
    }

    setBusy(true);
    try {
      if (!user) throw new Error("Not signed in");
      const db = getClientDb();
      const patch: Record<string, unknown> = {
        "profile.preferredName": preferredName.trim(),
        "profile.universityEmail": uniEmailTrimmed,
        "profile.notifications": serialiseNotifications(prefs),
        // Keep the legacy field roughly in sync for any code still reading it
        // pre-migration. This is belt + braces — the normaliser prefers
        // `notifications` — but avoids surprise drift on a partial rollout.
        "profile.newsletter": {
          subscribed: anyCategoryOn,
          deliverToGmail: prefs.channels.gmail,
          deliverToUniEmail: prefs.channels.uniEmail,
        },
      };
      const wasSuppressed = Boolean(
        (me?.profile as { universityEmailWasSuppressed?: boolean } | undefined)
          ?.universityEmailWasSuppressed,
      );
      if (uniEmailChanging && wasSuppressed) {
        patch["profile.universityEmailLockUntil"] = new Date(Date.now() + UNI_EMAIL_LOCK_MS);
        patch["profile.universityEmailWasSuppressed"] = deleteField();
      } else if (uniEmailChanging) {
        patch["profile.universityEmailLockUntil"] = deleteField();
      }
      // Any uni-email change invalidates an old verified-at stamp — the
      // user needs to re-verify the new address before it's trusted again.
      if (uniEmailChanging) {
        patch["profile.uniEmailVerifiedAt"] = deleteField();
      }
      await updateDoc(doc(db, "users", user.uid), patch);
      setSaved(true);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function onRequestVerification() {
    setError(null);
    const emailError = validateUniversityEmail(universityEmail);
    if (emailError) {
      setError(emailError);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/verify-email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: universityEmail.trim().toLowerCase(),
          preferredName: preferredName.trim() || me?.displayName || "",
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? "Verification email failed to send");
      }
      setSaved(true);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Verification email failed to send");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading your profile…</p>
      </Card>
    );
  }
  if (!me) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>
          We couldn&apos;t find your profile record. Try signing out and back in.
        </p>
      </Card>
    );
  }

  const uniChannelDisabled = !hasUniEmail;

  return (
    <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", marginBottom: "var(--space-1)" }}>
          Your details
        </h2>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          Shown to the committee. Your Google account email stays linked automatically.
        </p>
        <div className={styles.grid}>
          <Field id="pref-name" label="Preferred name">
            <Input
              id="pref-name"
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              maxLength={FIELD_LIMITS.preferredName}
            />
          </Field>
          <Field
            id="uni-email"
            label="University email"
            hint={
              uniEmailVerified && !uniEmailChanged
                ? "Verified. If you change it, you'll need to verify the new address."
                : "Any @nottingham.ac.uk address (subdomains like exmail.nottingham.ac.uk included). Required if you want events/newsletter delivered to your uni inbox."
            }
          >
            <Input
              id="uni-email"
              type="email"
              value={universityEmail}
              onChange={(e) => setUniversityEmail(e.target.value)}
              placeholder="you@nottingham.ac.uk"
              maxLength={FIELD_LIMITS.universityEmail}
            />
            <div className={styles.verifyRow}>
              {uniEmailVerified && !uniEmailChanged ? (
                <Badge tone="success">Verified</Badge>
              ) : hasUniEmail ? (
                <>
                  <Badge tone="neutral">Not verified</Badge>
                  <button
                    type="button"
                    onClick={onRequestVerification}
                    disabled={busy}
                    className={styles.verifyButton}
                  >
                    Send verification email
                  </button>
                </>
              ) : null}
            </div>
          </Field>
        </div>
      </Card>

      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-1)" }}>
          <h2 style={{ fontSize: "var(--text-xl)" }}>Email preferences</h2>
          <Badge tone={anyCategoryOn ? "success" : "neutral"}>
            {anyCategoryOn ? "Getting emails" : "No emails"}
          </Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          Pick what you want us to email you about. You can unsubscribe from any
          email with one click.
        </p>

        <div className={styles.categoryList}>
          {ALL_CATEGORIES.map((cat) => (
            <div key={cat} className={styles.categoryRow}>
              <Switch
                checked={prefs.categories[cat]}
                onChange={(next) => setPrefs((p) => setCategory(p, cat, next))}
                label={CATEGORY_LABELS[cat]}
                description={CATEGORY_DESCRIPTIONS[cat]}
                size="lg"
                tone="accent"
              />
            </div>
          ))}
        </div>

        {anyCategoryOn && (
          <div className={styles.deliveryBlock}>
            <p className={styles.deliveryLabel}>Deliver to</p>
            <div className={styles.channelList}>
              <Switch
                checked={prefs.channels.gmail}
                onChange={(next) => setPrefs((p) => setChannel(p, "gmail", next))}
                label={`Google account email${me.email ? ` (${me.email})` : ""}`}
              />
              <Switch
                checked={prefs.channels.uniEmail}
                onChange={(next) => setPrefs((p) => setChannel(p, "uniEmail", next))}
                disabled={uniChannelDisabled}
                label={
                  hasUniEmail
                    ? `University email (${universityEmail.trim()})`
                    : "University email (add one above first)"
                }
              />
            </div>
          </div>
        )}
      </Card>

      {error && <p style={{ color: "var(--color-danger)" }}>{error}</p>}
      {saved && !error && (
        <p style={{ color: "var(--color-success)" }}>Saved.</p>
      )}

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
