/**
 * Comment body serialization + parsing.
 *
 * Storage format: UTF-8 text with mention tokens `@[Display Name](uid:abc123)`
 * + a small set of inline formatting markers (Stage 7, 2026-04-27): bold
 * `**text**`, italic `_text_`, underline `<u>text</u>`, link
 * `[text](href)`. Markers may nest; marks layered on a text run are applied
 * inside-out so a stored body round-trips through the TipTap composer
 * deterministically. The display name on a mention is for human-readable
 * fallback if a user doc is missing; the UID is the source of truth.
 *
 * The format is narrower than full markdown by design — no headings, lists,
 * blockquotes, code blocks. They aren't useful in committee chat and would
 * widen the XSS surface (or pull in a 200kB parser). Bold/italic/underline/
 * links are the minimum that makes "this URL is the agenda" + "I emphasise
 * this" possible inline. Line breaks remain `\n`; blank lines are
 * paragraph breaks at render time.
 *
 * Backward-compat: pre-Stage-7 bodies (plain text + mentions only) parse
 * cleanly because none of the new markers can match without their pairs.
 * No migration needed; existing comments render identically.
 */

export type TextMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "link"; href: string };

export type MentionToken = { kind: "mention"; uid: string; displayName: string };
export type TextToken = { kind: "text"; value: string; marks: TextMark[] };
export type LineBreakToken = { kind: "linebreak" };
export type ParagraphBreakToken = { kind: "paragraph-break" };
export type CommentToken =
  | MentionToken
  | TextToken
  | LineBreakToken
  | ParagraphBreakToken;

// [^\]\n] keeps the name single-line; (uid:...) UID is non-greedy stop at ).
const MENTION_REGEX = /@\[([^\]\n]+)\]\(uid:([^)\s]+)\)/g;

// Bold / italic / underline / link, with three safety nets:
//   1. Each marker's inner-text class forbids the marker char + newline so a
//      stray opener can't swallow the rest of the line.
//   2. The link alternative uses a `(?<!@)` lookbehind so the inner half of
//      a mention token (`[name](uid:xxx)`) never gets misread as a link.
//   3. Italic uses `\b_…_\b` word-boundary guards so common identifiers
//      like `my_var_name` or `__init__` keep their underscores literal.
//      Bold (`**…**`) and underline (`<u>…</u>`) don't need this because
//      their delimiters aren't word chars and basically never appear by
//      accident.
// Order matters for ambiguity: bold goes before italic so `**foo**` is
// matched as bold rather than two adjacent empty-italic stubs.
const FORMAT_REGEX =
  /\*\*([^*\n]+?)\*\*|\b_([^_\n]+?)_\b|<u>([^<\n]+?)<\/u>|(?<!@)\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Allow only http(s) and mailto links through the renderer / TipTap node
 * tree. `javascript:`, `data:`, etc. would let a comment author run code in
 * the reader's browser context. Returns the trimmed href on success, null
 * if the scheme isn't on the allowlist (caller falls back to rendering the
 * literal `[text](href)` so the markup stays visible without becoming
 * clickable).
 */
function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return trimmed;
  }
  return null;
}

/**
 * Recursive parse of a plain-text segment (no mentions present — the
 * caller has already split by mention tokens). Each match wraps its inner
 * text in another mark and recurses, producing a flat list of text
 * tokens whose `marks` array runs outermost-first → innermost-last.
 */
function parseFormattedText(text: string, marks: TextMark[]): TextToken[] {
  const out: TextToken[] = [];
  // Local copy of the regex — reusing the module-level one would race with
  // outer recursive calls (regex `lastIndex` is shared per-instance).
  const re = new RegExp(FORMAT_REGEX.source, "g");
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      out.push({ kind: "text", value: text.slice(cursor, m.index), marks });
    }
    let inner: string | null = null;
    let next: TextMark[] | null = null;
    if (m[1] !== undefined) {
      inner = m[1];
      next = [...marks, { type: "bold" }];
    } else if (m[2] !== undefined) {
      inner = m[2];
      next = [...marks, { type: "italic" }];
    } else if (m[3] !== undefined) {
      inner = m[3];
      next = [...marks, { type: "underline" }];
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = sanitizeHref(m[5]);
      if (href !== null) {
        inner = m[4];
        next = [...marks, { type: "link", href }];
      }
    }
    if (inner !== null && next !== null) {
      out.push(...parseFormattedText(inner, next));
    } else {
      // Unrecognised / unsafe marker — keep it as literal text so the
      // user can see what they typed instead of silently swallowing it.
      out.push({ kind: "text", value: m[0], marks });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    out.push({ kind: "text", value: text.slice(cursor), marks });
  }
  return out;
}

