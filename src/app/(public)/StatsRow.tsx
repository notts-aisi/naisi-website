import DigitRoll from "./DigitRoll";
import Reveal from "./Reveal";
import { STATS } from "@/content/stats";
import styles from "./StatsRow.module.css";

/*
  StatsRow — small editorial strip of quantitative substance directly
  below the hero. Numbers roll into place via DigitRoll; section heading
  wipes in with a mask sweep.

  Empty STATS array → section returns null.
*/
export default function StatsRow() {
  if (STATS.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <Reveal variant="mask-wipe" as="h2" className={styles.heading}>
          By the numbers.
        </Reveal>
        <dl className={styles.grid}>
          {STATS.map((s) => (
            <div key={s.label} className={styles.stat}>
              <dt className={styles.value}>
                <DigitRoll value={s.value} />
              </dt>
              <dd className={styles.label}>{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
