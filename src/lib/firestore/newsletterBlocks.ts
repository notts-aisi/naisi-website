import { marked } from "marked";

/**
 * A draft (newsletter or event) is an ordered list of typed blocks. Each block
 * has its own editor form in the UI and its own rendered output.
 *
 * Types: heading, richText, image, divider, video.
 * Video blocks render as embedded YouTube on the web and as a thumbnail link
 * in email (iframes are blocked by most clients).
 */

export type BlockType = "heading" | "richText" | "image" | "divider" | "video";

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

export type VideoBlock = BaseBlock & {
  type: "video";
  /** Full pasted URL. We parse the video ID on render. */
  url: string;
  caption?: string;
};

export type Block =
  | HeadingBlock
  | RichTextBlock
  | ImageBlock
  | DividerBlock
  | VideoBlock;

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
    case "video":
      return { id, type: "video", url: "" };
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
    case "video":
      return typeof b.url === "string";
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
 * Map of token keys → substitution values. Missing/undefined values leave the
 * {token} literal in place so admins notice typos.
 */
export type TokenValues = Record<string, string | undefined>;

/**
 * Substitute `{key}` patterns in a string against a token map. Unknown keys
 * are left untouched. Used at send time for both subject lines and block text.
 */
export function personaliseString(input: string, tokens: TokenValues): string {
  return input.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    const value = tokens[key];
    return typeof value === "string" ? value : match;
  });
}

/**
 * Replace tokens in any text content of the block list. Used at send time,
 * never at edit time.
 */
export function personaliseBlocks(blocks: Block[], tokens: TokenValues): Block[] {
  const sub = (s: string) => personaliseString(s, tokens);
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
      case "video":
        return { ...b, caption: b.caption ? sub(b.caption) : b.caption };
    }
  });
}

/**
 * Extract the 11-char YouTube video ID from a typical URL. Supports watch URLs,
 * short youtu.be links, /embed/, /shorts/, and bare IDs. Returns null when
 * the input doesn't look like a YouTube reference.
 */
export function youtubeIdFromUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  // Bare 11-char id (what you get if the drafter pastes just the ID).
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const match = url.pathname.match(/\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
  }
  return null;
}
