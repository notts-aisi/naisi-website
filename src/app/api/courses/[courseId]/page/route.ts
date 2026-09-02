import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { normalizeCourse } from "@/lib/firestore/courses";
import {
  COURSE_PAGES_COLLECTION,
  COURSE_PAGE_LIMITS,
  canAuthorCoursePage,
  normalizeCoursePage,
  sanitizeCoursePageBlocks,
  sanitizeFaq,
  sanitizeJourney,
  sanitizeWeeklyThemes,
} from "@/lib/firestore/coursePages";
import { isValidDateKey } from "@/lib/courses/weekPlan";

/**
 * `PUT /api/courses/[courseId]/page` — the ONLY writer of `coursePages`.
 *
 * `coursePages` is `allow write: if false`. See the collection's module
 * comment (`src/lib/firestore/coursePages.ts`) and the rules block for the
 * reason it is routes-only rather than client-direct like `courses`: the
 * pitch blocks render through `dangerouslySetInnerHTML` on a logged-out page,
 * `sanitizeBlocks` is a shape filter rather than an HTML sanitiser, and two
 * write paths cannot enforce one sanitisation.
 *
 * FULL REPLACE, not a patch. The editor holds the whole page and sends the
 * whole page back, so a partial write here would mean a field the editor
 * failed to send silently keeping an old value the author thought they had
 * cleared. The two exceptions are the provenance pair, which is carried
 * forward from the stored document whatever the body says: they are written
 * only by the generate-themes route, on the same argument that makes
 * `courseRuns.templateId` server-owned. Provenance the editor can also type is
 * not provenance.
 */

