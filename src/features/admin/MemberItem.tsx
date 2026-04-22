"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import type { Role } from "@/lib/firebase/session";
import {
  ALL_TRACKS,
  STATUS_LABELS,
  TRACK_LABELS,
  type AffiliationStatus,
  type Track,
  type UserDoc,
  type UserPermissions,
} from "@/lib/firestore/users";
import MemberEditForm from "./MemberEditForm";
import {
  deleteUser,
  setNewsletterSubscribed,
  setPermissions,
  setRole,
  setTracks,
  unrejectUser,
  updateMember,
} from "./adminMutations";
import styles from "./MemberItem.module.css";

type Props = {
  user: UserDoc;
  currentAdminUid: string;
  expanded: boolean;
  onToggleExpand: () => void;
};

const ACTIVE_ROLES: Role[] = ["member", "committee", "admin"];

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

function roleTone(role: Role): Tone {
  switch (role) {
    case "admin":
      return "accent";
    case "committee":
      return "success";
    case "rejected":
      return "danger";
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
}

function statusTone(status: AffiliationStatus): Tone {
  switch (status) {
    case "foundation":
    case "postdoc":
      return "warning";
    case "undergraduate":
      return "accent";
    case "masters":
      return "success";
    case "phd":
      return "danger";
    case "employee":
    case "other":
    default:
      return "neutral";
  }
}

function trackTone(track: Track): Tone {
  return track === "technical" ? "accent" : "success";
}

function shortStatusLabel(status: AffiliationStatus): string {
  switch (status) {
    case "undergraduate":
      return "Undergrad";
    case "masters":
      return "Masters";
    case "phd":
      return "PhD";
    case "postdoc":
      return "Postdoc";
    case "foundation":
      return "Foundation";
    case "employee":
      return "Staff";
    case "other":
      return "Other";
    default:
      return STATUS_LABELS[status as AffiliationStatus] ?? status;
  }
}

export default function MemberItem({ user, currentAdminUid, expanded, onToggleExpand }: Props) {
  const [busy, setBusy] = useState(false);

  const isSelf = user.uid === currentAdminUid;
  const isRejected = user.role === "rejected";
  const displayName =
    user.displayName ?? user.profile?.preferredName ?? user.email ?? "Unnamed";

  async function onRoleChange(next: Role) {
    if (next === user.role) return;
    if (isSelf && next !== "admin") {
      const ok = window.confirm(
        "Demote yourself from admin? You'll lose admin access on next page load.",
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await setRole(user.uid, next);
    } catch (err) {
      console.error(err);
      alert("Failed to change role");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleShow() {
    setBusy(true);
    try {
      await updateMember(user.uid, { showOnMembers: !user.showOnMembers });
    } catch (err) {
      console.error(err);
      alert("Failed to update visibility");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleNewsletter() {
    const currentlySubscribed = Boolean(user.profile?.newsletter?.subscribed);
    setBusy(true);
    try {
      await setNewsletterSubscribed(user.uid, !currentlySubscribed);
    } catch (err) {
      console.error(err);
      alert("Failed to update newsletter subscription");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleTrack(track: Track) {
    const current = new Set(user.tracks ?? []);
    if (current.has(track)) current.delete(track);
    else current.add(track);
    // Preserve canonical order so downstream equality checks stay stable.
    const next = ALL_TRACKS.filter((t) => current.has(t));
    setBusy(true);
    try {
      await setTracks(user.uid, next);
    } catch (err) {
      console.error(err);
      alert("Failed to update tracks");
    } finally {
      setBusy(false);
    }
  }

  async function onTogglePermission(key: keyof UserPermissions) {
    const current = user.permissions ?? {};
    const next: UserPermissions = { ...current, [key]: !current[key] };
    setBusy(true);
    try {
      await setPermissions(user.uid, next);
    } catch (err) {
      console.error(err);
      alert("Failed to update permissions");
    } finally {
      setBusy(false);
    }
  }

  async function onUnreject() {
    setBusy(true);
    try {
      await unrejectUser(user.uid);
    } catch (err) {
      console.error(err);
      alert("Failed to un-reject");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (isSelf) {
      alert("You can't delete yourself. Ask another admin.");
      return;
    }
    const ok = window.confirm(
      `Permanently delete ${displayName}? This removes their record and sign-in account. This can't be undone.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await deleteUser(user.uid);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const status = user.profile?.status;
  const showCommitteeTitle = user.role === "committee" || user.role === "admin";

  // Collapsed summary — clickable row. Always rendered.
  const summary = (
    <button
      type="button"
      className={styles.summary}
      onClick={onToggleExpand}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${displayName}`}
    >
      <div className={styles.identity}>
        <div
          aria-hidden
          className={styles.avatar}
          style={{
            background: user.photoURL
              ? `center/cover no-repeat url(${user.photoURL})`
              : "var(--color-surface-hover)",
          }}
        />
        <div className={styles.identityText}>
          <div className={styles.name}>
            {displayName}
            {isSelf && (
              <Badge tone="accent" style={{ marginLeft: "var(--space-2)" }}>
                You
              </Badge>
            )}
          </div>
          <div className={styles.subline}>
            <Badge tone={roleTone(user.role)}>{user.role}</Badge>
            <span className={styles.email}>{user.email ?? "No email on file"}</span>
          </div>
        </div>
      </div>

      <div className={styles.meta}>
        {status && (
          <Badge tone={statusTone(status)} title={STATUS_LABELS[status]}>
            {shortStatusLabel(status)}
          </Badge>
        )}
        {(user.tracks ?? []).map((t) => (
          <Badge key={t} tone={trackTone(t)}>
            {TRACK_LABELS[t]}
          </Badge>
        ))}
        {showCommitteeTitle && user.title && (
          <span className={styles.title}>{user.title}</span>
        )}
        {user.showOnMembers && !isRejected && (
          <Badge tone="neutral" title="Shown on public /members page">
            Public
          </Badge>
        )}
      </div>

      <span aria-hidden className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>
        ▾
      </span>
    </button>
  );

  if (!expanded) {
    return (
      <div className={`${styles.item} ${isRejected ? styles.itemRejected : ""}`}>{summary}</div>
    );
  }

  // Expanded panel.
  return (
    <div
      className={`${styles.item} ${styles.itemExpanded} ${isRejected ? styles.itemRejected : ""}`}
    >
      {summary}

      <div className={styles.panel}>
        {isRejected ? (
          <div className={styles.rejectedPanel}>
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
              This user was rejected. Un-reject to send them back to Pending, or permanently delete.
            </p>
            <div className={styles.rejectedActions}>
              <Button size="sm" variant="ghost" onClick={onUnreject} disabled={busy}>
                Un-reject (back to pending)
              </Button>
              {!isSelf && (
                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={onDelete}
                  disabled={busy}
                  title="Permanently delete (removes record and sign-in account)"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.controls}>
              <label className={styles.controlBlock}>
                <span className={styles.controlLabel}>Role</span>
                <select
                  className={styles.rolePicker}
                  value={user.role}
                  onChange={(e) => onRoleChange(e.target.value as Role)}
                  disabled={busy}
                >
                  {ACTIVE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Tracks (private)</span>
                <div className={styles.trackRow}>
                  {ALL_TRACKS.map((t) => {
                    const checked = (user.tracks ?? []).includes(t);
                    return (
                      <label key={t} className={styles.trackChoice}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleTrack(t)}
                          disabled={busy}
                        />
                        <span>{TRACK_LABELS[t]}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Newsletter permissions
                  {user.role === "admin" && (
                    <span className={styles.hint}> (admins always have both)</span>
                  )}
                </span>
                <div className={styles.trackRow}>
                  <label className={styles.trackChoice}>
                    <input
                      type="checkbox"
                      checked={Boolean(user.permissions?.draftNewsletter)}
                      onChange={() => onTogglePermission("draftNewsletter")}
                      disabled={busy}
                    />
                    <span>Can draft</span>
                  </label>
                  <label className={styles.trackChoice}>
                    <input
                      type="checkbox"
                      checked={Boolean(user.permissions?.approveNewsletter)}
                      onChange={() => onTogglePermission("approveNewsletter")}
                      disabled={busy}
                    />
                    <span>Can approve + send</span>
                  </label>
                </div>
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Event permissions
                  {user.role === "admin" && (
                    <span className={styles.hint}> (admins always have both)</span>
                  )}
                </span>
                <div className={styles.trackRow}>
                  <label className={styles.trackChoice}>
                    <input
                      type="checkbox"
                      checked={Boolean(user.permissions?.draftEvent)}
                      onChange={() => onTogglePermission("draftEvent")}
                      disabled={busy}
                    />
                    <span>Can draft</span>
                  </label>
                  <label className={styles.trackChoice}>
                    <input
                      type="checkbox"
                      checked={Boolean(user.permissions?.approveEvent)}
                      onChange={() => onTogglePermission("approveEvent")}
                      disabled={busy}
                    />
                    <span>Can approve + publish</span>
                  </label>
                </div>
              </div>

              <label className={`${styles.controlBlock} ${styles.controlToggle}`}>
                <input
                  type="checkbox"
                  checked={Boolean(user.showOnMembers)}
                  onChange={onToggleShow}
                  disabled={busy}
                />
                <span className={styles.controlLabel}>Show on public /members page</span>
              </label>

              <label className={`${styles.controlBlock} ${styles.controlToggle}`}>
                <input
                  type="checkbox"
                  checked={Boolean(user.profile?.newsletter?.subscribed)}
                  onChange={onToggleNewsletter}
                  disabled={busy}
                />
                <span className={styles.controlLabel}>Subscribed to newsletter</span>
              </label>

              {!isSelf && (
                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={onDelete}
                  disabled={busy}
                  title="Permanently delete (removes record and sign-in account)"
                >
                  Delete
                </button>
              )}
            </div>

            <MemberEditForm user={user} onDone={onToggleExpand} />
          </>
        )}
      </div>
    </div>
  );
}
