import { marked } from "marked";

/**
 * A newsletter draft is an ordered list of typed blocks. Each block has its own
 * editor form in the admin UI and its own React Email component at render time.
 *
 * Phase 1 types: heading, richText, image, divider. Phase 2 adds callout, button.
 */

export type BlockType = "heading" | "richText" | "image" | "divider";

type BaseBlock = {
  id: string;
  type: BlockType;
};

export type HeadingBlock = BaseBlock & {
  type: "heading";
  text: string;
  /** h2 = major section; h3 = subsection. */
  level: 2 | 3;
};

export type RichTextBlock = BaseBlock & {
  type: "richText";
  /** TipTap HTML output. Trusted content — drafters pass admin approval. */
  html: string;
};

export type ImageBlock = BaseBlock & {
  type: "image";
  /** Publicly-accessible URL (Firebase Storage download URL). */
  url: string;
  /** Required for accessibility + when images are blocked. */
  alt: string;
  caption?: string;
  /** Persisted so delete-on-removal could be wired up later. */
  storagePath?: string;
};

export type DividerBlock = BaseBlock & {
  type: "divider";
};

export type Block = HeadingBlock | RichTextBlock | ImageBlock | DividerBlock;

/** Short, collision-unlikely block id for the editor. */
export function newBlockId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyBlock(type: BlockType): Block {
  const id = newBlockId();
  switch (type) {
    case "heading":
      return { id, type: "heading", text: "", level: 2 };
    case "richText":
      return { id, type: "richText", html: "" };
    case "image":
      return { id, type: "image", url: "", alt: "" };
    case "divider":
      return { id, type: "divider" };
  }
}

/** Quick structural check — never trust arbitrary Firestore data. */
export function isValidBlock(raw: unknown): raw is Block {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.type !== "string") return false;
  switch (b.type) {
    case "heading":
      return (
        typeof b.text === "string" &&
        (b.level === 2 || b.level === 3)
      );
    case "richText":
      return typeof b.html === "string";
    case "image":
      return typeof b.url === "string" && typeof b.alt === "string";
    case "divider":
      return true;
    default:
      return false;
  }
}

export function sanitizeBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidBlock);
}

/**
 * Auto-migrate a legacy bodyMarkdown-only draft to a single rich-text block.
 * Rendered from the existing markdown via marked so existing drafts look the
 * same as before, just now in the new structure.
 */
export function bodyMarkdownToBlocks(bodyMarkdown: string): Block[] {
  if (!bodyMarkdown.trim()) return [];
  const html = marked.parse(bodyMarkdown, { async: false }) as string;
  return [{ id: newBlockId(), type: "richText", html }];
}

/**
 * Replace {preferredName} tokens in any text content of the block list.
 * Used at send time, never at edit time.
 */
export function personaliseBlocks(blocks: Block[], preferredName: string): Block[] {
  const sub = (s: string) => s.replace(/\{preferredName\}/g, preferredName);
  return blocks.map((b) => {
    switch (b.type) {
      case "heading":
        return { ...b, text: sub(b.text) };
      case "richText":
        return { ...b, html: sub(b.html) };
      case "image":
        return { ...b, alt: sub(b.alt), caption: b.caption ? sub(b.caption) : b.caption };
      case "divider":
        return b;
    }
  });
}
