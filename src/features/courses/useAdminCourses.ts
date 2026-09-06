"use client";

import { collection, getDocs, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useOneShotList } from "@/features/admin/adminList";
import {
  normalizeCourse,
  normalizeCourseRun,
  normalizeCourseWeek,
  type CourseDoc,
  type CourseRunDoc,
  type CourseWeekDoc,
} from "@/lib/firestore/courses";
import {
  normalizeCourseGroup,
  type CourseGroupDoc,
} from "@/lib/firestore/courseGroups";

/**
 * One-shot admin reads for the course authoring surfaces.
 *
 * `useOneShotList` (not `onSnapshot`) for the same reason the admin lists use
 * it: these are low-churn editorial collections opened by one or two people,
 * and an always-open listener per surface is a standing read cost for no
 * benefit. Every hook returns that hook's shape verbatim —
 * `{ items, loading, refreshing, error, reload }` — so a page can wire the
 * Refresh button straight through after a mutation.
 *
 * No `orderBy` anywhere: Firestore drops docs missing the ordered field, which
 * would silently hide a half-authored draft (CLAUDE.md). Sorting is
 * client-side, on fields that may legitimately be blank.
 */

/** Every course. Sorted newest-touched first, blanks last. */
export function useCourses() {
  return useOneShotList<CourseDoc>(async () => {
    const db = getClientDb();
    const snap = await getDocs(collection(db, "courses"));
    const rows = snap.docs.map((d) => normalizeCourse(d.id, d.data()));
    rows.sort((a, b) => {
      const av = a.updatedAt?.getTime() ?? 0;
      const bv = b.updatedAt?.getTime() ?? 0;
      if (av !== bv) return bv - av;
      return a.title.localeCompare(b.title);
    });
    return rows;
  }, "courses");
}

/**
 * Runs of one course: live ones first (most recent start date first), then the
 * archived ones in the same order. An empty `courseId` resolves to `[]`
 * without a query — the course editor mounts these hooks before it has an id
 * to ask about.
 *
 * ARCHIVED RUNS ARE RETURNED, not filtered — the `useCourseGroups` precedent
 * below, and for the same reason: a soft-archived thing has to be reachable
 * from admin or it can never be brought back, and this hook is the only read
 * of the collection the editor has. What the hook owns is the ORDER, so the
 * list a caller renders by default is the live one and the archived tail is
 * something it can choose to hide behind an affordance (CourseEditor does
 * exactly that). `archived` is orthogonal to `status`, so this partition
 * cannot be expressed as a status sort.
 */
export function useCourseRuns(courseId: string) {
  return useOneShotList<CourseRunDoc>(async () => {
    if (!courseId) return [];
    const db = getClientDb();
    const snap = await getDocs(
      query(collection(db, "courseRuns"), where("courseId", "==", courseId)),
    );
    const rows = snap.docs.map((d) => normalizeCourseRun(d.id, d.data()));
    // startDate is a civil "YYYY-MM-DD" key, so string compare IS date order.
    rows.sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        b.startDate.localeCompare(a.startDate),
    );
    return rows;
  }, `courseRuns:${courseId}`);
}

/**
 * Groups of one run, including archived ones — the run editor shows archived
 * groups greyed out rather than hiding them, so a soft-archived group can be
 * brought back. Callers filter on `archived` for allocation surfaces.
 */
export function useCourseGroups(runId: string) {
  return useOneShotList<CourseGroupDoc>(async () => {
    if (!runId) return [];
    const db = getClientDb();
    const snap = await getDocs(
      query(collection(db, "courseGroups"), where("runId", "==", runId)),
    );
    const rows = snap.docs.map((d) => normalizeCourseGroup(d.id, d.data()));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, `courseGroups:${runId}`);
}

/**
 * A run's authored weeks, in week order. Doc ids are zero-padded ("w01".."w60")
 * so the subcollection already reads in order, but we sort on `weekNumber`
 * anyway — that is the field the curriculum is numbered by, and it survives a
 * clone-forward that preserves ids.
 */
export function useCourseWeeks(runId: string) {
  return useOneShotList<CourseWeekDoc>(async () => {
    if (!runId) return [];
    const db = getClientDb();
    const snap = await getDocs(collection(db, "courseRuns", runId, "weeks"));
    const rows = snap.docs.map((d) => normalizeCourseWeek(d.id, d.data()));
    rows.sort((a, b) => a.weekNumber - b.weekNumber);
    return rows;
  }, `courseWeeks:${runId}`);
}
