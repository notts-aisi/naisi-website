"use client";

import Link from "next/link";
import { useState } from "react";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import SegmentedControl, { type SegmentedOption } from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
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
import { startImpersonation } from "@/auth/impersonation";
import ConductFlagControl from "./ConductFlagControl";
import MemberApplicationHistory from "./MemberApplicationHistory";
import MemberEditForm from "./MemberEditForm";
import MembershipChip, { MembershipSummaryBadge } from "./MembershipChip";
import {
  deleteUser,
  setPermissions,
  setRole,
  setSuRecognised,
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

type PermissionTier = "none" | "draft" | "approve";

const PERMISSION_OPTIONS: readonly SegmentedOption<PermissionTier>[] = [
  { value: "none", label: "None" },
  { value: "draft", label: "Draft" },
  { value: "approve", label: "Draft + approve" },
];

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

function permissionTier(
  perms: UserPermissions | undefined,
  draftKey: keyof UserPermissions,
  approveKey: keyof UserPermissions,
): PermissionTier {
  if (perms?.[approveKey]) return "approve";
  if (perms?.[draftKey]) return "draft";
  return "none";
}

function applyTier(
  perms: UserPermissions,
  draftKey: keyof UserPermissions,
  approveKey: keyof UserPermissions,
  tier: PermissionTier,
): UserPermissions {
  // approve implies draft — keeps the segmented control honest; there's no
  // useful "approve but not draft" configuration.
  switch (tier) {
    case "none":
      return { ...perms, [draftKey]: false, [approveKey]: false };
    case "draft":
      return { ...perms, [draftKey]: true, [approveKey]: false };
    case "approve":
      return { ...perms, [draftKey]: true, [approveKey]: true };
  }
}

export default function MemberItem({ user, currentAdminUid, expanded, onToggleExpand }: Props) {
  const [busy, setBusy] = useState(false);
  const { toast, dismiss } = useActionToast();
  // The members list is a ONE-SHOT fetch, so nothing pushes a fresh document
  // into this row after a write: `user` keeps saying whatever the list read
  // when it loaded. `saved` is what THIS row has written since, and every
  // control below is drawn off the overlay rather than off the prop. Without
  // it a toggle snapped straight back to its old value the moment the write
  // returned, and the next click resent the value that was already stored, so
  // a permission could be granted and never taken off again in that session.
  //
  // The overlay remembers WHICH document it was taken against, so a genuine
  // refresh (a new prop object) drops it and the server's answer wins, with no
  // effect and no second render to do it.
  const [saved, setSaved] = useState<{ from: UserDoc; patch: Partial<UserDoc> }>({
    from: user,
    patch: {},
  });
  const shown = saved.from === user ? { ...user, ...saved.patch } : user;

  /** Record what this row just saved, so the control it belongs to settles. */
  function remember(fields: Partial<UserDoc>) {
    setSaved((prev) => ({
      from: user,
      patch: prev.from === user ? { ...prev.patch, ...fields } : fields,
    }));
  }

  const isSelf = user.uid === currentAdminUid;
  const isRejected = shown.role === "rejected";
  const isAdminRole = shown.role === "admin";
  const displayName =
    user.displayName ?? user.profile?.preferredName ?? user.email ?? "Unnamed";
  // Signed up claiming a university email but never clicked the magic link to
  // prove it. Flag the row (distinct colour + pill) so admins can chase it.
  const uniEmailUnverified =
    Boolean(user.profile?.universityEmail) && !user.profile?.uniEmailVerifiedAt;

  async function onRoleChange(next: Role) {
    if (next === shown.role) return;
    if (isSelf && next !== "admin") {
      const ok = window.confirm(
        "Demote yourself from admin? You'll lose admin access on next page load.",
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await setRole(user.uid, next);
      remember({ role: next });
    } catch (err) {
      console.error(err);
      alert("Failed to change role");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleShow() {
    const next = !shown.showOnMembers;
    setBusy(true);
    try {
      await updateMember(user.uid, { showOnMembers: next });
      remember({ showOnMembers: next });
    } catch (err) {
      console.error(err);
      alert("Failed to update visibility");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleTrack(track: Track) {
    const current = new Set(shown.tracks ?? []);
    if (current.has(track)) current.delete(track);
    else current.add(track);
    const next = ALL_TRACKS.filter((t) => current.has(t));
    setBusy(true);
    try {
      await setTracks(user.uid, next);
      remember({ tracks: next });
    } catch (err) {
      console.error(err);
      alert("Failed to update tracks");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleSuRecognised() {
    const next = !shown.suRecognised;
    setBusy(true);
    try {
      await setSuRecognised(user.uid, next);
      remember({ suRecognised: next });
    } catch (err) {
      console.error(err);
      alert("Failed to update SU recognition");
    } finally {
      setBusy(false);
    }
  }

  /** One standalone permission key, for the ones that have no draft/approve
   *  pair. `manageMembership` was the first (there is no "draft a
   *  membership"); `circulateWorksheet` is the second, because writing a
   *  worksheet is open to the whole committee and the only act left to gate
   *  is putting one in front of named people. */
  async function onChangePermission(key: keyof UserPermissions, value: boolean) {
    const next = { ...(shown.permissions ?? {}), [key]: value };
    setBusy(true);
    try {
      await setPermissions(user.uid, next);
      remember({ permissions: next });
    } catch (err) {
      console.error(err);
      alert("Failed to update permissions");
    } finally {
      setBusy(false);
    }
  }

  async function onChangePermissionTier(
    draftKey: keyof UserPermissions,
    approveKey: keyof UserPermissions,
    tier: PermissionTier,
  ) {
    const next = applyTier(shown.permissions ?? {}, draftKey, approveKey, tier);
    setBusy(true);
    try {
      await setPermissions(user.uid, next);
      remember({ permissions: next });
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

  async function onViewAs() {
    // Plain-language warning because writes during view-as look like the
    // target performed them (full impersonation: request.auth is theirs).
    const ok = window.confirm(
      `View the site as ${displayName}?\n\n`
        + `You'll see exactly what they see — sidebar, tabs, page access.\n\n`
        + `Heads up:\n`
        + `• Anything you click that writes data will be recorded as ${displayName} doing it.\n`
        + `• Exiting signs you out — you'll need to log back in as yourself.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await startImpersonation(user.uid);
      // No setBusy(false) on success — the page is navigating away.
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "View as failed");
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
  const showCommitteeTitle = shown.role === "committee" || shown.role === "admin";

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
            <Badge tone={roleTone(shown.role)}>{shown.role}</Badge>
            <span className={styles.email}>{user.email ?? "No email on file"}</span>
          </div>
        </div>
      </div>

      <div className={styles.meta}>
        {uniEmailUnverified && (
          <Badge
            tone="warning"
            title="Signed up as University of Nottingham but never verified their university email"
          >
            Uni email unverified
          </Badge>
        )}
        {status && (
          <Badge tone={statusTone(status)} title={STATUS_LABELS[status]}>
            {shortStatusLabel(status)}
          </Badge>
        )}
        {(shown.tracks ?? []).map((t) => (
          <Badge key={t} tone={trackTone(t)}>
            {TRACK_LABELS[t]}
          </Badge>
        ))}
        <MembershipSummaryBadge recordedYears={user.paidMembershipYears} />
        {showCommitteeTitle && user.title && (
          <span className={styles.title}>{user.title}</span>
        )}
        {shown.showOnMembers && !isRejected && (
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
      <div
        className={`${styles.item} ${isRejected ? styles.itemRejected : ""} ${uniEmailUnverified ? styles.itemUnverifiedUni : ""}`}
      >
        {summary}
      </div>
    );
  }

  return (
    <div
      className={`${styles.item} ${styles.itemExpanded} ${isRejected ? styles.itemRejected : ""} ${uniEmailUnverified ? styles.itemUnverifiedUni : ""}`}
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
              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Role</span>
                <ResponsiveSelect<Role>
                  className={styles.rolePicker}
                  value={shown.role}
                  onChange={onRoleChange}
                  options={ACTIVE_ROLES.map<ResponsiveSelectOption<Role>>((r) => ({
                    value: r,
                    label: r,
                  }))}
                  disabled={busy}
                  ariaLabel="Role"
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Tracks (private)</span>
                <div className={styles.trackRow}>
                  {ALL_TRACKS.map((t) => {
                    const checked = (shown.tracks ?? []).includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => onToggleTrack(t)}
                        disabled={busy}
                        className={`${styles.trackPill} ${checked ? styles.trackPillOn : ""}`}
                      >
                        {TRACK_LABELS[t]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Membership
                  <span className={styles.hint}>(badge only, never a gate)</span>
                </span>
                <MembershipChip
                  uid={user.uid}
                  recordedYears={user.paidMembershipYears}
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Membership admin
                  {isAdminRole && (
                    <span className={styles.hint}> (admins always have it)</span>
                  )}
                </span>
                <Switch
                  checked={Boolean(shown.permissions?.manageMembership)}
                  onChange={() =>
                    onChangePermission(
                      "manageMembership",
                      !shown.permissions?.manageMembership,
                    )
                  }
                  disabled={busy || isAdminRole}
                  label="Can create membership periods and record members"
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Worksheet circulation
                  {isAdminRole && (
                    <span className={styles.hint}> (admins always have it)</span>
                  )}
                </span>
                <Switch
                  checked={Boolean(shown.permissions?.circulateWorksheet)}
                  onChange={() =>
                    onChangePermission(
                      "circulateWorksheet",
                      !shown.permissions?.circulateWorksheet,
                    )
                  }
                  disabled={busy || isAdminRole}
                  label="Can send worksheets to committee members and watch their progress"
                />
              </div>

              {shown.role === "committee" && (
                <div className={styles.controlBlock}>
                  <span className={styles.controlLabel}>SU recognition</span>
                  <Switch
                    checked={Boolean(shown.suRecognised)}
                    onChange={onToggleSuRecognised}
                    disabled={busy}
                    label="Recognised by the SU (can see member directory and task board)"
                  />
                </div>
              )}

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Newsletter permissions
                  {isAdminRole && (
                    <span className={styles.hint}> (admins always have both)</span>
                  )}
                </span>
                <SegmentedControl
                  ariaLabel="Newsletter permissions"
                  value={permissionTier(
                    shown.permissions,
                    "draftNewsletter",
                    "approveNewsletter",
                  )}
                  onChange={(next) =>
                    onChangePermissionTier("draftNewsletter", "approveNewsletter", next)
                  }
                  options={PERMISSION_OPTIONS}
                  size="sm"
                  disabled={busy || isAdminRole}
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Event permissions
                  {isAdminRole && (
                    <span className={styles.hint}> (admins always have both)</span>
                  )}
                </span>
                <SegmentedControl
                  ariaLabel="Event permissions"
                  value={permissionTier(shown.permissions, "draftEvent", "approveEvent")}
                  onChange={(next) =>
                    onChangePermissionTier("draftEvent", "approveEvent", next)
                  }
                  options={PERMISSION_OPTIONS}
                  size="sm"
                  disabled={busy || isAdminRole}
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>
                  Course permissions
                  {isAdminRole && (
                    <span className={styles.hint}> (admins always have both)</span>
                  )}
                </span>
                <SegmentedControl
                  ariaLabel="Course permissions"
                  value={permissionTier(shown.permissions, "draftCourse", "approveCourse")}
                  onChange={(next) =>
                    onChangePermissionTier("draftCourse", "approveCourse", next)
                  }
                  options={PERMISSION_OPTIONS}
                  size="sm"
                  disabled={busy || isAdminRole}
                />
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Email subscriptions</span>
                <Link
                  href={`/admin/subscriptions?audienceId=${encodeURIComponent(user.uid)}`}
                  className={styles.subscriptionsLink}
                >
                  Manage subscriptions →
                </Link>
              </div>

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Public profile</span>
                <Switch
                  checked={Boolean(shown.showOnMembers)}
                  onChange={onToggleShow}
                  disabled={busy}
                  label="Show on public /members page"
                />
              </div>

              {/* Not on your own row. A conduct flag is a record one admin
                  keeps about another person, so a self-set one has nobody
                  outside it who agreed to it; another admin can still flag
                  this one. The route refuses a self-flag as well, so a
                  hand-made request meets the same rule. */}
              {!isSelf && <ConductFlagControl uid={user.uid} displayName={displayName} />}

              <div className={styles.controlBlock}>
                <span className={styles.controlLabel}>Debug</span>
                {isSelf ? (
                  <span className={styles.hint} style={{ marginLeft: 0 }}>
                    Can&apos;t view as yourself.
                  </span>
                ) : isAdminRole ? (
                  <span className={styles.hint} style={{ marginLeft: 0 }}>
                    Can&apos;t view as another admin.
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onViewAs}
                    disabled={busy}
                    title="Sign in as this member to see exactly what they see (writes during the session look like they did them)"
                  >
                    View as {displayName}
                  </Button>
                )}
              </div>

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

        {/* The committee's record of this person: which rounds they applied
            to, what was decided, and what the reviewers wrote. Mounted inside
            the expanded panel only, so opening the Members list never listens
            to anybody's history, and mounted OUTSIDE the rejected branch on
            purpose: the record of what a rejected applicant was told is
            exactly what an admin wants in front of them before they press
            delete. */}
        <MemberApplicationHistory uid={user.uid} />
      </div>

      {/* Kept mounted with no live toaster of its own: the membership control
          reports its own errors inline, and the next toasted mutation on this
          row has its host ready. The backdrop covers the summary button, so a
          row cannot collapse mid-toast. */}
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
