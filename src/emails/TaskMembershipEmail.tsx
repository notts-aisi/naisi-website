import { Button, Section, Text } from "@react-email/components";
import EmailChrome, { emailLinkStyle } from "./EmailChrome";

export type MembershipPreassignment = {
  title: string;
  /** Formatted due date (e.g. "Mon 4 May") or empty when not set. */
  dueLabel: string;
};

type Props = {
  recipientName: string;
  taskTitle: string;
  taskLink: string;
  /** Subtasks the recipient is already pre-assigned to. Empty array when
   *  they were added at task-level only (no subtask claims yet). */
  preassignments: MembershipPreassignment[];
  /** Other completers' display names — for the social-context line.
   *  Excludes the recipient themselves; empty array when they're alone. */
  otherCompleterNames: string[];
};

/**
 * Short personal welcome to a new task member. Deliberately minimal: no
 * state-of-project, no phases primer. The deep link is the orientation —
 * the in-app view shows them everything they need.
 */
export default function TaskMembershipEmail({
  recipientName,
  taskTitle,
  taskLink,
  preassignments,
  otherCompleterNames,
}: Props) {
  const subject = `You've been added to "${taskTitle}"`;
  return (
    <EmailChrome subject={subject} greeting={`Hi ${recipientName},`}>
      <Section>
        <Text style={para}>
          You&apos;ve been added to <strong>{taskTitle}</strong>.
        </Text>
        {preassignments.length > 0 && (
          <Text style={para}>
            You&apos;re pre-assigned to{" "}
            {preassignments.map((p, i) => (
              <span key={i}>
                {i > 0 && (i === preassignments.length - 1 ? " and " : ", ")}
                <strong>{p.title}</strong>
                {p.dueLabel ? ` (due ${p.dueLabel})` : ""}
              </span>
            ))}
            .
          </Text>
        )}
        {otherCompleterNames.length > 0 && (
          <Text style={para}>
            The other completers are{" "}
            {otherCompleterNames.map((n, i) => (
              <span key={i}>
                {i > 0 &&
                  (i === otherCompleterNames.length - 1 ? " and " : ", ")}
                <strong>{n}</strong>
              </span>
            ))}
            . Feel free to chat with the team and re-allocate as you see fit.
          </Text>
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

const para: React.CSSProperties = {
  fontSize: "15px",
  color: "#27272a",
  margin: "0 0 12px",
  lineHeight: 1.6,
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
