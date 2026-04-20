"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import type { Role } from "@/lib/firebase/session";
import type { UserDoc } from "@/lib/firestore/users";
import { deleteUser, setRole, unrejectUser, updateMember } from "./adminMutations";
import MemberEditForm from "./MemberEditForm";
import styles from "./MemberRow.module.css";

type Props = {
  user: UserDoc;
  currentAdminUid: string;
};

const ACTIVE_ROLES: Role[] = ["member", "committee", "admin"];

export default function MemberRow({ user, currentAdminUid }: Props) {
  const [title, setTitle] = useState(user.title ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const isSelf = user.uid === currentAdminUid;
  const isRejected = user.role === "rejected";

  if (editing) {
    return <MemberEditForm user={user} onDone={() => setEditing(false)} />;
  }

  async function onRoleChange(next: Role) {
    if (isSelf && next !== "admin") {
      if (!window.confirm("Demote yourself from admin? You'll lose admin access on next page load.")) {
        return;
      }
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

  async function onTitleBlur() {
    if (title === (user.title ?? "")) return;
    try {
      await updateMember(user.uid, { title: title.trim() || null });
    } catch (err) {
      console.error(err);
      alert("Failed to save title");
      setTitle(user.title ?? "");
    }
  }

  async function onBioBlur() {
    if (bio === (user.bio ?? "")) return;
    try {
      await updateMember(user.uid, { bio: bio.trim() || null });
    } catch (err) {
      console.error(err);
      alert("Failed to save bio");
      setBio(user.bio ?? "");
    }
  }

  async function onToggleShow() {
    try {
      await updateMember(user.uid, { showOnMembers: !user.showOnMembers });
    } catch (err) {
      console.error(err);
      alert("Failed to update visibility");
    }
  }

  async function onDelete() {
    if (isSelf) {
      alert("You can't delete yourself. Ask another admin.");
      return;
    }
    const label = user.displayName ?? user.email ?? user.uid;
    if (
      !window.confirm(
        `Permanently delete ${label}? This removes their record and sign-in account. This can't be undone.`,
      )
    ) {
      return;
    }
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

  return (
    <div className={styles.row} data-rejected={isRejected ? "" : undefined}>
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
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {user.displayName ?? user.profile?.preferredName ?? "Unnamed"}
            {isSelf && (
              <Badge tone="accent" style={{ marginLeft: "var(--space-2)" }}>
                You
              </Badge>
            )}
          </div>
          <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {user.email}
          </div>
        </div>
      </div>

      {isRejected ? (
        <div className={styles.rejectedActions}>
          <Badge tone="danger">Rejected</Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              setBusy(true);
              try {
                await unrejectUser(user.uid);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Un-reject (back to pending)
          </Button>
          {!isSelf && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className={styles.deleteBtn}
              title="Permanently delete (removes record and sign-in account)"
            >
              Delete
            </button>
          )}
        </div>
      ) : (
        <>
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

          <input
            className={styles.inline}
            value={title}
            placeholder="Title (e.g. President)"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={onTitleBlur}
          />

          <textarea
            className={styles.inlineBio}
            value={bio}
            placeholder="Short bio for the public Members page"
            rows={2}
            onChange={(e) => setBio(e.target.value)}
            onBlur={onBioBlur}
          />

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={Boolean(user.showOnMembers)}
              onChange={onToggleShow}
            />
            <span>Show on Members page</span>
          </label>

          <div className={styles.rowActions}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={styles.editBtn}
              aria-label={`Edit ${user.displayName ?? user.email}`}
            >
              Edit
            </button>
            {!isSelf && (
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className={styles.deleteBtn}
                aria-label={`Delete ${user.displayName ?? user.email}`}
                title="Delete this user (removes their record and sign-in account)"
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
