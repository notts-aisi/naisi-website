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
import EventChangeSummary from "./EventChangeSummary";
import type { EventChange } from "@/lib/events/changeSummary";

type Props = {
  eventTitle: string;
  recipientName: string;
  whenLine: string;
  locationLine: string;
  subject: string;
  /** Organiser-written plain-text body. Rendered with paragraph breaks preserved. */
  body: string;
  /** Optional notify-worthy change diff, rendered as a struck-through summary. */
  changes?: EventChange[];
  cancelUrl?: string;
  changeUrl?: string;
  instagramHandle?: string;
  contactEmail?: string;
};

/**
 * One-click organiser broadcast — e.g. "Room change: moved to Pope B11".
 * Plain-text body (newlines preserved as paragraphs) + a quick reminder of
 * when/where at the bottom so the recipient doesn't have to hunt for it.
 */
export default function EventUpdateEmail({
  eventTitle,
  recipientName,
  whenLine,
  locationLine,
  subject,
  body,
  changes,
  cancelUrl,
  changeUrl,
  instagramHandle,
  contactEmail,
}: Props) {
  const paragraphs = body.split(/\n{2,}|\r\n\r\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={style.body}>
        <Container style={style.container}>
          <Section>
            <Text style={style.eyebrow}>Event update</Text>
            <Heading style={style.heading}>{eventTitle}</Heading>
            <Text style={style.greeting}>Hi {recipientName},</Text>
          </Section>

          <Section>
            {paragraphs.map((p, i) => (
              <Text key={i} style={style.paragraph}>
                {p.split(/\r?\n/).map((line, j, arr) => (
                  <span key={j}>
                    {line}
                    {j < arr.length - 1 && <br />}
                  </span>
                ))}
              </Text>
            ))}
          </Section>

          <EventChangeSummary changes={changes ?? []} />

          <Section style={style.details}>
            <Text style={style.detailLine}>
              <strong>When:</strong> {whenLine}
            </Text>
            <Text style={style.detailLine}>
              <strong>Where:</strong> {locationLine}
            </Text>
          </Section>

          {(cancelUrl || changeUrl) && (
            <Section style={{ margin: "20px 0 0" }}>
              {changeUrl && (
                <Text style={style.actionLine}>
                  Need to update your answers?{" "}
                  <EmailLink href={changeUrl} style={style.link}>
                    Update my answers
                  </EmailLink>
                  .
                </Text>
              )}
              {cancelUrl && (
                <Text style={style.actionLine}>
                  Can&apos;t make it any more?{" "}
                  <EmailLink href={cancelUrl} style={style.link}>
                    Cancel my RSVP
                  </EmailLink>
                  .
                </Text>
              )}
            </Section>
          )}

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
    color: "#71717a",
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
  details: {
    backgroundColor: "#fafafa",
    padding: "16px 20px",
    borderRadius: "8px",
    border: "1px solid #e4e4e7",
    margin: "12px 0 0",
  } as React.CSSProperties,
  detailLine: {
    fontSize: "15px",
    color: "#27272a",
    margin: "4px 0",
    lineHeight: 1.5,
  } as React.CSSProperties,
  actionLine: {
    fontSize: "14px",
    lineHeight: 1.6,
    color: "#27272a",
    margin: "0 0 8px",
  } as React.CSSProperties,
  link: {
    color: "#2563eb",
    textDecoration: "underline" as const,
  } as React.CSSProperties,
  hr: {
    borderColor: "#e4e4e7",
    margin: "28px 0 16px",
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
