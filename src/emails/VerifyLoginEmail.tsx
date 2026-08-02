import { Button, Link, Section, Text } from "@react-email/components";
import EmailChrome from "./EmailChrome";

type Props = {
  verifyUrl: string;
  expiresInMinutes: number;
};

/**
 * Sent from POST /api/register when a NEW account is created. The link proves
 * control of the sign-in email and, once clicked, verifies the address and
 * signs the user in to continue registration. If the email was ALREADY
 * registered, this email is never sent — the register response is identical
 * either way, so the only signal (this email arriving, or not) reaches solely
 * the inbox's true owner.
 */
export default function VerifyLoginEmail({ verifyUrl, expiresInMinutes }: Props) {
  const subject = "Confirm your email to finish joining NAISI";
  return (
    <EmailChrome
      subject={subject}
      preheader={`Click once to confirm your email and continue. Link expires in ${expiresInMinutes} minutes.`}
    >
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        Hi there,
      </Text>
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        Someone (hopefully you) just started creating a NAISI account with this
        email address. Confirm it&apos;s yours to continue.
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
          Confirm my email
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
        The link expires in {expiresInMinutes} minutes. If you didn&apos;t try
        to join NAISI, you can safely ignore this email.
      </Text>
    </EmailChrome>
  );
}
