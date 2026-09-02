import "server-only";
import CourseDroppedOutEmail from "@/emails/CourseDroppedOutEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  buildCourseTokens,
  courseTemplateDefaults,
  normalizeCourseTemplate,
} from "@/lib/firestore/courseEmails";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  personaliseBlocks,
  personaliseString,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * ENROLMENT lifecycle mail, as opposed to the ADMISSIONS lifecycle mail in
 * `courseApplicationEmails.ts`. One template today: the confirmation somebody
 * gets after dropping themselves out of a course.
 *
 * Same resolution discipline as its sibling and for the same reasons:
 * FALLBACK-FIRST (a stored `courseEmailTemplates/{id}` doc wins only when it
 * is well-formed and non-empty, so an admin who saves a blank body still
 * sends the seed copy), and a Firestore read failure degrades to the defaults
 * rather than to silence.
 *
 * ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────
 * `sendCourseApplicationEmail`'s whole contract is stated in terms of an
 * application: its kinds are `submitted` / `accepted` / `waitlisted` /
 * `rejected` / `allocated`, it logs as `course-application`, and its module
 * comment is a set of promises about what a decision email may and may not
 * claim. An open-enrolment run has no application anywhere in it. Bolting a
 * sixth kind onto that module would have made every one of those sentences
 * conditionally true.
 *
 * ── SUPPRESSION IS CHECKED HERE, NOT LEFT TO THE TRANSPORT ──────────────────
 * `sendEmail` logs a send; it does not consult the suppression list. This mail
 * is transactional and the recipient is owed it, but "owed" does not survive a
 * hard bounce or a spam complaint: continuing to mail a suppressed address is
 * how a sending domain's reputation goes, and the drop-out has already
 * committed, so skipping the confirmation costs the member nothing they can
 * act on. A suppressed address is skipped silently, which the caller cannot
 * distinguish from a send, and must not need to.
 */

export type CourseDroppedOutEmailOptions = {
  /** Deliverable address, from the SESSION at the call site, never a body. */
  to: string;
  /** Display name; drives the {preferredName} / {firstName} tokens. */
  name: string;
  courseTitle: string;
  runLabel: string;
  /**
   * `config/courses.dropOutFeedbackUrl`, or "" when none is configured.
   * Rendered by the email component only when non-empty; also offered as the
   * `{feedbackUrl}` token for an admin who prefers it inline.
   */
  feedbackUrl: string;
  /** The member's uid, the deliverability log's actor. */
  uid: string;
  /** Run id, the deliverability log's reference, so a run's mail is greppable. */
  runId: string;
};

export async function sendCourseDroppedOutEmail(
  opts: CourseDroppedOutEmailOptions,
): Promise<void> {
  const templateId = "course-dropped-out" as const;
  const defaults = courseTemplateDefaults[templateId];

  let subject = defaults.subject;
  let blocks = defaults.blocks;
  let fromName: string | undefined;

  const db = getAdminDb();
  if (db) {
    if (await isSuppressed(db, opts.to)) return;
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
      console.warn("[courseEnrolmentEmails] template read failed", templateId, err);
    }
  }

  const tokens: TokenValues = {
    ...buildCourseTokens({
      // `name` is already the resolved preferredName / displayName fallback at
      // the call site, so it feeds the token builder as the display name.
      user: { displayName: opts.name },
      courseTitle: opts.courseTitle,
      runLabel: opts.runLabel,
      // No run start date on this one: somebody who has just left does not
      // need to be told when the thing they left begins. The token stays
      // literal if an admin puts it in the copy, which is the house
      // convention for a value that should not have been asked for.
      startDate: "",
      feedbackUrl: opts.feedbackUrl,
    }),
  };
  delete tokens.startDate;

  const personalisedSubject = personaliseString(subject, tokens);
  const personalisedBlocks = personaliseBlocks(blocks, tokens);

  await sendEmail({
    to: opts.to,
    subject: personalisedSubject,
    react: CourseDroppedOutEmail({
      subject: personalisedSubject,
      blocks: personalisedBlocks,
      feedbackUrl: opts.feedbackUrl,
      preheader: personalisedSubject,
    }),
    fromName,
    kind: "course-enrolment",
    actorUid: opts.uid,
    referenceId: opts.runId,
  });
}
