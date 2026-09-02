import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import BlockView from "@/features/events/BlockView";
import { COURSE_TRACK_LABELS, type CourseTrack } from "@/lib/firestore/courses";
import {
  getCourseRunSet,
  getPublishedCourse,
  type RunWindow,
} from "@/features/courses/fetchCourses";
import {
  fetchLiveRoundForRuns,
  type CourseLiveRound,
} from "@/features/courses/fetchLiveRound";
import { fetchCoursePage } from "@/features/courses/fetchCoursePage";
import type { PublicCoursePage } from "@/lib/firestore/coursePages";
import { cohortLabel } from "@/lib/courses/cohortLabel";
import { londonDateKey } from "@/lib/courses/weekPlan";
import {
  formatPastWindowDate,
  formatRunStartShort,
  formatWindowDate,
  formatWindowDeadline,
} from "@/lib/courses/window";
import CourseCTA, {
  type CourseCTARound,
  type CourseCTARun,
} from "@/features/courses/CourseCTA";
import CourseFactsRail, {
  type CourseFact,
  type CourseNote,
} from "@/features/courses/CourseFactsRail";
import CourseFaq from "@/features/courses/CourseFaq";
import CourseVisual from "@/features/courses/CourseVisual";
import JourneyStrip from "@/features/courses/JourneyStrip";
import WeeklyThemes from "@/features/courses/WeeklyThemes";
import WeekCurriculum from "@/features/courses/WeekCurriculum";
import {
  fetchGroupPicker,
  type GroupPickerOption,
} from "@/features/courses/fetchGroupPicker";
import Reveal from "../../Reveal";
import styles from "./course.module.css";

/**
 * THE PUBLIC PROGRAMME PAGE.
 *
 * Built on `coursePages/{courseId}` (the authored pitch) plus the course, its
 * runs and the admission round that places people onto them. Three rules
 * decide almost everything below:
 *
 * 1. THE ROUND OWNS THE DATES. `courseRuns.admissionRoundIds` does not exist
 *    yet, so the live round is derived at read time by asking which rounds
 *    name one of this course's runs (`fetchLiveRound.ts`). When one exists,
 *    the CTA points at `/apply/[roundId]` and every date on the page comes
 *    from the round. When none does, the page falls back to the run's own
 *    application window, or to the enrolment window and the session picker
 *    for an open-enrolment pre-course. Two objects naming the same deadline is
 *    the drift V3 exists to stop, so exactly one of them is read per render.
 *
 * 2. NO RAW `run.label` REACHES A VISITOR. The cohort is named by
 *    `cohortLabel(run)` and by nothing else. `run.label` survives on the
 *    document for admin lists; a run with no structured cohort simply gets no
 *    chip, because falling back to the admin handle is what the formatter
 *    exists to prevent.
 *
 * 3. ONE dangerouslySetInnerHTML, AND IT IS `BlockView`. The pitch blocks are
 *    authored copy, sanitised at the write end by the page route and again at
 *    the read end by `normalizeCoursePage`. Every other string on this page
 *    (themes, FAQ, journey labels, the facts rail) is a text node.
 *
 * The sample week renders through `WeekCurriculum` with NO optional props, so
 * its byte-identical public contract holds and the week page and this page
 * cannot drift apart. `tests/course-programme-page.test.mjs` pins that.
 */

// Run status, the round's window and the published-week set all change without
// a deploy, so the page is rendered per request rather than cached at build.
export const dynamic = "force-dynamic";

/**
 * The social card. No generated OG image route: `next/og`'s `ImageResponse`
 * would be this repo's first, it needs a font shipped with it to render
 * anything but a system fallback, and the win over the brand lockup on a page
 * whose share is almost always a link in a group chat is small. The per-track
 * difference lives in the TITLE and the DESCRIPTION, which is the part a
 * reader actually reads.
 */
const OG_IMAGE = "/brand/naisi-lockup.png";

/** The one-line pitch under the title, per track, when nothing is authored. */
const TRACK_BLURB: Record<CourseTrack, string> = {
  technical:
    "A technical AI safety programme at the University of Nottingham: read the full plan, week by week, before you apply.",
  governance:
    "An AI governance programme at the University of Nottingham: read the full plan, week by week, before you apply.",
  general:
    "An AI safety programme at the University of Nottingham: read the full plan, week by week, before you apply.",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ courseId: string }>;
}): Promise<Metadata> {
  const { courseId } = await params;
  const found = await getPublishedCourse(courseId);
  if (!found) return { title: "Course not found" };
  const page = await fetchCoursePage(courseId);
  const title = found.course.title || "Course";
  const description =
    page.headline.trim()
    || found.course.tagline
    || TRACK_BLURB[found.course.track];
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: page.coverImageUrl || OG_IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [page.coverImageUrl || OG_IMAGE],
    },
  };
}

