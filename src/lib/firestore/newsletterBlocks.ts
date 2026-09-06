import { marked } from "marked";

/**
 * A draft (newsletter or event) is an ordered list of typed blocks. Each block
 * has its own editor form in the UI and its own rendered output.
 *
 * Types: heading, richText, image, divider, video.
 * Video blocks render as an embedded player on the web and as a thumbnail link
 * in email (iframes are blocked by most clients). YouTube and Loom are both
 * recognised: see `videoEmbedFromUrl` at the foot of this file, which is the
 * one place that decides which provider a pasted URL belongs to.
 *
 * NO RENDERER CALLS `videoEmbedFromUrl` YET. Every video block on the site
 * still resolves through `youtubeIdFromUrl`, so a pasted Loom URL is accepted
 * by this module and rendered by nothing: the resolver landed first, with the
 * worksheets data model, and the surfaces adopt it in the wave that builds the
 * editors. Said here because "Loom is recognised" is true of this file and not
 * yet true of anything a reader can see.
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

/**
 * Extract the 32-hex Loom video id from a share or embed URL.
 *
 * Loom joined YouTube as a video provider for worksheets: a question body is
 * where a reviewer records a two-minute walkthrough of what they are asking
 * for, and that recording is made in Loom rather than published to YouTube.
 *
 * Only the two real URL shapes are accepted, `loom.com/share/<id>` and
 * `loom.com/embed/<id>`. Unlike `youtubeIdFromUrl` there is deliberately NO
 * bare-id branch: an 11-character YouTube id is recognisable because it sits
 * in a `v=` slot, whereas a bare 32-character hex string is just a hex string,
 * and treating any such blob as a video would turn a pasted hash into a
 * silent, broken embed.
 */
export function loomIdFromUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.hostname.replace(/^www\./, "") !== "loom.com") return null;
  // `\b` after the group so a longer hex run fails rather than being truncated
  // to its first 32 characters, which would embed a different video.
  const match = url.pathname.match(/^\/(?:share|embed)\/([0-9a-fA-F]{32})\b/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * One resolved video block: which provider, its id, and the three URLs every
 * surface needs: the iframe source, the human link, and a thumbnail for the
 * places an iframe cannot go.
 *
 * `thumbnailUrl` is nullable because Loom has no public thumbnail endpoint.
 * A caller with no iframe (an email, where clients strip them) therefore has
 * to render a Loom block as a plain link, and the null is what tells it so.
 */
export type VideoEmbed = {
  provider: "youtube" | "loom";
  id: string;
  embedUrl: string;
  watchUrl: string;
  thumbnailUrl: string | null;
};

/**
 * Resolve a pasted video URL to the provider that recognises it.
 *
 * YouTube is tried first because its matcher accepts a bare id and would
 * otherwise never be reached for one. The two matchers cannot both match a
 * given input in any case: the hostnames are disjoint and the id shapes differ.
 *
 * The YouTube URLs are exactly the ones the existing renderers already build
 * (`youtube-nocookie.com/embed/<id>` for the iframe, so a reader is not
 * cookied by a block they did not click, and `i.ytimg.com/vi/<id>/hqdefault.jpg`
 * for the email thumbnail), so adopting this helper cannot change what any of
 * them renders today.
 */
export function videoEmbedFromUrl(raw: string): VideoEmbed | null {
  const youtubeId = youtubeIdFromUrl(raw);
  if (youtubeId) {
    return {
      provider: "youtube",
      id: youtubeId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
      watchUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    };
  }
  const loomId = loomIdFromUrl(raw);
  if (loomId) {
    return {
      provider: "loom",
      id: loomId,
      embedUrl: `https://www.loom.com/embed/${loomId}`,
      watchUrl: `https://www.loom.com/share/${loomId}`,
      thumbnailUrl: null,
    };
  }
  return null;
}
