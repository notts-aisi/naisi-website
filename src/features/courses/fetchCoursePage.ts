import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  COURSE_PAGES_COLLECTION,
  emptyCoursePage,
  normalizeCoursePage,
  toPublicCoursePage,
  type PublicCoursePage,
} from "@/lib/firestore/coursePages";

/**
 * Server-only fetcher for the authored public course page (`fetchCourses.ts`
 * pattern, and the same standing obligation).
 *
 * ## The obligation, restated because this file inherits it
 *
 * This reads through the ADMIN SDK, so Firestore rules provide no defence
 * here. `coursePages` is `allow read: if isSignedIn()` and this function
 * ignores that, deliberately, because the public page is rendered for
 * logged-out visitors. VISIBILITY IS THE CALLER'S TO ENFORCE: a page is only
 * publishable copy when its course is `status === "published"`, and a caller
 * rendering to the world must check that before it renders anything from here.
 * `fetchCourses.ts` already does that check for the course itself, so the
 * public page composes the two.
 *
 * ## What this returns is NARROWER than what is stored
 *
 * The return type is `PublicCoursePage`, which is the stored document minus
 * `themesSourceTemplateId` and `themesSourceLabel`. Those two are staff-facing
 * provenance, not copy: the label may be a run's free-text `label`, which is
 * the exact string V3 stopped showing visitors and which an author may have
 * written for themselves ("Autumn 2026 (pilot, do not publish)"). Stripping
 * them in the fetcher rather than in each renderer makes the omission a type
 * error to undo, so it survives the next component somebody writes.
 *
 * Everything that REMAINS was written to be read by strangers: no uid, no
 * member text and no PII. What over-serving the remainder would leak is the
 * pitch for a programme that has not been announced yet, which is a real thing
 * to avoid on a page whose whole purpose is an announcement, and which is what
 * the published-status check above is for.
 *
 * ## Blocks are sanitised on the way out
 *
 * `normalizeCoursePage` runs `sanitizeCoursePageBlocks` over `pitchBlocks`, so
 * the HTML this hands a renderer has been through the allowlist even if the
 * stored row never was. That is the read half of the both-ends contract in
 * `src/lib/firestore/coursePages.ts` and it is what makes this fetcher safe to
 * point at `dangerouslySetInnerHTML`.
 *
 * A course with no authored page yet returns the EMPTY page rather than null,
 * so the caller renders a course page with fallbacks instead of a 404. Use
 * `coursePageHasContent()` to decide whether it is worth showing.
 */
export async function fetchCoursePage(courseId: string): Promise<PublicCoursePage> {
  const db = getAdminDb();
  if (!db) return toPublicCoursePage(emptyCoursePage(courseId));

  const snap = await db.collection(COURSE_PAGES_COLLECTION).doc(courseId).get();
  if (!snap.exists) return toPublicCoursePage(emptyCoursePage(courseId));
  return toPublicCoursePage(normalizeCoursePage(courseId, snap.data() ?? {}));
}
