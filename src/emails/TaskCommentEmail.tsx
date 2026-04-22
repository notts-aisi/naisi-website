import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

type Props = {
  recipientName: string;
  authorName: string;
  taskTitle: string;
  commentPreview: string;
  taskLink: string;
  /** Distinguishes what triggered the email so the subject line makes sense. */
  reason: "mention" | "completer" | "reviewer";
};

const REASON_COPY: Record<Props["reason"], { subject: string; line: string }> = {
  mention: {
    subject: "You were mentioned on a task",
    line: "mentioned you in a comment on",
  },
  completer: {
    subject: "New comment on a task you're on",
    line: "commented on",
  },
  reviewer: {
    subject: "New comment on a task you review",
    line: "commented on",
  },
};

export default function TaskCommentEmail({
  recipientName,
  authorName,
  taskTitle,
  commentPreview,
  taskLink,
  reason,
}: Props) {
  const { subject, line } = REASON_COPY[reason];
  return (
    <EmailChrome subject={subject} greeting={`Hi ${recipientName},`}>
      <Section>
        <Text style={para}>
          <strong>{authorName}</strong> {line} <strong>{taskTitle}</strong>.
        </Text>
        <Text style={quote}>{commentPreview}</Text>
        <Button href={taskLink} style={ctaStyle}>
          Open task
        </Button>
        <Text style={subtle}>
          Or paste this into your browser:{" "}
          <a href={taskLink} style={emailLinkStyle}>
            {taskLink}
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

const quote: React.CSSProperties = {
  ...para,
  borderLeft: "3px solid #a1a1aa",
  padding: "8px 12px",
  background: "#f4f4f5",
  fontStyle: "italic",
  whiteSpace: "pre-wrap" as const,
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
  marginTop: "8px",
};
