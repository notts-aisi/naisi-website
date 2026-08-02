import "server-only";
import CollaboratorEmail, {
  COLLABORATOR_EMAIL_SUBJECTS,
} from "@/emails/CollaboratorEmail";
import { sendEmail } from "./send";

type Kind = "submitted" | "approved" | "rejected";

/**
 * Send a collaborator lifecycle email. Thin wrapper over `sendEmail` so the
 * create route (submitted) and the admin approve/reject routes share one path
 * and the deliverability log records them under `kind: "application"`.
 * Errors are the caller's to swallow — these are fire-and-forget niceties.
 */
export async function sendCollaboratorEmail(opts: {
  kind: Kind;
  to: string;
  name: string;
  uid: string;
  actorUid?: string;
  rejectionReason?: string;
}): Promise<void> {
  await sendEmail({
    to: opts.to,
    subject: COLLABORATOR_EMAIL_SUBJECTS[opts.kind],
    react: CollaboratorEmail({
      kind: opts.kind,
      name: opts.name,
      rejectionReason: opts.rejectionReason,
    }),
    kind: "application",
    actorUid: opts.actorUid,
    referenceId: opts.uid,
  });
}
