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
  /** Back to the FORM: the new questions are answered where the rest were. */
  applicationUrl: string;
  preheader?: string;
};

/**
 * The note that goes out when a round releases the next part of its form.
 *
 * ── IT ANNOUNCES, IT DOES NOT AUTHORISE ─────────────────────────────────────
 * The release itself is derived at read time by `isStageReleased`, so the
 * questions are already on the applicant's form before this email is
 * composed. That is deliberate: a tick that never ran, a scheduler that was
 * switched off, a send that bounced, none of them can gate a question behind
 * an email. So the copy says the part is open, never that this letter opens
 * it, and there is nothing in here to click that unlocks anything.
 *
 * ── WHO GETS IT ─────────────────────────────────────────────────────────────
 * Everybody on the round holding a `draft` or a `submitted` application.
 * Somebody who submitted stage one a fortnight ago is squarely in the
 * audience, which is why the body reassures them that what they already sent
 * is untouched. Withdrawn and decided rows are out.
 *
 * ── WHY THE LINK GOES TO /apply ─────────────────────────────────────────────
 * There is writing to do, and it is done on the form. Sending this reader to
 * their status page would be a step away from the one action the email is
 * about. Same link discipline as the rest of the family: rendered HERE rather
 * than tokenised into the body, so it is either a real link or absent, never
 * fourteen literal characters.
 *
 * No unsubscribe footer. This is transactional: it is about a form the
 * recipient started, and it stops when the round closes.
 *
 * No member-authored string ever goes in the body.
 */
export default function AdmissionsStageReleasedEmail({
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
              Open your application
            </Link>{" "}
            to read the new questions. They are already there.
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
