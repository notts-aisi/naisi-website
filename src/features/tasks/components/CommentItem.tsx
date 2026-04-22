"use client";

import { Fragment, useState } from "react";
import type { CommentDoc } from "@/lib/firestore/comments";
import type { UserDoc } from "@/lib/firestore/users";
import { tokenizeCommentBody } from "../lib/comments/markdown";
import { softDeleteComment } from "../commentMutations";

type Props = {
  taskId: string;
  comment: CommentDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  onEditRequested: (commentId: string) => void;
};

function nameOf(users: UserDoc[], uid: string): string {
  const u = users.find((x) => x.uid === uid);
  return u?.displayName ?? u?.email ?? "Unknown";
}

function formatRelative(date: Date | null): string {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return "just now";
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return date.toLocaleDateString();
}

export default function CommentItem({
  taskId,
  comment,
  users,
  viewerUid,
  viewerIsAdmin,
  onEditRequested,
}: Props) {
  const [busy, setBusy] = useState(false);
  const isAuthor = comment.authorUid === viewerUid;
  const canEdit = isAuthor && !comment.deleted;
  const canHide = isAuthor && !comment.deleted;

  const authorName = nameOf(users, comment.authorUid);
  const initial = authorName.charAt(0).toUpperCase();

  async function handleDelete() {
    if (!window.confirm("Delete this comment? The thread will show '(deleted)' in its place.")) {
      return;
    }
    setBusy(true);
    try {
      await softDeleteComment(taskId, comment.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (comment.deleted) {
    return (
      <div
        style={{
          display: "flex",
          gap: "var(--space-3)",
          padding: "0.6rem 0.85rem",
          color: "var(--color-text-subtle)",
          fontSize: "var(--text-sm)",
          fontStyle: "italic",
        }}
      >
        <Avatar initial="—" muted />
        <div>
          <strong style={{ fontWeight: 500 }}>{authorName}</strong> deleted this comment
          {comment.editedAt && <> · {formatRelative(comment.editedAt)}</>}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        padding: "0.6rem 0.85rem",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <Avatar initial={initial} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--space-2)",
            fontSize: "var(--text-sm)",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: "var(--color-text)" }}>{authorName}</strong>
          <span style={{ color: "var(--color-text-subtle)", fontSize: "var(--text-xs)" }}>
            {formatRelative(comment.createdAt)}
            {comment.editedAt && <> · edited {formatRelative(comment.editedAt)}</>}
          </span>
          <span style={{ flex: 1 }} />
          {canEdit && (
            <button
              type="button"
              onClick={() => onEditRequested(comment.id)}
              disabled={busy}
              style={linkButtonStyle}
            >
              Edit
            </button>
          )}
          {(canHide || viewerIsAdmin) && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              style={{ ...linkButtonStyle, color: "var(--color-danger)" }}
            >
              Delete
            </button>
          )}
        </div>
        <div
          style={{
            marginTop: "var(--space-1)",
            fontSize: "var(--text-sm)",
            color: "var(--color-text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <CommentBody body={comment.bodyMarkdown} users={users} />
        </div>
      </div>
    </div>
  );
}

function CommentBody({ body, users }: { body: string; users: UserDoc[] }) {
  const tokens = tokenizeCommentBody(body);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === "text") return <Fragment key={i}>{t.value}</Fragment>;
        if (t.kind === "linebreak") return <br key={i} />;
        if (t.kind === "paragraph-break") {
          return (
            <Fragment key={i}>
              <br />
              <br />
            </Fragment>
          );
        }
        // mention
        const mentioned = users.find((u) => u.uid === t.uid);
        const label = mentioned?.displayName ?? mentioned?.email ?? t.displayName;
        return (
          <span
            key={i}
            title={mentioned?.email ?? undefined}
            style={{
              background: "var(--color-accent-soft)",
              color: "var(--color-accent)",
              padding: "0 0.3rem",
              borderRadius: "var(--radius-sm, 4px)",
              fontWeight: 500,
            }}
          >
            @{label}
          </span>
        );
      })}
    </>
  );
}

function Avatar({ initial, muted }: { initial: string; muted?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "1.75rem",
        height: "1.75rem",
        borderRadius: "50%",
        background: muted ? "transparent" : "var(--color-surface-hover)",
        color: "var(--color-text)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initial}
    </span>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--color-text-muted)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  padding: "0.1rem 0.35rem",
  borderRadius: "var(--radius-sm, 4px)",
};
