"use client";

import { useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Button from "@/components/ui/Button";
import type { UserDoc } from "@/lib/firestore/users";
import { COMMENT_FIELD_LIMITS } from "@/lib/firestore/comments";
import { bodyToTipTapDoc, serializeTipTapDoc } from "../lib/comments/markdown";
import { buildMentionSuggestion } from "../lib/comments/mentionSuggestion";
import CommentToolbar from "./CommentToolbar";

type Props = {
  users: UserDoc[];
  /** Stable key used to reset the editor when switching between contexts
   *  (e.g. `new` vs `edit:<commentId>`). Changing the key forces useEditor
   *  to rebuild so seeded content takes effect. */
  editorKey?: string;
  /** Body in storage format. When present, editor opens with mention pills
   *  round-tripped from the stored token form. */
  initialBody?: string;
  submitLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  autoFocus?: boolean;
  /** Clear the editor after a successful submit (default true for new
   *  composers, pass false when caller unmounts the editor on success). */
  clearOnSubmit?: boolean;
  minHeightRem?: number;
  onSubmit: (body: string, mentions: string[]) => Promise<void>;
  onCancel?: () => void;
};

export default function CommentEditor({
  users,
  editorKey = "new",
  initialBody,
  submitLabel = "Post comment",
  busyLabel = "Posting…",
  cancelLabel = "Cancel",
  autoFocus = false,
  clearOnSubmit = true,
  minHeightRem = 4.5,
  onSubmit,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [length, setLength] = useState(() => initialBody?.length ?? 0);

  // Snapshot at editor-creation time — matches CommentComposer's choice to
  // avoid reconfiguring the Mention extension on every users refresh (which
  // would steal caret position).
  const usersSnapshot = useMemo(() => users, [users]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Underline,
        Link.configure({
          openOnClick: false,
          autolink: false,
          HTMLAttributes: {
            rel: "noopener noreferrer",
            target: "_blank",
          },
        }),
        Mention.configure({
          HTMLAttributes: { class: "mention" },
          // `@all` is now valid on subcomments too (the storage format
          // sentinel `__all__` expands at write-time in `addComment`).
          // Subcomment composer was the last place still gated to
          // explicit @-uids; flipping this matches the task-level
          // composer's affordance and finishes the @all rollout.
          suggestion: buildMentionSuggestion(() => usersSnapshot, {
            includeAll: true,
          }),
        }),
      ],
      content: initialBody
        ? bodyToTipTapDoc(initialBody)
        : { type: "doc", content: [{ type: "paragraph" }] },
      editorProps: {
        attributes: {
          class: "naisi-comment-editor",
          // Border + radius live on the wrapper (see render below); the
          // editor itself only carries padding + typography so the
          // toolbar attaches flush above without doubled chrome.
          style: [
            `min-height: ${minHeightRem}rem`,
            "padding: 0.6rem 0.75rem",
            "background: transparent",
            "color: var(--color-text)",
            "font-size: var(--text-sm)",
            "outline: none",
          ].join(";"),
        },
      },
      onUpdate: ({ editor: e }) => {
        const { body } = serializeTipTapDoc(e.getJSON());
        setLength(body.length);
      },
      immediatelyRender: false,
      // Toolbar's `editor.isActive(...)` checks need a re-render hook to
      // reflect selection changes; v3's default of false would leave
      // the buttons stale until the next prop change.
      shouldRerenderOnTransaction: true,
    },
    [editorKey],
  );

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end");
  }, [editor, autoFocus]);

  // Reset local length counter when the editor rebuilds for a different key
  // (e.g. opening the edit composer for a different comment).
  useEffect(() => {
    setLength(initialBody?.length ?? 0);
    setError(null);
  }, [editorKey, initialBody]);

  async function handleSubmit() {
    if (!editor || busy) return;
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
      await onSubmit(body, mentions);
      if (clearOnSubmit) {
        editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
        setLength(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment.");
    } finally {
      setBusy(false);
    }
  }

  // Cmd/Ctrl+Enter submits — matches common comment-box affordances.
  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const overLimit = length > COMMENT_FIELD_LIMITS.bodyMarkdown;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          // No `overflow: hidden` — it would clip the link popover. The
          // toolbar carries its own top-corner radius to keep the
          // chrome visually flush.
        }}
      >
        <CommentToolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button
          size="sm"
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || length === 0 || overLimit}
        >
          {busy ? busyLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: overLimit ? "var(--color-danger)" : "var(--color-text-muted)",
          }}
        >
          {length} / {COMMENT_FIELD_LIMITS.bodyMarkdown}
        </span>
      </div>
      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-xs)", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
