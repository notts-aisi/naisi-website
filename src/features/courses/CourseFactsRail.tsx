import styles from "./CourseFactsRail.module.css";

/**
 * The facts rail on the public programme page: the eight or so questions a
 * prospective applicant asks before reading a word of the pitch.
 *
 * ## Two shapes, deliberately
 *
 * SHORT facts (format, sessions, weekly hours, the dates) are a scannable
 * grid: they are answered in a phrase and a reader compares them across two
 * courses in an open tab each. LONG notes (who it is for, how selection works,
 * what membership is expected) are prose the author wrote in sentences, and
 * squeezing four hundred words into a grid cell is how a page stops being read.
 *
 * ## Every string here is a TEXT NODE
 *
 * The values come from `coursePages`, which is authored by a course drafter
 * and sanitised at both ends, but this component still renders plain text
 * only. The one surface on this page allowed to emit HTML is `BlockView`, for
 * the pitch blocks. Prose keeps its authored line breaks through
 * `white-space: pre-line` in the stylesheet rather than through any parsing
 * here, which is the version that cannot grow an injection.
 */

export type CourseFact = {
  label: string;
  /** Falsy values are dropped by the caller-facing filter below. */
  value: string;
};

export type CourseNote = {
  label: string;
  body: string;
};

type Props = {
  facts: CourseFact[];
  notes: CourseNote[];
};

export default function CourseFactsRail({ facts, notes }: Props) {
  const shown = facts.filter((f) => f.value.trim());
  const prose = notes.filter((n) => n.body.trim());
  if (shown.length === 0 && prose.length === 0) return null;

  return (
    <section className={styles.rail} aria-labelledby="course-facts-heading">
      <h2 id="course-facts-heading" className={styles.heading}>
        The essentials
      </h2>

      {shown.length > 0 && (
        <dl className={styles.grid}>
          {shown.map((fact) => (
            <div key={fact.label} className={styles.cell}>
              <dt className={styles.term}>{fact.label}</dt>
              <dd className={styles.value}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {prose.length > 0 && (
        <div className={styles.notes}>
          {prose.map((note) => (
            <div key={note.label} className={styles.note}>
              <h3 className={styles.noteTitle}>{note.label}</h3>
              <p className={styles.noteBody}>{note.body}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
