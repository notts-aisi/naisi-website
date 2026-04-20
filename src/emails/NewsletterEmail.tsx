import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";

type Props = {
  subject: string;
  blocks: Block[];
  recipientName: string;
  unsubscribeUrl: string;
  preheader?: string;
};

export default function NewsletterEmail({
  subject,
  blocks,
  recipientName,
  unsubscribeUrl,
  preheader,
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
            <Text style={greeting}>Hi {recipientName},</Text>
          </Section>

          {blocks.map((block) => (
            <BlockRenderer key={block.id} block={block} />
          ))}

          <Hr style={hr} />
          <Section>
            <Text style={footer}>
              You&apos;re getting this because you subscribed on the NAISI website. You can change
              your subscription preferences or unsubscribe at any time by visiting{" "}
              <Link href={unsubscribeUrl} style={link}>
                your profile
              </Link>
              .
            </Text>
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

const greeting: React.CSSProperties = {
  fontSize: "16px",
  color: "#27272a",
  margin: "0 0 8px",
};

const hr: React.CSSProperties = {
  borderColor: "#e4e4e7",
  margin: "32px 0 20px",
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

const link: React.CSSProperties = {
  color: "#3f3f46",
  textDecoration: "underline",
};
