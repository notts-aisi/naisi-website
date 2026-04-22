/**
 * Comment body serialization + parsing.
 *
 * Storage format: UTF-8 text with mention tokens `@[Display Name](uid:abc123)`.
 * The display name is for human-readable fallback if a user doc is missing;
 * the UID is the source of truth. This is narrower than full markdown by
 * design — we skip bold/italic/links for v1 to avoid 200kB of parser deps and
 * a wider XSS surface. Bold/italic/links can layer on later if the use-case
 * warrants.
 *
 * Line breaks are `\n`. Blank lines become paragraph breaks at render time.
 */

export type MentionToken = { kind: "mention"; uid: string; displayName: string };
export type TextToken = { kind: "text"; value: string };
export type LineBreakToken = { kind: "linebreak" };
export type ParagraphBreakToken = { kind: "paragraph-break" };
export type CommentToken =
  | MentionToken
  | TextToken
  | LineBreakToken
  | ParagraphBreakToken;

// [^\]\n] keeps the name single-line; (uid:...) UID is non-greedy stop at ).
const MENTION_REGEX = /@\[([^\]\n]+)\]\(uid:([^)\s]+)\)/g;

/**
 * Parse a stored body into tokens ready for rendering. Handles mention tokens,
 * single line breaks, and paragraph breaks (empty lines).
 */
export function tokenizeCommentBody(body: string): CommentToken[] {
  const out: CommentToken[] = [];

  // Split into paragraph-separated chunks, then handle newlines within each.
  const paragraphs = body.split(/\n{2,}/);
  paragraphs.forEach((para, pi) => {
    if (pi > 0) out.push({ kind: "paragraph-break" });
    const lines = para.split("\n");
    lines.forEach((line, li) => {
      if (li > 0) out.push({ kind: "linebreak" });
      pushTokensFromLine(line, out);
    });
  });

  return out;
}

function pushTokensFromLine(line: string, out: CommentToken[]): void {
  MENTION_REGEX.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_REGEX.exec(line)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: "text", value: line.slice(cursor, m.index) });
    }
    out.push({ kind: "mention", displayName: m[1], uid: m[2] });
    cursor = m.index + m[0].length;
  }
  if (cursor < line.length) {
    out.push({ kind: "text", value: line.slice(cursor) });
  }
}

/**
 * Extract all mention UIDs from a body. Used by the /notify route to decide
 * who to email. De-duplicated, preserves first-occurrence order.
 */
export function extractMentionUids(body: string): string[] {
  MENTION_REGEX.lastIndex = 0;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MENTION_REGEX.exec(body)) !== null) {
    const uid = m[2];
    if (!seen.has(uid)) {
      seen.add(uid);
      order.push(uid);
    }
  }
  return order;
}

/**
 * Serialize a TipTap JSON doc into our storage format. The mention extension
 * stores mentions as `{ type: "mention", attrs: { id: "<uid>", label: "<name>" } }`.
 * Everything else we treat as plain text + paragraph breaks.
 *
 * Accepts a loosely-typed doc so we don't take a TipTap type-dep on the
 * server side. Unknown node types fall through as empty string (safer than
 * spilling internal markup into the body).
 */
type TipTapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
};

export function serializeTipTapDoc(doc: TipTapNode | null | undefined): {
  body: string;
  mentions: string[];
} {
  if (!doc || !doc.content) return { body: "", mentions: [] };
  const mentionUids: string[] = [];
  const paragraphs: string[] = [];

  for (const block of doc.content) {
    if (block.type === "paragraph") {
      paragraphs.push(renderInline(block.content ?? [], mentionUids));
    } else if (block.type === "hardBreak") {
      // Hard break at top level — rare, treat as blank paragraph
      paragraphs.push("");
    } else {
      // Unknown block: best-effort fallback to inline rendering
      paragraphs.push(renderInline(block.content ?? [], mentionUids));
    }
  }

  const dedupedMentions: string[] = [];
  const seen = new Set<string>();
  for (const uid of mentionUids) {
    if (!seen.has(uid)) {
      seen.add(uid);
      dedupedMentions.push(uid);
    }
  }

  // Join paragraphs with a blank line between. Trim trailing whitespace.
  return { body: paragraphs.join("\n\n").replace(/\s+$/, ""), mentions: dedupedMentions };
}

function renderInline(nodes: TipTapNode[], mentionUids: string[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      out += sanitizeInlineText(n.text ?? "");
    } else if (n.type === "mention") {
      const uid = typeof n.attrs?.id === "string" ? n.attrs.id : null;
      const label = typeof n.attrs?.label === "string" ? n.attrs.label : "User";
      if (uid) {
        mentionUids.push(uid);
        out += `@[${label}](uid:${uid})`;
      }
    } else if (n.type === "hardBreak") {
      out += "\n";
    } else if (n.content) {
      out += renderInline(n.content, mentionUids);
    }
  }
  return out;
}

/**
 * Strip control chars but keep everything else. We deliberately don't encode
 * `@`, `[`, `]`, `(`, `)` because those would corrupt the storage format only
 * if a user typed the exact sequence `@[...](uid:...)` — which is a
 * non-human-readable token and vanishingly unlikely in free-form prose.
 */
function sanitizeInlineText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}
