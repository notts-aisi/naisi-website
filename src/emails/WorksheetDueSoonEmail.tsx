import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

type Props = {
  recipientName: string;
  worksheetTitle: string;
  /** The due date, already formatted in London civil time by the sender. */
  dueLabel: string;
  /**
   * Which reminder this is, in words ("3 days before the due date"), built by
   * `worksheetLeadLabel` in the sending module.
   */
  leadLabel: string;
  /** Absolute link to the recipient's own copy, never to the staff view. */
  respondLink: string;
};

/**
 * The nudge somebody gets while their copy of a worksheet is still unanswered
 * and its due date is close.
 *
 * ── WHO GETS IT ─────────────────────────────────────────────────────────────
 * Only a recipient whose response is still `not-opened` or `started`, on a
 * circulation whose sender left the due-soon switch on. Anyone who has
 * submitted is out of the audience by construction (the job filters on the
 * stored state), which is why the copy can say plainly that the answers are
 * not in yet rather than hedging about it.
 *
 * ── ONE PER PERSON PER SCHEDULED REMINDER ───────────────────────────────────
 * The scheduler claims a marker keyed on the circulation, the recipient and
 * the moment the reminder resolved to, so a tick that runs every quarter of
 * an hour sends each scheduled nudge once. A circulation carries up to six of
 * them, so the same person may get this mail more than once for one
 * worksheet, which is why the copy says WHICH reminder it is: without that,
 * the second one reads as the first one sent twice. Moving the deadline
 * re-resolves every slot and therefore mints new keys, which is the behaviour
 * a sender who moved a deadline expects.
 *
 * ── THE LINK IS THE RECIPIENT'S OWN COPY ────────────────────────────────────
 * Not the task board and not the circulation page. The one action this email
 * asks for is finishing the answers, and any other destination is a step in
 * the wrong direction on the day the step matters.
 *
 * No unsubscribe footer. This is transactional: it is about a document the
 * recipient was asked to fill in, it stops when they submit or when the
 * circulation closes, and the line under the button says so, because a
 * reminder that does not explain when it stops reads as the first of an
 * unknown number.
 */
export default function WorksheetDueSoonEmail({
  recipientName,
  worksheetTitle,
  dueLabel,
  leadLabel,
  respondLink,
}: Props) {
  const subject = `Due soon: ${worksheetTitle}`;
  return (
    <EmailChrome subject={subject} greeting={`Hi ${recipientName},`}>
      <Section>
        <Text style={para}>
          Your answers to <strong>{worksheetTitle}</strong> are due{" "}
          <strong>{dueLabel}</strong>, and they are not in yet.
        </Text>
        <Button href={respondLink} style={ctaStyle}>
          Open the worksheet
        </Button>
        <Text style={subtle}>
          Or paste this into your browser:{" "}
          <a href={respondLink} style={emailLinkStyle}>
            {respondLink}
          </a>
        </Text>
        <Text style={subtle}>
          This is the reminder set for {leadLabel}. Once you submit, these reminders
          stop.
        </Text>
      </Section>
    </EmailChrome>
  );
}

const para: React.CSSProperties = {
  fontSize: "15px",
  color: "#27272a",
  margin: "0 0 12px",
  lineHeight: 1.6,
};

const subtle: React.CSSProperties = {
  fontSize: "12px",
  color: "#71717a",
  margin: "16px 0 0",
};

const ctaStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  background: "#09090b",
  color: "#fafafa",
  borderRadius: "8px",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
  marginTop: "8px",
};
