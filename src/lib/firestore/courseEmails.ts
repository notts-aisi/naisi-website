import { firstWord } from "./applicationEmails";
import {
  isValidBlock,
  newBlockId,
  sanitizeBlocks,
  type Block,
} from "./newsletterBlocks";

/**
 * `courseEmailTemplates/{id}` — admin-edited boilerplates for the course
 * lifecycle emails, mirroring the `applicationEmailTemplates` pattern
 * (applicationEmails.ts): fixed well-known ids, block-based bodies, `{token}`
 * substitution at send time, and seed defaults so a fresh deploy has
 * something sensible to send before anyone opens the admin UI.
 */

export const COURSE_TEMPLATE_IDS = [
  "course-application-submitted",
  "course-application-accepted",
  "course-application-waitlisted",
  "course-application-rejected",
  "course-allocated",
  "course-week-nudge",
  "course-dropped-out",
  // The ADMISSIONS lifecycle (V3). Same collection and same editor as the
  // course templates above, because they are the same job to an admin: the
  // boilerplate NAISI sends people about their application. The ids carry the
  // `admissions-` prefix because a round is not a run, and the retired
  // `course-application-*` ids stay in the list until the surfaces that send
  // them are gone.
  "admissions-submitted",
  "admissions-reinstated",
  "admissions-deadline-reminder",
  // The weekly-questions announcement. The RELEASE itself is derived at read
  // time by `isStageReleased`, so this template announces something that has
  // already happened: a missed send delays an email and never gates access.
  "admissions-stage-released",
  // The APPOINTMENT round's two endings. A facilitator round decides who runs
  // a group, so its outcome names a run and its refusal is about a role rather
  // than about a place on a course. Both send through `sendAdmissionEmail`.
  //
  // `admissions-declined` is the APPOINTMENT refusal and nothing else. The
  // ENROLMENT round's refusal is a separate template about a separate thing (a
  // place on a course, not a role running one) and it arrives with the
  // enrolment decide path, so the id it will take is deliberately not
  // registered here yet.
  "admissions-appointed",
  "admissions-declined",
] as const;

export type CourseTemplateId = (typeof COURSE_TEMPLATE_IDS)[number];

export type CourseTemplateTrigger =
  | "submitted"
  | "accepted"
  | "waitlisted"
  | "rejected"
  | "allocated"
  | "week-nudge"
  | "dropped-out"
  | "admissions-submitted"
  | "admissions-reinstated"
  | "admissions-deadline-reminder"
  | "admissions-stage-released"
  | "admissions-appointed"
  | "admissions-declined";

/**
 * Trigger each template belongs to. Used by the send paths to decide which
 * lifecycle event a template fires on.
 */
export const COURSE_TEMPLATE_TRIGGER: Record<CourseTemplateId, CourseTemplateTrigger> = {
  "course-application-submitted": "submitted",
  "course-application-accepted": "accepted",
  "course-application-waitlisted": "waitlisted",
  "course-application-rejected": "rejected",
  "course-allocated": "allocated",
  "course-week-nudge": "week-nudge",
  "course-dropped-out": "dropped-out",
  "admissions-submitted": "admissions-submitted",
  "admissions-reinstated": "admissions-reinstated",
  "admissions-deadline-reminder": "admissions-deadline-reminder",
  "admissions-stage-released": "admissions-stage-released",
  "admissions-appointed": "admissions-appointed",
  "admissions-declined": "admissions-declined",
};

export type CourseTemplateDoc = {
  templateId: CourseTemplateId;
  trigger: CourseTemplateTrigger;
  label: string;
  subject: string;
  blocks: Block[];
  fromName?: string;
  updatedAt?: Date | null;
  updatedBy?: string | null;
};

export const COURSE_SUBJECT_MAX = 200;
export const COURSE_TEMPLATE_MAX_BLOCKS = 40;

export function isCourseTemplateId(v: unknown): v is CourseTemplateId {
  return (
    typeof v === "string" && (COURSE_TEMPLATE_IDS as readonly string[]).includes(v)
  );
}

export function isValidCourseTemplateDoc(raw: unknown): raw is CourseTemplateDoc {
  if (!raw || typeof raw !== "object") return false;
  const d = raw as Record<string, unknown>;
  if (!isCourseTemplateId(d.templateId)) return false;
  if (typeof d.subject !== "string" || d.subject.length === 0) return false;
  if (d.subject.length > COURSE_SUBJECT_MAX) return false;
  if (!Array.isArray(d.blocks) || !d.blocks.every(isValidBlock)) return false;
  if (d.blocks.length > COURSE_TEMPLATE_MAX_BLOCKS) return false;
  return true;
}

