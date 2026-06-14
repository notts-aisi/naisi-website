import { Section, Text } from "@react-email/components";
import EmailChrome from "./EmailChrome";

type Kind = "submitted" | "approved" | "rejected";

type Props = {
  kind: Kind;
  name: string;
  /** Shown only for the rejected email, when an admin supplied a reason. */
  rejectionReason?: string;
};

export const COLLABORATOR_EMAIL_SUBJECTS: Record<Kind, string> = {
  submitted: "We've received your NAISI collaborator application",
  approved: "Your NAISI collaborator application has been approved",
  rejected: "An update on your NAISI collaborator application",
};

const bodyText = { fontSize: 16, lineHeight: 1.6, margin: "0 0 16px" } as const;
const mutedText = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#5b6785",
  margin: "0 0 8px",
} as const;

/**
 * Transactional email for the external-collaborator application lifecycle.
 * Fixed copy (unlike the block-editable member ApplicationEmail) — collaborator
 * volume is low and the messages are simple; can be made admin-editable later.
 */
export default function CollaboratorEmail({ kind, name, rejectionReason }: Props) {
  const greetingName = name.trim() || "there";

  return (
    <EmailChrome
      subject={COLLABORATOR_EMAIL_SUBJECTS[kind]}
      preheader={COLLABORATOR_EMAIL_SUBJECTS[kind]}
    >
      <Text style={bodyText}>Hi {greetingName},</Text>

      {kind === "submitted" && (
        <>
          <Text style={bodyText}>
            Thanks for applying to collaborate with the Nottingham AI Safety
            Initiative. We&apos;ve received your application and project pitch —
            the team will review it and be in touch.
          </Text>
          <Text style={bodyText}>
            You can sign back in any time to review or update what you
            submitted.
          </Text>
        </>
      )}

      {kind === "approved" && (
        <>
          <Text style={bodyText}>
            Good news — your application to collaborate with NAISI has been
            approved. We&apos;re excited about what you proposed and will reach
            out shortly with next steps.
          </Text>
          <Text style={bodyText}>
            In the meantime you can sign in to view your collaborator space.
          </Text>
        </>
      )}

      {kind === "rejected" && (
        <>
          <Text style={bodyText}>
            Thank you for your interest in collaborating with NAISI. After
            reviewing your application, we&apos;re not able to move forward at
            this time.
          </Text>
          {rejectionReason && (
            <Section
              style={{
                background: "#f4f6fa",
                borderRadius: 8,
                padding: "12px 16px",
                margin: "0 0 16px",
              }}
            >
              <Text style={{ ...bodyText, margin: 0 }}>{rejectionReason}</Text>
            </Section>
          )}
          <Text style={bodyText}>
            We genuinely appreciate the time you put in, and you&apos;re welcome
            to apply again in the future.
          </Text>
        </>
      )}

      <Text style={mutedText}>— The NAISI team</Text>
    </EmailChrome>
  );
}
