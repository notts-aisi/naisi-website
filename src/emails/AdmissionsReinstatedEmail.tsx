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
  /** Where the applicant carries on writing. Built server-side from the round id. */
  applicationUrl: string;
  preheader?: string;
};

/**
 * The note somebody gets when a withdrawn application is picked back up: they
 * pressed "apply" again inside the window, so the row they had is a draft
 * again with every answer still on it.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * Reopening is the one step in the applicant lane that LOOKS like a submission
 * and is not one. The form fills itself back in with everything they wrote, so
 * somebody who reopens on the deadline evening can easily believe they are
 * done. This email exists to say, in writing, that the thing in front of them
 * is a draft and that a draft at the deadline is not an application.
 *
 * It therefore leads with the link, and the copy is deliberately blunt about
 * the deadline. Same link discipline as its sibling: rendered here rather than
 * tokenised into the body, so it is either real or absent.
 *
 * No unsubscribe footer (transactional), and no member-authored string ever
 * goes in the body.
 */
export default function AdmissionsReinstatedEmail({
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
            to finish it. It is not with us until you press submit.
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
