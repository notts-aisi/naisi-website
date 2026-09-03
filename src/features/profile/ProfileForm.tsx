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
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  getVerifiedEmails,
  isSubscriptionCategory,
  normaliseNotifications,
  serialiseNotifications,
  SUBSCRIPTION_CATEGORIES,
  type NotificationPrefs,
  type SubscriptionCategory,
  type VerifiedEmail,
} from "@/lib/firestore/notifications";
import MembershipBadge from "./MembershipBadge";
import styles from "./ProfileForm.module.css";

const UNI_EMAIL_LOCK_MS = 24 * 60 * 60 * 1000;

const LOCK_MESSAGE =
  "To prevent abuse, we've temporarily locked email changes on this account. If you need to update your university email before it unlocks, email ai-safety@uonsu.com from the address you'd like us to use and we'll verify and make the change manually.";

const KIND_LABEL: Record<VerifiedEmail["kind"], string> = {
  google: "Google",
  uni: "Uni",
};

/**
 * The per-address matrix covers only the categories that ARE subscription
 * channels. `courses` is account-level (one opt-out, not one row per address)
 * and rides the standalone switch below the matrix — see
 * `SUBSCRIPTION_CATEGORIES` in notifications.ts.
 */
type Matrix = Record<string, Record<SubscriptionCategory, boolean>>;

function emptyCell(): Record<SubscriptionCategory, boolean> {
  return { newsletter: false, events: false };
}

/**
 * Read the stored `courses` opt-out RAW, off the untouched document data —
 * deliberately NOT via `normaliseNotifications`, which collapses "absent" and
 * "false" into the same `false`. Absent means "hasn't answered", so the switch
 * starts ON and only an explicit stored `false` unticks it. Getting this wrong
 * would show every member who has never answered as opted out, and then store
 * that invented refusal on their next save. Mirror of
 * `hasOptedOutOfCourseAnnouncements` in the run email route — the two are one
 * decision spelled in two places.
 */
function readCourseAnnouncements(data: Record<string, unknown> | undefined): boolean {
  const profile = (data?.profile as Record<string, unknown> | undefined) ?? {};
  const notifications = profile.notifications;
  if (!notifications || typeof notifications !== "object") return true;
  const categories = (notifications as Record<string, unknown>).categories;
  if (!categories || typeof categories !== "object") return true;
  return (categories as Record<string, unknown>).courses !== false;
}

/**
 * The push switches are NOT on this form: they live on the push card, beside
 * the per-device opt-in they qualify. This form still has to read them,
 * because its save writes the whole `profile.notifications` map and would
 * otherwise reset both keys to the default every time somebody changed their
 * preferred name. Read through `normaliseNotifications` so "absent" resolves
 * to the same default the card shows.
 */
function readPushPrefs(
  data: Record<string, unknown> | undefined,
): NotificationPrefs["push"] {
  const profile = (data?.profile as Record<string, unknown> | undefined) ?? {};
  return normaliseNotifications({
    notifications: profile.notifications,
    newsletter: profile.newsletter,
  }).push;
}

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
  courseAnnouncements: boolean,
  push: NotificationPrefs["push"],
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
    // `courses` comes from the standalone switch, not the matrix. It MUST be
    // carried through: `serialiseNotifications` writes all three booleans, so
    // dropping it here would store `courses: false` on every save and the run
    // email route would read that as an explicit refusal.
    categories: { newsletter, events, courses: courseAnnouncements },
    channels: { gmail: gmailGetsAnything, uniEmail: uniEmailGetsAnything },
    // Passed straight through from the stored document, never derived here.
    // This form does not own the push switches; it only has to avoid
    // trampling them. See readPushPrefs.
    push,
  };
}

