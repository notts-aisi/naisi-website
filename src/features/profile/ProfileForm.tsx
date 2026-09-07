"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  getVerifiedEmails,
  isSubscriptionCategory,
  normaliseNotifications,
  PUSH_DESCRIPTIONS,
  serialiseNotifications,
  serialisePush,
  type NotificationPrefs,
  type SubscriptionCategory,
  type VerifiedEmail,
} from "@/lib/firestore/notifications";
import { PUSH_DEVICE_CARD_ID, usePushDevice } from "@/features/pwa/pushDevice";
import {
  columnIsOn,
  emailColumnCells,
  emptyCell,
  GRID_ROWS,
  NOTICE_ROW,
  pushColumnCells,
  pushColumnDisabled,
  pushDeviceLinkText,
  pushDisabledHint,
  setColumn,
  setEmailColumn,
  type Matrix,
} from "./notificationGrid";
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
 * Read the stored `courses` opt-out RAW, off the untouched document data.
 *
 * Absent means "hasn't answered", so the switch starts ON and only an explicit
 * stored `false` unticks it. `normaliseNotifications` now resolves this row
 * the same way (it is an OPT_OUT row), so this reader agrees with it rather
 * than working around it; it is kept because it reads the raw document and is
 * the mirror of `hasOptedOutOfCourseAnnouncements` in the run email route.
 * The two are one decision spelled in two places.
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
 * The stored cells this form reads off the live document rather than deriving.
 *
 * The grid draws all of them now, but the reason for reading them here has not
 * changed: the Save button writes the WHOLE `profile.notifications` map, so a
 * cell this form did not know about would be reset to its default every time
 * somebody changed their preferred name. That is also why the push map is read
 * even though the push column saves itself on toggle: a save that ran a moment
 * after a toggle must write the toggled value, not the one this form started
 * with. Read through `normaliseNotifications` so "absent" resolves to the same
 * default every other reader sees.
 */
