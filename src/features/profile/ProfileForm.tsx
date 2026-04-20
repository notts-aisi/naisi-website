"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  FIELD_LIMITS,
  normalizeUser,
  validateUniversityEmail,
  type UserDoc,
} from "@/lib/firestore/users";
import styles from "./ProfileForm.module.css";

type NewsletterPrefs = {
  subscribed: boolean;
  deliverToGmail: boolean;
  deliverToUniEmail: boolean;
};

export default function ProfileForm() {
  const { user } = useAuth();
  const [me, setMe] = useState<UserDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [deliverToGmail, setDeliverToGmail] = useState(true);
  const [deliverToUniEmail, setDeliverToUniEmail] = useState(false);

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
      const nl = normalized.profile?.newsletter;
      setSubscribed(Boolean(nl?.subscribed));
      setDeliverToGmail(nl ? Boolean(nl.deliverToGmail) : true);
      setDeliverToUniEmail(Boolean(nl?.deliverToUniEmail));
      setLoading(false);
    });
    return unsub;
  }, [user]);

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
    if (subscribed && !deliverToGmail && !deliverToUniEmail) {
      setError("Pick at least one inbox to deliver to, or turn off the subscription.");
      return;
    }

    setBusy(true);
    try {
      if (!user) throw new Error("Not signed in");
      const db = getClientDb();
      const newsletter: NewsletterPrefs = {
        subscribed,
        deliverToGmail: subscribed ? deliverToGmail : false,
        deliverToUniEmail: subscribed ? deliverToUniEmail : false,
      };
      await updateDoc(doc(db, "users", user.uid), {
        "profile.preferredName": preferredName.trim(),
        "profile.universityEmail": uniEmailTrimmed,
        "profile.newsletter": newsletter,
      });
      setSaved(true);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save");
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
            hint="Ends in @nottingham.ac.uk — optional here, required for newsletter delivery to your uni inbox."
          >
            <Input
              id="uni-email"
              type="email"
              value={universityEmail}
              onChange={(e) => setUniversityEmail(e.target.value)}
              placeholder="you@nottingham.ac.uk"
              maxLength={FIELD_LIMITS.universityEmail}
            />
          </Field>
        </div>
      </Card>

      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-1)" }}>
          <h2 style={{ fontSize: "var(--text-xl)" }}>Newsletter</h2>
          <Badge tone={subscribed ? "success" : "neutral"}>
            {subscribed ? "Subscribed" : "Unsubscribed"}
          </Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          Low-frequency updates about our courses, events, and what the committee is working on.
        </p>

        <label className={styles.bigToggle}>
          <input
            type="checkbox"
            checked={subscribed}
            onChange={(e) => setSubscribed(e.target.checked)}
          />
          <span>
            <strong>
              {subscribed ? "Subscribed to the newsletter" : "Subscribe to the newsletter"}
            </strong>
            <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", display: "block" }}>
              Uncheck to unsubscribe. We&apos;ll stop sending immediately.
            </span>
          </span>
        </label>

        {subscribed && (
          <div className={styles.deliveryBlock}>
            <p className={styles.deliveryLabel}>Deliver to</p>
            <label className={styles.deliveryOption}>
              <input
                type="checkbox"
                checked={deliverToGmail}
                onChange={(e) => setDeliverToGmail(e.target.checked)}
              />
              <span>
                My Google account email{me.email ? ` (${me.email})` : ""}
              </span>
            </label>
            <label className={styles.deliveryOption}>
              <input
                type="checkbox"
                checked={deliverToUniEmail}
                onChange={(e) => setDeliverToUniEmail(e.target.checked)}
                disabled={!universityEmail.trim()}
              />
              <span>
                My university email
                {universityEmail.trim() ? ` (${universityEmail.trim()})` : " (add one above first)"}
              </span>
            </label>
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
