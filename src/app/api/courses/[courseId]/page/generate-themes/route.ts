import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { normalizeCourse, normalizeCourseRun, normalizeCourseWeek } from "@/lib/firestore/courses";
import { normalizeCourseTemplate, COURSE_TEMPLATES_COLLECTION } from "@/lib/firestore/courseTemplates";
import {
  COURSE_PAGES_COLLECTION,
  COURSE_PAGE_LIMITS,
  canAuthorCoursePage,
  normalizeCoursePage,
  sanitizeWeeklyThemes,
  type CoursePageTheme,
} from "@/lib/firestore/coursePages";
import { cohortLabel } from "@/lib/courses/cohortLabel";

/**
 * `POST /api/courses/[courseId]/page/generate-themes` — fill the public
 * page's weekly themes from curriculum that already exists.
 *
 * The themes list is the spine of a BlueDot-style course page ("week 3: goal
 * misgeneralisation, and why a model that scores well can still be doing the
 * wrong thing"), and typing it out a second time beside the curriculum it
 * already describes is how the two drift apart. So it is GENERATED from one
 * of two sources and then edited:
 *
 *  - a `courseTemplates` snapshot, which is the right source before any run
 *    of the new term exists; or
 *  - a run's PUBLISHED weeks, which is the right source once the term's
 *    curriculum is being authored on the run itself.
 *
 * `overwrite` defaults to FALSE, and that default is the point. An author
 * writes a blurb for the visitor; the week summary it was generated from is
 * written for the cohort. Regenerating after a curriculum edit must not
 * silently replace the first with the second, so a theme that already has a
 * blurb is KEPT and NAMED in the receipt, and the caller decides.
 *
 * This route is the ONLY writer of `themesSourceTemplateId` /
 * `themesSourceLabel`; the PUT route carries them forward untouched.
 */

type WeekSource = { weekNumber: number; title: string; summary: string };

/** A week's public blurb: its plain-text summary, capped. */
function blurbFor(week: WeekSource): string {
  return week.summary.trim().slice(0, COURSE_PAGE_LIMITS.themeBlurb);
}

export async function POST(
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

  let body: { templateId?: unknown; runId?: unknown; overwrite?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (Boolean(templateId) === Boolean(runId)) {
    return NextResponse.json(
      { error: "Name exactly one source: a template or a run." },
      { status: 400 },
    );
  }
  const overwrite = body.overwrite === true;

  // --- Resolve the source, and check it belongs to THIS course ---
  // Without that check a page could be generated from another course's
  // curriculum and would then advertise weeks nobody on this programme will
  // ever be taught. It is the same check the publish route makes on
  // `showcaseRunId`, for the same reason.
  let weeks: WeekSource[] = [];
  let sourceTemplateId: string | null = null;
  let sourceLabel = "";

  if (templateId) {
    const templateRef = db.collection(COURSE_TEMPLATES_COLLECTION).doc(templateId);
    const templateSnap = await templateRef.get();
    if (!templateSnap.exists) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    const template = normalizeCourseTemplate(templateSnap.id, templateSnap.data() ?? {});
    if (template.courseId !== courseId) {
      return NextResponse.json(
        { error: "That snapshot belongs to a different course." },
        { status: 400 },
      );
    }
    const weekSnap = await templateRef.collection("weeks").get();
    // A snapshot's weeks are staff artefacts and are taken WHOLE, unpublished
    // ones included: a template is the plan for a term that has not started,
    // and filtering it on `published` would drop exactly the weeks an author
    // is trying to describe in advance.
    weeks = weekSnap.docs.map((doc) => {
      const week = normalizeCourseWeek(doc.id, doc.data() ?? {});
      return { weekNumber: week.weekNumber, title: week.title, summary: week.summary };
    });
    sourceTemplateId = template.id;
    sourceLabel = template.label;
  } else {
    const runRef = db.collection("courseRuns").doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
    if (run.courseId !== courseId) {
      return NextResponse.json(
        { error: "That run belongs to a different course." },
        { status: 400 },
      );
    }
    const weekSnap = await runRef.collection("weeks").get();
    // PUBLISHED only. Unpublished weeks are hidden from learners on the run
    // itself, and this generates copy for a page anybody can read.
    weeks = weekSnap.docs
      .map((doc) => normalizeCourseWeek(doc.id, doc.data() ?? {}))
      .filter((week) => week.published)
      .map((week) => ({
        weekNumber: week.weekNumber,
        title: week.title,
        summary: week.summary,
      }));
    sourceTemplateId = null;
    // STAFF-FACING provenance shown in the authoring UI, never on the public
    // page: the structured cohort where the run has one, and only then the
    // free-text label, which V3 stopped showing visitors.
    sourceLabel = cohortLabel(run) || run.label;
  }

  weeks = weeks
    .filter((week) => week.weekNumber >= 1 && week.weekNumber <= COURSE_PAGE_LIMITS.maxWeekNumber)
    .sort((a, b) => a.weekNumber - b.weekNumber)
    .slice(0, COURSE_PAGE_LIMITS.maxWeeklyThemes);

  if (weeks.length === 0) {
    return NextResponse.json(
      { error: "That source has no weeks to generate themes from." },
      { status: 400 },
    );
  }

  // --- Merge against what is already on the page ---
  const pageRef = db.collection(COURSE_PAGES_COLLECTION).doc(courseId);
  const pageSnap = await pageRef.get();
  const page = normalizeCoursePage(courseId, pageSnap.data() ?? {});
  const existingByWeek = new Map(page.weeklyThemes.map((theme) => [theme.weekNumber, theme]));

  const kept: { weekNumber: number; title: string }[] = [];
  const themes: CoursePageTheme[] = weeks.map((week) => {
    const existing = existingByWeek.get(week.weekNumber);
    // "Edited" means "has a blurb". There is no record of what was generated
    // last time, and inventing one (a hash of the source summary, say) would
    // make a curriculum edit look like an author edit. A non-empty blurb is
    // the honest, checkable version of the question.
    if (!overwrite && existing && existing.blurb.trim()) {
      kept.push({ weekNumber: existing.weekNumber, title: existing.title });
      return existing;
    }
    return {
      weekNumber: week.weekNumber,
      // The title follows the blurb: keeping a hand-written title beside a
      // regenerated blurb reads as a mismatch on the page.
      title: week.title.slice(0, COURSE_PAGE_LIMITS.themeTitle),
      blurb: blurbFor(week),
    };
  });

  const weeklyThemes = sanitizeWeeklyThemes(themes);

  await pageRef.set(
    {
      weeklyThemes,
      themesSourceTemplateId: sourceTemplateId,
      themesSourceLabel: sourceLabel.slice(0, COURSE_PAGE_LIMITS.themesSourceLabel),
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
    },
    // MERGE, unlike the PUT: this route owns three fields and must not blank a
    // page an author has already written the rest of.
    { merge: true },
  );

  return NextResponse.json({
    ok: true,
    weeklyThemes,
    /** How many rows this call wrote fresh copy into. */
    generated: weeklyThemes.length - kept.length,
    /** Rows left alone because they already carried an edited blurb. */
    kept,
    source: {
      kind: sourceTemplateId ? "template" : "run",
      id: sourceTemplateId ?? runId,
      label: sourceLabel,
    },
    overwrite,
  });
}
