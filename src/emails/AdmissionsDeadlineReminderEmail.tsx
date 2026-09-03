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
  /** Back to the FORM: the audience holds drafts, so there is still writing to do. */
  applicationUrl: string;
  preheader?: string;
};

/**
 * The nudge somebody gets while their application is still a draft.
 *
 * ── WHO GETS IT ─────────────────────────────────────────────────────────────
 * Only `status: "draft"` on an open round, on the dates that round's reminder
 * schedule resolves to. Anyone who has submitted is out of the audience by
 * construction, which is why the copy can state plainly that the thing is
 * still a draft rather than hedging about it.
 *
 * ── WHY THE LINK GOES TO /apply AND NOT TO THE STATUS HUB ───────────────────
 * Its sibling receipts link to `/applications/[roundId]`, because by then the
 * application is with us and the only thing left to do is read it back. This
 * one is the opposite case: there is unfinished writing, and the one action
 * the email is asking for is to go and finish it. Sending this reader to a
 * status page would be a step in the wrong direction on the one day the step
 * matters.
 *
 * Same link discipline as the rest of the family: rendered HERE rather than
 * tokenised into the body, so it is either a real link or absent, never the
 * fourteen literal characters of an unresolved token.
 *
 * No unsubscribe footer. This is transactional: it is about a document the
 * recipient started, it stops when they submit or when the round closes, and
 * there is nothing to unsubscribe from that leaving the draft alone does not
 * already do. The line below says so, because a reminder that does not
 * explain when it stops reads as the first of an unknown number.
 *
 * No member-authored string ever goes in the body.
 */
export default function AdmissionsDeadlineReminderEmail({
  subject,
  blocks,
  applicationUrl,
  preheader,
}: Props) {
  return (
    <EmailChrome
      subject={subject}
      preheader={preheader}
      footerSlot={
        applicationUrl ? (
          <Text style={emailFooterTextStyle}>
            <Link href={applicationUrl} style={emailLinkStyle}>
              Finish your application
            </Link>{" "}
            before the deadline. Once you submit, these reminders stop.
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
