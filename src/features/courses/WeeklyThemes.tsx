import Link from "next/link";
import type { CoursePageTheme } from "@/lib/firestore/coursePages";
import styles from "./WeeklyThemes.module.css";

/**
 * The week-by-week shape of the programme, as AUTHORED copy.
 *
 * This is what replaced the old public curriculum accordion. The accordion
 * showed the real week documents, which sounds better and read worse: a
 * visitor deciding whether to spend seven weeks on this does not want fourteen
 * expandable rows of reading links, they want to know what week 3 is ABOUT.
 * The real material is still one click away on the sample week and on each
 * week's public page; this list is the pitch.
 *
 * `weeklyThemes` is generated from a template snapshot or a run's published
 * weeks (`POST /api/courses/[courseId]/page/generate-themes`) and then edited,
 * so it starts truthful and stays the author's.
 *
 * Titles and blurbs are TEXT NODES. See `CourseFactsRail` for the rule.
 *
 * A theme whose week is PUBLISHED links to that week's page. The list is the
 * pitch and the week pages are the evidence for it, and until this existed the
 * only way from one to the other was the sample-week section, which shows a
 * single week: a reader who wanted to check week 6 before applying had no
 * route to it but the URL bar. A week with no published page stays plain text
 * rather than becoming a link to a 404.
 */

type Props = {
  themes: CoursePageTheme[];
  /** The course, for the week links. */
  courseId: string;
  /**
   * The week numbers with a public page, from the same published-only fetcher
   * the week pages use. Anything absent renders as plain text, so this list is
   * what stops the pitch linking at a 404.
   */
  publishedWeeks?: number[];
  /**
   * The pre-start note: the plan is the core content, a facilitator may tweak
   * their group's week, and reading ahead is welcome. Rendered under the list
   * because it qualifies what the list is, and a reader who has not seen the
   * list yet has nothing to qualify.
   */
  note?: string;
};

export default function WeeklyThemes({
  themes,
  courseId,
  publishedWeeks = [],
  note,
}: Props) {
  if (themes.length === 0) return null;
  const published = new Set(publishedWeeks);

  return (
    <section className={styles.section} aria-labelledby="weekly-themes-heading">
      <h2 id="weekly-themes-heading" className={styles.heading}>
        Week by week
      </h2>
      <ol className={styles.list}>
        {themes.map((theme) => {
          const title = theme.title || "To be confirmed";
          const href = published.has(theme.weekNumber)
            ? `/courses/${encodeURIComponent(courseId)}/weeks/${theme.weekNumber}`
            : null;
          return (
            <li key={theme.weekNumber} className={styles.item}>
              <span className={styles.week}>Week {theme.weekNumber}</span>
              <div className={styles.body}>
                {/* The heading stays the heading and the link sits INSIDE it,
                    so the outline a screen reader builds is unchanged and the
                    link text is the week's own title rather than "read more".
                    The week number is named in the accessible name too: out of
                    the list's visual order, "Goal misgeneralisation" alone does
                    not say which week it is. */}
                <h3 className={styles.title}>
                  {href ? (
                    <Link
                      href={href}
                      className={styles.titleLink}
                      aria-label={`Week ${theme.weekNumber}: ${title}`}
                    >
                      {title}
                    </Link>
                  ) : (
                    title
                  )}
                </h3>
                {theme.blurb ? <p className={styles.blurb}>{theme.blurb}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {note ? <p className={styles.note}>{note}</p> : null}
    </section>
  );
}
