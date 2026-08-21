import "server-only";
import ApplicationEmail from "@/emails/ApplicationEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  buildCourseTokens,
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import {
  personaliseBlocks,
  personaliseString,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * Course application lifecycle emails. Thin wrapper over `sendEmail` in the
 * `collaboratorEmails.ts` shape, but block-based rather than a hard-coded JSX
 * body: the copy lives in `courseEmailTemplates/{id}` and renders through the
 * SAME `ApplicationEmail` component + `EmailChrome` the member-application
 * emails use, so course mail is visually identical to the rest of the estate.
 *
 * Template resolution is FALLBACK-FIRST: the admin editor for
 * `courseEmailTemplates` does not ship until P5 (admissions review), so on a
 * fresh deploy no doc exists and `courseTemplateDefaults` (courseEmails.ts) is
 * what actually sends. A stored template only wins when it is well-formed AND
 * non-empty — an admin who saves a blank body gets the seed copy rather than
 * an empty email. A Firestore read failure degrades the same way: the send
 * still happens, on the defaults.
 *
 * Errors are the caller's to swallow — every call site fires these after its
 * write has committed, and a failed niceness email must never fail the
 * request that earned it.
 */

/**
 * The application-lifecycle triggers. Only `submitted` is called in P4 (the
 * apply route); P5's decide route reuses this function for the other three,
 * which is why the map is complete rather than a single entry.
 */
export type CourseApplicationEmailKind =
  | "submitted"
  | "accepted"
  | "waitlisted"
  | "rejected";

const TEMPLATE_FOR_KIND: Record<CourseApplicationEmailKind, CourseTemplateId> = {
  submitted: "course-application-submitted",
  accepted: "course-application-accepted",
  waitlisted: "course-application-waitlisted",
  rejected: "course-application-rejected",
};

export type CourseApplicationEmailOptions = {
  kind: CourseApplicationEmailKind;
  /** Deliverable address — sourced from the SESSION at the call site, never a body field. */
  to: string;
  /** The applicant's display name; drives the {preferredName} / {firstName} tokens. */
  name: string;
  courseTitle: string;
  runLabel: string;
  /**
   * Human-formatted run start ("Monday 6 October") for the {startDate} token.
   * Omitted when the run has no start date set yet: the token then stays
   * literal in the sent mail, which is the house convention for a value that
   * should have been there (an admin notices; an empty gap in a sentence
   * nobody does).
   */
  startDate?: string;
  /** Applicant uid — recorded as the deliverability log's actor. */
  uid: string;
  /** Run id — the deliverability log's reference, so a run's mail is greppable. */
  runId: string;
};

export async function sendCourseApplicationEmail(
  opts: CourseApplicationEmailOptions,
): Promise<void> {
  const templateId = TEMPLATE_FOR_KIND[opts.kind];
  const defaults = courseTemplateDefaults[templateId];

  let subject = defaults.subject;
  let blocks = defaults.blocks;
  let fromName: string | undefined;

  const db = getAdminDb();
  if (db) {
    try {
      const snap = await db.collection("courseEmailTemplates").doc(templateId).get();
      if (snap.exists) {
        const template = normalizeCourseTemplate(snap.id, snap.data() ?? {});
        if (template && template.subject && template.blocks.length > 0) {
          subject = template.subject;
          blocks = template.blocks;
          fromName = template.fromName;
        }
      }
    } catch (err) {
      console.warn("[courseApplicationEmails] template read failed", templateId, err);
    }
  }

  const tokens: TokenValues = {
    ...buildCourseTokens({
      // `name` is already the resolved preferredName → displayName fallback at
      // the call site, so it feeds the token builder as the display name.
      user: { displayName: opts.name },
      courseTitle: opts.courseTitle,
      runLabel: opts.runLabel,
      startDate: opts.startDate ?? "",
    }),
  };
  // Leave {startDate} literal rather than substituting an empty string.
  if (!opts.startDate) delete tokens.startDate;

  const personalisedSubject = personaliseString(subject, tokens);
  const personalisedBlocks = personaliseBlocks(blocks, tokens);

  await sendEmail({
    to: opts.to,
    subject: personalisedSubject,
    react: ApplicationEmail({
      subject: personalisedSubject,
      blocks: personalisedBlocks,
      preheader: personalisedSubject,
    }),
    fromName,
    kind: "course-application",
    actorUid: opts.uid,
    referenceId: opts.runId,
  });
}
