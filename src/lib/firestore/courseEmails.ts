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
  | "admissions-reinstated";

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
   *     `{sessionWhen}` `{sessionWhere}` `{weekPrep}` `{weekUrl}` resolve here;
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
          "<p>Read what you can. The week stays open, and nobody is keeping score.</p>",
      ),
    ],
  },
  /**
   * The admissions pair (V3). Three things an editor should know before
   * rewriting them:
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
