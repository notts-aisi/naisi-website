import { firstWord } from "@/lib/firestore/applicationEmails";
import {
  buildCourseTokens,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import type { TokenValues } from "@/lib/firestore/newsletterBlocks";

/**
 * Sample token values for the course email designer — shared by the live
 * preview (client) and the test send (route handler) so the two can never drift
 * and show an admin two different renderings of the same copy.
 *
 * Deliberately plain data + one pure function: this module has no "use client"
 * directive and pulls in no React, so importing it from a route handler costs
 * nothing.
 */

export const COURSE_PREVIEW_SAMPLE = {
  courseTitle: "AI Safety Fundamentals",
  runLabel: "Autumn 2026",
  startDate: "Monday 6 October",
  groupName: "Tuesday 6pm — Group B",
  facilitatorNames: "Priya and Sam",
  firstSessionWhen: "Tuesday 7 October, 6pm",
  feedbackUrl: "https://example.com/naisi-course-feedback",
} as const;

/**
 * Sample values for the weekly nudge's own tokens, which no other course
 * template resolves. Hard-coded rather than imported from
 * `src/lib/email/courseNudgeEmail.ts` because that module is `server-only` and
 * this one is pulled into a client component — the token NAMES are the shared
 * contract, and `COURSE_NUDGE_TOKEN_KEYS` there is the source of truth for them.
 * `tests/course-nudge.test.mjs` fails if this map and that list drift apart,
 * which is the only thing standing in for an import across that boundary.
 *
 * Shaped to look like a real send: `weekPrep` is a whole derived sentence (the
 * server counts the week's non-optional materials and required exercises),
 * `sessionWhen` is date-anchored rather than recurring because a weekly email
 * names the day it means, and `sessionWhere` is a room rather than a video link
 * — the nudge never puts a meeting URL in an inbox.
 *
 * WHAT THE PREVIEW CANNOT SHOW: every sample below resolves, so the preview
 * renders the template at full length. On a real send an unresolved token
 * deletes its whole paragraph instead of staying literal (see
 * `courseNudgeEmail.ts`), which is the opposite of what the other five
 * templates do — so a week with no summary sends a SHORTER email than this,
 * never a broken one.
 */
export const COURSE_NUDGE_PREVIEW_SAMPLE = {
  weekNumber: "3",
  weekTitle: "Goal misgeneralisation",
  weekSummary:
    "Why a system that learned the right thing in training can still pursue the wrong one when the world shifts.",
  sessionWhen: "Tuesday 21 October, 18:00–19:30",
  sessionWhere: "Hallward Library, B12",
  weekPrep:
    "There are four things to read or watch and one exercise to write up this week, about 2 hours in total.",
  weekUrl: "https://naisi.uk/learn/asf-autumn-2026/weeks/3",
} as const;

/**
 * Templates whose send path actually populates the group-scoped tokens
 * (`groupName` / `facilitatorNames` / `firstSessionWhen`). Only the allocation
 * email knows a recipient's group: the application-lifecycle sends fire before
 * anyone is placed (see courseApplicationEmails.ts, which passes none of them).
 *
 * Previewing them as literal `{groupName}` on the other templates is the point
 * — it is exactly what the recipient would receive, so an admin who drops a
 * group token into the acceptance email sees the mistake here rather than in
 * someone's inbox. Same convention as applicationEmails' `{customReason}`.
 *
 * The weekly nudge is NOT on this list. It knows a recipient's group session
 * (`{sessionWhen}` / `{sessionWhere}`, below) but not the allocation trio: it
 * addresses people who were placed weeks ago, so naming their facilitator and
 * their FIRST session would be stale copy. It has its own token set instead.
 */
export const COURSE_GROUP_TOKEN_TEMPLATES: readonly CourseTemplateId[] = [
  "course-allocated",
];

export function courseTemplateUsesGroupTokens(templateId: CourseTemplateId): boolean {
  return COURSE_GROUP_TOKEN_TEMPLATES.includes(templateId);
}

/**
 * Templates whose send path resolves the week-scoped tokens. One today; the
 * predicate exists so the editor and the preview ask the same question the
 * group-token pair does, rather than string-matching an id in two places.
 */
export const COURSE_WEEK_TOKEN_TEMPLATES: readonly CourseTemplateId[] = [
  "course-week-nudge",
];

export function courseTemplateUsesWeekTokens(templateId: CourseTemplateId): boolean {
  return COURSE_WEEK_TOKEN_TEMPLATES.includes(templateId);
}

/**
 * Templates whose send path resolves `{feedbackUrl}`. One today: the drop-out
 * confirmation, which reads it from `config/courses.dropOutFeedbackUrl`.
 *
 * A caution the preview cannot show: on a REAL send with no form configured
 * the token stays literal, because `personaliseBlocks` never blanks an
 * unresolved token. That is why the seed copy does not use it and the email
 * component renders the link itself. An admin who chooses to put
 * `{feedbackUrl}` in the body is choosing to depend on the config doc being
 * set, and the sample below is what they will get when it is.
 */
export const COURSE_FEEDBACK_TOKEN_TEMPLATES: readonly CourseTemplateId[] = [
  "course-dropped-out",
];

export function courseTemplateUsesFeedbackToken(
  templateId: CourseTemplateId,
): boolean {
  return COURSE_FEEDBACK_TOKEN_TEMPLATES.includes(templateId);
}

/**
 * Build the sample token map for one template. Routed through
 * `buildCourseTokens` rather than hand-written so the preview cannot drift from
 * the real send-time shape (`preferredName` / `firstName` derivation included).
 *
 * THE NUDGE TAKES THE OTHER BRANCH, and the branch is the point: its send path
 * is `buildCourseNudgeTokens`, a DIFFERENT map, so feeding it the lifecycle
 * samples would resolve `{startDate}` and `{preferredName}` in the preview and
 * leave them literal in the real inbox — the exact drift this module exists to
 * prevent. Whatever this function hands back for a template is what that
 * template's send path can resolve, and nothing else.
 */
export function courseSampleTokens(
  templateId: CourseTemplateId,
  name: string,
): TokenValues {
  if (courseTemplateUsesWeekTokens(templateId)) {
    return {
      courseTitle: COURSE_PREVIEW_SAMPLE.courseTitle,
      runLabel: COURSE_PREVIEW_SAMPLE.runLabel,
      // Same derivation the nudge does: first word of the display name, and no
      // `preferredName` — the nudge greets with `{firstName}` alone.
      firstName: firstWord(name),
      ...COURSE_NUDGE_PREVIEW_SAMPLE,
    };
  }

  const group = courseTemplateUsesGroupTokens(templateId)
    ? {
        groupName: COURSE_PREVIEW_SAMPLE.groupName,
        facilitatorNames: COURSE_PREVIEW_SAMPLE.facilitatorNames,
        firstSessionWhen: COURSE_PREVIEW_SAMPLE.firstSessionWhen,
      }
    : {};

  const feedback = courseTemplateUsesFeedbackToken(templateId)
    ? { feedbackUrl: COURSE_PREVIEW_SAMPLE.feedbackUrl }
    : {};

  return {
    ...buildCourseTokens({
      user: { displayName: name },
      courseTitle: COURSE_PREVIEW_SAMPLE.courseTitle,
      runLabel: COURSE_PREVIEW_SAMPLE.runLabel,
      startDate: COURSE_PREVIEW_SAMPLE.startDate,
      ...group,
      ...feedback,
    }),
  };
}
