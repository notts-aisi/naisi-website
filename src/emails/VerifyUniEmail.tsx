import { Button, Link, Section, Text } from "@react-email/components";
import EmailChrome from "./EmailChrome";

type Props = {
  preferredName: string;
  verifyUrl: string;
  expiresInMinutes: number;
};

/**
 * Magic-link verification email sent from /api/verify-email/send. The link
 * proves control of the university email address — once clicked, the
 * registering user (original tab) sees their uni email marked verified via
 * an `onSnapshot` subscription on the underlying `emailVerifications` doc.
 */
export default function VerifyUniEmail({
  preferredName,
  verifyUrl,
  expiresInMinutes,
}: Props) {
  const subject = "Verify your university email for NAISI";
  const greetingName = preferredName.trim() || "there";
  return (
    <EmailChrome
      subject={subject}
      preheader={`Click once to finish joining NAISI. Link expires in ${expiresInMinutes} minutes.`}
    >
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        Hi {greetingName},
      </Text>
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        We got a NAISI application asking us to use this email address.
        Before we review it, we just need to check you actually own this
        inbox. Click the button below to verify.
      </Text>
      <Section style={{ textAlign: "center", margin: "24px 0" }}>
        <Button
          href={verifyUrl}
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
          Verify my university email
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
        <Link href={verifyUrl} style={{ color: "#3b55e3" }}>
          {verifyUrl}
        </Link>
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 1.5, color: "#5b6785", margin: "0 0 8px" }}>
        The link expires in {expiresInMinutes} minutes. If you
        didn&apos;t try to join NAISI, you can ignore this email. No
        account was created.
      </Text>
    </EmailChrome>
  );
}
