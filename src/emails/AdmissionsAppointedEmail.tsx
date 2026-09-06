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
   * The decider's own note, typically the training dates and where to be.
   * Plain text, rendered as a text node. "" when they wrote none, and then no
   * paragraph appears at all.
   */
  note: string;
  /**
   * Where this person reads their application back, or "" when the send path
   * has none. Built server-side from the round id, never from a request body.
   */
  applicationUrl: string;
  preheader?: string;
};

/**
 * The email somebody gets when an appointment round appoints them to
 * facilitate a run.
 *
 * ── WHY THE NOTE IS A PROP AND NOT A TOKEN ──────────────────────────────────
 * The note is typed by the decider in the appointments queue, at decide time,
 * and it carries the one fact the template cannot: which training session to
 * be at. A round has no training-dates field, so this is where those dates
 * live.
 *
 * That makes it MEMBER-AUTHORED TEXT, and member-authored text may not go
 * through the block path. `richText` blocks reach `dangerouslySetInnerHTML`
 * through `BlockRenderer`, which is safe for admin-authored template copy and
 * is not safe for a string somebody typed into a form ten seconds ago. Feeding
 * it in as a `{token}` would do exactly that: `personaliseBlocks` substitutes
 * into the HTML before it is rendered. So it is a prop, rendered as a React
 * text node by `Text`, and there is no code path from this field to that
 * renderer.
 *
 * It sits BELOW the admin-authored body and above the footer, because the body
 * is the standing welcome and the note is what is true about this one
 * appointment.
 *
 * ── WHAT THIS EMAIL MUST DO ─────────────────────────────────────────────────
 * Name the run, say when training is, and say what happens if they can no
 * longer do it. Somebody who has just been asked to run a group for six weeks
 * needs the commitment stated plainly, not softened.
 *
 * No unsubscribe footer: this is TRANSACTIONAL, and it is the answer to an
 * application they sent.
 */
export default function AdmissionsAppointedEmail({
  subject,
  blocks,
  note,
  applicationUrl,
  preheader,
}: Props) {
  const trimmed = note.trim();
  return (
    <EmailChrome
      subject={subject}
      preheader={preheader}
      footerSlot={
        applicationUrl ? (
          <Text style={emailFooterTextStyle}>
            Your{" "}
            <Link href={applicationUrl} style={emailLinkStyle}>
              application page
            </Link>{" "}
            on the site shows this decision too.
          </Text>
        ) : undefined
      }
    >
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
      {trimmed ? <Text style={noteStyle}>{trimmed}</Text> : null}
    </EmailChrome>
  );
}

/**
 * Set apart from the body so it reads as a note attached to this appointment
 * rather than as another paragraph of the standing copy. Colours are hard
 * coded because an inbox has no stylesheet and no CSS variables: every other
 * template in this estate does the same.
 */
const noteStyle: React.CSSProperties = {
  margin: "20px 0 0",
  padding: "12px 16px",
  borderLeft: "3px solid #cbd5e1",
  fontSize: "15px",
  lineHeight: "24px",
  color: "#0f172a",
  whiteSpace: "pre-wrap",
};
