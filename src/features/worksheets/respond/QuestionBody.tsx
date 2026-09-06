import BlockView from "@/features/events/BlockView";
import type { Block } from "@/lib/firestore/newsletterBlocks";

/**
 * The rich body under a question's title, or under a section's heading.
 *
 * `BlockView` is the same renderer the public event page uses, which is what
 * makes an image, a paragraph and an embedded video look the same wherever a
 * block body appears on the site. The worksheet model already narrows the
 * block set to richText, image and video (`sanitizeBody` in worksheets.ts), so
 * a heading or a divider pasted in from a newsletter draft never reaches here
 * to compete with the question's own title.
 *
 * Renders nothing at all for an empty body, so a question with no prose under
 * it does not leave a gap where a paragraph would be.
 */
export default function QuestionBody({ body }: { body: Block[] }) {
  if (!body || body.length === 0) return null;
  return <BlockView blocks={body} />;
}
