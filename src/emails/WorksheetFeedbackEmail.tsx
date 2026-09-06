import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

/**
 * "Your reviewers have written back": sent by
 * `POST /api/worksheets/circulations/{id}/responses/{uid}/return`.
 *
 * IT CARRIES NO FEEDBACK. The message says feedback exists and where to read
 * it, and the words themselves stay on the respond page. Two reasons, and both
 * are about the same thing: feedback about somebody's work is written for them
 * and lands in a mailbox that is forwarded, previewed on a lock screen and
 * quoted in a reply; and the returned copy on the response is the one a later
 * unfreeze clears, so an email holding the text would outlive the record and
 * quote a version nobody can correct. Scores are not here for the stronger
 * reason: the return route never copies one anywhere the recipient can reach.
 *
 * Hardcoded JSX, like every transactional template in this folder except the
 * newsletter. There is no admin editor for this copy on purpose.
 */

type Props = {
  recipientName: string;
  /** The circulation's title, which is the worksheet's as it was sent. */
  worksheetTitle: string;
  /** Who pressed Return. Named because feedback is somebody's judgement. */
  reviewerName: string;
  /** Absolute URL of the respond page, where the feedback is. */
  link: string;
};

export default function WorksheetFeedbackEmail({
  recipientName,
  worksheetTitle,
  reviewerName,
  link,
}: Props) {
  return (
    <EmailChrome
      subject={`Feedback on "${worksheetTitle}"`}
      greeting={`Hi ${recipientName},`}
    >
      <Section>
        <Text style={para}>
          <strong>{reviewerName}</strong> has returned feedback on{" "}
          <strong>{worksheetTitle}</strong>. Your answers stay as you submitted them; the
          feedback sits beside them.
        </Text>
        <Button href={link} style={ctaStyle}>
          Read the feedback
        </Button>
        <Text style={subtle}>
          Or paste this into your browser:{" "}
          <a href={link} style={emailLinkStyle}>
            {link}
          </a>
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