export default function ProfileForm() {
  const { user } = useAuth();
  const [me, setMe] = useState<UserDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const [preferredName, setPreferredName] = useState("");
  const [universityEmail, setUniversityEmail] = useState("");
  const [matrix, setMatrix] = useState<Matrix>({});
  // Account-level, not per-address. Starts ON: absent = "hasn't answered",
  // and cohort mail is an opt-out. See readCourseAnnouncements.
  const [courseAnnouncements, setCourseAnnouncements] = useState(true);
  // Read-only here, and edited on the push card. Held in state purely so the
  // save below can write the map back unchanged. See readPushPrefs.
  const [pushPrefs, setPushPrefs] = useState<NotificationPrefs["push"]>({
    tasks: true,
    courseDecisions: true,
  });

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
      // Raw data, not the normalized doc: `UserProfile.notifications` is typed
      // as the full shape, so a missing `courses` reads as `false` through it.
      setCourseAnnouncements(readCourseAnnouncements(snap.data()));
      setPushPrefs(readPushPrefs(snap.data()));
      setLoading(false);
    });
    return unsub;
  }, [user]);

  // Subscriptions collection snapshot for this user. Source of truth for
  // the matrix cell values: an admin flipping a row in /admin/subscriptions
  // shows up here within one Firestore tick, so a subsequent /profile save
  // doesn't overwrite the admin's intent with stale state.
  useEffect(() => {
    if (!user) return;
    const db = getClientDb();
    const q = query(
      collection(db, "subscriptions"),
      where("audienceId", "==", user.uid),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: Matrix = {};
      for (const docSnap of snap.docs) {
        const data = docSnap.data();
        const email = typeof data.email === "string" ? data.email : "";
        const channel = typeof data.channel === "string" ? data.channel : "";
        const subscribed = data.subscribed === true;
        if (!email || !channel) continue;
        // Only the matrix-backed channels. A `cohort:<runId>` row belongs to
        // the course cohort, not to a checkbox here.
        if (!isSubscriptionCategory(channel)) continue;
        const cell = next[email] ?? emptyCell();
        cell[channel] = subscribed;
        next[email] = cell;
      }
      setMatrix(next);
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

  /**
   * Any SUBSCRIPTION at all, across every address — the matrix only.
   *
   * Deliberately not counting `courses`: that switch is an opt-out on mail a
   * cohort sends its own members, not a list anyone subscribed to, so a badge
   * reading "subscribed" off it would be claiming something the member never
   * did. It is also why the badge says "no subscriptions" rather than "no
   * emails": a member with an empty matrix still gets their group's practical
   * email and everything else transactional, and a badge promising silence
   * would be a lie the first time a session moved.
   */
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
    cat: SubscriptionCategory,
    next: boolean,
  ) {
    setMatrix((prev) => {
      const cur = prev[email] ?? emptyCell();
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
      const legacy = legacyPrefsFromMatrix(
        matrix,
        verifiedEmails,
        courseAnnouncements,
        pushPrefs,
      );
      const patch: Record<string, unknown> = {
        "profile.preferredName": preferredName.trim(),
        "profile.universityEmail": uniEmailTrimmed,
        "profile.notifications": serialiseNotifications(legacy),
        // Older legacy field — kept roughly in sync for any code still
        // reading it pre-migration. Both legacy fields are dropped in the
        // follow-up cleanup PR after the new paths settle.
        "profile.newsletter": {
          // Matrix-backed categories only — NOT `isSubscribedToAnything`,
          // which now counts `courses` too. This field is the legacy
          // newsletter flag some read paths still show as "newsletter: yes"
          // (e.g. the admin approval card); a default-on course opt-out must
          // not flip it. Same value this line produced before `courses`
          // existed.
          subscribed: legacy.categories.newsletter || legacy.categories.events,
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
        payloadMatrix[ve.email] = matrix[ve.email] ?? emptyCell();
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

      <MembershipBadge />

      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-1)" }}>
          <h2 style={{ fontSize: "var(--text-xl)" }}>Email preferences</h2>
          <Badge tone={anyChecked ? "success" : "neutral"}>
            {anyChecked ? "Subscribed" : "No subscriptions"}
          </Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          Pick which inbox should receive the newsletter and event announcements —
          every one of those carries a one-click unsubscribe link. Email about
          something you are already part of — your reading group&apos;s session
          moving, an RSVP confirmation — is not a subscription and reaches you
          either way.
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

              {SUBSCRIPTION_CATEGORIES.map((cat) => (
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
              {SUBSCRIPTION_CATEGORIES.map((cat) => (
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

        {/*
          Account-level, so it sits outside the per-address matrix: cohort mail
          is addressed by the `cohort:<runId>` subscription written to the one
          proven address at allocation, and a per-address checkbox here could
          not move it. Rendered for everyone, not just enrolled members — it is
          the switch that makes an unticked box mean a refusal the member
          actually made, which is the whole premise of the opt-out.

          The eyebrow is not decoration. Directly under a grid of per-address
          checkboxes, a lone switch reads as another row of that grid; this
          says what it actually is before the label does, and names the one
          thing it explicitly does NOT reach.
        */}
        <div className={styles.accountToggle}>
          <p className={styles.accountToggleEyebrow}>
            One setting for the whole account
          </p>
          <Switch
            checked={courseAnnouncements}
            onChange={setCourseAnnouncements}
            label={CATEGORY_LABELS.courses}
            description={CATEGORY_DESCRIPTIONS.courses}
          />
          <p className={styles.accountToggleNote}>
            Not a subscription and not per-inbox: a cohort emails whichever
            address the course has already proven for you. Leaving it on is not
            a promise of mail — it just means you have not asked your cohorts to
            stop.
          </p>
        </div>
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
  cat: SubscriptionCategory;
  emails: VerifiedEmail[];
  matrix: Matrix;
  onChange: (email: string, cat: SubscriptionCategory, next: boolean) => void;
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
