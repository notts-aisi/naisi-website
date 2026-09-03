import { Text } from "@react-email/components";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";
import EmailChrome from "./EmailChrome";

type Props = {
  subject: string;
  blocks: Block[];
  /**
   * The decider's reason, and ONLY when they ticked "share this with the
   * applicant". "" in every other case, including a written-but-unshared one,
   * and then no paragraph appears at all.
   */
  sharedReason: string;
  preheader?: string;
};

/**
 * The email a facilitator applicant gets when an APPOINTMENT round decides it
 * cannot take them on this time.
 *
 * Only the appointment round's refusal. The enrolment round's own refusal is a
 * different email about a different thing (a place on a course rather than a
 * role running one), and it arrives with the enrolment decide path under its
 * own template id.
 *
 * ── THE SHARE GATE IS THE WHOLE COMPONENT ───────────────────────────────────
 * `outcome.reason` is the decider's note, and `outcome.reasonShared` is the
 * one tick that decides whether the applicant ever sees it. The send path
 * passes `sharedReason` ONLY on the shared arm, so an unshared reason cannot
 * arrive here by any route: this component has no access to the document and
 * nothing else on the page is derived from it. Same gate the status hub's
 * `sharedDecisionReason` applies, said the same way in the other direction.
 *
 * It is a PROP rather than a `{reason}` token for the reason every
 * member-authored string on this estate is: `richText` blocks reach
 * `dangerouslySetInnerHTML` through `BlockRenderer`, and substituting typed
 * text into that HTML would put somebody's keystrokes into a renderer that
 * trusts its input. Rendered here it is a React text node and nothing else.
 *
 * ── WHAT THIS EMAIL MUST NOT DO ─────────────────────────────────────────────
 * It must not explain, apologise at length, or invite a reply that argues the
 * decision. Say the answer, say it is about the number of places, say what is
 * still open to them, stop. The copy is admin-editable, and the seed copy is
 * written to that shape.
 *
 * No unsubscribe footer: this is TRANSACTIONAL, and it is the answer to an
 * application they sent.
 */
export default function AdmissionsDeclinedEmail({
  subject,
  blocks,
  sharedReason,
  preheader,
}: Props) {
  const trimmed = sharedReason.trim();
  return (
    <EmailChrome subject={subject} preheader={preheader}>
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
      {trimmed ? <Text style={reasonStyle}>{trimmed}</Text> : null}
    </EmailChrome>
  );
}

/**
 * Quieter than the body: this is one person's note, not the standing copy.
 * Colours are hard coded because an inbox has no stylesheet and no CSS
 * variables, the same as every other template here.
 */
const reasonStyle: React.CSSProperties = {
  margin: "20px 0 0",
  padding: "12px 16px",
  borderLeft: "3px solid #cbd5e1",
  fontSize: "15px",
  lineHeight: "24px",
  color: "#334155",
  whiteSpace: "pre-wrap",
};
