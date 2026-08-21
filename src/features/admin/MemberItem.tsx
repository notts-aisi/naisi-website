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
  currentAcademicYear,
  hasPaidMembership,
  type AffiliationStatus,
  type Track,
  type UserDoc,
  type UserPermissions,
} from "@/lib/firestore/users";
import { startImpersonation } from "@/auth/impersonation";
import MemberEditForm from "./MemberEditForm";
import {
  deleteUser,
  setPaidMembership,
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
  const { toast, run, dismiss } = useActionToast();
  const academicYear = currentAcademicYear();
  // The members list is a one-shot fetch, so `user` doesn't refresh after a
  // write. Remember just this toggle locally (null = no local change yet, read
  // the doc) so the switch and badge settle on the new value straight away.
  const [paidOverride, setPaidOverride] = useState<boolean | null>(null);
  const paidThisYear = paidOverride ?? hasPaidMembership(user, academicYear);

  const isSelf = user.uid === currentAdminUid;
  const isRejected = user.role === "rejected";
  const isAdminRole = user.role === "admin";
  const displayName =
    user.displayName ?? user.profile?.preferredName ?? user.email ?? "Unnamed";
  // Signed up claiming a university email but never clicked the magic link to
  // prove it. Flag the row (distinct colour + pill) so admins can chase it.
  const uniEmailUnverified =
    Boolean(user.profile?.universityEmail) && !user.profile?.uniEmailVerifiedAt;

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

  async function onToggleTrack(track: Track) {
    const current = new Set(user.tracks ?? []);
    if (current.has(track)) current.delete(track);
    else current.add(track);
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

  async function onTogglePaidMembership() {
    const next = !paidThisYear;
    setBusy(true);
    // Year-scoped: this only ever adds/removes `academicYear`, so last year's
    // tag stays on the record as history.
    await run(
      async () => {
        await setPaidMembership(user.uid, academicYear, next);
        setPaidOverride(next);
      },
      {
        savingMessage: next
          ? `Marking paid for ${academicYear}…`
          : `Clearing ${academicYear} membership…`,
        successMessage: next
          ? `Paid member for ${academicYear}`
          : `No longer marked paid for ${academicYear}`,
      },
    );
    setBusy(false);
  }

  async function onToggleSuRecognised() {
    setBusy(true);
    try {
      await setSuRecognised(user.uid, !user.suRecognised);
    } catch (err) {
      console.error(err);
      alert("Failed to update SU recognition");
    } finally {
      setBusy(false);
    }
  }

  async function onChangePermissionTier(
    draftKey: keyof UserPermissions,
    approveKey: keyof UserPermissions,
    tier: PermissionTier,
  ) {
    const next = applyTier(user.permissions ?? {}, draftKey, approveKey, tier);
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
  const showCommitteeTitle = user.role === "committee" || user.role === "admin";

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
        {(user.tracks ?? []).map((t) => (
          <Badge key={t} tone={trackTone(t)}>
            {TRACK_LABELS[t]}
          </Badge>
        ))}
        {paidThisYear && (
          <Badge tone="success" title={`Tagged as a paid member for ${academicYear}`}>
            Paid {academicYear}
          </Badge>
        )}
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
                  value={user.role}
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
                    const checked = (user.tracks ?? []).includes(t);
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
                  Paid membership
                  <span className={styles.hint}>(badge only, never a gate)</span>
                </span>
                <Switch
                  checked={paidThisYear}
                  onChange={onTogglePaidMembership}
                  disabled={busy}
                  tone="success"
                  label={`Paid ${academicYear}`}
                />
              </div>

              {user.role === "committee" && (
                <div className={styles.controlBlock}>
                  <span className={styles.controlLabel}>SU recognition</span>
                  <Switch
                    checked={Boolean(user.suRecognised)}
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
                    user.permissions,
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
                  value={permissionTier(user.permissions, "draftEvent", "approveEvent")}
                  onChange={(next) =>
                    onChangePermissionTier("draftEvent", "approveEvent", next)
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
                  checked={Boolean(user.showOnMembers)}
                  onChange={onToggleShow}
                  disabled={busy}
                  label="Show on public /members page"
                />
              </div>

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
      </div>

      {/* Only the expanded panel runs a toasted mutation, and its backdrop
          covers the summary button, so the row can't collapse mid-toast. */}
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