export default async function PublicCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  // Independent reads go together. An unpublished course throws the other two
  // away, which is cheaper than serialising them on every hit.
  const [found, runSet, page] = await Promise.all([
    getPublishedCourse(courseId),
    getCourseRunSet(courseId),
    fetchCoursePage(courseId),
  ]);
  // A draft or unknown course is a 404 either way, so a draft URL leaks
  // nothing about whether the course exists.
  if (!found) notFound();

  // `showcaseRun` is deliberately not destructured: the page names its cohort
  // from the APPLICATION run (the one people are joining), and the showcase
  // run's only job here is having supplied `weeks`.
  const { course, weeks } = found;
  const applicationRun = runSet.featuredRun;
  // The round can only be asked for once the run ids are known: the join runs
  // backwards from `outcomeRunIds` until PR17 adds the forward pointer.
  const round = await fetchLiveRoundForRuns(runSet.runIds);

  // Dates are formatted HERE, on the server, in Europe/London. The CTA is a
  // client island, and formatting a Nottingham deadline in the visitor's own
  // timezone is how someone reads "closes Sat 17 Oct" and applies a day late.
  const ctaRun = toCTARun(applicationRun);
  const ctaRound = toCTARound(round);

  // OPEN-ENROLMENT runs put the session picker on this page, so the slots are
  // fetched with the page rather than by the client island: a signed-out
  // visitor sees the timetable in the first paint, and the projection stays on
  // the server where `fetchGroupPicker` can guarantee what leaves it
  // (`courseGroups` carries meeting links and facilitator uids).
  const pickerGroups: GroupPickerOption[] =
    ctaRun && ctaRun.enrolMode === "open" && ctaRun.state !== "inactive"
      ? await fetchGroupPicker(ctaRun.id)
      : [];

  const cohort = cohortLabel(applicationRun?.run ?? null);
  const meta = [
    course.level,
    page.weeklyHoursText.trim()
      || (course.estimatedWeeklyHours
        ? formatWeeklyHours(course.estimatedWeeklyHours)
        : ""),
    weeks.length ? `${weeks.length} ${weeks.length === 1 ? "week" : "weeks"}` : "",
  ].filter(Boolean);

  // The pitch: the authored blocks when there are any, else the course's own
  // introduction, so a course whose page nobody has written yet still reads
  // like a page rather than like a stub.
  const pitchBlocks =
    page.pitchBlocks.length > 0 ? page.pitchBlocks : course.summaryBlocks;

  const sampleWeek = pickSampleWeek(page, weeks);
  const todayKey = londonDateKey(new Date());

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
          <div className={styles.heroChips}>
            <Badge tone="accent">{COURSE_TRACK_LABELS[course.track]}</Badge>
            {cohort ? <span className={styles.cohort}>{cohort}</span> : null}
          </div>
          <Reveal variant="mask-wipe" as="h1" className={styles.title}>
            {course.title || "Untitled course"}
          </Reveal>
          {page.headline.trim() || course.tagline ? (
            <Reveal variant="blur-rise" as="p" className={styles.tagline}>
              {page.headline.trim() || course.tagline}
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

          <CourseVisual
            seed={page.visualSeed || course.id}
            track={course.track}
            coverImageUrl={page.coverImageUrl}
            coverAlt={page.coverAlt}
            size="hero"
            className={styles.visual}
          />

          <CourseCTA
            courseId={course.id}
            courseTitle={course.title}
            run={ctaRun}
            round={ctaRound}
            groups={pickerGroups}
            placement="hero"
          />
        </header>

        <CourseFactsRail
          facts={buildFacts(page, round, applicationRun)}
          notes={buildNotes(page)}
        />

        {pitchBlocks.length > 0 ? (
          <section className={styles.summary}>
            <BlockView blocks={pitchBlocks} />
          </section>
        ) : null}

        <WeeklyThemes themes={page.weeklyThemes} note={PRE_START_NOTE} />

        {sampleWeek ? (
          <section className={styles.sample}>
            <Reveal variant="mask-wipe" as="h2" className={styles.sectionTitle}>
              A sample week
            </Reveal>
            <p className={styles.sectionBlurb}>
              Week {sampleWeek.weekNumber} in full, exactly as the cohort reads
              it. Every other week is published too.
            </p>
            {/* NO optional props. `WeekCurriculum` renders its public output
                only when every render prop is absent, and that output is the
                diff-frozen contract the week page also depends on. */}
            <WeekCurriculum week={sampleWeek} />
            <p className={styles.sampleMore}>
              <Link
                href={`/courses/${course.id}/weeks/${sampleWeek.weekNumber}`}
                className={styles.sampleLink}
              >
                Open week {sampleWeek.weekNumber} on its own page
                <span aria-hidden="true" className={styles.arrow}>
                  →
                </span>
              </Link>
            </p>
          </section>
        ) : null}

        <JourneyStrip
          steps={page.journey}
          todayKey={todayKey}
          dateLabels={page.journey.map((step) =>
            step.dateKey ? (formatRunStartShort(step.dateKey) ?? "") : "",
          )}
        />

        <CourseFaq items={page.faq} />

        <CourseCTA
          courseId={course.id}
          courseTitle={course.title}
          run={ctaRun}
          round={ctaRound}
          groups={pickerGroups}
          placement="foot"
        />
      </div>
    </article>
  );
}

