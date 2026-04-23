"use client";

import { useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Button from "@/components/ui/Button";
import type { UserDoc } from "@/lib/firestore/users";
import type { TaskDoc } from "@/lib/firestore/tasks";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";
import { COMMENT_FIELD_LIMITS } from "@/lib/firestore/comments";
import { isSubtaskBlocked } from "@/lib/firestore/tasks";
import {
  extractMentionUids,
  serializeTipTapDoc,
  tokenizeCommentBody,
} from "../lib/comments/markdown";
import { buildMentionSuggestion } from "../lib/comments/mentionSuggestion";
import { addComment, updateComment } from "../commentMutations";

type CommonProps = {
  task: TaskDoc;
  users: UserDoc[];
};

type CreateProps = CommonProps & {
  mode: "create";
  /** Full activity stream for the task. Used to detect whether a
   *  sent_for_review is already pending so we can disable the button while
   *  a review is in flight. */
  activity: ActivityDoc[];
  onDone?: () => void;
};

type EditProps = CommonProps & {
  mode: "edit";
  commentId: string;
  initialBody: string;
  onDone: () => void;
};

type Props = CreateProps | EditProps;

// Initial TipTap content when editing an existing comment. We round-trip
// our storage format → TipTap JSON so mention pills render instead of raw
// token text.
function bodyToTipTapDoc(body: string) {
  const tokens = tokenizeCommentBody(body);
  const content: Array<Record<string, unknown>> = [];
  let para: Array<Record<string, unknown>> = [];
  const flush = () => {
    content.push({ type: "paragraph", content: para.length ? para : undefined });
    para = [];
  };
  for (const t of tokens) {
    if (t.kind === "paragraph-break") flush();
    else if (t.kind === "linebreak") para.push({ type: "hardBreak" });
    else if (t.kind === "text") para.push({ type: "text", text: t.value });
    else if (t.kind === "mention")
      para.push({ type: "mention", attrs: { id: t.uid, label: t.displayName } });
  }
  flush();
  return { type: "doc", content };
}

export default function CommentComposer(props: Props) {
  const { task, users, mode } = props;
  const [emailCompleters, setEmailCompleters] = useState(false);
  const [emailReviewers, setEmailReviewers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot users at editor creation. If the members list changes mid-
  // composition (rare — only on Firestore onSnapshot), the mention dropdown
  // won't pick up new names until next edit-session, which is fine. A deeper
  // live-sync would require reconfiguring the extension and cost caret
  // position on every users refresh.
  const usersSnapshot = useMemo(() => users, [users]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Mention.configure({
          HTMLAttributes: { class: "mention" },
          suggestion: buildMentionSuggestion(() => usersSnapshot),
        }),
      ],
      content:
        mode === "edit"
          ? bodyToTipTapDoc(props.initialBody)
          : { type: "doc", content: [{ type: "paragraph" }] },
      editorProps: {
        attributes: {
          class: "naisi-comment-editor",
          style: [
            "min-height: 4.5rem",
            "padding: 0.6rem 0.75rem",
            "background: var(--color-bg-elevated)",
            "border: 1px solid var(--color-border)",
            "border-radius: var(--radius-md)",
            "color: var(--color-text)",
            "font-size: var(--text-sm)",
            "outline: none",
          ].join(";"),
        },
      },
      immediatelyRender: false,
    },
    [mode === "edit" ? props.commentId : "new"],
  );

  const completerCount = task.completerUids.length;
  const reviewerCount = task.reviewerUids.length;

  // "Send for review" requires a reviewer somewhere (task-level or on an
  // unblocked + not-done subtask). For v1 we fall back to task-level; a
  // subtask picker can land in a follow-up once there are real workflows to
  // test against.
  // Find the most recent sent_for_review activity entry that targets the same
  // subtask (or task-level) as the composer's current reviewTarget, and
  // decide whether it's still "pending". Resolution rules:
  //   - subtask review: resolved when the subtask is ticked done
  //   - task-level review: resolved when the task status reaches "done"
  // If there's a pending entry for the target we're about to send to, the
  // Send-for-review button shows "⏳ Awaiting review" and is disabled.
  const pendingReview = useMemo(() => {
    if (mode !== "create") return null;
    const acts = (props as CreateProps).activity;
    // Find the latest sent_for_review per (subtaskId | null) target.
    let latestTask: ActivityDoc | null = null;
    const latestBySubtask = new Map<string, ActivityDoc>();
    for (const a of acts) {
      if (a.kind !== "sent_for_review") continue;
      const subId =
        typeof a.payload?.subtaskId === "string" ? (a.payload.subtaskId as string) : null;
      if (subId === null) {
        if (!latestTask || (a.createdAt?.getTime() ?? 0) > (latestTask.createdAt?.getTime() ?? 0)) {
          latestTask = a;
        }
      } else {
        const prev = latestBySubtask.get(subId);
        if (!prev || (a.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
          latestBySubtask.set(subId, a);
        }
      }
    }
    // Task-level: pending until task.status === "done"
    // Subtask: pending until the specific subtask is done
    const pendingTaskLevel = latestTask && task.status !== "done" ? latestTask : null;
    const pendingSubtasks = new Map<string, ActivityDoc>();
    for (const [subId, a] of latestBySubtask) {
      const sub = task.subtasks.find((s) => s.id === subId);
      if (sub && !sub.done) pendingSubtasks.set(subId, a);
    }
    return { pendingTaskLevel, pendingSubtasks };
  }, [mode, props, task]);

  const reviewTarget = useMemo(() => {
    const reviewSub = task.subtasks.find(
      (s) =>
        s.reviewerUids.length > 0 &&
        !s.done &&
        !isSubtaskBlocked(s, task),
    );
    if (reviewSub) {
      return {
        kind: "subtask" as const,
        subtaskId: reviewSub.id,
        reviewerUids: reviewSub.reviewerUids,
        label: `Send "${reviewSub.title}" for review`,
      };
    }
    if (task.reviewerUids.length > 0) {
      return {
        kind: "task" as const,
        reviewerUids: task.reviewerUids,
        label: "Send task for review",
      };
    }
    return null;
  }, [task]);

  const [reviewerPickerOpen, setReviewerPickerOpen] = useState(false);
  const [selectedReviewerUids, setSelectedReviewerUids] = useState<string[]>([]);

  async function postComment(
    forceSendForReview: boolean,
    reviewerUidsFilter: string[] | null = null,
  ) {
    if (!editor) return;
    const { body, mentions } = serializeTipTapDoc(editor.getJSON());
    if (!body.trim()) {
      setError("Comment can't be empty.");
      return;
    }
    if (body.length > COMMENT_FIELD_LIMITS.bodyMarkdown) {
      setError(`Comment is too long (${body.length}/${COMMENT_FIELD_LIMITS.bodyMarkdown}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "edit") {
        const priorMentions = extractMentionUids(props.initialBody);
        await updateComment(task.id, props.commentId, body, mentions);
        // UI can close immediately — the Firestore write is what mattered.
        props.onDone();
        const addedMentions = mentions.filter((u) => !priorMentions.includes(u));
        if (addedMentions.length > 0) {
          fireNotify(task.id, {
            commentId: props.commentId,
            priorMentions,
          });
        }
        return;
      }

      const commentId = await addComment({
        taskId: task.id,
        bodyMarkdown: body,
        mentions,
      });

      // Optimistic UI: clear the editor + close-callback the instant Firestore
      // confirms the comment write. The /notify + /send-for-review calls are
      // side-effects — fire them in the background with keepalive so the
      // browser holds the request alive across a tab close. Errors log to
      // the server; we can't surface them to a UI that's already moved on.
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
      setEmailCompleters(false);
      setEmailReviewers(false);
      props.onDone?.();

      fireNotify(task.id, {
        commentId,
        forceEmailCompleters: emailCompleters,
        forceEmailReviewers: emailReviewers,
      });

      if (forceSendForReview && reviewTarget) {
        fireSendForReview(task.id, {
          commentId,
          subtaskId: reviewTarget.kind === "subtask" ? reviewTarget.subtaskId : null,
          reviewerUids: reviewerUidsFilter,
        });
      }
      return;
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to post comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <EditorContent editor={editor} />

      {mode === "create" && (
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
            flexWrap: "wrap",
          }}
        >
          {completerCount > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <input
                type="checkbox"
                checked={emailCompleters}
                onChange={(e) => setEmailCompleters(e.target.checked)}
              />
              <span>Email completers ({completerCount})</span>
            </label>
          )}
          {reviewerCount > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <input
                type="checkbox"
                checked={emailReviewers}
                onChange={(e) => setEmailReviewers(e.target.checked)}
              />
              <span>Email reviewers ({reviewerCount})</span>
            </label>
          )}
        </div>
      )}

      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", margin: 0 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button type="button" onClick={() => postComment(false)} disabled={busy}>
          {busy
            ? mode === "edit"
              ? "Saving…"
              : "Posting…"
            : mode === "edit"
              ? "Save changes"
              : "Post comment"}
        </Button>
        {mode === "create" && reviewTarget && (() => {
          const pendingForThisTarget =
            reviewTarget.kind === "subtask"
              ? pendingReview?.pendingSubtasks.get(reviewTarget.subtaskId) ?? null
              : pendingReview?.pendingTaskLevel ?? null;
          if (pendingForThisTarget) {
            const sentAgo = pendingForThisTarget.createdAt
              ? formatSentAgo(pendingForThisTarget.createdAt)
              : "";
            return (
              <Button
                type="button"
                variant="secondary"
                disabled
                title={
                  reviewTarget.kind === "subtask"
                    ? `A review was already requested for this subtask${sentAgo ? ` ${sentAgo}` : ""}. The button will re-enable once the subtask is ticked done.`
                    : `A task-level review was already requested${sentAgo ? ` ${sentAgo}` : ""}. The button will re-enable once the task is marked done.`
                }
              >
                ⏳ Awaiting review
              </Button>
            );
          }
          // Single reviewer: fire immediately, no picker needed.
          if (reviewTarget.reviewerUids.length <= 1) {
            return (
              <Button
                type="button"
                variant="secondary"
                onClick={() => postComment(true)}
                disabled={busy}
              >
                {reviewTarget.label}
              </Button>
            );
          }
          // 2+ reviewers: open a small inline picker, default all checked.
          return (
            <span style={{ position: "relative" }}>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSelectedReviewerUids(reviewTarget.reviewerUids);
                  setReviewerPickerOpen((v) => !v);
                }}
              >
                {reviewTarget.label}
              </Button>
              {reviewerPickerOpen && (
                <ReviewerSelector
                  reviewerUids={reviewTarget.reviewerUids}
                  selected={selectedReviewerUids}
                  users={users}
                  onChange={setSelectedReviewerUids}
                  onCancel={() => setReviewerPickerOpen(false)}
                  onSubmit={() => {
                    setReviewerPickerOpen(false);
                    postComment(true, selectedReviewerUids).catch(console.error);
                  }}
                />
              )}
            </span>
          );
        })()}
        {mode === "edit" && (
          <Button type="button" variant="ghost" onClick={props.onDone} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function formatSentAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return "just now";
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}

/**
 * Inline popover for picking which reviewers to email when 2+ reviewers exist.
 * Defaults all checked (most common case is "ping everyone"); unchecking is
 * the escape hatch for flows like "review chain: Alice → Bob", where Bob
 * sends the next leg without re-emailing Alice.
 */
function ReviewerSelector({
  reviewerUids,
  selected,
  users,
  onChange,
  onCancel,
  onSubmit,
}: {
  reviewerUids: string[];
  selected: string[];
  users: UserDoc[];
  onChange: (uids: string[]) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const chosen = new Set(selected);
  return (
    <div
      role="dialog"
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 5,
        minWidth: "14rem",
        padding: "var(--space-3)",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--color-text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Send to
      </div>
      {reviewerUids.map((uid) => {
        const u = users.find((x) => x.uid === uid);
        const name = u?.displayName ?? u?.email ?? uid;
        return (
          <label
            key={uid}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={chosen.has(uid)}
              onChange={(e) => {
                if (e.target.checked) onChange([...selected, uid]);
                else onChange(selected.filter((u) => u !== uid));
              }}
            />
            <span>{name}</span>
          </label>
        );
      })}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSubmit}
          disabled={selected.length === 0}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * Fire-and-forget HTTP helpers for the notify + send-for-review side-effects.
 * `keepalive: true` asks the browser to hold the request open across a tab
 * close (up to ~60s in most browsers) so even a fast dismissal still lets
 * the email go out. Errors are swallowed on the client — the browser would
 * have nothing useful to do with them once the UI has moved on — but the
 * server logs them via console.error for later inspection.
 */
function fireNotify(taskId: string, payload: Record<string, unknown>): void {
  fetch(`/api/tasks/${taskId}/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch((err) => console.warn("notify failed:", err));
}

function fireSendForReview(taskId: string, payload: Record<string, unknown>): void {
  fetch(`/api/tasks/${taskId}/send-for-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch((err) => console.warn("send-for-review failed:", err));
}
