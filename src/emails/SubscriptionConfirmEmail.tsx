import { Button, Link, Section, Text } from "@react-email/components";
import EmailChrome, { emailFooterTextStyle, emailLinkStyle } from "./EmailChrome";
import { channelLabel } from "@/lib/firestore/subscriptions";

type Props = {
  confirmUrl: string;
  /**
   * Channel ids the subscriber just signed up to. Drives the body copy.
   * Usually one element, but the API tolerates a single sign-up call adding
   * to an existing pending row, so we render the full list.
   */
  channels: string[];
  expiresInHours: number;
  unsubUrl?: string;
  /** Optional first / preferred name. When present, used in the greeting. */
  name?: string;
};

/**
 * First-time confirmation email. Sent when an email signs up for any channel
 * and has no prior confirmed row. One click here flips every `pending` row
 * for this address to `confirmed`.
 */
export default function SubscriptionConfirmEmail({
  confirmUrl,
  channels,
  expiresInHours,
  unsubUrl,
  name,
}: Props) {
  const subject = "Confirm your NAISI subscription";
  const channelList = channels
    .map((c) => channelLabel(c))
    .filter((l) => l && l !== "all NAISI emails");
  const channelPhrase = formatList(channelList);
  const trimmedName = name?.trim();
  const greetingName = trimmedName ? trimmedName : "there";
  return (
    <EmailChrome
      subject={subject}
      preheader={`One click to start receiving ${channelPhrase}.`}
    >
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 12px" }}>
        Hi {greetingName},
      </Text>
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        You asked to subscribe to {channelPhrase} from the Nottingham AI Safety
        Initiative. Click below to confirm. Once you do, you&apos;ll start
        getting them.
      </Text>
      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button
          href={confirmUrl}
          style={{
            background: "#3b55e3",
            color: "#ffffff",
            padding: "12px 24px",
            borderRadius: 8,
            fontWeight: 600,
            textDecoration: "none",
            fontSize: 15,
          }}
        >
          Confirm subscription
        </Button>
      </Section>
      <Text style={{ fontSize: 13, lineHeight: 1.5, color: "#5b6785", margin: "0 0 12px" }}>
        Or copy this link into your browser:
      </Text>
      <Text
        style={{
          fontSize: 13,
          lineHeight: 1.4,
          color: "#5b6785",
          wordBreak: "break-all",
          margin: "0 0 20px",
        }}
      >
        <Link href={confirmUrl} style={{ color: "#3b55e3" }}>
          {confirmUrl}
        </Link>
      </Text>
      <Text style={emailFooterTextStyle}>
        The link expires in {expiresInHours} hours. If you didn&apos;t sign up,
        ignore this email. Without confirmation, no further mail will be sent
        to this address.
      </Text>
      {unsubUrl ? (
        <Text style={emailFooterTextStyle}>
          Want out anyway?{" "}
          <Link href={unsubUrl} style={emailLinkStyle}>
            Unsubscribe
          </Link>
          .
        </Text>
      ) : null}
    </EmailChrome>
  );
}

function formatList(items: string[]): string {
  if (items.length === 0) return "our emails";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
