import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { COURSE_TRACK_LABELS } from "@/lib/firestore/courses";
import {
  listPublishedCourses,
  type CourseCatalogueEntry,
} from "@/features/courses/fetchCourses";
import CourseVisual from "@/features/courses/CourseVisual";
import {
  formatRunStartShort,
  formatWindowDate,
  type ApplicationWindowState,
} from "@/lib/courses/window";
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
  const { course, featuredRun, liveRound } = entry;
  const state = liveRound?.state ?? featuredRun?.window.state ?? null;
  const dates = cardDates(entry);
  return (
    // Plain next/link, never TransitionLink: the public transition's ~960ms
    // exit choreography is tuned for one-off editorial pages and reads as a
    // broken tap on a grid of cards.
    <Link href={`/courses/${course.id}`} className={styles.cardLink}>
      <Card padding="lg" interactive className={styles.card}>
        {/* The same seed and cover the course page's hero uses, read in one
            batch by the fetcher, so a course is one picture across the site. */}
        <CourseVisual
          seed={entry.visual.seed}
          track={course.track}
          coverImageUrl={entry.visual.coverImageUrl}
          coverAlt={entry.visual.coverAlt}
          className={styles.visual}
        />

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
          {/* Three tones for three states. "Applications open Mon 21 Sep" is a
              date to plan around, so it must not be painted the same muted
              grey as "Applications closed" and read as a run that is over. */}
          <span className={stateClass(state)}>{applicationState(entry)}</span>
          {/* Shares `.commitment` (muted, tabular numerals) rather than
              growing the stylesheet a near-identical class: it is the same
              kind of line, and `.cardFoot` is already the flex column that
              stacks them. */}
          {dates ? <span className={styles.commitment}>{dates}</span> : null}
        </p>
      </Card>
    </Link>
  );
}

/** Open is live, not-yet is upcoming, everything else is over. */
function stateClass(state: ApplicationWindowState | null): string {
  if (state === "open") return styles.stateOpen;
  if (state === "not-yet") return styles.stateSoon;
  return styles.stateClosed;
}

/**
 * The card's one-line state, keyed on the WINDOW rather than the run's
 * status. Keying on status alone is what put "Applications open" on a card
 * whose deadline had passed and whose form the apply route then refused, and
 * on one whose window had not started yet.
 *
 * The noun changes with the run's `enrolMode`. An open-enrolment run (the
 * pre-course) has no application: telling a fresher they can "apply" to
 * something that admits everybody promises a wait and a decision that are
 * never coming.
 *
 * The run LABEL never appears here. It is an internal handle an admin typed,
 * and "Applications open for wd" is what that reads like in the wild.
 */
function applicationState(entry: CourseCatalogueEntry): string {
  const round = entry.liveRound;
  const found = entry.featuredRun;
  if (!round && !found) return "Next run TBA";
  // An open-enrolment run has no round and never will, so the noun is only
  // ever "Sign-ups" on the run's own window.
  const noun = found?.run.enrolMode === "open" ? "Sign-ups" : "Applications";
  // The ROUND wins when there is one: it is the object people apply to, and
  // its dates are the ones an admin typed. See `CourseCatalogueEntry`.
  const state = round?.state ?? found?.window.state ?? null;
  const opensAt = round ? round.opensAt : (found?.window.opensAt ?? null);
  if (state === "open") return `${noun} open`;
  if (state === "not-yet") {
    return opensAt ? `${noun} open ${formatWindowDate(opensAt)}` : `${noun} open soon`;
  }
  return `${noun} closed`;
}

/**
 * "Applications close Sun 18 Oct · Starts Mon 26 Oct". The two questions
 * every prospective applicant asks, answered on the card rather than only in
 * a confirmation email they have not been sent yet.
 *
 * A closed run drops the deadline: it is no longer something to plan around,
 * and the state line above has already said it has passed.
 */
function cardDates(entry: CourseCatalogueEntry): string {
  const round = entry.liveRound;
  const found = entry.featuredRun;
  if (!round && !found) return "";
  const bits: string[] = [];
  const state = round?.state ?? found?.window.state ?? null;
  const closesAt = round ? round.closesAt : (found?.window.closesAt ?? null);
  if (state !== "closed" && closesAt) {
    const noun = found?.run.enrolMode === "open" ? "Sign-ups" : "Applications";
    bits.push(`${noun} close ${formatWindowDate(closesAt)}`);
  }
  const starts = found ? formatRunStartShort(found.run.startDate) : undefined;
  if (starts) bits.push(`Starts ${starts}`);
  return bits.join(" · ");
}

/** "~5 hrs/week", a rough commitment figure phrased as one. */
function formatWeeklyHours(hours: number): string {
  return hours === 1 ? "~1 hr/week" : `~${hours} hrs/week`;
}
