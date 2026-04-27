"use client";

import { Fragment, type ReactNode } from "react";
import type { UserDoc } from "@/lib/firestore/users";
import {
  sanitizeHref,
  tokenizeCommentBody,
  type TextMark,
  type TextToken,
} from "../lib/comments/markdown";

type Props = {
  body: string;
  /** Provide when the body may contain `@[name](uid:xxx)` mention
   *  tokens (i.e. comments). Omit on description fields where mentions
   *  aren't allowed — they'll never appear, and we skip the user lookup
   *  entirely. */
  users?: UserDoc[];
};

/**
 * Universal renderer for the rich-text storage format used by both
 * comments and descriptions. Walks the token stream produced by
 * `tokenizeCommentBody` and emits semantic React nodes — `<strong>`,
 * `<em>`, `<u>`, sanitised `<a>` for links, mention pills for `@uid`
 * tokens. Defence-in-depth on link hrefs: re-runs `sanitizeHref` at
 * paint-time so a buggy migration or admin-edited Firestore doc can't
 * sneak a `javascript:` URL past the renderer.
 */
export default function RichTextRender({ body, users }: Props) {
  const tokens = tokenizeCommentBody(body);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === "text") return <FormattedText key={i} token={t} />;
        if (t.kind === "linebreak") return <br key={i} />;
        if (t.kind === "paragraph-break") {
          return (
            <Fragment key={i}>
              <br />
              <br />
            </Fragment>
          );
        }
        // mention
        const mentioned = users?.find((u) => u.uid === t.uid);
        const label = mentioned?.displayName ?? mentioned?.email ?? t.displayName;
        return (
          <span
            key={i}
            title={mentioned?.email ?? undefined}
            style={{
              background: "var(--color-accent-soft)",
              color: "var(--color-accent)",
              padding: "0 0.3rem",
              borderRadius: "var(--radius-sm, 4px)",
              fontWeight: 500,
            }}
          >
            @{label}
          </span>
        );
      })}
    </>
  );
}

function FormattedText({ token }: { token: TextToken }) {
  let node: ReactNode = token.value;
  for (let i = token.marks.length - 1; i >= 0; i--) {
    node = wrapWithMark(token.marks[i], node);
  }
  return <>{node}</>;
}

function wrapWithMark(mark: TextMark, child: ReactNode): ReactNode {
  switch (mark.type) {
    case "bold":
      return <strong>{child}</strong>;
    case "italic":
      return <em>{child}</em>;
    case "underline":
      return <u>{child}</u>;
    case "link": {
      const safe = sanitizeHref(mark.href);
      if (!safe) return <>{child}</>;
      return (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "var(--color-accent)",
            textDecoration: "underline",
          }}
        >
          {child}
        </a>
      );
    }
    default:
      return <>{child}</>;
  }
}
