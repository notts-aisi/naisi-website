import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { COURSE_TRACK_LABELS } from "@/lib/firestore/courses";
import {
  listPublishedCourses,
  type CourseCatalogueEntry,
} from "@/features/courses/fetchCourses";
import Reveal from "../Reveal";
import styles from "./courses.module.css";

export const metadata: Metadata = {
  title: "Courses",
  description:
    "NAISI's fellowships and reading groups — the full curriculum, week by week, and when applications open.",
};

// Application windows and run statuses change without a deploy, so the
// catalogue is rendered per request rather than cached at build.
export const dynamic = "force-dynamic";

export default async function CourseCataloguePage() {
  const entries = await listPublishedCourses();

  return (
    <section className={styles.page}>
      <div className="container">
        <header className={styles.intro}>
          <Badge>Learn with us</Badge>
          <Reveal variant="mask-wipe" as="h1" className={styles.heading}>
            Courses
          </Reveal>
          <Reveal variant="blur-rise" as="p" className={styles.lede}>
            Our fellowships and reading groups, with the whole curriculum
            readable before you commit to anything. Applications run through
            this site — every course below tells you where it is in that cycle.
          </Reveal>
        </header>

        {entries.length === 0 ? (
          <Card padding="lg">
            <p className={styles.emptyText}>
              No courses are on the catalogue right now. We publish the next
              term&apos;s curriculum a few weeks before applications open —
              check back soon.
            </p>
          </Card>
        ) : (
          <Reveal
            variant="tilt-in"
            staggerChildren
            staggerMs={110}
            as="div"
            className={styles.grid}
          >
            {entries.map((entry) => (
              <CourseCard key={entry.course.id} entry={entry} />
            ))}
          </Reveal>
        )}
      </div>
    </section>
  );
}

function CourseCard({ entry }: { entry: CourseCatalogueEntry }) {
  const { course, openRun } = entry;
  return (
    // Plain next/link, never TransitionLink: the public transition's ~960ms
    // exit choreography is tuned for one-off editorial pages and reads as a
    // broken tap on a grid of cards.
    <Link href={`/courses/${course.id}`} className={styles.cardLink}>
      <Card padding="lg" interactive className={styles.card}>
        <div className={styles.cardTop}>
          <Badge tone="accent">{COURSE_TRACK_LABELS[course.track]}</Badge>
          {course.level ? <span className={styles.level}>{course.level}</span> : null}
        </div>

        <h2 className={styles.cardTitle}>{course.title || "Untitled course"}</h2>
        {course.tagline ? <p className={styles.tagline}>{course.tagline}</p> : null}

        <p className={styles.cardFoot}>
          {course.estimatedWeeklyHours ? (
            <span className={styles.commitment}>
              {formatWeeklyHours(course.estimatedWeeklyHours)}
            </span>
          ) : null}
          <span className={openRun ? styles.stateOpen : styles.stateClosed}>
            {openRun ? `Applications open — ${openRun.label}` : "Next run TBA"}
          </span>
        </p>
      </Card>
    </Link>
  );
}

/** "~5 hrs/week" — a rough commitment figure, phrased as one. */
function formatWeeklyHours(hours: number): string {
  return hours === 1 ? "~1 hr/week" : `~${hours} hrs/week`;
}
