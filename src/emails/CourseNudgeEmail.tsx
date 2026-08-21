import { Link, Text } from "@react-email/components";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";
import EmailChrome, {
  emailFooterTextStyle,
  emailLinkStyle,
} from "./EmailChrome";

type Props = {
  subject: string;
  blocks: Block[];
  /** `/api/unsubscribe?t=<signed>` for THIS recipient and THIS run's channel. */
  unsubscribeUrl: string;
  preheader?: string;
};

/**
 * The weekly cohort nudge. Structurally `ApplicationEmail` (admin-authored
 * blocks through the shared chrome) with `NewsletterEmail`'s unsubscribe
 * footer bolted on, because the nudge sits in the ANNOUNCEMENT lane: it is
 * opt-outable mail, so it must carry a visible unsubscribe affordance to pair
 * with the RFC 8058 `List-Unsubscribe` headers the send helper sets.
 *
 * ── WHY NOT JUST REUSE `NewsletterEmail` ────────────────────────────────────
 * Two reasons, both about the admin-editable body:
 *
 *  1. **No chrome greeting.** `NewsletterEmail` renders its own "Hi {name},"
 *     above the blocks. Every other course template opens with an authored
 *     `Hi {firstName},` heading in the body (that is what an admin sees in the
 *     designer's preview), so reusing it would print the greeting twice the
 *     moment an admin follows the pattern the other five templates teach. The
 *     greeting belongs to the template here, exactly as it does for the
 *     lifecycle mail.
 *  2. **Truthful provenance.** The newsletter footer says "you subscribed on
 *     the NAISI website". A cohort member did not: they were placed in a group
 *     and the allocation step subscribed them to `cohort:<runId>`. The footer
 *     below says the true thing, and says the part that matters — unsubscribing
 *     stops the weekly email without dropping the course.
 *
 * The body is rendered by `BlockRenderer`, so `richText` blocks reach
 * `dangerouslySetInnerHTML`. That is safe here for the same reason it is safe
 * for the application templates — the HTML is admin-authored template content,
 * not user input — and `courseNudgeEmail.ts` HTML-escapes every token value it
 * substitutes into those blocks, so the facilitator-authored week title,
 * summary, and room name arrive as TEXT. See that module's header.
 */
export default function CourseNudgeEmail({
  subject,
  blocks,
  unsubscribeUrl,
  preheader,
}: Props) {
  return (
    <EmailChrome
      subject={subject}
      preheader={preheader}
      footerSlot={
        <Text style={emailFooterTextStyle}>
          You&apos;re getting this because you&apos;re on this course with NAISI. If
          the weekly email isn&apos;t useful to you, you can{" "}
          <Link href={unsubscribeUrl} style={emailLinkStyle}>
            stop it here
          </Link>{" "}
          — you stay on the course either way.
        </Text>
      }
    >
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </EmailChrome>
  );
}
