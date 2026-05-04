import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

type Props = { name: string };

export default function TestEmail({ name }: Props) {
  return (
    <Html>
      <Head />
      <Preview>NAISI email pipeline test. If you see this, it works.</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>Email pipeline test</Heading>
          <Section>
            <Text style={text}>Hi {name},</Text>
            <Text style={text}>
              This is a test from the NAISI website. If it arrived in your inbox, Nodemailer is
              authenticated against the Google Workspace SMTP for ai-safety@uonsu.com and React
              Email templating is rendering as expected.
            </Text>
            <Text style={textMuted}>
              Nothing else. No action needed. You can safely delete this message.
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
  maxWidth: "560px",
  backgroundColor: "#ffffff",
  borderRadius: "12px",
  border: "1px solid #e4e4e7",
};

const heading: React.CSSProperties = {
  fontSize: "22px",
  fontWeight: 600,
  color: "#09090b",
  marginBottom: "16px",
};

const text: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: "1.6",
  color: "#27272a",
  margin: "0 0 12px",
};

const textMuted: React.CSSProperties = {
  ...text,
  color: "#71717a",
  fontSize: "13px",
};
