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

export type EventRsvpEmailVariant =
  | "requested"
  | "approved"
  | "waitlisted"
  | "promoted"
  | "denied"
  | "cancelled";

type Props = {
  variant: EventRsvpEmailVariant;
  recipientName: string;
  eventTitle: string;
  /** Pre-formatted day-and-time string, e.g. "Mon, 25 April · 6:00 PM". Always shown. */
  whenLine: string;
  /**
   * The location to show. For "requested"/"waitlisted"/"denied"/"cancelled"
   * this is the public/fuzzy text; for "approved"/"promoted" it's the exact
   * location.
   */
  locationLine: string;
  /** Shown on the approved/promoted email when the event had a privacy toggle. */
  locationDisclosure?: string;
  foodLine?: string;
  /** Organiser's decision note, surfaced on the denied variant only. */
  decisionNote?: string;
  /** Pretty-printed summary of the attendee's answers ("Burger: Beef · Allergies: Peanuts"). */
  answersLine?: string;
  /** Schedule/location changes since the attendee signed up — shown on acceptance. */
  changesSinceSignup?: EventChange[];
  /** "Add to Google Calendar" link, shown on the approved / promoted emails. */
  googleCalUrl?: string;
  /** Link to the .ics download, for Apple Calendar / Outlook. */
  icsUrl?: string;
  /** Absolute URL letting the attendee self-cancel. */
  cancelUrl?: string;
  /** Absolute URL letting the attendee request a dietary / answer change. */
  changeUrl?: string;
  /** Optional Instagram handle for the contact footer ("naisi.uon"). */
  instagramHandle?: string;
  /** Optional contact email for the footer (defaults to the from address). */
  contactEmail?: string;
};

const COPY: Record<
  EventRsvpEmailVariant,
  { eyebrow: string; subject: string; preview: string; heading: string; body: string }
> = {
  requested: {
    eyebrow: "RSVP received",
    subject: "We got your RSVP (pending review)",
    preview: "A NAISI organiser will review your RSVP shortly.",
    heading: "Thanks, we've got your RSVP",
    body: "A NAISI organiser will review it and confirm your spot. You'll get another email once it's approved (or if we need any more info).",
  },
  approved: {
    eyebrow: "You're confirmed",
    subject: "You're confirmed",
    preview: "Here's where and when.",
    heading: "You're in. See you there.",
    body: "Your RSVP has been approved. Here are the details you need.",
  },
  waitlisted: {
    eyebrow: "You're on the waitlist",
    subject: "You're on the waitlist",
    preview: "We'll bump you up automatically if a spot opens.",
    heading: "You're on the waitlist",
    body: "This event is full, but you've been approved for the waitlist. If someone cancels we'll bump you to confirmed automatically and email you again.",
  },
  promoted: {
    eyebrow: "You're off the waitlist",
    subject: "A spot opened. You're confirmed.",
    preview: "Great news: a spot opened and you're now confirmed.",
    heading: "You're off the waitlist",
    body: "A spot opened up and you've been bumped from the waitlist to confirmed. Here are the details.",
  },
  denied: {
    eyebrow: "RSVP update",
    subject: "Your RSVP wasn't approved",
    preview: "An update on your event RSVP.",
    heading: "We weren't able to confirm your spot",
    body: "Thanks for your interest. We can't confirm your RSVP this time. If you think this was a mistake, reply to this email and we'll take another look.",
  },
  cancelled: {
    eyebrow: "RSVP cancelled",
    subject: "Your RSVP has been cancelled",
    preview: "An organiser has cancelled your RSVP.",
    heading: "Your RSVP was cancelled",
    body: "A NAISI organiser has cancelled your RSVP to this event. If this wasn't expected, reply to this email and we'll sort it out.",
  },
};