/**
 * Coerce a raw Firestore doc into a CourseTemplateDoc. Unknown ids return
 * null; a missing or malformed blocks array becomes [].
 */
export function normalizeCourseTemplate(
  id: string,
  data: Record<string, unknown>,
): CourseTemplateDoc | null {
  if (!isCourseTemplateId(id)) return null;
  return {
    templateId: id,
    trigger: COURSE_TEMPLATE_TRIGGER[id],
    label: typeof data.label === "string" ? data.label : COURSE_DEFAULT_LABELS[id],
    subject: typeof data.subject === "string" ? data.subject : "",
    blocks: sanitizeBlocks(data.blocks).slice(0, COURSE_TEMPLATE_MAX_BLOCKS),
    fromName: typeof data.fromName === "string" ? data.fromName : undefined,
    updatedAt: tsToDate(data.updatedAt),
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

/**
 * Token map used at send time. The group-scoped tokens (`groupName`,
 * `facilitatorNames`, `firstSessionWhen`) are only populated once the
 * recipient has a group — before allocation they're absent, so a template
 * that uses them out of place leaves the `{token}` literal visible and the
 * admin notices (same convention as applicationEmails' `customReason`).
 */
export type CourseTokenMap = {
  courseTitle: string;
  runLabel: string;
  /** Human-formatted run start, e.g. "Monday 6 October". */
  startDate: string;
  groupName?: string;
  /** Comma-joined display names, e.g. "Priya and Sam". */
  facilitatorNames?: string;
  /** Human-formatted first session, e.g. "Tuesday 7 October, 6pm". */
  firstSessionWhen?: string;
  /**
   * The anonymous feedback form offered on drop-out (`config/courses`
   * `dropOutFeedbackUrl`). ABSENT when no link is configured.
   *
   * NOT used by the seed copy, on purpose. `personaliseBlocks` leaves an
   * unresolved token LITERAL (the house convention: an admin notices a typo),
   * so a `{feedbackUrl}` in the body of a transactional email would read as
   * "tell us at {feedbackUrl}" the day the config doc is empty. The drop-out
   * email renders the link from its own component instead, and shows nothing
   * when there is none. The token exists so an admin who HAS configured a
   * form can place it in the sentence they prefer.
   */
  feedbackUrl?: string;
  /**
   * THE ADMISSIONS TOKENS (V3). Each is optional and each is omitted rather
   * than blanked when the send path does not know it, so the house convention
   * holds: an admin who puts `{cohortLabel}` in the application-received email
   * sees the literal token in a test send and moves it.
   *
   * `applicationUrl` is where THIS applicant reads THIS application on the
   * site, resolved at the call site: the form while it is still theirs to
   * finish, the status hub once it has been sent. It is not used by the seed
   * copy, for the same reason `feedbackUrl` is not: a bare `{applicationUrl}`
   * in a sentence is a broken link the day a send path forgets to pass it. The
   * admissions email components render the link themselves. The token is here
   * for an admin who wants it in their own wording.
   */
  applicationUrl?: string;
  /** The round's public name, e.g. "Autumn 2026 intake". */
  roundLabel?: string;
  /** One part of a multi-part form, e.g. "Week 2 questions". */
  stageLabel?: string;
  /** Human-formatted application deadline, e.g. "Sun 18 Oct, 23:59". */
  deadline?: string;
  /** Human-formatted date decisions are promised by, e.g. "Fri 23 Oct". */
  decisionsBy?: string;
  /** The structured cohort name, e.g. "Autumn 2026, cohort 2". */
  cohortLabel?: string;
  /**
   * The decider's shared reason for a decision, and ONLY when they ticked
   * "share this with the applicant". Absent otherwise, which is what makes an
   * unshared reason structurally unable to reach a template: a caller passes
   * nothing rather than a blank, so a paragraph built around `{reason}` keeps
   * the literal token in front of the admin who wrote it instead of quietly
   * closing over a hole.
   *
   * NO TRIGGER SUPPLIES IT TODAY. The appointment round's refusal renders the
   * shared note as its own paragraph in `AdmissionsDeclinedEmail`, so offering
   * `{reason}` as well would have printed it twice; the enrolment refusal,
   * which has no such paragraph, is the send this is here for.
   *
   * Never confuse this with `outcome.reason`, which is the decider's whole
   * note. Only the SHARED half is ever handed to a token map.
   */
  reason?: string;
  preferredName: string;
  firstName: string;
};

export type CourseTokenInput = {
  user: {
    displayName?: string | null;
    profile?: { preferredName?: string } | null;
  };
  courseTitle: string;
  runLabel: string;
  /** Pre-formatted for humans — formatting happens at the call site. */
  startDate: string;
  groupName?: string;
  facilitatorNames?: string;
  firstSessionWhen?: string;
  feedbackUrl?: string;
  applicationUrl?: string;
  roundLabel?: string;
  stageLabel?: string;
  deadline?: string;
  decisionsBy?: string;
  cohortLabel?: string;
  reason?: string;
};

export function buildCourseTokens(input: CourseTokenInput): CourseTokenMap {
  const preferredName = input.user.profile?.preferredName?.trim() ?? "";
  const displayName = input.user.displayName?.trim() ?? "";
  const source = preferredName || displayName;
  return {
    courseTitle: input.courseTitle,
    runLabel: input.runLabel,
    startDate: input.startDate,
    preferredName: preferredName || displayName,
    firstName: firstWord(source),
    ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
    ...(input.facilitatorNames !== undefined
      ? { facilitatorNames: input.facilitatorNames }
      : {}),
    ...(input.firstSessionWhen !== undefined
      ? { firstSessionWhen: input.firstSessionWhen }
      : {}),
    ...(input.feedbackUrl ? { feedbackUrl: input.feedbackUrl } : {}),
    // The admissions tokens, omitted rather than blanked: an empty string
    // substitutes a hole into somebody's sentence, while a missing key leaves
    // the token visible to the admin who wrote it.
    ...(input.applicationUrl ? { applicationUrl: input.applicationUrl } : {}),
    ...(input.roundLabel ? { roundLabel: input.roundLabel } : {}),
    ...(input.stageLabel ? { stageLabel: input.stageLabel } : {}),
    ...(input.deadline ? { deadline: input.deadline } : {}),
    ...(input.decisionsBy ? { decisionsBy: input.decisionsBy } : {}),
    ...(input.cohortLabel ? { cohortLabel: input.cohortLabel } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export const COURSE_DEFAULT_LABELS: Record<CourseTemplateId, string> = {
  "course-application-submitted": "Course application submitted",
  "course-application-accepted": "Course application accepted",
  "course-application-waitlisted": "Course application waitlisted",
  "course-application-rejected": "Course application rejected",
  "course-allocated": "Placed in a group",
  "course-week-nudge": "Weekly reminder",
  "course-dropped-out": "Left a course",
  "admissions-submitted": "Application received",
  "admissions-reinstated": "Application picked back up",
  "admissions-deadline-reminder": "Deadline reminder",
  "admissions-stage-released": "New questions released",
  "admissions-appointed": "Appointed as a facilitator",
  "admissions-declined": "Facilitator application declined",
};

function rt(html: string): Block {
  return { id: newBlockId(), type: "richText", html };
}

function h(text: string, level: 2 | 3 = 2): Block {
  return { id: newBlockId(), type: "heading", text, level };
}

/**
 * Seed copy for each template. Admins can fully rewrite these in the editor;
 * they exist so a fresh deploy has something sensible to send before anyone
 * opens the admin UI.
 */
export const courseTemplateDefaults: Record<
  CourseTemplateId,
  { label: string; subject: string; blocks: Block[] }
> = {
  "course-application-submitted": {
    label: COURSE_DEFAULT_LABELS["course-application-submitted"],
    subject: "We got your {courseTitle} application, {firstName}",
    blocks: [
      h("Thanks for applying, {firstName}"),
      rt(
        "<p>Your application for <strong>{courseTitle}</strong> ({runLabel}) has been received. The committee reviews applications before the cohort starts on {startDate} — we'll email you as soon as there's a decision.</p>" +
          "<p>There's nothing else you need to do for now. If your availability changes, you can edit your application from the course page any time before the deadline.</p>",
      ),
    ],
  },
  "course-application-accepted": {
    label: COURSE_DEFAULT_LABELS["course-application-accepted"],
    subject: "You're in — {courseTitle} starts {startDate}",
    blocks: [
      h("You're in, {firstName}"),
      rt(
        "<p>Your application for <strong>{courseTitle}</strong> ({runLabel}) has been accepted. The cohort starts on {startDate}.</p>" +
          "<p>We're now sorting everyone into small groups, each with its own weekly session and facilitator. You'll get another email once you've been placed — that one has your group, your time slot, and where to be.</p>" +
          "<p>Glad to have you on board.</p>",
      ),
    ],
  },
  "course-application-waitlisted": {
    label: COURSE_DEFAULT_LABELS["course-application-waitlisted"],
    subject: "You're on the waitlist for {courseTitle}",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>Thanks for applying for <strong>{courseTitle}</strong> ({runLabel}). This round was oversubscribed, so we've placed you on the waitlist rather than turning you away.</p>" +
          "<p>Spots open up more often than you'd think — people's timetables shift in the first couple of weeks. If one does, we'll email you straight away. No need to do anything in the meantime.</p>",
      ),
    ],
  },
  "course-application-rejected": {
    label: COURSE_DEFAULT_LABELS["course-application-rejected"],
    subject: "About your {courseTitle} application",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>Thanks for applying for <strong>{courseTitle}</strong> ({runLabel}). We weren't able to offer you a place this time — cohorts are small by design, and we had more strong applications than seats.</p>" +
          "<p>This isn't a judgement on you or your interest in the field. We run the programme every term, and applying again next time is genuinely encouraged. Until then, our events and socials are open to all members.</p>",
      ),
    ],
  },
  "course-allocated": {
    label: COURSE_DEFAULT_LABELS["course-allocated"],
    subject: "Your {courseTitle} group — first session {firstSessionWhen}",
    blocks: [
      h("You've been placed, {firstName}"),
      rt(
        "<p>You're in <strong>{groupName}</strong> for {courseTitle} ({runLabel}), facilitated by {facilitatorNames}.</p>" +
          "<p>Your first session is <strong>{firstSessionWhen}</strong>. Everything you need — the week's reading, your group's details, and your progress — lives in the learning space on the website.</p>" +
          "<p>Do the first week's reading before you come; the sessions work best when everyone arrives with opinions.</p>",
      ),
    ],
  },
  /**
   * The weekly nudge (P11). Four things make this seed different from the five
   * above, and an editor should know them before rewriting it — the full
   * argument is in `src/lib/email/courseNudgeEmail.ts`, whose
   * `COURSE_NUDGE_TOKEN_KEYS` is the authoritative list:
   *
   *  1. **It has its own token map.** `{firstName}` `{courseTitle}`
   *     `{runLabel}` `{weekNumber}` `{weekTitle}` `{weekSummary}`
   *     `{sessionWhen}` `{sessionWhere}` `{weekPrep}` `{weekUrl}`
   *     `{feedbackUrl}` resolve here;
   *     `{preferredName}`, `{startDate}` and the group trio do NOT. The list is
   *     closed — a token outside it stays literal in the inbox.
   *  2. **An unresolved token deletes its sentence, it does not stay literal.**
   *     A paragraph whose tokens ALL come back empty is dropped whole, so a
   *     week with no summary, or a member with no group time, gets a shorter
   *     email rather than a broken one. Hence the shape below: ONE OPTIONAL
   *     TOKEN PER PARAGRAPH, in plain text — not wrapped in bold or a link, and
   *     not mixed with copy that only makes sense when it resolves.
   *  3. **The SUBJECT leads with what varies.** A phone truncates a subject at
   *     roughly 35 characters, so "Week 3 of AI Safety Fundamentals: …" spends
   *     the whole visible line on the half that is identical every week. The
   *     week's own title goes first; the fixed half is what gets cut. When there
   *     is no title yet the leading separator is trimmed and the subject falls
   *     back to "Week 3 of AI Safety Fundamentals".
   *  4. **The voice is deliberately unpushy.** It says what is in the week and
   *     where to find it, and it never implies the reader is behind — it has no
   *     idea whether they are. Keep the last line, or something like it.
   *
   * `{runLabel}` resolves but is not used: a member is on exactly one run, so
   * "(Autumn 2026)" in the body is bookkeeping addressed to nobody. It stays on
   * the token list for an admin who has a reason to name it.
   */
  "course-week-nudge": {
    label: COURSE_DEFAULT_LABELS["course-week-nudge"],
    subject: "{weekTitle} · Week {weekNumber} of {courseTitle}",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>Week {weekNumber} of {courseTitle} is open: {weekTitle}.</p>" +
          "<p>{weekSummary}</p>" +
          "<p>Your group meets {sessionWhen}, {sessionWhere}.</p>" +
          "<p>{weekPrep}</p>" +
          '<p><a href="{weekUrl}" style="color:#2563eb">Open this week on the site</a></p>' +
          '<p><a href="{feedbackUrl}" style="color:#2563eb">Tell us how the last session went</a></p>' +
          "<p>Read what you can. The week stays open, and nobody is keeping score.</p>",
      ),
    ],
  },
  /**
   * The two admissions RECEIPTS (V3). Three things an editor should know
   * before rewriting them:
   *
   *  1. **They resolve a DIFFERENT token set.** `{roundLabel}`, `{deadline}`,
   *     `{decisionsBy}` and `{applicationUrl}` resolve here; `{courseTitle}`,
   *     `{runLabel}` and `{startDate}` do NOT, because a round is not a run
   *     and nobody has been placed on anything yet. A course token in this
   *     copy stays literal in the inbox.
   *  2. **The link is rendered by the component, not by a token.** See
   *     `applicationUrl` on `CourseTokenMap`. Do not paste a bare
   *     `{applicationUrl}` into the body unless you mean to depend on the
   *     send path passing it.
   *  3. **Neither may promise a decision, or hint at one.** These go to
   *     everybody who applies, weeks before anybody has read anything. The
   *     only thing they may say about the outcome is when it will arrive.
   */
  "admissions-submitted": {
    label: COURSE_DEFAULT_LABELS["admissions-submitted"],
    subject: "We have your application, {firstName}",
    blocks: [
      h("Thanks for applying, {firstName}"),
      rt(
        "<p>Your application to <strong>{roundLabel}</strong> is in. There is nothing else you need to do right now.</p>" +
          "<p>We read everything after the deadline rather than as it arrives, so a quiet few weeks is normal and is not a sign of anything. You will hear from us by {decisionsBy}, whatever the answer is.</p>" +
          "<p>Until applications close on {deadline} you can still read what you sent, and withdraw it if your plans change.</p>",
      ),
    ],
  },
  "admissions-reinstated": {
    label: COURSE_DEFAULT_LABELS["admissions-reinstated"],
    subject: "Your {roundLabel} application is open again",
    blocks: [
      h("Picked back up, {firstName}"),
      rt(
        "<p>You have reopened your application to <strong>{roundLabel}</strong>. Everything you had written is still there, and it is a draft again, so nothing has been sent to us yet.</p>" +
          "<p>Finish it and press submit before applications close on {deadline}. A draft sitting at the deadline is not an application, and we would rather you knew that now than found out afterwards.</p>",
      ),
    ],
  },
  /**
   * The deadline reminder (V3 W3). Sent by the scheduler tick to everybody
   * still holding an UNSUBMITTED draft, on the dates the round's reminder
   * schedule resolves to. Three things an editor should know:
   *
   *  1. **The audience is drafts only.** Nobody who has submitted ever
   *      receives this, so the copy may say "still a draft" as a fact rather
   *      than as a hedge. It must never read as a chase: plenty of people
   *      start an application and decide against it, and that is fine.
   *  2. **It resolves fewer tokens than its siblings.** `{roundLabel}` and
   *      `{deadline}` resolve; `{decisionsBy}` and `{stageLabel}` do NOT,
   *      because the tick knows the round's deadline and nothing about
   *      stages. A token this trigger does not supply stays literal.
   *  3. **It can arrive up to a day late and no later.** A tick that has been
   *      down stamps anything over `maxLateHours` as stale rather than
   *      sending it, so this copy is never read after the deadline has gone.
   */
  "admissions-deadline-reminder": {
    label: COURSE_DEFAULT_LABELS["admissions-deadline-reminder"],
    subject: "Still a draft: your {roundLabel} application",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>You have started an application to <strong>{roundLabel}</strong> and it is still a draft, so it has not reached us yet.</p>" +
          "<p>Applications close on {deadline}. A draft sitting at the deadline is not an application, and we would rather you knew that now than found out afterwards.</p>" +
          "<p>If you have changed your mind, you can leave it. Nothing else happens, and this is the only kind of reminder we send about it.</p>",
      ),
    ],
  },
  /**
   * The stage-released announcement (V3 W3). Sent by the scheduler tick, or by
   * the admin release button, once a stage's questions are actually out.
   * Three things an editor should know:
   *
   *  1. **It announces, it does not authorise.** The questions are released by
   *     `isStageReleased` at read time, so by the time this arrives they are
   *     already on the applicant's form. A tick that never ran costs an email
   *     and never costs access, and the copy must not imply the reader has to
   *     do anything to unlock anything.
   *  2. **The audience is drafts AND submitted applications.** Somebody who
   *     sent stage one weeks ago is still in it, so the copy has to reassure
   *     them that what they already sent is untouched.
   *  3. **{stageLabel} is the stage's own name**, as the round authored it
   *     ("Stage 2", "The technical exercise"), and {deadline} is the earlier
   *     of the stage's own closing time and the round's.
   *  4. **The deadline sentence is a block of its own, and that is load
   *     bearing.** A round may legitimately have no `closesAt` (it means "no
   *     automatic deadline"), and `sendAdmissionEmail` drops whole any block
   *     whose only supplied token had no value on that send. Fold the
   *     deadline back into the paragraph above it and the copy either ships
   *     "it is due by {deadline}." to an applicant or takes a sentence that
   *     still made sense with it.
   */
  "admissions-stage-released": {
    label: COURSE_DEFAULT_LABELS["admissions-stage-released"],
    subject: "{stageLabel} is open: your {roundLabel} application",
    blocks: [
      h("The next part is open, {firstName}"),
      rt(
        "<p><strong>{stageLabel}</strong> of the {roundLabel} application is open, and its questions are on your application now.</p>" +
          "<p>Anything you have already sent us stays exactly as it is. This part is new writing.</p>",
      ),
      rt("<p>It is due by {deadline}.</p>"),
      rt(
        "<p>If you have decided not to carry on, you can leave it there. Nothing else happens, and nobody chases you.</p>",
      ),
    ],
  },
  /**
   * THE APPOINTMENT ROUND'S TWO ENDINGS, and three rules govern the copy.
   *
   *  1. **The appointment names a real run**, so `{courseTitle}`, `{runLabel}`
   *     and `{startDate}` DO resolve here, unlike on the two receipts above.
   *     That is the whole difference between an appointment and an
   *     application: by the time this sends, the person has been written onto
   *     a run's facilitator list.
   *  2. **The training dates are the decider's own sentence.** There is no
   *     training-dates field on a round, so the decide route's `note` is
   *     rendered as its own paragraph by `AdmissionsAppointedEmail`, below the
   *     body and above the footer. It is member-authored plain text and it is
   *     NOT a token: putting it through `personaliseBlocks` would put a
   *     typed-in string into a `richText` block that reaches
   *     `dangerouslySetInnerHTML`.
   *  3. **The refusal says nothing about the person.** A facilitator team is
   *     small, so most good applicants are not on it, and the sentence has to
   *     make that the reason. The decider's shared note is NOT a token here
   *     either: `AdmissionsDeclinedEmail` renders it as its own paragraph, so
   *     a `{reason}` in the body would print it a second time. The declined
   *     trigger supplies no such token, which is what stops that happening.
   */
  "admissions-appointed": {
    label: COURSE_DEFAULT_LABELS["admissions-appointed"],
    subject: "You are facilitating {courseTitle}, {firstName}",
    blocks: [
      h("Welcome to the team, {firstName}"),
      rt(
        "<p>We would like you to facilitate on <strong>{courseTitle}</strong> ({runLabel}), which starts {startDate}. Thank you for offering: we had more good applications to {roundLabel} than we had groups.</p>" +
          "<p>Facilitator training comes before the first session, and the note below says when. Everything else, your group and its weekly material, appears in your course area on the site once groups are set.</p>" +
          "<p>If you can no longer do it, tell us as soon as you can. A group with no facilitator is the one thing we cannot fix late.</p>",
      ),
    ],
  },
  "admissions-declined": {
    label: COURSE_DEFAULT_LABELS["admissions-declined"],
    subject: "Your {roundLabel} application",
    blocks: [
      h("Thank you for applying, {firstName}"),
      rt(
        "<p>We are not able to take you on for <strong>{roundLabel}</strong> this time. We had more people offering than we have groups, so this is about the number of places and not about your application.</p>" +
          "<p>Please do stay involved. Coming along as a participant is genuinely the usual route in, and applying again next term is welcome.</p>",
      ),
    ],
  },
  "course-dropped-out": {
    label: COURSE_DEFAULT_LABELS["course-dropped-out"],
    subject: "You've left {courseTitle}",
    blocks: [
      h("That's you off the list, {firstName}"),
      rt(
        "<p>You're no longer on <strong>{courseTitle}</strong> ({runLabel}), and your place has gone back to the group. The weekly emails will stop.</p>" +
          "<p>Thanks for giving it a go. If you'd like to join a future cohort, keep an eye on the courses page: applying again is welcome and counts for nothing against you.</p>" +
          "<p>Nothing else is needed from you.</p>",
      ),
    ],
  },
};
