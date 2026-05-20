import { Section, Text } from "@react-email/components";
import EmailChrome from "./EmailChrome";

type Props = {
  preferredName: string;
  /** Obfuscated Google account email of the existing account, e.g. `m**n@gmail.com`. */
  maskedAccountEmail: string;
};

/**
 * Sent from /api/verify-email/send when someone tries to register with a
 * university email that is already verified on an existing NAISI account.
 *
 * Carries NO verification link: the point is to send the person back to
 * their existing account, not to let them finish a duplicate registration.
 * The Google account email is masked so the email hints at which account to
 * use without exposing the full address. This email only ever reaches an
 * inbox the recipient just proved they control, so there is no enumeration
 * surface, but masking keeps it tidy if the inbox is shared.
 */
export default function AlreadyRegisteredEmail({
  preferredName,
  maskedAccountEmail,
}: Props) {
  const subject = "You already have a NAISI account";
  const greetingName = preferredName.trim() || "there";
  return (
    <EmailChrome
      subject={subject}
      preheader="This university email is already linked to a NAISI account."
    >
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        Hi {greetingName},
      </Text>
      <Text style={{ fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" }}>
        Someone (probably you) just tried to register a NAISI account using
        this university email. It is already linked to an account, so there
        is nothing more to do here.
      </Text>
      <Section
        style={{
          background: "#f4f6fb",
          borderRadius: 8,
          padding: "16px 20px",
          margin: "0 0 16px",
        }}
      >
        <Text style={{ fontSize: 14, lineHeight: 1.6, margin: 0, color: "#5b6785" }}>
          Sign in with the Google account you used originally:
        </Text>
        <Text
          style={{
            fontSize: 16,
            lineHeight: 1.6,
            margin: "4px 0 0",
            fontWeight: 600,
          }}
        >
          {maskedAccountEmail}
        </Text>
      </Section>
      <Text style={{ fontSize: 14, lineHeight: 1.6, color: "#5b6785", margin: "0 0 8px" }}>
        Lost access to that Google account? Email{" "}
        <strong>accounts@naisi.uk</strong> from this address and we will help
        you recover it.
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 1.5, color: "#5b6785", margin: 0 }}>
        If you did not try to register, you can ignore this email. No new
        account was created.
      </Text>
    </EmailChrome>
  );
}
