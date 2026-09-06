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
   * Where this applicant reads this application back, or "" when the send path
   * has none (which should not happen: `NEXT_PUBLIC_APP_URL` is set on every
   * backend). Built server-side from the round id, never from a request body.
   */
  applicationUrl: string;
  preheader?: string;
};

/**
 * The receipt somebody gets when they submit an application to an admission
 * round.
 *
 * Structurally `ApplicationEmail` (admin-authored blocks through the shared
 * chrome) with one addition: a footer link back to the application.
 *
 * ── WHY THE LINK IS A PROP AND NOT A BODY TOKEN ─────────────────────────────
 * The same argument as `CourseDroppedOutEmail`. `personaliseBlocks` leaves an
 * unresolved `{token}` LITERAL, which is right for admin-authored copy and
 * wrong for a URL: the day a send path stops passing it, the email reads "read
 * it at {applicationUrl}" to somebody who has just spent an evening writing an
 * application. Rendered here, the link is either a real link or nothing at all,
 * and the email is complete either way.
 *
 * ── WHAT THIS EMAIL MUST NOT DO ─────────────────────────────────────────────
 * It must not congratulate, encourage or discourage. It goes to every single
 * applicant the moment they press submit, weeks before anybody has read a word
 * of it, and a warm sentence here is read as a signal by somebody who very
 * much wants one. Say it arrived, say when they will hear, stop.
 *
 * No unsubscribe footer: this is TRANSACTIONAL, and the recipient caused it by
 * pressing submit.
 *
 * `richText` blocks reach `dangerouslySetInnerHTML` through `BlockRenderer`.
 * Safe for the reason it is on every other template in this estate: the HTML is
 * admin-authored template copy. THE APPLICANT'S OWN ANSWERS ARE NEVER PUT IN
 * THIS EMAIL, so no member-authored string reaches that renderer.
 */
export default function AdmissionsSubmittedEmail({
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
            You can{" "}
            <Link href={applicationUrl} style={emailLinkStyle}>
              read your application on the site
            </Link>{" "}
            whenever you like. That page is also where the decision shows up.
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
