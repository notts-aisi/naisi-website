"use client";

import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { useEffect, useState } from "react";
import styles from "./RichTextEditor.module.css";

type Props = {
  html: string;
  onChange: (html: string) => void;
  disabled?: boolean;
};

/**
 * WYSIWYG rich-text editor used inside a Rich text block. Outputs email-safe
 * HTML (TipTap StarterKit uses only semantic tags that Gmail/Outlook render
 * correctly: <p>, <strong>, <em>, <u>, <a>, <ul>/<ol>/<li>, <br>).
 */
export default function RichTextEditor({ html, onChange, disabled }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Headings come from the Heading BLOCK, not inline, which keeps the outer
        // document structure consistent with the block system.
        heading: false,
        // We don't need a code block here; inline code is useless for newsletters.
        codeBlock: false,
        // StarterKit v3 bundles Link and Underline. Disable those so we can
        // configure our own below (different defaults: no open-on-click,
        // target=_blank, safe rel).
        link: false,
        underline: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        // Non-inclusive mark: typing at the edge of a link won't extend it
        // (matches Gmail). The Link extension ties `inclusive` to `autolink`,
        // so disabling autolink also disables URL auto-detection-as-you-type,
        // paste-to-link still works via `linkOnPaste` (default true).
        autolink: false,
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
    ],
    content: html || "<p></p>",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: styles.editor,
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    // Avoid Next 16 / React 19 hydration mismatch warnings for the contenteditable.
    immediatelyRender: false,
  });

  // Keep external content changes (undo, reset) in sync without clobbering local edits.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (html && html !== current) {
      editor.commands.setContent(html, { emitUpdate: false });
    }
  }, [html, editor]);

  if (!editor) return null;

  return (
    <div className={styles.wrap} data-disabled={disabled || undefined}>
      <Toolbar editor={editor} disabled={disabled} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");

  // TipTap v3's `useEditor` doesn't re-render on every transaction; we opt in
  // via `useEditorState` so toolbar buttons reflect the current cursor's marks.
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      link: editor.isActive("link"),
    }),
  });

  function toggleLink() {
    const prev = editor.getAttributes("link").href as string | undefined;
    setLinkHref(prev && prev.length > 0 ? prev : "https://");
    setLinkOpen(true);
  }

  function applyLink() {
    const url = linkHref.trim();
    if (!url) {
      editor.chain().focus().unsetLink().run();
    } else {
      // Default to https:// if the user typed a bare domain.
      const safe = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href: safe }).run();
    }
    setLinkOpen(false);
  }

  function removeLink() {
    editor.chain().focus().unsetLink().run();
    setLinkOpen(false);
  }

  const btn = (opts: {
    label: string;
    onClick: () => void;
    active?: boolean;
    title: string;
  }) => (
    <button
      type="button"
      onClick={opts.onClick}
      className={`${styles.btn} ${opts.active ? styles.btnActive : ""}`}
      aria-pressed={opts.active ? "true" : "false"}
      title={opts.title}
      disabled={disabled}
    >
      {opts.label}
    </button>
  );

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
      {btn({
        label: "B",
        onClick: () => editor.chain().focus().toggleBold().run(),
        active: active.bold,
        title: "Bold (⌘B)",
      })}
      {btn({
        label: "I",
        onClick: () => editor.chain().focus().toggleItalic().run(),
        active: active.italic,
        title: "Italic (⌘I)",
      })}
      {btn({
        label: "U",
        onClick: () => editor.chain().focus().toggleUnderline().run(),
        active: active.underline,
        title: "Underline (⌘U)",
      })}
      <span className={styles.divider} aria-hidden />
      {btn({
        label: "• List",
        onClick: () => editor.chain().focus().toggleBulletList().run(),
        active: active.bulletList,
        title: "Bulleted list",
      })}
      {btn({
        label: "1. List",
        onClick: () => editor.chain().focus().toggleOrderedList().run(),
        active: active.orderedList,
        title: "Numbered list",
      })}
      <span className={styles.divider} aria-hidden />
      {btn({
        label: "Link",
        onClick: toggleLink,
        active: active.link,
        title: "Add or edit link",
      })}

      {linkOpen && (
        <div className={styles.linkRow}>
          <input
            type="url"
            value={linkHref}
            placeholder="https://…"
            onChange={(e) => setLinkHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
              if (e.key === "Escape") setLinkOpen(false);
            }}
            autoFocus
            className={styles.linkInput}
          />
          <button type="button" onClick={applyLink} className={styles.linkApply}>
            Apply
          </button>
          {active.link && (
            <button type="button" onClick={removeLink} className={styles.linkRemove}>
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={() => setLinkOpen(false)}
            className={styles.linkCancel}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
