"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Compact formatting toolbar shared by `CommentComposer` (task-level) and
 * `CommentEditor` (subcomments) — also used by the description editor.
 * Bold / italic / underline / link, with `editor.isActive(...)` driving
 * the pressed state. The host editors set `shouldRerenderOnTransaction:
 * true` so the buttons stay in sync with the live selection.
 *
 * The toolbar renders flush at the top of the composer chrome (single
 * border around the whole composer, separator only beneath the toolbar
 * row). `onMouseDown(preventDefault)` keeps the editor focused when the
 * user clicks a toolbar button — without it, the click steals focus, the
 * selection collapses, and `toggleBold` would no longer have the right
 * range to apply.
 */
export default function CommentToolbar({ editor }: { editor: Editor | null }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close the link popover on outside click + Escape. Anchoring the
  // dismiss behaviour to the popover lifecycle keeps the editor itself
  // free of dismissal logic.
  useEffect(() => {
    if (!linkOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (popoverRef.current?.contains(target)) return;
      if (linkButtonRef.current?.contains(target)) return;
      setLinkOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLinkOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [linkOpen]);

  useEffect(() => {
    if (linkOpen) inputRef.current?.focus();
  }, [linkOpen]);

  if (!editor) return null;

  function openLinkPopover() {
    if (!editor) return;
    const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkDraft(previous);
    setLinkError(null);
    setLinkOpen(true);
  }

  /**
   * Normalise what the user typed into a safe href, or null if it
   * couldn't be coerced into one. Auto-prefixes `https://` for
   * unprefixed inputs that look like URLs (contain a `.`) — matches the
   * behaviour every other chat composer has and avoids the "doesn't
   * recognise things without https" footgun.
   */
  function normaliseHref(raw: string): { href: string } | { error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { error: "Paste a URL or leave blank to remove the link." };
    // Already-prefixed inputs go through the allowlist directly.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      if (
        lower.startsWith("http://") ||
        lower.startsWith("https://") ||
        lower.startsWith("mailto:")
      ) {
        return { href: trimmed };
      }
      return { error: "Only http(s):// and mailto: links are supported." };
    }
    // No scheme — auto-prefix `https://` if it looks even vaguely like a
    // host (one dot or `localhost`). Otherwise reject so the user gets
    // feedback instead of a broken link.
    if (trimmed.includes(".") || trimmed === "localhost" || trimmed.startsWith("localhost:")) {
      return { href: `https://${trimmed}` };
    }
    return { error: "That doesn't look like a URL." };
  }

  function applyLink() {
    if (!editor) return;
    const trimmed = linkDraft.trim();
    if (!trimmed) {
      // Empty submit removes the link — matches Slack / Notion convention.
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const result = normaliseHref(trimmed);
    if ("error" in result) {
      setLinkError(result.error);
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: result.href })
      .run();
    setLinkOpen(false);
  }

  function removeLink() {
    if (!editor) return;
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkOpen(false);
  }

  const linkActive = editor.isActive("link");

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
      <span style={{ position: "relative", display: "inline-flex" }}>
        <ToolbarButton
          active={linkActive}
          ref={linkButtonRef}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openLinkPopover}
          title={linkActive ? "Edit link" : "Add link"}
        >
          <span aria-hidden="true">🔗</span>
        </ToolbarButton>
        {linkOpen && (
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Link URL"
            style={popoverStyle}
            // Stop click bubbling so the editor's outside-click handlers
            // don't blur the input mid-type.
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              type="url"
              value={linkDraft}
              onChange={(e) => {
                setLinkDraft(e.target.value);
                if (linkError) setLinkError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                }
              }}
              placeholder="paste or type a URL — we'll add https:// if missing"
              style={popoverInput}
              autoComplete="off"
              spellCheck={false}
            />
            {linkError && <div style={popoverError}>{linkError}</div>}
            <div style={popoverActions}>
              <button
                type="button"
                onClick={applyLink}
                onMouseDown={(e) => e.preventDefault()}
                style={popoverPrimary}
              >
                {linkActive ? "Update" : "Add"}
              </button>
              {linkActive && (
                <button
                  type="button"
                  onClick={removeLink}
                  onMouseDown={(e) => e.preventDefault()}
                  style={popoverDanger}
                >
                  Remove
                </button>
              )}
              <button
                type="button"
                onClick={() => setLinkOpen(false)}
                onMouseDown={(e) => e.preventDefault()}
                style={popoverGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </span>
    </div>
  );
}

const ToolbarButton = function ToolbarButton({
  children,
  active,
  ref,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={ref}
      {...rest}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "1.85rem",
        height: "1.85rem",
        padding: "0 0.45rem",
        background: active
          ? "var(--color-accent-soft)"
          : "transparent",
        border: `1px solid ${active ? "var(--color-accent)" : "transparent"}`,
        borderRadius: "var(--radius-sm, 4px)",
        color: active ? "var(--color-accent)" : "var(--color-text)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      {children}
    </button>
  );
};

const toolbarRow: React.CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0.3rem 0.45rem",
  background: "var(--color-bg)",
  borderBottom: "1px solid var(--color-border)",
  // Match the parent wrapper's `--radius-md` on the top corners so the
  // toolbar bg paints to the rounded edges. The wrapper drops
  // `overflow: hidden` to let the link popover escape downward without
  // getting clipped, so the radius has to live on the toolbar itself.
  borderTopLeftRadius: "var(--radius-md)",
  borderTopRightRadius: "var(--radius-md)",
};

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  // Anchor to the right edge of the link-button span and expand leftward
  // so a button near the right edge of a narrow toolbar (the task modal
  // at 375px) doesn't push the popover past the modal frame.
  right: 0,
  left: "auto",
  zIndex: 10,
  minWidth: "min(20rem, calc(100vw - 2 * var(--space-4)))",
  maxWidth: "calc(100vw - 2 * var(--space-4))",
  padding: "var(--space-3)",
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const popoverInput: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm, 4px)",
  color: "var(--color-text)",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const popoverError: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--color-danger, #dc2626)",
};

const popoverActions: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
};

const popoverPrimary: React.CSSProperties = {
  padding: "0.35rem 0.85rem",
  background: "var(--color-accent)",
  color: "var(--color-bg)",
  border: "none",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const popoverGhost: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  background: "transparent",
  color: "var(--color-text-muted)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const popoverDanger: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  background: "transparent",
  color: "var(--color-danger, #dc2626)",
  border: "1px solid var(--color-danger, #dc2626)",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  fontFamily: "inherit",
};
