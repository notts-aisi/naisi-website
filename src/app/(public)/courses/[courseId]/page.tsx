import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import BlockView from "@/features/events/BlockView";
import { COURSE_TRACK_LABELS } from "@/lib/firestore/courses";
import {
  getOpenRunForCourse,
  getPublishedCourse,
} from "@/features/courses/fetchCourses";
import CourseCTA from "@/features/courses/CourseCTA";
import WeekAccordion from "@/features/courses/WeekAccordion";
import Reveal from "../../Reveal";
import styles from "./course.module.css";

// Run status and the published-week set change without a deploy, so the page
// is rendered per request rather than cached at build.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ courseId: string }>;
}): Promise<Metadata> {
  const { courseId } = await params;
  const found = await getPublishedCourse(courseId);
  if (!found) return { title: "Course not found" };
  return {
    title: found.course.title || "Course",
    description:
      found.course.tagline ||
      `${found.course.title} — a NAISI course. Read the full curriculum before you apply.`,
  };
}

export default async function PublicCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  // Both reads are independent — an unpublished course throws away the run
  // read, which is cheaper than serialising them on every hit.
  const [found, openRun] = await Promise.all([
    getPublishedCourse(courseId),
    getOpenRunForCourse(courseId),
  ]);
  // A draft or unknown course is a 404 either way, so a draft URL leaks
  // nothing about whether the course exists.
  if (!found) notFound();

  const { course, showcaseRun, weeks } = found;
  const ctaRun = openRun ? { id: openRun.id, label: openRun.label } : null;

  const meta = [
    course.level,
    course.estimatedWeeklyHours ? formatWeeklyHours(course.estimatedWeeklyHours) : "",
    weeks.length ? `${weeks.length} ${weeks.length === 1 ? "week" : "weeks"}` : "",
  ].filter(Boolean);

  return (
    <article className={styles.page}>
      <div className="container">
        <p className={styles.breadcrumb}>
          <Link href="/courses" className={styles.breadcrumbLink}>
            <span aria-hidden="true" className={styles.backArrow}>
              ←
            </span>
            All courses
          </Link>
        </p>

        <header className={styles.hero}>
          <Badge tone="accent">{COURSE_TRACK_LABELS[course.track]}</Badge>
          <Reveal variant="mask-wipe" as="h1" className={styles.title}>
            {course.title || "Untitled course"}
          </Reveal>
          {course.tagline ? (
            <Reveal variant="blur-rise" as="p" className={styles.tagline}>
              {course.tagline}
            </Reveal>
          ) : null}
          {meta.length > 0 ? (
            <p className={styles.meta}>
              {meta.map((bit, i) => (
                <span key={bit}>
                  {i > 0 ? (
                    <span aria-hidden="true" className={styles.metaDot}>
                      ·
                    </span>
                  ) : null}
                  {bit}
                </span>
              ))}
            </p>
          ) : null}

          <CourseCTA courseId={course.id} openRun={ctaRun} placement="hero" />
        </header>

        {course.summaryBlocks.length > 0 ? (
          <section className={styles.summary}>
            <BlockView blocks={course.summaryBlocks} />
          </section>
        ) : null}

        <section className={styles.curriculum}>
          <Reveal variant="mask-wipe" as="h2" className={styles.sectionTitle}>
            Curriculum
          </Reveal>
          <p className={styles.sectionBlurb}>
            {weeks.length > 0
              ? "Every week, in full, before you apply. Expand a week to see what you'd read and watch."
              : "The week-by-week plan goes up here as it's finalised."}
            {showcaseRun && weeks.length > 0
              ? ` This is the ${showcaseRun.label} curriculum.`
              : ""}
          </p>
          <WeekAccordion courseId={course.id} weeks={weeks} />
        </section>

        <CourseCTA courseId={course.id} openRun={ctaRun} placement="foot" />
      </div>
    </article>
  );
}

/** "~5 hrs/week" — a rough commitment figure, phrased as one. */
function formatWeeklyHours(hours: number): string {
  return hours === 1 ? "~1 hr/week" : `~${hours} hrs/week`;
}
