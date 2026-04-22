"use client";

import { useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Button from "@/components/ui/Button";
import type { UserDoc } from "@/lib/firestore/users";
import type { TaskDoc } from "@/lib/firestore/tasks";
import { COMMENT_FIELD_LIMITS } from "@/lib/firestore/comments";
import { serializeTipTapDoc, tokenizeCommentBody } from "../lib/comments/markdown";
import { buildMentionSuggestion } from "../lib/comments/mentionSuggestion";
import { addComment, updateComment } from "../commentMutations";

type CommonProps = {
  task: TaskDoc;
  users: UserDoc[];
};

type CreateProps = CommonProps & {
  mode: "create";
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
  const reviewTarget = useMemo(() => {
    const reviewSub = task.subtasks.find(
      (s) =>
        s.reviewerUids.length > 0 && !s.done && !isSubtaskBlocked(s, task.subtasks),
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

  async function postComment(forceSendForReview: boolean) {
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
        await updateComment(task.id, props.commentId, body, mentions);
        props.onDone();
        return;
      }

      const commentId = await addComment({
        taskId: task.id,
        bodyMarkdown: body,
        mentions,
      });

      // Fire-and-forget notify call. A failure here still leaves the comment
      // visible via the onSnapshot feed — we surface errors inline.
      try {
        const notifyBody: Record<string, unknown> = {
          commentId,
          forceEmailCompleters: emailCompleters,
          forceEmailReviewers: emailReviewers,
        };
        await fetch(`/api/tasks/${task.id}/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notifyBody),
        });
      } catch (err) {
        console.warn("notify failed:", err);
      }

      if (forceSendForReview && reviewTarget) {
        try {
          await fetch(`/api/tasks/${task.id}/send-for-review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commentId,
              subtaskId: reviewTarget.kind === "subtask" ? reviewTarget.subtaskId : null,
            }),
          });
        } catch (err) {
          console.warn("send-for-review failed:", err);
        }
      }

      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
      setEmailCompleters(false);
      setEmailReviewers(false);
      props.onDone?.();
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
        {mode === "create" && reviewTarget && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => postComment(true)}
            disabled={busy}
            title={
              reviewTarget.kind === "subtask"
                ? `Emails the ${reviewTarget.reviewerUids.length} reviewer(s) of this subtask and logs a 'sent for review' entry.`
                : `Emails the ${reviewTarget.reviewerUids.length} task-level reviewer(s).`
            }
          >
            {reviewTarget.label}
          </Button>
        )}
        {mode === "edit" && (
          <Button type="button" variant="ghost" onClick={props.onDone} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Local mirror of the tasks.ts helper so this component doesn't need the
 * whole TaskDoc shape just to import a helper. Keep in sync.
 */
function isSubtaskBlocked(
  subtask: { blockedBy: string[] },
  siblings: Array<{ id: string; done: boolean }>,
): boolean {
  if (subtask.blockedBy.length === 0) return false;
  const doneIds = new Set(siblings.filter((s) => s.done).map((s) => s.id));
  return subtask.blockedBy.some((id) => !doneIds.has(id));
}
