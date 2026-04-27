"use client";

import type { Editor } from "@tiptap/react";

/**
 * Compact formatting toolbar shared by `CommentComposer` (task-level) and
 * `CommentEditor` (subcomments). Bold / italic / underline / link, with
 * `editor.isActive(...)` driving the pressed state so the buttons reflect
 * the current selection. Renders nothing while the editor is null —
 * TipTap's `useEditor` returns null on the first render before the
 * extensions mount.
 *
 * The `onMouseDown(preventDefault)` trick is the standard way to keep the
 * editor focused when the user clicks a toolbar button — without it, the
 * click steals focus, the selection collapses, and `toggleBold` would no
 * longer have the right range to apply the mark to.
 */
export default function CommentToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  function handleLink() {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt(
      previous
        ? "Update the link URL (leave blank to remove the link):"
        : "Paste the URL:",
      previous ?? "",
    );
    if (input === null) return; // cancelled
    const next = input.trim();
    if (next === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!/^(https?:|mailto:)/i.test(next)) {
      window.alert("Only http(s):// and mailto: links are supported.");
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: next })
      .run();
  }

  return (
    <div style={toolbarRow} role="toolbar" aria-label="Formatting">
      <ToolbarButton
        active={editor.isActive("bold")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (⌘B)"
      >
        <span style={{ fontWeight: 700 }}>B</span>
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (⌘I)"
      >
        <span style={{ fontStyle: "italic" }}>I</span>
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("underline")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (⌘U)"
      >
        <span style={{ textDecoration: "underline" }}>U</span>
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("link")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleLink}
        title="Add or edit link"
      >
        <span aria-hidden="true">🔗</span>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  active,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "1.85rem",
        height: "1.85rem",
        padding: "0 0.45rem",
        background: active
          ? "var(--color-accent-soft)"
          : "var(--color-bg-elevated)",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
        borderRadius: "var(--radius-sm, 4px)",
        color: active ? "var(--color-accent)" : "var(--color-text)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

const toolbarRow: React.CSSProperties = {
  display: "flex",
  gap: "0.3rem",
  marginBottom: "0.35rem",
};
