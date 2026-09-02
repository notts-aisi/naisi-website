import "server-only";
import AdmissionsReinstatedEmail from "@/emails/AdmissionsReinstatedEmail";
import AdmissionsSubmittedEmail from "@/emails/AdmissionsSubmittedEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  buildCourseTokens,
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  personaliseBlocks,
  personaliseString,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * ADMISSIONS lifecycle mail: the applicant's own receipts on an admission
 * round. Two sends today, one per template id, and the rest of the round's
 * lifecycle (stage released, deadline reminder, and the four decisions) lands
 * on this module as those routes are built.
 *
 * ## Why it is not `courseApplicationEmails.ts`
 *
 * That module's whole contract is stated in terms of a RUN: its options are
 * `courseTitle` / `runLabel` / `startDate`, it logs as `course-application`,
 * and its comment is a set of promises about what a decision email may claim
 * about a group and a first session. An admission round has none of those. One
 * round feeds several runs and an appointment round feeds none, so folding
 * these in would have made every one of those sentences conditionally true and
 * left `{courseTitle}` resolving to something arbitrary in an applicant's
 * inbox.
 *
 * ## Template resolution is FALLBACK-FIRST
 *
 * A stored `courseEmailTemplates/{id}` doc wins only when it is well-formed and
 * non-empty, so an admin who saves a blank body still sends the seed copy, and
 * a Firestore read failure degrades to the defaults rather than to silence.
 * Same discipline as both sibling modules, and it matters more here: there is
 * no seed step, so "no doc" is the normal state on a fresh backend.
 *
 * ## Suppression is checked here, and this function never throws
 *
 * `sendEmail` logs a send; it does not consult the suppression list, and
 * continuing to mail a hard bounce is how a sending domain's reputation goes.
 * A suppressed address is skipped silently.
 *
 * Every call site fires this AFTER its transaction has committed, and a
 * confirmation is a courtesy rather than part of the write, so the whole body
 * sits in a try/catch and the caller cannot tell a send from a skip from a
 * failure. That is the `sendRsvpEmail` posture, chosen for the same reason: an
 * SMTP hiccup must never turn a saved application into a 500 the applicant
 * reads as "it did not go through".
 */

export type AdmissionEmailKind = "submitted" | "reinstated";

const TEMPLATE_FOR_KIND: Record<AdmissionEmailKind, CourseTemplateId> = {
  submitted: "admissions-submitted",
  reinstated: "admissions-reinstated",
};

export type AdmissionEmailOptions = {
  kind: AdmissionEmailKind;
  /** Deliverable address, from the SESSION at the call site, never a body field. */
  to: string;
  /** Display name; drives the {preferredName} / {firstName} tokens. */
  name: string;
  /** The round's public label, for {roundLabel}. */
  roundLabel: string;
  /**
   * Where this applicant reads this application: the form while it is still
   * theirs to finish, `/applications/[roundId]` once it has been sent. Absolute,
   * built from `NEXT_PUBLIC_APP_URL` by `admissionApplicationUrl` below.
   */
  applicationUrl: string;
  /** Human-formatted deadline ("Sun 18 Oct, 23:59"). Omitted when the round has none. */
  deadline?: string;
  /** Human-formatted decisions-by date ("Fri 23 Oct"). Omitted when unset. */
  decisionsBy?: string;
  /**
   * The part of a multi-part form this send is about. Omitted on a
   * single-stage round, where naming "the form" as a stage would be noise.
   */
  stageLabel?: string;
  /** The applicant's uid, the deliverability log's actor. */
  uid: string;
  /** The round id, the log's reference, so one intake's mail is greppable. */
  roundId: string;
};

/** The absolute url for a round's application, for whichever surface owns it. */
export function admissionApplicationUrl(
  roundId: string,
  surface: "apply" | "status",
): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (!base) return "";
  const path = surface === "apply" ? "apply" : "applications";
  return `${base}/${path}/${encodeURIComponent(roundId)}`;
}

export async function sendAdmissionEmail(opts: AdmissionEmailOptions): Promise<void> {
  try {
    const templateId = TEMPLATE_FOR_KIND[opts.kind];
    const defaults = courseTemplateDefaults[templateId];

    let subject = defaults.subject;
    let blocks = defaults.blocks;
    let fromName: string | undefined;

    const db = getAdminDb();
    if (db) {
      if (await isSuppressed(db, opts.to)) {
        console.log(`[admissions email:${opts.kind}] skipped, suppressed:`, opts.to);
        return;
      }
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
        console.warn("[admissions email] template read failed", templateId, err);
      }
    }

    const tokens: TokenValues = {
      ...buildCourseTokens({
        // `name` is already the resolved preferredName / displayName fallback
        // at the call site, so it feeds the builder as the display name.
        user: { displayName: opts.name },
        // A round is not a run. These three are passed empty and then DELETED
        // below, so a course token pasted into admissions copy stays literal
        // in a test send instead of resolving to a blank.
        courseTitle: "",
        runLabel: "",
        startDate: "",
        applicationUrl: opts.applicationUrl,
        roundLabel: opts.roundLabel,
        stageLabel: opts.stageLabel,
        deadline: opts.deadline,
        decisionsBy: opts.decisionsBy,
      }),
    };
    delete tokens.courseTitle;
    delete tokens.runLabel;
    delete tokens.startDate;

    const personalisedSubject = personaliseString(subject, tokens);
    const personalisedBlocks = personaliseBlocks(blocks, tokens);

    const react =
      opts.kind === "submitted"
        ? AdmissionsSubmittedEmail({
            subject: personalisedSubject,
            blocks: personalisedBlocks,
            applicationUrl: opts.applicationUrl,
            preheader: personalisedSubject,
          })
        : AdmissionsReinstatedEmail({
            subject: personalisedSubject,
            blocks: personalisedBlocks,
            applicationUrl: opts.applicationUrl,
            preheader: personalisedSubject,
          });

    await sendEmail({
      to: opts.to,
      subject: personalisedSubject,
      react,
      fromName,
      kind: "admissions",
      actorUid: opts.uid,
      referenceId: opts.roundId,
    });
  } catch (err) {
    console.error(`[admissions email:${opts.kind}] send failed`, opts.roundId, err);
  }
}
