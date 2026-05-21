import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link as EmailLink,
  Preview,
  Section,
  Text,
} from "@react-email/components";

type Props = {
  eventTitle: string;
  recipientName: string;
  /** The schedule the event was set to run at, e.g. "Fri 6 June 2026, 18:00". */
  whenLine: string;
  /** Optional organiser note explaining the cancellation. */
  note?: string;
  instagramHandle?: string;
  contactEmail?: string;
};

/**
 * Sent to confirmed and waitlisted attendees when an organiser cancels a whole
 * event. Framed unambiguously as a cancellation: the event is no longer
 * happening. Kept separate from EventUpdateEmail (a generic change broadcast)
 * and from EventRsvpEmail's "cancelled" variant (which cancels one person's
 * RSVP, not the event).
 */
export default function EventCancelledEmail({
  eventTitle,
  recipientName,
  whenLine,
  note,
  instagramHandle,
  contactEmail,
}: Props) {
  const trimmedNote = (note ?? "").trim();
  const noteParagraphs = trimmedNote
    ? trimmedNote.split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean)
    : [];
  return (
    <Html>
      <Head />
      <Preview>This event has been cancelled.</Preview>
      <Body style={style.body}>
        <Container style={style.container}>
          <Section>
            <Text style={style.eyebrow}>Event cancelled</Text>
            <Heading style={style.heading}>{eventTitle}</Heading>
            <Text style={style.greeting}>Hi {recipientName},</Text>
          </Section>

          <Section>
            <Text style={style.paragraph}>
              We&apos;re sorry to let you know that this event has been
              cancelled. It will no longer be taking place.
            </Text>
          </Section>

          {noteParagraphs.length > 0 && (
            <Section style={style.note}>
              <Text style={style.noteLabel}>A note from the organisers:</Text>
              {noteParagraphs.map((p, i) => (
                <Text key={i} style={style.noteBody}>
                  {p.split(/\r?\n/).map((line, j, arr) => (
                    <span key={j}>
                      {line}
                      {j < arr.length - 1 && <br />}
                    </span>
                  ))}
                </Text>
              ))}
            </Section>
          )}

          <Section style={style.details}>
            <Text style={style.detailLine}>
              <strong>Was scheduled for:</strong>{" "}
              <span style={style.struck}>{whenLine}</span>
            </Text>
          </Section>

          <Section>
            <Text style={style.paragraph}>
              Apologies for any inconvenience. We hope to see you at a future
              NAISI event.
            </Text>
          </Section>

          <Hr style={style.hr} />
          <Section>
            <Text style={style.footer}>
              Questions? Message us
              {instagramHandle ? (
                <>
                  {" "}on Instagram{" "}
                  <EmailLink
                    href={`https://instagram.com/${instagramHandle}`}
                    style={style.link}
                  >
                    @{instagramHandle}
                  </EmailLink>
                </>
              ) : null}
              {contactEmail ? (
                <>
                  {instagramHandle ? " or email " : " at "}
                  <EmailLink href={`mailto:${contactEmail}`} style={style.link}>
                    {contactEmail}
                  </EmailLink>
                </>
              ) : null}
              .
            </Text>
            <Text style={style.footerMuted}>
              Nottingham AI Safety Initiative · University of Nottingham
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const style = {
  body: {
    backgroundColor: "#f4f4f5",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
  } as React.CSSProperties,
  container: {
    margin: "40px auto",
    padding: "32px",
    maxWidth: "600px",
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    border: "1px solid #e4e4e7",
  } as React.CSSProperties,
  eyebrow: {
    color: "#b91c1c",
    fontSize: "12px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    margin: "0 0 8px",
  } as React.CSSProperties,
  heading: {
    fontSize: "26px",
    fontWeight: 700,
    color: "#09090b",
    margin: "0 0 16px",
    lineHeight: 1.3,
  } as React.CSSProperties,
  greeting: {
    fontSize: "16px",
    color: "#27272a",
    margin: "0 0 8px",
  } as React.CSSProperties,
  paragraph: {
    fontSize: "15px",
    lineHeight: 1.7,
    color: "#27272a",
    margin: "0 0 14px",
  } as React.CSSProperties,
  note: {
    backgroundColor: "#fafafa",
    padding: "16px 20px",
    borderRadius: "8px",
    border: "1px solid #e4e4e7",
    margin: "0 0 14px",
  } as React.CSSProperties,
  noteLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#18181b",
    margin: "0 0 6px",
  } as React.CSSProperties,
  noteBody: {
    fontSize: "15px",
    lineHeight: 1.7,
    color: "#27272a",
    margin: "0 0 8px",
  } as React.CSSProperties,
  details: {
    backgroundColor: "#fafafa",
    padding: "16px 20px",
    borderRadius: "8px",
    border: "1px solid #e4e4e7",
    margin: "0 0 14px",
  } as React.CSSProperties,
  detailLine: {
    fontSize: "15px",
    color: "#27272a",
    margin: "4px 0",
    lineHeight: 1.5,
  } as React.CSSProperties,
  struck: {
    textDecoration: "line-through" as const,
    color: "#a1a1aa",
  } as React.CSSProperties,
  hr: {
    borderColor: "#e4e4e7",
    margin: "28px 0 16px",
  } as React.CSSProperties,
  link: {
    color: "#2563eb",
    textDecoration: "underline" as const,
  } as React.CSSProperties,
  footer: {
    fontSize: "13px",
    lineHeight: "1.6",
    color: "#71717a",
    margin: "0 0 8px",
  } as React.CSSProperties,
  footerMuted: {
    fontSize: "12px",
    color: "#a1a1aa",
    margin: 0,
  } as React.CSSProperties,
};