export default function EventRsvpEmail({
  variant,
  recipientName,
  eventTitle,
  whenLine,
  locationLine,
  locationDisclosure,
  foodLine,
  decisionNote,
  answersLine,
  changesSinceSignup,
  googleCalUrl,
  icsUrl,
  cancelUrl,
  changeUrl,
  instagramHandle,
  contactEmail,
}: Props) {
  const copy = COPY[variant];
  const showDetails = variant !== "denied" && variant !== "cancelled";
  // Self-service links only make sense while the RSVP is live.
  const showActions =
    variant === "requested" ||
    variant === "approved" ||
    variant === "waitlisted" ||
    variant === "promoted";
  return (
    <Html>
      <Head />
      <Preview>{copy.preview}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <Text style={eyebrow}>{copy.eyebrow}</Text>
            <Heading style={heading}>{eventTitle}</Heading>
            <Text style={greeting}>Hi {recipientName},</Text>
          </Section>

          <Section>
            <Heading as="h2" style={subheading}>
              {copy.heading}
            </Heading>
            <Text style={paragraph}>{copy.body}</Text>
          </Section>

          {showDetails && (
            <Section style={details}>
              <Text style={detailLine}>
                <strong>When:</strong> {whenLine}
              </Text>
              <Text style={detailLine}>
                <strong>Where:</strong> {locationLine}
              </Text>
              {locationDisclosure && (
                <Text style={detailMuted}>{locationDisclosure}</Text>
              )}
              {foodLine && (
                <Text style={detailLine}>
                  <strong>Food:</strong> {foodLine}
                </Text>
              )}
            </Section>
          )}

          {showDetails && changesSinceSignup && changesSinceSignup.length > 0 && (
            <Section style={{ margin: "16px 0 0" }}>
              <Text style={changeHeading}>This changed since you signed up:</Text>
              <EventChangeSummary changes={changesSinceSignup} />
            </Section>
          )}

          {(googleCalUrl || icsUrl) && (
            <Section style={{ margin: "16px 0 0" }}>
              <Text style={detailLine}>
                <strong>Add it to your calendar:</strong>{" "}
                {googleCalUrl && (
                  <EmailLink href={googleCalUrl} style={link}>
                    Google Calendar
                  </EmailLink>
                )}
                {googleCalUrl && icsUrl ? "  ·  " : null}
                {icsUrl && (
                  <EmailLink href={icsUrl} style={link}>
                    Apple or Outlook
                  </EmailLink>
                )}
              </Text>
              <Text style={detailMuted}>
                The event is also attached to this email as a calendar file.
              </Text>
            </Section>
          )}

          {variant === "denied" && decisionNote && (
            <Section style={details}>
              <Text style={detailLine}>
                <strong>Note from the organiser:</strong>
              </Text>
              <Text style={paragraph}>{decisionNote}</Text>
            </Section>
          )}

          {showDetails && answersLine && (
            <Section style={details}>
              <Text style={detailLine}>
                <strong>What you told us:</strong>
              </Text>
              <Text style={detailLine}>{answersLine}</Text>
              <Text style={detailMuted}>
                Something off? Use the &ldquo;update my answers&rdquo;
                link below, or message us (details at the bottom of this
                email).
              </Text>
            </Section>
          )}

          {showActions && (cancelUrl || changeUrl) && (
            <Section style={{ margin: "20px 0 0" }}>
              {changeUrl && (
                <Text style={actionLine}>
                  Need to update your dietary requirements or other answers?{" "}
                  <EmailLink href={changeUrl} style={link}>
                    Update my answers
                  </EmailLink>
                  . A NAISI organiser will review the change before it&apos;s applied.
                </Text>
              )}
              {cancelUrl && (
                <Text style={actionLine}>
                  Can&apos;t make it?{" "}
                  <EmailLink href={cancelUrl} style={link}>
                    Cancel my RSVP
                  </EmailLink>{" "}
                  . This frees up a spot for someone on the waitlist.
                </Text>
              )}
            </Section>
          )}

          <Hr style={hr} />
          <Section>
            <Text style={footer}>
              Need to make a change in the meantime? Message us
              {instagramHandle ? (
                <>
                  {" "}on Instagram{" "}
                  <EmailLink
                    href={`https://instagram.com/${instagramHandle}`}
                    style={link}
                  >
                    @{instagramHandle}
                  </EmailLink>
                </>
              ) : null}
              {contactEmail ? (
                <>
                  {instagramHandle ? " or email " : " at "}
                  <EmailLink href={`mailto:${contactEmail}`} style={link}>
                    {contactEmail}
                  </EmailLink>
                </>
              ) : null}
              {" "}and we&apos;ll sort it out.
            </Text>
            <Text style={footerMuted}>
              Nottingham AI Safety Initiative · University of Nottingham
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function subjectFor(variant: EventRsvpEmailVariant, title: string): string {
  const base = COPY[variant].subject;
  return title ? `${base}: ${title}` : base;
}

const body: React.CSSProperties = {
  backgroundColor: "#f4f4f5",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
};

const container: React.CSSProperties = {
  margin: "40px auto",
  padding: "32px",
  maxWidth: "600px",
  backgroundColor: "#ffffff",
  borderRadius: "12px",
  border: "1px solid #e4e4e7",
};

const eyebrow: React.CSSProperties = {
  color: "#71717a",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  margin: "0 0 8px",
};

const heading: React.CSSProperties = {
  fontSize: "26px",
  fontWeight: 700,
  color: "#09090b",
  margin: "0 0 16px",
  lineHeight: 1.3,
};

const subheading: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  color: "#18181b",
  margin: "16px 0 8px",
  lineHeight: 1.3,
};

const greeting: React.CSSProperties = {
  fontSize: "16px",
  color: "#27272a",
  margin: "0 0 8px",
};

const paragraph: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: 1.7,
  color: "#27272a",
  margin: "0 0 12px",
};

const details: React.CSSProperties = {
  backgroundColor: "#fafafa",
  padding: "16px 20px",
  borderRadius: "8px",
  border: "1px solid #e4e4e7",
  margin: "12px 0 0",
};

const detailLine: React.CSSProperties = {
  fontSize: "15px",
  color: "#27272a",
  margin: "4px 0",
  lineHeight: 1.5,
};

const detailMuted: React.CSSProperties = {
  fontSize: "13px",
  color: "#71717a",
  margin: "4px 0 0",
  fontStyle: "italic",
};

const changeHeading: React.CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  color: "#18181b",
  margin: "0 0 4px",
};

const hr: React.CSSProperties = {
  borderColor: "#e4e4e7",
  margin: "28px 0 16px",
};

const actionLine: React.CSSProperties = {
  fontSize: "14px",
  lineHeight: 1.6,
  color: "#27272a",
  margin: "0 0 8px",
};

const link: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "underline",
};

const footer: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: "1.6",
  color: "#71717a",
  margin: "0 0 8px",
};

const footerMuted: React.CSSProperties = {
  fontSize: "12px",
  color: "#a1a1aa",
  margin: 0,
};