/**
 * Parse a stored body into tokens ready for rendering. Handles mention
 * tokens, single line breaks, paragraph breaks, and inline formatting
 * (bold / italic / underline / link). Mentions are extracted first so
 * format markers can never accidentally swallow them.
 */
export function tokenizeCommentBody(body: string): CommentToken[] {
  const out: CommentToken[] = [];
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
      out.push(...parseFormattedText(line.slice(cursor, m.index), []));
    }
    out.push({ kind: "mention", displayName: m[1], uid: m[2] });
    cursor = m.index + m[0].length;
  }
  if (cursor < line.length) {
    out.push(...parseFormattedText(line.slice(cursor), []));
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
 * Text nodes carry a `marks` array — bold / italic / underline / link map
 * to their corresponding storage markers. Marks are applied innermost-first
 * so the marker order matches what the parser expects on round-trip.
 *
 * Accepts a loosely-typed doc so we don't take a TipTap type-dep on the
 * server side. Unknown node types fall through as empty string (safer than
 * spilling internal markup into the body).
 */
// Loose mirror of TipTap's `JSONContent` — defined here so the markdown
// module stays free of any `@tiptap/*` import (it runs server-side too,
// for the email preview shaping in /notify). Marks carry `type: string`
// to match what TipTap's typings demand on the way *into* the editor;
// optional only to tolerate malformed snapshots on the way *out*.
type TipTapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type TipTapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: TipTapMark[];
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
      paragraphs.push("");
    } else {
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

  return {
    body: paragraphs.join("\n\n").replace(/\s+$/, ""),
    mentions: dedupedMentions,
  };
}

function applyStorageMark(text: string, mark: TipTapMark): string {
  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `_${text}_`;
    case "underline":
      return `<u>${text}</u>`;
    case "link": {
      const href =
        typeof mark.attrs?.href === "string" ? sanitizeHref(mark.attrs.href) : null;
      // Drop the link wrapper if href didn't pass the scheme allowlist —
      // round-tripping a cleaned link would surprise the author. Keeping
      // just the inner text matches what the renderer would have shown.
      return href !== null ? `[${text}](${href})` : text;
    }
    default:
      return text;
  }
}

function renderInline(nodes: TipTapNode[], mentionUids: string[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      let acc = sanitizeInlineText(n.text ?? "");
      const marks = Array.isArray(n.marks) ? n.marks : [];
      // Apply marks innermost-first so the *last* mark in the array becomes
      // the outermost wrapper in storage. Matches `parseFormattedText`'s
      // outer-first parse order so a stored body parsed and re-serialized
      // produces the same bytes.
      for (const mark of marks) {
        acc = applyStorageMark(acc, mark);
      }
      out += acc;
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
 * Inverse of `serializeTipTapDoc`: parse a stored body back into TipTap JSON
 * so mention pills + formatted text round-trip when the editor is seeded
 * with existing content. Text tokens with marks become TipTap text nodes
 * whose `marks` array carries the corresponding TipTap mark types.
 */
export function bodyToTipTapDoc(body: string): TipTapNode {
  const tokens = tokenizeCommentBody(body);
  const content: TipTapNode[] = [];
  let para: TipTapNode[] = [];
  const flush = () => {
    content.push({ type: "paragraph", content: para.length ? para : undefined });
    para = [];
  };
  for (const t of tokens) {
    if (t.kind === "paragraph-break") flush();
    else if (t.kind === "linebreak") para.push({ type: "hardBreak" });
    else if (t.kind === "text") {
      const tipTapMarks = t.marks.map(textMarkToTipTap);
      para.push({
        type: "text",
        text: t.value,
        ...(tipTapMarks.length > 0 ? { marks: tipTapMarks } : {}),
      });
    } else if (t.kind === "mention") {
      para.push({ type: "mention", attrs: { id: t.uid, label: t.displayName } });
    }
  }
  flush();
  return { type: "doc", content };
}

function textMarkToTipTap(mark: TextMark): TipTapMark {
  if (mark.type === "link") {
    return { type: "link", attrs: { href: mark.href } };
  }
  return { type: mark.type };
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

/**
 * Re-export the URL allowlist so the comment renderer can validate hrefs
 * one more time at paint-time. Defence-in-depth — a stored body should
 * already be sanitised, but a buggy migration or an admin-edited Firestore
 * doc shouldn't be able to slip a `javascript:` URL past the renderer.
 */
export { sanitizeHref };
