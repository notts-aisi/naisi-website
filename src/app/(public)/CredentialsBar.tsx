import AwardBadge from "./AwardBadge";
import Reveal from "./Reveal";
import styles from "./CredentialsBar.module.css";

/*
  Sits right below the stats row. Pairs the NAISI emblem with the
  UONSU Activities Awards "Newcomer of the Year" badge — both are
  identity / credibility signals, so they belong together rather than
  competing for attention in the hero.
*/
export default function CredentialsBar() {
  return (
    <Reveal variant="fade-rise" as="section" className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.emblemWrap} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/naisi-emblem.png"
            alt=""
            className={styles.emblem}
          />
        </div>
        <AwardBadge />
      </div>
    </Reveal>
  );
}
