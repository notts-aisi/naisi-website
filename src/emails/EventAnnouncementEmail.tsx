import { Button, Img, Link, Section, Text } from "@react-email/components";
import EmailChrome, {
  emailFooterTextStyle,
  emailLinkStyle,
} from "./EmailChrome";

/**
 * "We have published a new event": sent once per event by
 * `POST /api/events/{id}/publish` to the `events` row of the notification grid.
 *
 * ── IT IS THE GRID CLASS, SO IT CARRIES THE FOOTER ──────────────────────────
 * This is the one event mail that goes to people who have NOT signed up for
 * anything but the list itself, which makes it the opposite of the notice lane
 * next door: the recipient's `events` row is what put them here, and every
 * message therefore carries an unsubscribe link scoped to the events channel,
 * exactly as the newsletter's does. The route pairs it with the RFC 8058
 * `List-Unsubscribe` headers for the same reason.
 *
 * ── WHAT IT SAYS, AND WHAT IT DOES NOT ──────────────────────────────────────
 * Title, when, where and a button to the public event page. The LOCATION is the
 * public one: an event with `locationHidden` shows its fuzzy placeholder here,
 * because this list is not the attendee list and the exact room is the thing an
 * approved RSVP earns. There is no RSVP form in the email and no signed link:
 * this is an invitation to go and look, and everything that follows happens on
 * the page where the capacity, the waitlist and the questions live.
 */

type Props = {
  eventTitle: string;
  recipientName: string;
  /** Formatted schedule line, e.g. "Fri 6 June 2026, 18:00". */
  whenLine: string;
  /** The PUBLIC location: the placeholder when the real one is hidden. */
  locationLine: string;
  /** Absolute URL of the public event page. */
  eventUrl: string;
  /** Absolute URL of the cover image, when the event has one. */
  coverImageUrl?: string | null;
  /** One-line teaser, used as the inbox preview when present. */
  preheader?: string;
  /** `/api/unsubscribe?t=<signed>` for THIS recipient and the events channel. */
  unsubscribeUrl: string;
};

export default function EventAnnouncementEmail({
  eventTitle,
  recipientName,
  whenLine,
  locationLine,
  eventUrl,
  coverImageUrl,
  preheader,
  unsubscribeUrl,
}: Props) {
  return (
    <EmailChrome
      subject={eventTitle}
      preheader={preheader ?? `${whenLine} · ${locationLine}`}
      greeting={`Hi ${recipientName},`}
      footerSlot={
        <Text style={emailFooterTextStyle}>
          You are getting this because you asked us to tell you when we publish a
          new event. You can change that, or unsubscribe, at any time by visiting{" "}
          <Link href={unsubscribeUrl} style={emailLinkStyle}>
            your profile
          </Link>
          .
        </Text>
      }
    >
      <Section>
        <Text style={para}>We have just published a new event.</Text>
      </Section>

      {coverImageUrl ? (
        <Section>
          <Img src={coverImageUrl} alt={eventTitle} width={536} style={cover} />
        </Section>
      ) : null}

      <Section style={details}>
        <Text style={detailLine}>
          <strong>What:</strong> {eventTitle}
        </Text>
        <Text style={detailLine}>
          <strong>When:</strong> {whenLine}
        </Text>
        <Text style={detailLine}>
          <strong>Where:</strong> {locationLine}
        </Text>
      </Section>

      <Section>
        <Button href={eventUrl} style={ctaStyle}>
          See the event and sign up
        </Button>
        <Text style={subtle}>
          Or paste this into your browser:{" "}
          <a href={eventUrl} style={emailLinkStyle}>
            {eventUrl}
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

const cover: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: "536px",
  height: "auto",
  borderRadius: "8px",
  margin: "0 0 16px",
};

const details: React.CSSProperties = {
  backgroundColor: "#fafafa",
  padding: "16px 20px",
  borderRadius: "8px",
  border: "1px solid #e4e4e7",
  margin: "0 0 16px",
};

const detailLine: React.CSSProperties = {
  fontSize: "15px",
  color: "#27272a",
  margin: "4px 0",
  lineHeight: 1.5,
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
  marginTop: "4px",
};