/** Reject a string field that is over its cap, naming it. Empty is fine. */
function stringField(
  raw: unknown,
  field: string,
  max: number,
): { value: string } | { error: string } {
  if (raw === undefined || raw === null) return { value: "" };
  if (typeof raw !== "string") return { error: `${field} must be text.` };
  if (raw.length > max) {
    return { error: `${field} must be ${max} characters or fewer.` };
  }
  return { value: raw };
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { courseId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const courseSnap = await db.collection("courses").doc(courseId).get();
  if (!courseSnap.exists) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const course = normalizeCourse(courseSnap.id, courseSnap.data() ?? {});

  if (!canAuthorCoursePage(actor, course)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // --- Plain-text fields, each capped and named in its own error ---
  const textFields: [keyof typeof COURSE_PAGE_LIMITS, string][] = [
    ["headline", "Headline"],
    ["whoItIsFor", "Who it is for"],
    ["howSelectionWorks", "How selection works"],
    ["membershipExpectation", "Membership expectation"],
    ["formatText", "Format"],
    ["sessionsText", "Sessions"],
    ["weeklyHoursText", "Weekly hours"],
    ["coverAlt", "Cover image description"],
    ["visualSeed", "Visual seed"],
  ];
  const text: Record<string, string> = {};
  for (const [key, label] of textFields) {
    const result = stringField(body[key], label, COURSE_PAGE_LIMITS[key] as number);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    text[key] = result.value;
  }

  // --- Cover image ---
  const coverRaw = body.coverImageUrl;
  if (coverRaw !== undefined && coverRaw !== null && typeof coverRaw !== "string") {
    return NextResponse.json(
      { error: "Cover image URL must be a link or null." },
      { status: 400 },
    );
  }
  const coverImageUrl =
    typeof coverRaw === "string" && coverRaw.trim() ? coverRaw.trim() : null;
  if (coverImageUrl && coverImageUrl.length > COURSE_PAGE_LIMITS.coverImageUrl) {
    return NextResponse.json({ error: "That cover image URL is too long." }, { status: 400 });
  }
  // An image with no alternative text is an image a screen reader announces as
  // nothing on a page whose job is to explain a programme.
  if (coverImageUrl && !text.coverAlt.trim()) {
    return NextResponse.json(
      { error: "A cover image needs a short description for screen readers." },
      { status: 400 },
    );
  }

  // --- Arrays. Each sanitiser is the same one the read path runs, so what is
  // stored and what is later read cannot disagree about shape. A caller whose
  // list is over the cap is TOLD, rather than silently truncated: a page that
  // quietly loses its twenty-first week is worse than one that refuses. ---
  if (body.pitchBlocks !== undefined && !Array.isArray(body.pitchBlocks)) {
    return NextResponse.json({ error: "pitchBlocks must be a list." }, { status: 400 });
  }
  if (
    Array.isArray(body.pitchBlocks)
    && body.pitchBlocks.length > COURSE_PAGE_LIMITS.maxPitchBlocks
  ) {
    return NextResponse.json(
      { error: `The pitch may have at most ${COURSE_PAGE_LIMITS.maxPitchBlocks} blocks.` },
      { status: 400 },
    );
  }
  if (Array.isArray(body.weeklyThemes)
    && body.weeklyThemes.length > COURSE_PAGE_LIMITS.maxWeeklyThemes) {
    return NextResponse.json(
      { error: `At most ${COURSE_PAGE_LIMITS.maxWeeklyThemes} weekly themes.` },
      { status: 400 },
    );
  }
  if (Array.isArray(body.faq) && body.faq.length > COURSE_PAGE_LIMITS.maxFaq) {
    return NextResponse.json(
      { error: `At most ${COURSE_PAGE_LIMITS.maxFaq} FAQ entries.` },
      { status: 400 },
    );
  }
  if (Array.isArray(body.journey) && body.journey.length > COURSE_PAGE_LIMITS.maxJourney) {
    return NextResponse.json(
      { error: `At most ${COURSE_PAGE_LIMITS.maxJourney} journey steps.` },
      { status: 400 },
    );
  }
  // A journey step's date is a civil "YYYY-MM-DD". `2026-02-31` matches the
  // shape and is not a day, and the strip marks the current step by comparing
  // date keys, so a shape-only check would silently mark the wrong step.
  if (Array.isArray(body.journey)) {
    for (const step of body.journey) {
      const dateKey = (step as { dateKey?: unknown } | null)?.dateKey;
      if (dateKey !== undefined && dateKey !== null && dateKey !== "") {
        if (typeof dateKey !== "string" || !isValidDateKey(dateKey)) {
          return NextResponse.json(
            { error: "Journey dates must be real YYYY-MM-DD dates." },
            { status: 400 },
          );
        }
      }
    }
  }

  const pitchBlocks = sanitizeCoursePageBlocks(body.pitchBlocks);
  const weeklyThemes = sanitizeWeeklyThemes(body.weeklyThemes);
  const faq = sanitizeFaq(body.faq);
  const journey = sanitizeJourney(body.journey);

  // --- Sample week ---
  const sampleRaw = body.sampleWeekNumber;
  let sampleWeekNumber: number | null = null;
  if (sampleRaw !== undefined && sampleRaw !== null && sampleRaw !== "") {
    if (typeof sampleRaw !== "number" || !Number.isFinite(sampleRaw)) {
      return NextResponse.json(
        { error: "The sample week must be a week number." },
        { status: 400 },
      );
    }
    const n = Math.floor(sampleRaw);
    if (n < 1 || n > COURSE_PAGE_LIMITS.maxWeekNumber) {
      return NextResponse.json(
        { error: `The sample week must be between 1 and ${COURSE_PAGE_LIMITS.maxWeekNumber}.` },
        { status: 400 },
      );
    }
    sampleWeekNumber = n;
  }

  // --- Provenance carried forward, never taken from the body ---
  const pageRef = db.collection(COURSE_PAGES_COLLECTION).doc(courseId);
  const existingSnap = await pageRef.get();
  const existing = normalizeCoursePage(courseId, existingSnap.data() ?? {});

  // Built once, written once, echoed once: the response is the same object
  // the next read will normalise, so the editor never has to guess what the
  // sanitisers did to what it sent.
  const stored = {
    headline: text.headline,
    pitchBlocks,
    whoItIsFor: text.whoItIsFor,
    howSelectionWorks: text.howSelectionWorks,
    membershipExpectation: text.membershipExpectation,
    formatText: text.formatText,
    sessionsText: text.sessionsText,
    weeklyHoursText: text.weeklyHoursText,
    weeklyThemes,
    sampleWeekNumber,
    faq,
    journey,
    coverImageUrl,
    coverAlt: text.coverAlt,
    visualSeed: text.visualSeed,
    themesSourceTemplateId: existing.themesSourceTemplateId,
    themesSourceLabel: existing.themesSourceLabel,
  };

  await pageRef.set({
    ...stored,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: actor.uid,
  });

  return NextResponse.json({
    ok: true,
    page: normalizeCoursePage(courseId, { ...stored, updatedByUid: actor.uid }),
  });
}
