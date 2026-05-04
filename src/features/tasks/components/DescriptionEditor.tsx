"use client";

import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { bodyToTipTapDoc, serializeTipTapDoc } from "../lib/comments/markdown";
import CommentToolbar from "./CommentToolbar";

type Props = {
  /** Initial body in storage format. The editor seeds from this on mount;
   *  later prop changes don't re-seed (would clobber in-flight typing).
   *  Parents that need to swap content should remount via `editorKey`. */
  initialBody: string;
  /** Stable key used to rebuild the editor when switching contexts (e.g.
   *  opening the editor for a different subtask). */
  editorKey: string;
  /** Fires on every transaction with the latest serialised body — parent
   *  reads from this to know what to save. */
  onChange: (body: string) => void;
  minHeightRem?: number;
  autoFocus?: boolean;
  disabled?: boolean;
};

/**
 * Description-side editor: same TipTap chrome as comment composers
 * (StarterKit + Underline + Link + the shared `CommentToolbar`) but
 * deliberately NO mentions. Descriptions are stable instructions from
 * the task setter, not threaded conversation — pinging people from a
 * description block would be confusing and noisy.
 *
 * Storage format is identical to comments (markdown.ts), so descriptions
 * round-trip through the same parser / `RichTextRender`. Parent owns
 * Save / Cancel chrome; this component is just the editing surface.
 */
export default function DescriptionEditor({
  initialBody,
  editorKey,
  onChange,
  minHeightRem = 5,
  autoFocus = false,
  disabled = false,
}: Props) {
  // Keep the latest `onChange` reachable from the editor's `onUpdate`
  // closure without re-running `useEditor`'s `editorKey` dep — assigning
  // the ref inside an effect (rather than during render) keeps React's
  // refs-during-render rule happy.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
      ],
      content: initialBody
        ? bodyToTipTapDoc(initialBody)
        : { type: "doc", content: [{ type: "paragraph" }] },
      editorProps: {
        attributes: {
          class: "naisi-description-editor",
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
        onChangeRef.current(body);
      },
      editable: !disabled,
      immediatelyRender: false,
      shouldRerenderOnTransaction: true,
    },
    [editorKey],
  );

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end");
  }, [editor, autoFocus]);

  // Mirror editable updates onto live editor instances so the parent can
  // disable mid-edit without remounting.
  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      style={{
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        // No `overflow: hidden` — it would clip the link popover. The
        // toolbar carries its own top-corner radius.
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <CommentToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
