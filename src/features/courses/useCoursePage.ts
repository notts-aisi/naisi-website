"use client";

import { doc, getDoc } from "firebase/firestore";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import { getClientDb } from "@/lib/firebase/client";
import { useOneShotList } from "@/features/admin/adminList";
import {
  COURSE_PAGES_COLLECTION,
  emptyCoursePage,
  normalizeCoursePage,
  type CoursePageDoc,
  type CoursePageFaq,
  type CoursePageJourneyStep,
  type CoursePageTheme,
} from "@/lib/firestore/coursePages";

/**
 * The authored public page for one course, read CLIENT-DIRECT.
 *
 * `coursePages` is `allow read: if isAdmin() || canDraftCourse() ||
 * canApproveCourse(); allow write: if false`. The asymmetry is the whole
 * design (see the collection's module comment): a read is cheap to allow the
 * staff who author the thing, while writes go through one route so a single
 * sanitiser can stand between stored HTML and `dangerouslySetInnerHTML` on a
 * logged-out page.
 *
 * The read predicate is the SAME gate this hook already sits behind
 * (`requireCourseAuthorPage()` on `/admin/courses`), narrowed from the old
 * signed-in tier by V3 W3 PR20 so a draft course's pitch is not readable by
 * every account once the course document itself stopped being. Nothing here
 * changed shape as a result.
 *
 * So the editor READS here and WRITES through `PUT /api/courses/[courseId]/page`.
 * Reading through a route as well would have bought nothing and cost the
 * editor a second failure mode.
 *
 * One-shot rather than `onSnapshot`, matching `useAdminCourses`: this is an
 * editorial document opened by one author at a time, and a live listener on it
 * would fight the form's own draft state on every save.
 *
 * The hook returns a single-element list so it can reuse `useOneShotList` and
 * its `{ items, loading, refreshing, error, reload }` shape. A course with no
 * page yet resolves to the EMPTY page rather than to nothing, so the editor
 * never branches on "no document" and a first save is an ordinary save.
 */
export function useCoursePage(courseId: string) {
  return useOneShotList<CoursePageDoc>(async () => {
    if (!courseId) return [];
    const db = getClientDb();
    const snap = await getDoc(doc(db, COURSE_PAGES_COLLECTION, courseId));
    return [
      snap.exists()
        ? normalizeCoursePage(courseId, snap.data() ?? {})
        : emptyCoursePage(courseId),
    ];
  }, `coursePage:${courseId}`);
}

// ---------------------------------------------------------------------------
// The two writes, both routes
// ---------------------------------------------------------------------------

/** Read a route response without ever throwing on a malformed body: a 500 from
 *  the platform is an HTML error page, and that has to reach the author as a
 *  sentence rather than as a JSON syntax error. (`useTemplates` precedent.) */
async function readBody<T extends object>(
  res: Response,
): Promise<(T & { ok?: true; error?: string }) | null> {
  return (await res.json().catch(() => null)) as (T & { ok?: true; error?: string }) | null;
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * The full page payload the PUT route takes. FULL REPLACE, not a patch, which
 * is why every field is required here rather than optional: the route treats
 * an omitted key as an empty value, so an optional field in this type would be
 * a field the editor could silently clear by forgetting it.
 *
 * `weeklyThemes` is included in that rule and the route's comment says so out
 * loud. There is no "leave the themes alone" body.
 */
export type CoursePagePayload = {
  headline: string;
  pitchBlocks: Block[];
  whoItIsFor: string;
  howSelectionWorks: string;
  membershipExpectation: string;
  formatText: string;
  sessionsText: string;
  weeklyHoursText: string;
  weeklyThemes: CoursePageTheme[];
  sampleWeekNumber: number | null;
  faq: CoursePageFaq[];
  journey: CoursePageJourneyStep[];
  coverImageUrl: string | null;
  coverAlt: string;
  visualSeed: string;
};

/** THROWS on refusal, so callers can wrap it in `useActionToast().run`. */
export async function saveCoursePage(
  courseId: string,
  payload: CoursePagePayload,
): Promise<CoursePageDoc> {
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/page`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  const body = await readBody<{ page?: unknown }>(res);
  if (!res.ok) throw new Error(body?.error || "Couldn't save the page.");
  // Normalised rather than trusted: the response has been through JSON and the
  // route's own sanitisers, and this is the shape the next read will produce.
  return normalizeCoursePage(courseId, (body?.page ?? {}) as Record<string, unknown>);
}

/** What the generate route reports back, so the author can see what it did. */
export type ThemeGenerationReceipt = {
  weeklyThemes: CoursePageTheme[];
  /** Rows this call wrote fresh copy into. */
  generated: number;
  /** Rows left alone because they already carried an edited blurb. */
  kept: { weekNumber: number; title: string }[];
  /** Rows kept because the source has no week of that number at all. */
  carriedForward: { weekNumber: number; title: string }[];
  source: { kind: "template" | "run"; id: string; label: string };
  overwrite: boolean;
};

/** THROWS on refusal. Writes the themes AND their provenance server-side. */
export async function generateCoursePageThemes(
  courseId: string,
  source: { templateId?: string; runId?: string; overwrite: boolean },
): Promise<ThemeGenerationReceipt> {
  const res = await fetch(
    `/api/courses/${encodeURIComponent(courseId)}/page/generate-themes`,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(source) },
  );
  const body = await readBody<Partial<ThemeGenerationReceipt>>(res);
  if (!res.ok) throw new Error(body?.error || "Couldn't generate the themes.");
  return {
    weeklyThemes: Array.isArray(body?.weeklyThemes) ? body.weeklyThemes : [],
    generated: typeof body?.generated === "number" ? body.generated : 0,
    kept: Array.isArray(body?.kept) ? body.kept : [],
    carriedForward: Array.isArray(body?.carriedForward) ? body.carriedForward : [],
    source: body?.source ?? { kind: "template", id: "", label: "" },
    overwrite: body?.overwrite === true,
  };
}
