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
 * P11's weekly nudge may gain group context; add `course-week-nudge` here when
 * its send path starts passing those tokens.
 */
export const COURSE_GROUP_TOKEN_TEMPLATES: readonly CourseTemplateId[] = [
  "course-allocated",
];

export function courseTemplateUsesGroupTokens(templateId: CourseTemplateId): boolean {
  return COURSE_GROUP_TOKEN_TEMPLATES.includes(templateId);
}

/**
 * Build the sample token map for one template. Routed through
 * `buildCourseTokens` rather than hand-written so the preview cannot drift from
 * the real send-time shape (`preferredName` / `firstName` derivation included).
 */
export function courseSampleTokens(
  templateId: CourseTemplateId,
  name: string,
): TokenValues {
  const group = courseTemplateUsesGroupTokens(templateId)
    ? {
        groupName: COURSE_PREVIEW_SAMPLE.groupName,
        facilitatorNames: COURSE_PREVIEW_SAMPLE.facilitatorNames,
        firstSessionWhen: COURSE_PREVIEW_SAMPLE.firstSessionWhen,
      }
    : {};

  return {
    ...buildCourseTokens({
      user: { displayName: name },
      courseTitle: COURSE_PREVIEW_SAMPLE.courseTitle,
      runLabel: COURSE_PREVIEW_SAMPLE.runLabel,
      startDate: COURSE_PREVIEW_SAMPLE.startDate,
      ...group,
    }),
  };
}
