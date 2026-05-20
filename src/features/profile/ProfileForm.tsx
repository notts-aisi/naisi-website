"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
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
import {
  ALL_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  getVerifiedEmails,
  isSubscribedToAnything,
  serialiseNotifications,
  type NotificationCategory,
  type NotificationPrefs,
  type VerifiedEmail,
} from "@/lib/firestore/notifications";
import styles from "./ProfileForm.module.css";

const UNI_EMAIL_LOCK_MS = 24 * 60 * 60 * 1000;

const LOCK_MESSAGE =
  "To prevent abuse, we've temporarily locked email changes on this account. If you need to update your university email before it unlocks, email ai-safety@uonsu.com from the address you'd like us to use and we'll verify and make the change manually.";

const KIND_LABEL: Record<VerifiedEmail["kind"], string> = {
  google: "Google",
  uni: "Uni",
};

type Matrix = Record<string, { newsletter: boolean; events: boolean }>;

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

/**
 * Aggregate the matrix back into the legacy notification shape so we can
 * keep `profile.notifications` and `profile.newsletter` roughly in sync
 * for any read paths that still consult them. Both sides will be cleaned
 * up in the follow-up PR after the new code paths settle.
 */
function legacyPrefsFromMatrix(
  matrix: Matrix,
  verifiedEmails: VerifiedEmail[],
): NotificationPrefs {
  const newsletter = verifiedEmails.some(
    (ve) => matrix[ve.email]?.newsletter,
  );
  const events = verifiedEmails.some((ve) => matrix[ve.email]?.events);
  const google = verifiedEmails.find((ve) => ve.kind === "google");
  const uni = verifiedEmails.find((ve) => ve.kind === "uni");
  const gmailGetsAnything = google
    ? Boolean(
        matrix[google.email]?.newsletter || matrix[google.email]?.events,
      )
    : true;
  const uniEmailGetsAnything = uni
    ? Boolean(matrix[uni.email]?.newsletter || matrix[uni.email]?.events)
    : false;
  return {
    categories: { newsletter, events },
    channels: { gmail: gmailGetsAnything, uniEmail: uniEmailGetsAnything },
  };
}

