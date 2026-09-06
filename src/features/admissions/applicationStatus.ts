import type { ChipTone } from "@/components/ui/Chip";
import type { RoundWindowState } from "@/lib/admissions/window";
import type { AdmissionApplicationStatus } from "@/lib/firestore/admissionApplications";
import type { AdmissionRoundKind } from "@/lib/firestore/admissionRounds";

/**
 * How each application status READS to the person who wrote the application:
 * the chip's tone, and the sentence under it.
 *
 * One map, shared by `/applications` and `/applications/[roundId]`, because
 * the two pages sit one click apart and a status that is "Submitted, we are
 * reading it" on the list and something subtly different on the detail page
 * is how somebody decides the site has lost their application.
 *
 * ## The voice
 *
 * These sentences are read by people waiting on a decision that matters to
 * them, often days after they last heard anything. So: say what is true, say
 * what happens next, and never imply a decision that has not been made. The
 * rejection line in particular says nothing about the applicant.
 *
 * `ADMISSION_APPLICATION_STATUS_LABEL` (admissionApplications.ts) stays the
 * source of the chip's WORDS; this module only adds the tone and the
 * explanation, so a status renamed there renames everywhere.
 */

export const APPLICATION_STATUS_TONE: Record<AdmissionApplicationStatus, ChipTone> = {
  draft: "warning",
  submitted: "accent",
  accepted: "success",
  "fellowship-offered": "success",
  waitlisted: "warning",
  rejected: "neutral",
  withdrawn: "neutral",
  appointed: "success",
};

/**
 * The sentence under the chip. The WINDOW STATE, not a boolean, and it matters
 * for exactly one status: a draft nobody submitted before the window shut is
 * not a piece of work in progress, and telling somebody to finish it would be
 * worse than telling them plainly that it was not sent.
 *
 * A boolean was the earlier shape and it collapsed two different endings into
 * "still open": a round that has been archived, or taken back to draft, is
 * `inactive` rather than `closed`, so a draft on one read as work waiting to
 * be finished on a form that answers 404. Each state gets its own sentence.
 */
export function applicationStatusBlurb(
  status: AdmissionApplicationStatus,
  windowState: RoundWindowState,
  kind: AdmissionRoundKind = "enrolment",
): string {
  // THE APPOINTMENT ARM, and it comes first so no sentence below it can be
  // read by somebody who applied to facilitate. A facilitator round shares
  // this hub with the intake, and "we could not offer you a place this time,
  // cohorts are small" is the wrong sentence twice over for somebody who
  // offered to run one. `kind` defaults to `enrolment` so a caller that has no
  // round in hand gets the sentences this function has always given.
  if (kind === "appointment") {
    switch (status) {
      case "appointed":
        return "You are on the facilitator team. The email says which group and when the training runs.";
      case "rejected":
        return "We are not able to take you on as a facilitator this time. It is a small team and it says nothing about you as a participant: applying again next term is genuinely welcome.";
      case "submitted":
        return "Sent. We read facilitator applications together after the deadline, and you do not need to do anything else.";
      default:
        break;
    }
  }
  switch (status) {
    case "draft":
      if (windowState === "closed") {
        return "This was still a draft when applications closed, so it was never sent to us. Nobody has read it.";
      }
      if (windowState === "inactive") {
        return "This round is no longer taking applications, so this draft was never sent to us. Everything you wrote is still here.";
      }
      return "Saved but not sent. It stays exactly as you left it until you submit it.";
    case "submitted":
      return "Sent. It is in the queue to be read, and you do not need to do anything else.";
    case "accepted":
      return "You have a place. Everything you need comes by email.";
    case "fellowship-offered":
      return "You have been offered a fellowship place. The email explains what it involves and how to take it.";
    case "waitlisted":
      return "You are on the waitlist. Places do come free in the first couple of weeks, and we will email you if one does.";
    case "rejected":
      return "We could not offer you a place this time. Cohorts are small, and applying again next term is genuinely welcome.";
    case "withdrawn":
      return "You withdrew this application, so it is out of the queue.";
    case "appointed":
      // Reachable only if an appointment outcome is ever written on an
      // enrolment round, which the decide route refuses. Said plainly rather
      // than left to fall through to an empty string.
      return "You have been appointed. Everything you need comes by email.";
  }
}