/**
 * The pre-start note, shown under the weekly themes.
 *
 * Owner decision (decisions.md, section B7): before a run starts, show the
 * core content and say plainly that a facilitator may tweak their group's
 * week, so reading ahead is welcome rather than wasted. It is deliberately
 * hard-coded rather than authored: it is a promise the platform makes about
 * how the weeks behave, not copy about this particular course.
 */
const PRE_START_NOTE =
  "This is the core plan for the course. Facilitators may adjust their own group's week, so a few readings can change before you get there. Everything above is open to read ahead, and we would rather you did.";

/** "~5 hrs/week", a rough commitment figure phrased as one. */
function formatWeeklyHours(hours: number): string {
  return hours === 1 ? "~1 hr/week" : `~${hours} hrs/week`;
}

/**
 * Which week the "sample of the course" section renders: the authored
 * `sampleWeekNumber` when it names a published week, else the first published
 * week, else nothing.
 *
 * The fallback matters more than it looks: `sampleWeekNumber` is authored
 * against a curriculum that is still being written, so it routinely names a
 * week that is not published yet. Rendering nothing in that case would remove
 * the section from the page silently, which is exactly what an author cannot
 * see from the editor.
 */
function pickSampleWeek<T extends { weekNumber: number }>(
  page: PublicCoursePage,
  weeks: T[],
): T | null {
  if (weeks.length === 0) return null;
  if (page.sampleWeekNumber !== null) {
    const named = weeks.find((w) => w.weekNumber === page.sampleWeekNumber);
    if (named) return named;
  }
  return weeks[0];
}

/**
 * The facts rail's short answers. Dates come from the ROUND when there is one
 * and from the run otherwise, decided here rather than in the component so
 * there is one place to read for "which object is speaking".
 */
function buildFacts(
  page: PublicCoursePage,
  round: CourseLiveRound | null,
  run: RunWindow | null,
): CourseFact[] {
  const opensAt = round ? round.opensAt : (run?.window.opensAt ?? null);
  const closesAt = round ? round.closesAt : (run?.window.closesAt ?? null);
  const state = round?.state ?? run?.window.state ?? null;
  const past = state === "closed";
  const openMode = run?.run.enrolMode === "open";
  const noun = openMode ? "Sign-ups" : "Applications";

  return [
    { label: "Format", value: page.formatText },
    { label: "Sessions", value: page.sessionsText },
    { label: "Weekly hours", value: page.weeklyHoursText },
    {
      label: `${noun} open`,
      value: opensAt ? formatWindowDate(opensAt) : "",
    },
    {
      label: `${noun} close`,
      value: closesAt
        ? past
          ? formatPastWindowDate(closesAt)
          : formatWindowDeadline(closesAt)
        : "",
    },
    {
      label: "Decisions by",
      value: round?.decisionsByDate
        ? (formatRunStartShort(round.decisionsByDate) ?? "")
        : "",
    },
    {
      label: "Starts",
      value: run ? (formatRunStartShort(run.run.startDate) ?? "") : "",
    },
  ];
}

/** The facts rail's prose half. Empty fields are dropped by the component. */
function buildNotes(page: PublicCoursePage): CourseNote[] {
  return [
    { label: "Who it is for", body: page.whoItIsFor },
    { label: "How we select", body: page.howSelectionWorks },
    { label: "Membership", body: page.membershipExpectation },
  ];
}

/**
 * Flatten a run plus its window into the props the client CTA takes, with
 * every date already rendered in Europe/London.
 *
 * A LIVE deadline carries its TIME ("Sun 18 Oct, 23:59"), because the minute
 * it falls on is the thing an applicant plans around. A PASSED one carries its
 * year instead ("Sun 18 Oct 2026"): the minute no longer matters, and without
 * the year a run from a previous autumn reads as one you have just missed. A
 * start date needs neither, since its time is a group's session slot and is
 * told to them after allocation.
 */
function toCTARun(found: RunWindow | null): CourseCTARun | null {
  if (!found) return null;
  const { run, window } = found;
  const past = window.state === "closed";
  return {
    id: run.id,
    // The structured cohort, never the admin label. See rule 2 at the top.
    cohortLabel: cohortLabel(run),
    state: window.state,
    // `window` came from `courseRunWindow()`, so on an open-mode run its state
    // is the ENROLMENT window, not the application one. The CTA needs the mode
    // to know which of the two it is describing.
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

/** The same flattening for the round, whose state can never be `inactive`. */
function toCTARound(round: CourseLiveRound | null): CourseCTARound | null {
  if (!round || round.state === "inactive") return null;
  const past = round.state === "closed";
  return {
    id: round.id,
    state: round.state,
    opensOn: round.opensAt ? formatWindowDate(round.opensAt) : null,
    closesOn: round.closesAt
      ? past
        ? formatPastWindowDate(round.closesAt)
        : formatWindowDeadline(round.closesAt)
      : null,
    decisionsOn: round.decisionsByDate
      ? (formatRunStartShort(round.decisionsByDate) ?? null)
      : null,
  };
}
