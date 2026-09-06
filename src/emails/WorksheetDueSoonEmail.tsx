import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

type Props = {
  recipientName: string;
  worksheetTitle: string;
  /** The due date, already formatted in London civil time by the sender. */
  dueLabel: string;
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
 * ── ONE PER PERSON PER DUE DATE ─────────────────────────────────────────────
 * The scheduler claims a marker keyed on the circulation, the recipient and
 * the London civil date of the deadline, so a tick that runs every quarter of
 * an hour for two days sends this once. Moving the deadline mints a new key
 * and is therefore a genuinely new reminder, which is the behaviour a sender
 * who moved a deadline expects.
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
          Once you submit, these reminders stop.
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
