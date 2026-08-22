import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  countCourseDestroyTargets,
  courseDestroyBlockers,
  readDestroyMarker,
  readInterruptedDestroy,
  type CourseDestroyCounts,
  type InterruptedDestroyReport,
} from "@/lib/firestore/courseDeletion";
import { normalizeCourse, type CourseStatus } from "@/lib/firestore/courses";

/**
 * The course-level destroy manifest — the run manifest's shape, with the
 * counts a COURSE owns: its live runs (every one a blocker; runs are
 * destroyed one at a time, deliberately, so each run's own manifest names
 * its dead) and the template snapshots whose provenance will be orphaned.
 *
 * Templates are NOT deleted — they are frozen snapshots (v2 decision 2) and
 * a dangling parent link is honest history. The dialog should present
 * `counts.templates` as "snapshots that will lose their parent link", not
 * as casualties.
 *
 * ADMIN ONLY, authorization before existence — same reasoning as the run
 * manifest, and the same two additions: `interrupted` reports a cascade that
 * died mid-page (read through the course's own destroy marker, which names
 * its `courseDeletions` row), a course already mid-destroy reports NO
 * blockers because the engine does not re-evaluate them on a resume, and
 * `?probe=interrupted` answers the interrupted question alone for the
 * mount-time read.
 */

type CourseSubject = {
  id: string;
  title: string;
  status: CourseStatus;
};

export type CourseDestroyManifest = {
  course: CourseSubject;
  counts: CourseDestroyCounts;
  blockers: string[];
  interrupted: InterruptedDestroyReport | null;
};

/** The cheap read: `?probe=interrupted`. No counts, no blockers. */
export type CourseDestroyInterruptedProbe = {
  course: CourseSubject;
  interrupted: InterruptedDestroyReport | null;
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const courseSnap = await db.collection("courses").doc(courseId).get();
  if (!courseSnap.exists) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const raw = courseSnap.data() ?? {};
  const course = normalizeCourse(courseSnap.id, raw);

  if (new URL(req.url).searchParams.get("probe") === "interrupted") {
    const probe: CourseDestroyInterruptedProbe = {
      course: { id: course.id, title: course.title, status: course.status },
      interrupted: await readInterruptedDestroy(db, raw),
    };
    return NextResponse.json(probe);
  }

  const [counts, blockers, interrupted] = await Promise.all([
    countCourseDestroyTargets(db, course),
    readDestroyMarker(raw).destroying
      ? Promise.resolve<string[]>([])
      : courseDestroyBlockers(db, course),
    readInterruptedDestroy(db, raw),
  ]);

  const payload: CourseDestroyManifest = {
    course: { id: course.id, title: course.title, status: course.status },
    counts,
    blockers,
    interrupted,
  };
  return NextResponse.json(payload);
}
