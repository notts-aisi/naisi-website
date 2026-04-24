"use client";

import { useState } from "react";
import type { UserDoc } from "@/lib/firestore/users";
import type { TaskDoc } from "@/lib/firestore/tasks";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";
import type { FeedEntry } from "../hooks/useCommentsAndActivity";
import CommentItem from "./CommentItem";
import CommentComposer from "./CommentComposer";

type Props = {
  task: TaskDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  feed: FeedEntry[];
  loading: boolean;
};

function nameOf(users: UserDoc[], uid: string): string {
  const u = users.find((x) => x.uid === uid);
  return u?.displayName ?? u?.email ?? "Someone";
}

function formatShort(date: Date | null): string {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return "just now";
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  // Over a day — absolute date + time. Year shown only if different
  // from the current year.
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderActivityCopy(a: ActivityDoc, users: UserDoc[], task: TaskDoc): string {
  const actor = nameOf(users, a.actorUid);
  const p = a.payload as Record<string, unknown>;
  const pickStr = (k: string): string | null =>
    typeof p[k] === "string" ? (p[k] as string) : null;
  const pickUidLabel = (k: string): string => {
    const uid = pickStr(k);
    return uid ? nameOf(users, uid) : "someone";
  };
  const subtaskTitle = (id: string | null): string => {
    if (!id) return "a subtask";
    const s = task.subtasks.find((x) => x.id === id);
    return s ? `"${s.title}"` : "a subtask";
  };

  switch (a.kind) {
    case "created":
      return `${actor} created the task`;
    case "status_changed":
      return `${actor} moved status ${pickStr("from") ?? "?"} → ${pickStr("to") ?? "?"}`;
    case "assignee_added":
      return `${actor} added ${pickUidLabel("uid")} as a completer`;
    case "assignee_removed":
      return `${actor} removed ${pickUidLabel("uid")} as a completer`;
    case "reviewer_added":
      return `${actor} added ${pickUidLabel("uid")} as a reviewer`;
    case "reviewer_removed":
      return `${actor} removed ${pickUidLabel("uid")} as a reviewer`;
    case "subtask_added":
      return `${actor} added subtask ${subtaskTitle(pickStr("subtaskId"))}`;
    case "subtask_done":
      return `${actor} ticked ${subtaskTitle(pickStr("subtaskId"))} done`;
    case "subtask_blocked_changed":
      return `${actor} changed blockers on ${subtaskTitle(pickStr("subtaskId"))}`;
    case "attachment_added":
      return `${actor} attached ${pickStr("filename") ?? "a file"}`;
    case "comment_added":
      // Already rendered as the comment itself — we skip this in the hook.
      return `${actor} commented`;
    case "sent_for_review":
      return `${actor} sent ${subtaskTitle(pickStr("subtaskId") ?? null)} for review`;
    case "block_created":
      return `${actor} added block "${pickStr("name") ?? "Untitled"}"`;
    case "block_renamed": {
      const previous = pickStr("previousName");
      const name = pickStr("name") ?? "Untitled";
      return previous
        ? `${actor} renamed block "${previous}" → "${name}"`
        : `${actor} renamed a block to "${name}"`;
    }
    case "block_deleted":
      return `${actor} deleted block "${pickStr("name") ?? "a block"}"`;
    case "block_sealed":
      return `${actor}'s lock-in sealed block "${pickStr("name") ?? "a block"}"`;
    case "block_force_sealed":
      return `${actor} force-sealed block "${pickStr("name") ?? "a block"}"`;
    case "block_unsealed":
      return `${actor} re-opened block "${pickStr("name") ?? "a block"}"`;
    case "block_setup_finalized":
      return `${actor} finalized setup on "${pickStr("name") ?? "a block"}" — allocation open`;
    case "subtask_force_sealed":
      return `${actor} sealed subtask ${subtaskTitle(pickStr("subtaskId"))}`;
    case "subtask_unsealed":
      return `${actor} unsealed subtask ${subtaskTitle(pickStr("subtaskId"))}`;
    case "review_subtasks_spawned": {
      const count = typeof p.count === "number" ? (p.count as number) : 0;
      const name = pickStr("name") ?? "a block";
      return `${count} reviewer signoff row${count === 1 ? "" : "s"} auto-spawned on "${name}"`;
    }
    case "block_gate_applied":
      return `${actor} gated "${pickStr("nextBlockName") ?? "next block"}" on "${pickStr("name") ?? "this block"}"'s reviews`;
    case "block_gate_cleared":
      return `${actor} cleared the gate from "${pickStr("nextBlockName") ?? "next block"}"`;
    case "subtask_rejected": {
      const note = pickStr("note");
      return note
        ? `${actor} rejected ${subtaskTitle(pickStr("subtaskId"))} — "${note}"`
        : `${actor} rejected ${subtaskTitle(pickStr("subtaskId"))}`;
    }
    case "subtask_approved": {
      const note = pickStr("note");
      return note
        ? `${actor} approved ${subtaskTitle(pickStr("subtaskId"))} — "${note}"`
        : `${actor} approved ${subtaskTitle(pickStr("subtaskId"))}`;
    }
    case "subtask_questioned": {
      const note = pickStr("note");
      return note
        ? `${actor} has a question about ${subtaskTitle(pickStr("subtaskId"))} — "${note}"`
        : `${actor} flagged a question on ${subtaskTitle(pickStr("subtaskId"))}`;
    }
    case "subtask_resubmitted":
      return `${actor} resent ${subtaskTitle(pickStr("subtaskId"))} for review`;
    case "subtask_done":
      return `${actor} marked ${subtaskTitle(pickStr("subtaskId"))} done`;
    case "subtask_undone":
      return `${actor} un-ticked ${subtaskTitle(pickStr("subtaskId"))}`;
    case "block_sent_to_reviewers":
      return `${actor} sent block "${pickStr("name") ?? "?"}" to reviewers`;
    case "block_due_date_set": {
      const raw = p.dueDate as { toDate?: () => Date } | null | undefined;
      const d = raw && typeof raw.toDate === "function" ? raw.toDate() : null;
      return d
        ? `${actor} set every subtask in "${pickStr("name") ?? "a block"}" due ${d.toLocaleDateString()}`
        : `${actor} cleared the due date on "${pickStr("name") ?? "a block"}"`;
    }
    case "assignee_added": {
      const addedUid = pickStr("addedUid");
      if (addedUid) {
        const u = users.find((x) => x.uid === addedUid);
        const name = u?.displayName ?? u?.email ?? addedUid;
        return `${actor} added ${name} as assignee on ${subtaskTitle(pickStr("subtaskId"))}`;
      }
      return `${actor} joined ${subtaskTitle(pickStr("subtaskId"))} as assignee`;
    }
    case "assignee_removed": {
      const removedUid = pickStr("removedUid");
      if (removedUid) {
        const u = users.find((x) => x.uid === removedUid);
        const name = u?.displayName ?? u?.email ?? removedUid;
        return `${actor} removed ${name} from ${subtaskTitle(pickStr("subtaskId"))}`;
      }
      return `${actor} left ${subtaskTitle(pickStr("subtaskId"))}`;
    }
    case "reviewer_added": {
      const addedUid = pickStr("addedUid");
      if (addedUid) {
        const u = users.find((x) => x.uid === addedUid);
        const name = u?.displayName ?? u?.email ?? addedUid;
        return `${actor} added ${name} as reviewer on ${subtaskTitle(pickStr("subtaskId"))}`;
      }
      return `${actor} joined ${subtaskTitle(pickStr("subtaskId"))} as reviewer`;
    }
    case "reviewer_removed": {
      const removedUid = pickStr("removedUid");
      if (removedUid) {
        const u = users.find((x) => x.uid === removedUid);
        const name = u?.displayName ?? u?.email ?? removedUid;
        return `${actor} removed ${name} from reviewing ${subtaskTitle(pickStr("subtaskId"))}`;
      }
      return `${actor} dropped reviewing ${subtaskTitle(pickStr("subtaskId"))}`;
    }
    default:
      return `${actor} updated the task`;
  }
}

export default function ActivityFeed({
  task,
  users,
  viewerUid,
  viewerIsAdmin,
  feed,
  loading,
}: Props) {
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);

  // Deliberately don't surface a big "Loading discussion…" — the modal
  // already rendered the task body instantly from the parent's seed; a
  // loud loading banner here makes the whole modal feel slow even though
  // the subcollection fetch is ≤200ms in the common case. Render empty
  // and let content pop in when the snapshot arrives. For tasks with no
  // history (the majority), the empty-state text appears immediately and
  // stays — no flicker.
  if (feed.length === 0) {
    return (
      <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
        {loading ? "\u00A0" : "Nothing here yet — be the first to comment."}
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {feed.map((entry) => {
        if (entry.kind === "comment") {
          if (editingCommentId === entry.comment.id) {
            return (
              <CommentComposer
                key={entry.comment.id}
                mode="edit"
                commentId={entry.comment.id}
                initialBody={entry.comment.bodyMarkdown}
                task={task}
                users={users}
                onDone={() => setEditingCommentId(null)}
              />
            );
          }
          return (
            <CommentItem
              key={entry.comment.id}
              taskId={task.id}
              comment={entry.comment}
              users={users}
              viewerUid={viewerUid}
              viewerIsAdmin={viewerIsAdmin}
              onEditRequested={setEditingCommentId}
            />
          );
        }
        // Activity row — one-line log entry
        const copy = renderActivityCopy(entry.activity, users, task);
        return (
          <div
            key={entry.activity.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "0.2rem 0.75rem",
              fontSize: "var(--text-xs)",
              color: "var(--color-text-subtle)",
            }}
          >
            <span>•</span>
            <span style={{ flex: 1 }}>{copy}</span>
            <span>{formatShort(entry.activity.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
