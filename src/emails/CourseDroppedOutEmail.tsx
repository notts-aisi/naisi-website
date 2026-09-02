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
  /**
   * The anonymous feedback form from `config/courses.dropOutFeedbackUrl`, or
   * "" when none is configured. Scheme-checked upstream (`readCoursesConfig`
   * anchors it on `^https?://`), which is what makes putting it straight in an
   * href safe to say.
   */
  feedbackUrl: string;
  preheader?: string;
};

/**
 * The confirmation someone gets after leaving a course.
 *
 * Structurally `ApplicationEmail` (admin-authored blocks through the shared
 * chrome) with one addition: an OPTIONAL feedback footer.
 *
 * ── WHY THE LINK IS A COMPONENT PROP AND NOT A BODY TOKEN ────────────────────
 * `personaliseBlocks` leaves an unresolved `{token}` LITERAL, which is the
 * right convention for admin-authored copy (a typo is visible in a test send)
 * and the wrong one for a link that is legitimately absent: with no form
 * configured, a token in the body would mail "tell us at {feedbackUrl}" to
 * somebody who has just quit. The feedback ask is therefore rendered here,
 * only when there is somewhere for it to point, and disappears entirely when
 * there is not. That is a complete state, not a degraded one: the drop-out
 * works, it just asks for nothing.
 *
 * ── WHAT THIS EMAIL MUST NOT DO ─────────────────────────────────────────────
 * No unsubscribe footer, because this is TRANSACTIONAL: the recipient asked
 * for the thing it confirms. The cohort channel they were on is unsubscribed
 * by the drop-out route itself, so there is nothing here for them to opt out
 * of. And no "are you sure" or re-join link: dropping out is irreversible by
 * decision, and an email that hints otherwise sets up a disappointment.
 *
 * `richText` blocks reach `dangerouslySetInnerHTML` through `BlockRenderer`.
 * Safe for the same reason it is on the application templates: the HTML is
 * admin-authored template content, never member input. The one member-authored
 * string in this flow, the drop-out reason, is NEVER put in this email.
 */
export default function CourseDroppedOutEmail({
  subject,
  blocks,
  feedbackUrl,
  preheader,
}: Props) {
  return (
    <EmailChrome
      subject={subject}
      preheader={preheader}
      footerSlot={
        feedbackUrl ? (
          <Text style={emailFooterTextStyle}>
            If you have two minutes, we&apos;d really like to know what got in
            the way:{" "}
            <Link href={feedbackUrl} style={emailLinkStyle}>
              tell us anonymously
            </Link>
            . It goes to nobody who taught you, and it is the main way we work
            out what to change.
          </Text>
        ) : undefined
      }
    >
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </EmailChrome>
  );
}
