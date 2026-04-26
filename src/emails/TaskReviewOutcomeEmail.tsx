import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

export type ReviewOutcomeSubtask = {
  title: string;
  /** Reviewer-supplied note attached to the most recent decision on this
   *  subtask, if any. Currently surfaces the latest approve / question /
   *  reject `note` from the activity log; reviewers leave it blank for
   *  silent ✓ ticks. Empty string when no note. */
  note: string;
};

type Props = {
  recipientName: string;
  blockName: string;
  taskTitle: string;
  taskLink: string;
  approved: ReviewOutcomeSubtask[];
  questionsResolved: ReviewOutcomeSubtask[];
  rejected: ReviewOutcomeSubtask[];
};

export default function TaskReviewOutcomeEmail({
  recipientName,
  blockName,
  taskTitle,
  taskLink,
  approved,
  questionsResolved,
  rejected,
}: Props) {
  // Sections render in approve → questions-resolved → rejected order so the
  // good news leads — feedback the user explicitly called out as humane.
  // Any section with no rows is skipped entirely.
  const subject = `Review outcome: ${blockName} — ${taskTitle}`;
  return (
    <EmailChrome subject={subject} greeting={`Hi ${recipientName},`}>
      <Section>
        <Text style={para}>
          The review pass on <strong>{blockName}</strong> in{" "}
          <strong>{taskTitle}</strong> wrapped up. Here&apos;s where each
          subtask landed.
        </Text>
        {approved.length > 0 && (
          <OutcomeSection
            heading="Approved"
            colour="#16a34a"
            rows={approved}
          />
        )}
        {questionsResolved.length > 0 && (
          <OutcomeSection
            heading="Questions resolved"
            colour="#b45309"
            rows={questionsResolved}
          />
        )}
        {rejected.length > 0 && (
          <OutcomeSection
            heading="Needs another pass"
            colour="#b45309"
            rows={rejected}
          />
        )}
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

function OutcomeSection({
  heading,
  colour,
  rows,
}: {
  heading: string;
  colour: string;
  rows: ReviewOutcomeSubtask[];
}) {
  return (
    <Section style={{ margin: "16px 0" }}>
      <Text style={{ ...sectionHeading, color: colour }}>{heading}</Text>
      {rows.map((row, i) => (
        <Section key={i} style={rowStyle}>
          <Text style={rowTitle}>{row.title}</Text>
          {row.note && <Text style={rowNote}>“{row.note}”</Text>}
        </Section>
      ))}
    </Section>
  );
}

const para: React.CSSProperties = {
  fontSize: "15px",
  color: "#27272a",
  margin: "0 0 12px",
  lineHeight: 1.6,
};

const sectionHeading: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "16px 0 6px",
};

const rowStyle: React.CSSProperties = {
  margin: "0 0 6px",
  padding: "8px 12px",
  background: "#f4f4f5",
  borderLeft: "3px solid #d4d4d8",
  borderRadius: "4px",
};

const rowTitle: React.CSSProperties = {
  fontSize: "14px",
  color: "#27272a",
  fontWeight: 600,
  margin: 0,
};

const rowNote: React.CSSProperties = {
  fontSize: "13px",
  color: "#52525b",
  margin: "4px 0 0",
  fontStyle: "italic",
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
  marginTop: "12px",
};