export default function ProfileForm() {
  const { user } = useAuth();
  const [me, setMe] = useState<UserDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [matrix, setMatrix] = useState<Matrix>({});

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // User doc snapshot. Drives identity (name, uni email, verified
  // status). The matrix reads from the subscriptions collection
  // separately so admin-side row flips show up live in /profile.
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
      setLoading(false);
    });
    return unsub;
  }, [user]);

  const verifiedEmails = useMemo<VerifiedEmail[]>(() => {
    if (!me) return [];
    return getVerifiedEmails({
      email: me.email,
      profile: me.profile as
        | { universityEmail?: unknown; uniEmailVerifiedAt?: unknown }
        | undefined,
    });
  }, [me]);

  // Stable join of the verified addresses — drives the subscriptions
  // query dependency without re-firing the listener on every render.
  const verifiedEmailKey = verifiedEmails.map((v) => v.email).join(",");

  // Subscriptions collection snapshot for this user. Source of truth for
  // the matrix cell values: an admin flipping a row in /admin/subscriptions
  // shows up here within one Firestore tick, so a subsequent /profile save
  // doesn't overwrite the admin's intent with stale state.
  //
  // Query by email, not audienceId: the subscription row is keyed per
  // (email, channel), and `audienceId` only records whichever account
  // touched the row last. Reading by the user's own verified addresses
  // means the matrix reflects the true state of those inboxes even if a
  // row's audienceId points elsewhere (e.g. a duplicate-email account
  // that pre-dates uniqueness enforcement).
  useEffect(() => {
    if (!user) return;
    const emails = verifiedEmailKey ? verifiedEmailKey.split(",") : [];
    if (emails.length === 0) {
      setMatrix({});
      return;
    }
    const db = getClientDb();
    const q = query(
      collection(db, "subscriptions"),
      where("email", "in", emails),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: Matrix = {};
      for (const docSnap of snap.docs) {
        const data = docSnap.data();
        const email = typeof data.email === "string" ? data.email : "";
        const channel = typeof data.channel === "string" ? data.channel : "";
        const subscribed = data.subscribed === true;
        if (!email || !channel) continue;
        if (channel !== "newsletter" && channel !== "events") continue;
        const cell = next[email] ?? { newsletter: false, events: false };
        cell[channel as NotificationCategory] = subscribed;
        next[email] = cell;
      }
      setMatrix(next);
    });
    return unsub;
  }, [user, verifiedEmailKey]);

  const anyChecked = useMemo(
    () =>
      Object.values(matrix).some(
        (cell) => cell?.newsletter || cell?.events,
      ),
    [matrix],
  );

  const hasUniEmail = universityEmail.trim().length > 0;
  const uniEmailVerified = Boolean(
    (me?.profile as { uniEmailVerifiedAt?: unknown } | undefined)?.uniEmailVerifiedAt,
  );
  const uniEmailChanged = universityEmail.trim() !== (me?.profile?.universityEmail ?? "");

  function setCell(
    email: string,
    cat: NotificationCategory,
    next: boolean,
  ) {
    setMatrix((prev) => {
      const cur = prev[email] ?? { newsletter: false, events: false };
      return { ...prev, [email]: { ...cur, [cat]: next } };
    });
  }

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
      const legacy = legacyPrefsFromMatrix(matrix, verifiedEmails);
      const patch: Record<string, unknown> = {
        "profile.preferredName": preferredName.trim(),
        "profile.universityEmail": uniEmailTrimmed,
        "profile.notifications": serialiseNotifications(legacy),
        // Older legacy field — kept roughly in sync for any code still
        // reading it pre-migration. Both legacy fields are dropped in the
        // follow-up cleanup PR after the new paths settle.
        "profile.newsletter": {
          subscribed: isSubscribedToAnything(legacy),
          deliverToGmail: legacy.channels.gmail,
          deliverToUniEmail: legacy.channels.uniEmail,
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

      // Subscriptions sync — applies the matrix as deltas onto the
      // junction collection. Fire-and-forget; the user-doc write above
      // is the part the UI confirms with "Saved." If the sync fails,
      // the legacy fields still carry intent and the next save retries.
      // Build a lean payload restricted to the addresses the user can
      // actually act on. Server-side helper double-checks regardless.
      const payloadMatrix: Matrix = {};
      for (const ve of verifiedEmails) {
        payloadMatrix[ve.email] = matrix[ve.email] ?? {
          newsletter: false,
          events: false,
        };
      }
      fetch("/api/subscriptions/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matrix: payloadMatrix }),
      }).catch((err) => {
        console.warn("[profile subscriptions sync] failed", err);
      });

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
                : "Any @nottingham.ac.uk address (subdomains like exmail.nottingham.ac.uk included). Verify it to deliver email there."
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
          <Badge tone={anyChecked ? "success" : "neutral"}>
            {anyChecked ? "Getting emails" : "No emails"}
          </Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          Pick which inbox should receive each kind of email. You can unsubscribe from any
          email with one click.
        </p>

        {verifiedEmails.length === 0 ? (
          <div className={styles.matrixEmpty}>
            We don&apos;t have a verified email address on file for you yet. Sign in
            should always provide one — try signing out and back in.
          </div>
        ) : (
          <div className={styles.matrix}>
            <div
              className={styles.matrixGrid}
              style={{
                gridTemplateColumns: `minmax(10rem, 1fr) repeat(${verifiedEmails.length}, minmax(8rem, auto))`,
              }}
            >
              <div />
              {verifiedEmails.map((ve) => (
                <div key={ve.email} className={styles.matrixHeaderEmail}>
                  <span className={styles.matrixHeaderEmailAddress}>{ve.email}</span>
                  <span className={styles.matrixHeaderEmailMeta}>
                    <span className={styles.matrixHeaderKindLabel}>
                      {KIND_LABEL[ve.kind]}
                    </span>
                    <span className={styles.matrixVerifiedTick} aria-label="Verified">
                      <span aria-hidden>✓</span> Verified
                    </span>
                  </span>
                </div>
              ))}

              {ALL_CATEGORIES.map((cat) => (
                <MatrixChannelRow
                  key={cat}
                  cat={cat}
                  emails={verifiedEmails}
                  matrix={matrix}
                  onChange={setCell}
                />
              ))}
            </div>

            <div className={styles.matrixStacked}>
              {ALL_CATEGORIES.map((cat) => (
                <section key={cat} className={styles.matrixStackedSection}>
                  <div className={styles.matrixChannelTitle}>{CATEGORY_LABELS[cat]}</div>
                  <div className={styles.matrixChannelDescription}>
                    {CATEGORY_DESCRIPTIONS[cat]}
                  </div>
                  <div className={styles.matrixStackedRows}>
                    {verifiedEmails.map((ve) => (
                      <label key={ve.email} className={styles.matrixStackedRow}>
                        <span className={styles.matrixStackedEmail}>
                          <span className={styles.matrixStackedEmailAddress}>{ve.email}</span>
                          <span className={styles.matrixStackedEmailMeta}>
                            {KIND_LABEL[ve.kind]} · Verified
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(matrix[ve.email]?.[cat])}
                          onChange={(e) => setCell(ve.email, cat, e.target.checked)}
                          aria-label={`${CATEGORY_LABELS[cat]} to ${ve.email}`}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ))}
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

function MatrixChannelRow({
  cat,
  emails,
  matrix,
  onChange,
}: {
  cat: NotificationCategory;
  emails: VerifiedEmail[];
  matrix: Matrix;
  onChange: (email: string, cat: NotificationCategory, next: boolean) => void;
}) {
  return (
    <>
      <div className={styles.matrixChannelLabel}>
        <span className={styles.matrixChannelTitle}>{CATEGORY_LABELS[cat]}</span>
        <span className={styles.matrixChannelDescription}>
          {CATEGORY_DESCRIPTIONS[cat]}
        </span>
      </div>
      {emails.map((ve) => (
        <div key={ve.email} className={styles.matrixCell}>
          <label className={styles.matrixCheckboxLabel}>
            <input
              type="checkbox"
              checked={Boolean(matrix[ve.email]?.[cat])}
              onChange={(e) => onChange(ve.email, cat, e.target.checked)}
              aria-label={`${CATEGORY_LABELS[cat]} to ${ve.email}`}
            />
            <span>Deliver here</span>
          </label>
        </div>
      ))}
    </>
  );
}
