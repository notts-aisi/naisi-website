import type { AdmissionRoundKind } from "@/lib/firestore/admissionRounds";

/**
 * What the apply surfaces CALL the thing somebody is filling in.
 *
 * ## Why the wording is data rather than a conditional in each component
 *
 * The applicant meets the same round on four surfaces (the page hero, the
 * signed-out gate, the start card, the submit button) and two of those are in
 * a server component while two are in the client island. A round of kind
 * `appointment` is the facilitator intake: the person filling it in is
 * offering to RUN a group, not asking for a place on one, and a form that says
 * "Submit application" beside a heading about places on a course is the kind
 * of small wrongness that makes somebody stop and check they are on the right
 * page, in the week they are deciding whether to volunteer.
 *
 * Written as one table keyed on the kind, every surface reads the same row, so
 * adding a third kind later is one entry rather than four conditionals nobody
 * finds all of. It is a pure module with no `server-only` marker precisely
 * because both halves import it.
 *
 * ## What is deliberately NOT in here
 *
 * The privacy notice. `ApplicationPrivacyNotice` describes name-blind scored
 * review, which is the enrolment round's process and is mirrored word for word
 * in the "Courses and programmes" section of the privacy policy. The
 * appointment round's decide path (PR24) does no blind review and no scoring,
 * so an appointment variant of that copy would be a promise about data
 * handling that the policy does not make. Changing what an applicant is told
 * about how their answers are read is the owner's call and the policy's, not a
 * string swapped in a copy table.
 */

export type ApplyCopy = {
  /** The badge shown when the round carries no academic year. */
  kicker: string;
  /**
   * One line under the title saying what this form actually is. Empty for an
   * enrolment round, where the round label and blurb already say it, so the
   * hero is unchanged for the intake most applicants meet.
   */
  standfirst: string;
  /** Heading on the signed-out gate while the window is open. */
  signInTitle: string;
  /** Heading on the "no row yet" card while the window is open. */
  startTitle: string;
  /** The button that starts a row. */
  startAction: string;
  /** The button that sends it. */
  submitAction: string;
  /** Heading once it is in. */
  submittedTitle: string;
};

const COPY: Record<AdmissionRoundKind, ApplyCopy> = {
  enrolment: {
    kicker: "Applications",
    standfirst: "",
    signInTitle: "Sign in to apply",
    startTitle: "Start your application",
    startAction: "Start your application",
    submitAction: "Submit application",
    submittedTitle: "Your application is in",
  },
  appointment: {
    kicker: "Facilitator applications",
    standfirst:
      "This is an application to facilitate: to run a group each week rather than to take part in one.",
    signInTitle: "Sign in to apply to facilitate",
    startTitle: "Start your application to facilitate",
    startAction: "Start your application",
    submitAction: "Submit your application to facilitate",
    submittedTitle: "Your application to facilitate is in",
  },
};

/**
 * The copy for a round's kind, falling back to the enrolment wording for a
 * kind this build does not know about. A round document normalises `kind` to
 * `enrolment` when it is unrecognised, so this only matters for a payload that
 * reached the browser from an older or newer deploy, and generic wording is a
 * better answer there than a blank heading.
 */
export function applyCopy(kind: AdmissionRoundKind): ApplyCopy {
  return COPY[kind] ?? COPY.enrolment;
}
