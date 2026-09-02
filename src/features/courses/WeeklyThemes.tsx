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
 */

type Props = {
  themes: CoursePageTheme[];
  /**
   * The pre-start note: the plan is the core content, a facilitator may tweak
   * their group's week, and reading ahead is welcome. Rendered under the list
   * because it qualifies what the list is, and a reader who has not seen the
   * list yet has nothing to qualify.
   */
  note?: string;
};

export default function WeeklyThemes({ themes, note }: Props) {
  if (themes.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="weekly-themes-heading">
      <h2 id="weekly-themes-heading" className={styles.heading}>
        Week by week
      </h2>
      <ol className={styles.list}>
        {themes.map((theme) => (
          <li key={theme.weekNumber} className={styles.item}>
            <span className={styles.week}>Week {theme.weekNumber}</span>
            <div className={styles.body}>
              <h3 className={styles.title}>{theme.title || "To be confirmed"}</h3>
              {theme.blurb ? <p className={styles.blurb}>{theme.blurb}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {note ? <p className={styles.note}>{note}</p> : null}
    </section>
  );
}
