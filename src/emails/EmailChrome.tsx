import type { ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

type Props = {
  subject: string;
  preheader?: string;
  greeting?: string;
  children: ReactNode;
  footerSlot?: ReactNode;
};

/**
 * Shared chrome for every transactional email NAISI sends. Wraps the body in
 * the standard container/header/footer, so the only per-email variance is the
 * content slot + an optional variable footer line above the org signature.
 */
export default function EmailChrome({
  subject,
  preheader,
  greeting,
  children,
  footerSlot,
}: Props) {
  return (
    <Html>
      <Head />
      <Preview>{preheader ?? subject}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <Text style={eyebrow}>Nottingham AI Safety Initiative</Text>
            <Heading style={heading}>{subject}</Heading>
            {greeting ? <Text style={greetingStyle}>{greeting}</Text> : null}
          </Section>

          {children}

          <Hr style={hr} />
          <Section>
            {footerSlot}
            <Text style={footerMuted}>
              Nottingham AI Safety Initiative · University of Nottingham · ai-safety@uonsu.com
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
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

const greetingStyle: React.CSSProperties = {
  fontSize: "16px",
  color: "#27272a",
  margin: "0 0 8px",
};

const hr: React.CSSProperties = {
  borderColor: "#e4e4e7",
  margin: "32px 0 20px",
};

const footerMuted: React.CSSProperties = {
  fontSize: "12px",
  color: "#a1a1aa",
  margin: 0,
};

export const emailLinkStyle: React.CSSProperties = {
  color: "#3f3f46",
  textDecoration: "underline",
};

export const emailFooterTextStyle: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: "1.6",
  color: "#71717a",
  margin: "0 0 8px",
};
