import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

type Props = {
  recipientName: string;
  requesterName: string;
  taskTitle: string;
  /** The specific review-subtask title, if this was sent on a subtask. */
  subtaskTitle?: string | null;
  /** Optional preview of the comment that was posted alongside. */
  commentPreview?: string | null;
  taskLink: string;
};

export default function TaskReviewRequestEmail({
  recipientName,
  requesterName,
  taskTitle,
  subtaskTitle,
  commentPreview,
  taskLink,
}: Props) {
  const subject = subtaskTitle
    ? `Review requested: ${subtaskTitle}`
    : `Review requested: ${taskTitle}`;
  return (
    <EmailChrome subject={subject} greeting={`Hi ${recipientName},`}>
      <Section>
        <Text style={para}>
          <strong>{requesterName}</strong> is asking you to review{" "}
          {subtaskTitle ? (
            <>
              <strong>{subtaskTitle}</strong> on <strong>{taskTitle}</strong>
            </>
          ) : (
            <strong>{taskTitle}</strong>
          )}
          .
        </Text>
        {commentPreview && <Text style={quote}>{commentPreview}</Text>}
        <Button href={taskLink} style={ctaStyle}>
          Open task to review
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
