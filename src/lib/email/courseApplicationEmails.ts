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
 * Template resolution is FALLBACK-FIRST: until an admin saves a template in the
 * course email designs editor, no `courseEmailTemplates` doc exists and
 * `courseTemplateDefaults` (courseEmails.ts) is what actually sends. A stored
 * template only wins when it is well-formed AND non-empty — an admin who saves
 * a blank body gets the seed copy rather than an empty email. A Firestore read
 * failure degrades the same way: the send still happens, on the defaults.
 *
 * Errors are the caller's to swallow — every call site fires these after its
 * write has committed, and a failed niceness email must never fail the
 * request that earned it.
 *
 * WHAT THE DECISION COPY MAY PROMISE: an acceptance is an OFFER, not a seat.
 * Deciding does not enrol anyone — allocation places accepted applicants into
 * groups afterwards — so the accepted template says a placement email follows
 * with the group, facilitator, and time slot, and never names one. The
 * group-scoped tokens ({groupName}, {facilitatorNames}, {firstSessionWhen}) are
 * deliberately NOT supplied on the application-lifecycle paths: an admin who
 * pastes one into a decision template sees the literal `{token}` in a test send
 * and notices, rather than shipping a blank where a group name should be. They
 * ARE supplied on the `allocated` path (the allocation publish route), which is
 * exactly the email those tokens exist for.
 */

/**
 * The five lifecycle triggers, one per template id. `submitted` is fired by
 * the apply route; `accepted`/`waitlisted`/`rejected` by the decide route
 * (/api/courses/runs/[runId]/applications/[uid]/decide) once a decision has
 * COMMITTED, one email per status change — a re-decision into the same status
 * sends nothing, so a double-clicked Accept can't mail twice. `allocated` is
 * fired by the allocation publish route
 * (/api/courses/runs/[runId]/allocation/publish) once per placement, guarded
 * by `courseEnrolments.allocatedEmailAt`.
 */
export type CourseApplicationEmailKind =
  | "submitted"
  | "accepted"
  | "waitlisted"
  | "rejected"
  | "allocated";

const TEMPLATE_FOR_KIND: Record<CourseApplicationEmailKind, CourseTemplateId> = {
  submitted: "course-application-submitted",
  accepted: "course-application-accepted",
  waitlisted: "course-application-waitlisted",
  rejected: "course-application-rejected",
  allocated: "course-allocated",
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
  /**
   * Group-scoped tokens, supplied ONLY by the `allocated` kind (see the module
   * comment). Each is pre-formatted for humans at the call site; when absent
   * the `{token}` stays literal in the sent mail, per the house convention.
   */
  groupName?: string;
  /** Comma-joined display names, e.g. "Priya and Sam". */
  facilitatorNames?: string;
  /** Human first-session label, e.g. "Tuesday 7 October, 18:00". */
  firstSessionWhen?: string;
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
      // The group-scoped trio: `buildCourseTokens` omits each key when the
      // input is undefined, so an unset value leaves the `{token}` literal in
      // the sent mail (an admin notices) rather than a silent blank.
      groupName: opts.groupName,
      facilitatorNames: opts.facilitatorNames,
      firstSessionWhen: opts.firstSessionWhen,
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