function readCarriedPrefs(data: Record<string, unknown> | undefined): {
  push: NotificationPrefs["push"];
  taskEmails: boolean;
} {
  const profile = (data?.profile as Record<string, unknown> | undefined) ?? {};
  const prefs = normaliseNotifications({
    notifications: profile.notifications,
    newsletter: profile.newsletter,
  });
  return { push: prefs.push, taskEmails: prefs.categories.tasks };
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
  taskEmails: boolean,
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
    // `courses` and `tasks` come from their own cells of the grid, not from
    // the matrix: neither is a per-address subscription. Both MUST be carried
    // through: `serialiseNotifications` writes all four booleans, so dropping
    // either would store a `false` on every save that the run email route and
    // the task senders read as an explicit refusal.
    categories: { newsletter, events, courses: courseAnnouncements, tasks: taskEmails },
    channels: { gmail: gmailGetsAnything, uniEmail: uniEmailGetsAnything },
    // Passed straight through from state, which the push column keeps in step
    // with the document by writing its own leaf on every toggle. This save
    // must not be the thing that decides the push column, only the thing that
    // avoids trampling it. See readCarriedPrefs.
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
  // The push column. Held in state like the email cells, but SAVED ON TOGGLE
  // through a leaf write rather than by the Save button: the two columns of
  // one row are edited on one line, and a member who flips a notification
  // must not have their unsaved email edits written with it.
  const [pushPrefs, setPushPrefs] = useState<NotificationPrefs["push"]>({
    newsletter: false,
    events: false,
    courses: true,
    tasks: true,
  });
  const [pushError, setPushError] = useState<string | null>(null);
  const [taskEmails, setTaskEmails] = useState(true);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this browser can receive a notification at all. Shared with the
  // device card below the form (src/features/pwa/pushDevice.tsx) so the two
  // cannot disagree, and so the environment is probed once.
  const { state: pushDeviceState, cardShown: pushCardShown } = usePushDevice();
  const pushDisabled = pushColumnDisabled(pushDeviceState);

  /**
   * Whether the fields the SAVE BUTTON owns are carrying an unsaved edit.
   *
   * This matters because the push column moved into this form: a push cell
   * saves itself the moment it is flipped, that write changes `users/{uid}`,
   * and the listener below fires with it. Re-filling every field on each
   * snapshot regardless would throw away a half-typed preferred name, or a
   * course cell the member had unticked and not yet saved, because they
   * flipped an unrelated notification.
   *
   * A one-shot "hydrated" latch would fix that and break something else: the
   * form would then never see a later write to those cells at all, so an
   * `/api/unsubscribe` click, a second tab or an admin route flipping
   * `categories.courses` while /profile is open would be reverted by the whole
   * map this form writes on its next Save. That is exactly the stale-state
   * overwrite the subscriptions listener below refuses to allow, and the same
   * answer applies here: read the document again whenever there is nothing to
   * lose by doing so. So the refill is skipped only while the member has an
   * edit in flight, and `markDirty` is called from every control that makes
   * one.
   *
   * The push map is outside the question entirely: it is taken from every
   * snapshot, because nothing here edits it without writing it first.
   */
  const dirty = useRef(false);

  /**
   * Called by every control the Save button owns, and by nothing else.
   *
   * A ref rather than state: this changes no rendering, and the listener has
   * to read the CURRENT answer rather than the one captured when it was
   * registered.
   */
  function markDirty() {
    dirty.current = true;
  }

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
      const carried = readCarriedPrefs(snap.data());
      setPushPrefs(carried.push);
      if (!dirty.current) {
        setPreferredName(normalized.profile?.preferredName ?? "");
        setUniversityEmail(normalized.profile?.universityEmail ?? "");
        // Raw data, not the normalized doc: `UserProfile.notifications` is
        // typed as the full shape, so a missing `courses` reads as `false`
        // through it.
        setCourseAnnouncements(readCourseAnnouncements(snap.data()));
        setTaskEmails(carried.taskEmails);
      }
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
    // Both clauses are load-bearing. firestore.rules grants a non-admin read
    // on `audience == 'user' && audienceId == auth.uid`, and Firestore
    // judges a query by its shape, not its results: a query that does not
    // itself pin `audience` could in principle match another audience's
    // row, so the whole listen is denied (permission-denied in the console,
    // and an Email Preferences grid that silently shows nothing). Admins
    // never noticed because the admin branch of the rule has no such clause.
    const q = query(
      collection(db, "subscriptions"),
      where("audience", "==", "user"),
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

  const addresses = useMemo(
    () => verifiedEmails.map((ve) => ve.email),
    [verifiedEmails],
  );

  /**
   * Any SUBSCRIPTION at all, across every address — the matrix only.
   *
   * Deliberately not counting `courses` or `tasks`: neither is a list anyone
   * subscribed to, so a badge reading "subscribed" off them would be claiming
   * something the member never did. It is also why the badge says "no
   * subscriptions" rather than "no emails": a member with an empty matrix
   * still gets their group's practical email and everything else
   * transactional, and a badge promising silence would be a lie the first
   * time a session moved.
   */
  const anyChecked = useMemo(
    () =>
      Object.values(matrix).some(
        (cell) => cell?.newsletter || cell?.events,
      ),
    [matrix],
  );

  // The two column masters. Each reads ON only when every cell under it is
  // on, and writes the same per-row booleans the cells write: a master is a
  // convenience over the column, never a third stored value. See
  // notificationGrid.ts, where both rules are unit-tested.
  const emailAllOn = columnIsOn(
    emailColumnCells(
      { matrix, courses: courseAnnouncements, tasks: taskEmails },
      addresses,
    ),
  );
  const pushAllOn = columnIsOn(pushColumnCells(pushPrefs));

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

  function setEmailAll(next: boolean) {
    // Two of the four cells this moves are save-owned, so the master is an
    // edit in flight like any other.
    markDirty();
    const updated = setEmailColumn(
      { matrix, courses: courseAnnouncements, tasks: taskEmails },
      addresses,
      next,
    );
    setMatrix(updated.matrix);
    setCourseAnnouncements(updated.courses);
    setTaskEmails(updated.tasks);
  }

  /**
   * The push column's write: a LEAF at `profile.notifications.push`.
   *
   * Not the whole map, because the email half of that map is mid-edit in this
   * form and a whole-map write here would save it early. The Save button
   * carries this map back untouched (`legacyPrefsFromMatrix`), so the two
   * writers cannot invent a value for each other's half.
   */
  async function writePush(next: NotificationPrefs["push"]) {
    if (!user) return;
    const previous = pushPrefs;
    setPushPrefs(next);
    setPushError(null);
    try {
      await updateDoc(doc(getClientDb(), "users", user.uid), {
        "profile.notifications.push": serialisePush(next),
      });
    } catch (err) {
      console.warn("[profile notifications] saving a notification setting failed", err);
      setPushPrefs(previous);
      setPushError("That notification setting did not save. Try again in a moment.");
    }
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
        taskEmails,
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
          // which now counts `courses` and `tasks` too. This field is the legacy
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
      // Written, so there is nothing left to lose: the listener may fill these
      // fields from the document again, and pick up anything that landed while
      // the member was editing.
      dirty.current = false;

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
              onChange={(e) => {
                markDirty();
                setPreferredName(e.target.value);
              }}
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
              onChange={(e) => {
                markDirty();
                setUniversityEmail(e.target.value);
              }}
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
          <h2 style={{ fontSize: "var(--text-xl)" }}>Email and notifications</h2>
          {/* Addressed by the browser end-to-end suite: the badge is how a
              member is told, in one word, whether they are on any of our
              lists at all. It counts the two subscription rows only. */}
          <Badge
            tone={anyChecked ? "success" : "neutral"}
            data-testid="profile-subscriptions-badge"
          >
            {anyChecked ? "Subscribed" : "No subscriptions"}
          </Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
          One row per kind of message, one column per way of reaching you. The
          newsletter and event announcements carry a one-click unsubscribe link
          and can go to whichever inbox you like. Email about something you are
          already part of (your reading group&apos;s session moving, an RSVP
          confirmation) is not a subscription and reaches you either way.
        </p>

        {verifiedEmails.length === 0 ? (
          <div className={styles.matrixEmpty}>
            We don&apos;t have a verified email address on file for you yet. Sign in
            should always provide one — try signing out and back in.
          </div>
        ) : (
          <>
            <p className={styles.addressLine}>
              {verifiedEmails.length === 1 ? "Delivering to " : "Delivering to your "}
              {verifiedEmails.map((ve, i) => (
                <span key={ve.email} className={styles.addressChip}>
                  {i > 0 && <span aria-hidden> and </span>}
                  <span className={styles.addressText}>{ve.email}</span>
                  <span className={styles.addressMeta}>
                    {KIND_LABEL[ve.kind]}
                    <span className={styles.addressVerified} aria-label="Verified">
                      <span aria-hidden>✓</span> Verified
                    </span>
                  </span>
                </span>
              ))}
            </p>

            {/* ONE GRID, rows against two columns, and the same element the
                browser suite has always driven (`profile-subscriptions-grid`).
                It is a real CSS grid on a wide screen and a stack of per-row
                cards on a narrow one, from ONE set of nodes: a second copy of
                the rows for small screens would put two controls under every
                accessible label, and the suite finds each cell by its label. */}
            <div className={styles.notifGrid} data-testid="profile-subscriptions-grid">
              <div className={styles.notifHead}>
                <div className={styles.notifHeadCorner}>
                  <span className={styles.notifHeadCornerTitle}>What we send</span>
                </div>
                <div className={styles.notifHeadCell}>
                  <span className={styles.notifHeadTitle}>Email</span>
                  <label
                    className={styles.notifMaster}
                    data-testid="profile-notifications-master-email"
                  >
                    <input
                      type="checkbox"
                      checked={emailAllOn}
                      onChange={(e) => setEmailAll(e.target.checked)}
                      aria-label="All email on or off"
                    />
                    <span>All</span>
                  </label>
                </div>
                <div className={styles.notifHeadCell}>
                  <span className={styles.notifHeadTitle}>Push</span>
                  <label
                    className={styles.notifMaster}
                    data-testid="profile-notifications-master-push"
                  >
                    <input
                      type="checkbox"
                      checked={pushAllOn}
                      disabled={pushDisabled}
                      onChange={(e) => void writePush(setColumn(pushPrefs, e.target.checked))}
                      aria-label="All notifications on or off"
                    />
                    <span>All</span>
                  </label>
                  {pushDisabled && (
                    <p className={styles.notifHint}>
                      {pushDisabledHint(pushDeviceState)}
                      {/* Only where the card below has something to offer, and
                          in the words that match it: linking "turn them on" to
                          a card that says the site is blocked would send the
                          member after a switch that is not there. */}
                      {pushCardShown && pushDeviceLinkText(pushDeviceState) && (
                        <>
                          {" "}
                          <a href={`#${PUSH_DEVICE_CARD_ID}`}>
                            {pushDeviceLinkText(pushDeviceState)}
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {GRID_ROWS.map((row) => (
                <div key={row} className={styles.notifRow}>
                  <div className={styles.notifRowLabel}>
                    <span className={styles.notifRowTitle}>{CATEGORY_LABELS[row]}</span>
                    <span className={styles.notifRowDescription}>
                      {CATEGORY_DESCRIPTIONS[row]}
                    </span>
                    {/* The push note's second home, drawn by CSS only when the
                        grid is narrow (see the @container block in the
                        stylesheet); the copy in the Push cell is hidden then,
                        so one sentence is on screen at a time. */}
                    <span className={styles.notifRowPushNote}>
                      <span className={styles.notifRowPushNoteLabel}>Push</span>
                      {PUSH_DESCRIPTIONS[row]}
                    </span>
                  </div>
                  <div className={styles.notifCell}>
                    <span className={styles.notifCellName}>Email</span>
                    {isSubscriptionCategory(row) ? (
                      // The per-address matrix, kept: these two rows mint a
                      // `subscriptions` row per (address, channel), so the
                      // member picks the inbox as well as the answer. With one
                      // verified address it is one plain box writing that
                      // address, and the label is the same either way because
                      // the suite locates it by that label.
                      verifiedEmails.map((ve) => (
                        <label key={ve.email} className={styles.notifCheck}>
                          <input
                            type="checkbox"
                            checked={Boolean(matrix[ve.email]?.[row])}
                            onChange={(e) => setCell(ve.email, row, e.target.checked)}
                            aria-label={`${CATEGORY_LABELS[row]} to ${ve.email}`}
                          />
                          <span className={styles.notifCheckText}>
                            {verifiedEmails.length === 1 ? "Email me" : ve.email}
                          </span>
                        </label>
                      ))
                    ) : (
                      <label className={styles.notifCheck}>
                        <input
                          type="checkbox"
                          checked={row === "courses" ? courseAnnouncements : taskEmails}
                          onChange={(e) => {
                            markDirty();
                            if (row === "courses") setCourseAnnouncements(e.target.checked);
                            else setTaskEmails(e.target.checked);
                          }}
                          aria-label={`${CATEGORY_LABELS[row]} email`}
                        />
                        <span className={styles.notifCheckText}>Email me</span>
                      </label>
                    )}
                  </div>
                  <div className={styles.notifCell}>
                    <span className={styles.notifCellName}>Push</span>
                    <label className={styles.notifCheck}>
                      <input
                        type="checkbox"
                        checked={pushPrefs[row]}
                        disabled={pushDisabled}
                        onChange={(e) =>
                          void writePush({ ...pushPrefs, [row]: e.target.checked })
                        }
                        aria-label={`${CATEGORY_LABELS[row]} notifications`}
                      />
                      <span className={styles.notifCheckText}>Notify me</span>
                    </label>
                    <span className={styles.notifCellNote}>{PUSH_DESCRIPTIONS[row]}</span>
                  </div>
                </div>
              ))}

              {/* LOCKED, and drawn rather than left out. A member switching
                  everything else off should be told here that an organiser can
                  still reach them about a change to something they signed up
                  for, instead of finding out the first time one does. Both
                  cells are on, disabled, and say so in words as well as in
                  colour; nothing in this component writes them. */}
              <div
                className={`${styles.notifRow} ${styles.notifRowLocked}`}
                data-testid="profile-notifications-important-row"
              >
                <div className={styles.notifRowLabel}>
                  <span className={styles.notifRowTitle}>
                    {NOTICE_ROW.label}
                    <span className={styles.notifLockPill}>Locked</span>
                  </span>
                  <span className={styles.notifRowDescription}>
                    {NOTICE_ROW.description}
                  </span>
                </div>
                <div className={styles.notifCell}>
                  <span className={styles.notifCellName}>Email</span>
                  <label className={styles.notifCheck}>
                    <input
                      type="checkbox"
                      checked
                      readOnly
                      disabled
                      aria-disabled="true"
                      aria-label="Important notices by email"
                    />
                    <span className={styles.notifCheckText}>{NOTICE_ROW.cellText}</span>
                  </label>
                </div>
                <div className={styles.notifCell}>
                  <span className={styles.notifCellName}>Push</span>
                  <label className={styles.notifCheck}>
                    <input
                      type="checkbox"
                      checked
                      readOnly
                      disabled
                      aria-disabled="true"
                      aria-label="Important notices by notification"
                    />
                    <span className={styles.notifCheckText}>{NOTICE_ROW.cellText}</span>
                  </label>
                </div>
              </div>
            </div>

            <p className={styles.notifFootnote}>
              The Push column saves as you switch it, on every device you are
              signed in on. The Email column saves with the button below.
            </p>
            {pushError && <p className={styles.notifError}>{pushError}</p>}
          </>
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
