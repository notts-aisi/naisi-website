import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

/**
 * "The questions changed while you were answering them": sent by
 * `POST /api/worksheets/circulations/{id}/notify-copy-edited`, to the people
 * who have started and not yet submitted.
 *
 * WHY THIS TEMPLATE EXISTS AT ALL. A mid-flight edit the recipient never hears
 * about is the one surprise this feature can spring: they answer a question,
 * somebody rewords it, and the answer they gave now reads as an answer to
 * something else. `docs/worksheets.md` marks the whole event a Decision for
 * that reason, and the switch behind it is off by default so a typo fix is not
 * a broadcast.
 *
 * IT DOES NOT LIST WHAT CHANGED. There is no diff on the wire: the circulation
 * keeps one copy of its items and overwrites it, so the only honest thing to
 * say is that the questions moved and where to look. Saying more would mean
 * inventing a comparison the store cannot support.
 *
 * The reassurance in the second sentence is load-bearing rather than
 * decorative: answers are keyed by question id and option id, so an edit does
 * not clear what anybody typed, and somebody told "the questions changed" with
 * nothing else will assume it did.
 */

type Props = {
  recipientName: string;
  /** The circulation's title, which is the worksheet's as it was sent. */
  worksheetTitle: string;
  /** The staff member who made the change and chose to say so. */
  editorName: string;
  /** Absolute URL of the respond page. */
  link: string;
};

export default function WorksheetUpdatedEmail({
  recipientName,
  worksheetTitle,
  editorName,
  link,
}: Props) {
  return (
    <EmailChrome
      subject={`"${worksheetTitle}" has changed`}
      greeting={`Hi ${recipientName},`}
    >
      <Section>
        <Text style={para}>
          <strong>{editorName}</strong> has changed the questions in{" "}
          <strong>{worksheetTitle}</strong> since you started it. Everything you have
          already answered is still there.
        </Text>
        <Text style={para}>
          Worth a look before you submit, in case one of your answers was written for a
          question that now asks something else.
        </Text>
        <Button href={link} style={ctaStyle}>
          Open the worksheet
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
