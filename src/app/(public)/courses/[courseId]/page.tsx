import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import BlockView from "@/features/events/BlockView";
import { COURSE_TRACK_LABELS } from "@/lib/firestore/courses";
import {
  getApplicationRunForCourse,
  getPublishedCourse,
  type RunWindow,
} from "@/features/courses/fetchCourses";
import {
  formatPastWindowDate,
  formatRunStartShort,
  formatWindowDate,
  formatWindowDeadline,
} from "@/lib/courses/window";
import CourseCTA, { type CourseCTARun } from "@/features/courses/CourseCTA";
import {
  fetchGroupPicker,
  type GroupPickerOption,
} from "@/features/courses/fetchGroupPicker";
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
  const [found, applicationRun] = await Promise.all([
    getPublishedCourse(courseId),
    getApplicationRunForCourse(courseId),
  ]);
  // A draft or unknown course is a 404 either way, so a draft URL leaks
  // nothing about whether the course exists.
  if (!found) notFound();

  const { course, showcaseRun, weeks } = found;
  // Formatted HERE, on the server, in Europe/London. The CTA is a client
  // island; formatting a Nottingham deadline in the visitor's own timezone is
  // how someone reads "closes Sat 17 Oct" and applies a day late.
  const ctaRun = toCTARun(applicationRun);

  // OPEN-ENROLMENT runs put the session picker on this page, so the slots are
  // fetched with the page rather than by the client island: a signed-out
  // visitor sees the timetable in the first paint, and the projection stays
  // on the server where `fetchGroupPicker` can guarantee what leaves it
  // (`courseGroups` carries meeting links and facilitator uids). One extra
  // read, and only for a run that actually needs it.
  const pickerGroups: GroupPickerOption[] =
    ctaRun && ctaRun.enrolMode === "open" && ctaRun.state !== "inactive"
      ? await fetchGroupPicker(ctaRun.id)
      : [];

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

          <CourseCTA
            courseId={course.id}
            courseTitle={course.title}
            run={ctaRun}
            groups={pickerGroups}
            placement="hero"
          />
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
          {/* Only when there IS a curriculum. With no published weeks this
              blurb and WeekAccordion's own empty state were two consecutive
              sentences saying the same thing to the same reader; the
              accordion's is the one that stays, because it sits where the
              weeks would have been. */}
          {weeks.length > 0 ? (
            <p className={styles.sectionBlurb}>
              Every week, in full, before you apply. Expand a week to see what
              you&apos;d read and watch.
              {showcaseRun ? ` This is the ${showcaseRun.label} curriculum.` : ""}
            </p>
          ) : null}
          <WeekAccordion courseId={course.id} weeks={weeks} />
        </section>

        <CourseCTA
          courseId={course.id}
          courseTitle={course.title}
          run={ctaRun}
          groups={pickerGroups}
          placement="foot"
        />
      </div>
    </article>
  );
}

/** "~5 hrs/week", a rough commitment figure phrased as one. */
function formatWeeklyHours(hours: number): string {
  return hours === 1 ? "~1 hr/week" : `~${hours} hrs/week`;
}

/**
 * Flatten a run plus its window into the props the client CTA takes, with
 * every date already rendered in Europe/London.
 *
 * A LIVE deadline carries its TIME ("Sun 18 Oct, 23:59"), because the minute
 * it falls on is the thing an applicant plans around. A PASSED one carries
 * its year instead ("Sun 18 Oct 2026"): the minute no longer matters, and
 * without the year a run from a previous autumn reads as one you have just
 * missed. A start date needs neither, since its time is a group's session
 * slot and is told to them after allocation.
 */
function toCTARun(found: RunWindow | null): CourseCTARun | null {
  if (!found) return null;
  const { run, window } = found;
  const past = window.state === "closed";
  return {
    id: run.id,
    label: run.label,
    state: window.state,
    // `window` came from `courseRunWindow()`, so on an open-mode run its
    // state is the ENROLMENT window, not the application one. The CTA needs
    // the mode to know which of the two it is describing.
    enrolMode: run.enrolMode,
    streams: run.streams,
    opensOn: window.opensAt ? formatWindowDate(window.opensAt) : null,
    closesOn: window.closesAt
      ? past
        ? formatPastWindowDate(window.closesAt)
        : formatWindowDeadline(window.closesAt)
      : null,
    startsOn: formatRunStartShort(run.startDate) ?? null,
  };
}
