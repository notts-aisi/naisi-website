import { Link, Text } from "@react-email/components";
import EmailChrome, { emailFooterTextStyle, emailLinkStyle } from "./EmailChrome";
import { channelLabel } from "@/lib/firestore/subscriptions";

type Props = {
  /** The channel that was just added (alongside an already-confirmed one). */
  channel: string;
  /** One-click unsubscribe url for this specific channel. */
  unsubUrl: string;
  /** Optional first / preferred name. When present, used in the greeting. */
  name?: string;
};

/**
 * Sent when an already-confirmed email subscribes to a second (or further)
 * channel. No double-opt-in click is needed (the inbox is already proven),
 * so this is just a low-key receipt rather than an action email.
 */
export default function SubscriptionAddedEmail({ channel, unsubUrl, name }: Props) {
  const label = channelLabel(channel);
  const subject = `You're now subscribed to ${label}`;
  const trimmedName = name?.trim();
  const greetingName = trimmedName ? trimmedName : "there";
  return (
    <EmailChrome
      subject={subject}
      preheader={`We've added ${label} to your NAISI subscriptions.`}
    >
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 12px" }}>
        Hi {greetingName},
      </Text>
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        We&apos;ve added {label} to your existing NAISI subscriptions. No
        action needed; the next one will land in your inbox as normal.
      </Text>
      <Text style={emailFooterTextStyle}>
        Didn&apos;t mean to subscribe?{" "}
        <Link href={unsubUrl} style={emailLinkStyle}>
          Unsubscribe from {label}
        </Link>
        .
      </Text>
    </EmailChrome>
  );
}
