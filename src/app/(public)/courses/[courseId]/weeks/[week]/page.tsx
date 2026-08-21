import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import Card from "@/components/ui/Card";
import WeekCurriculum from "@/features/courses/WeekCurriculum";
import {
  getPublicWeek,
  getPublishedCourse,
} from "@/features/courses/fetchCourses";
import styles from "./week.module.css";

/**
 * Public curriculum for one week of a course. Logged-out readable by design —
 * the full syllabus IS the marketing. Served by the Admin SDK through
 * `fetchCourses` (the fetchEvents.ts house pattern): no public Firestore read
 * rules exist for courses, because `allow read` grants `list` and draft weeks
 * must never be world-listable.
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ courseId: string; week: string }> };

/**
 * Week segment is a bare week NUMBER ("3"), not the `wNN` doc id — the doc id
 * is an implementation detail of `courseRuns/{runId}/weeks/{wNN}` and the URL
 * should survive a copy-forward to a new run.
 */
function parseWeekNumber(raw: string): number | null {
  if (!/^[1-9]\d{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 60 ? n : null;
}

// `cache` dedupes between generateMetadata and the render body — both run in
// the same request, and neither should pay for the fetch twice.
const loadWeek = cache(async (courseId: string, weekNumber: number) =>
  getPublicWeek(courseId, weekNumber),
);

const loadCourse = cache(async (courseId: string) => getPublishedCourse(courseId));

function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { courseId, week } = await params;
  const weekNumber = parseWeekNumber(week);
  if (weekNumber === null) return { title: "Week not found" };

  const data = await loadWeek(courseId, weekNumber);
  if (!data) return { title: "Week not found" };

  const base = `${data.course.title} — Week ${data.week.weekNumber}`;
  const title = data.week.title ? `${base}: ${data.week.title}` : base;
  const description = data.week.summary || data.course.tagline || undefined;

  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicCourseWeekPage({ params }: Props) {
  const { courseId, week } = await params;
  const weekNumber = parseWeekNumber(week);
  if (weekNumber === null) notFound();

  const data = await loadWeek(courseId, weekNumber);
  // Unknown course, unpublished course, unpublished week, or a week number
  // that isn't in the run's plan — all one 404, no existence oracle.
  if (!data) notFound();

  const { course, run, week: weekDoc, totalWeeks } = data;

  // Neighbour arrows come from the course's PUBLISHED week list: a week with
  // no public page gets no link to it. Deliberately a second fetcher call —
  // `getPublicWeek` returns one week, and this page needs to know whether the
  // weeks either side have public pages at all.
  const publishedWeeks = (await loadCourse(courseId))?.weeks ?? [];
  const prev =
    publishedWeeks.find((w) => w.weekNumber === weekDoc.weekNumber - 1) ?? null;
  const next =
    publishedWeeks.find((w) => w.weekNumber === weekDoc.weekNumber + 1) ?? null;

  return (
    <article className={styles.page}>
      <div className="container">
        <div className={styles.inner}>
          <Link href={`/courses/${courseId}`} className={styles.breadcrumb}>
            <span className={styles.crumbArrow} aria-hidden="true">
              ←
            </span>
            <span>{course.title}</span>
          </Link>

          <header className={styles.header}>
            <p className={styles.eyebrow}>
              {totalWeeks > 0
                ? `Week ${weekDoc.weekNumber} of ${totalWeeks}`
                : `Week ${weekDoc.weekNumber}`}
              {run.label ? ` · ${run.label}` : ""}
            </p>
            <h1 className={styles.title}>
              {weekDoc.title || `Week ${weekDoc.weekNumber}`}
            </h1>
            {weekDoc.summary && <p className={styles.lede}>{weekDoc.summary}</p>}
            {weekDoc.estimatedMinutes ? (
              <p className={styles.timeNote}>
                About {formatMinutes(weekDoc.estimatedMinutes)} of material this week.
              </p>
            ) : null}
          </header>

          <WeekCurriculum week={weekDoc} />

          {(prev || next) && (
            <nav className={styles.weekNav} aria-label="Week navigation">
              {prev && (
                <Link
                  href={`/courses/${courseId}/weeks/${prev.weekNumber}`}
                  className={`${styles.navLink} ${styles.navPrev}`}
                >
                  <span className={styles.navKicker}>
                    <span className={styles.navArrow} aria-hidden="true">
                      ←
                    </span>
                    Week {prev.weekNumber}
                  </span>
                  <span className={styles.navTitle}>
                    {prev.title || `Week ${prev.weekNumber}`}
                  </span>
                </Link>
              )}
              {next && (
                <Link
                  href={`/courses/${courseId}/weeks/${next.weekNumber}`}
                  className={`${styles.navLink} ${styles.navNext}`}
                >
                  <span className={styles.navKicker}>
                    Week {next.weekNumber}
                    <span className={styles.navArrow} aria-hidden="true">
                      →
                    </span>
                  </span>
                  <span className={styles.navTitle}>
                    {next.title || `Week ${next.weekNumber}`}
                  </span>
                </Link>
              )}
            </nav>
          )}

          <Card padding="lg" className={styles.cta}>
            <p className={styles.ctaTitle}>Want to do this with a cohort?</p>
            <p className={styles.ctaBody}>
              Weekly sessions with a trained facilitator, a small group, and
              people to argue with. Applications run through the course page.
            </p>
            <Link href={`/courses/${courseId}`} className={styles.ctaLink}>
              See the course page
              <span className={styles.ctaArrow} aria-hidden="true">
                →
              </span>
            </Link>
          </Card>
        </div>
      </div>
    </article>
  );
}
