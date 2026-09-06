import { SU_PAGE_URL } from "@/content/socials";
import Reveal from "./Reveal";
import ElsewhereCard from "./ElsewhereCard";
import styles from "./ElsewhereRow.module.css";

type Item = {
  platform: string;
  href: string;
  primary: string;
  description: string;
};

const ITEMS: Item[] = [
  {
    platform: "Substack",
    href: "https://nottsaisafety.substack.com",
    primary: "Long-form posts",
    description: "Deeper writing from the committee. Past newsletters live here too.",
  },
  {
    platform: "Linktree",
    href: "https://linktr.ee/nottsaisi",
    primary: "Every link in one place",
    description: "The latest thing we're pointing people at — socials, sign-ups, events.",
  },
  {
    platform: "SU membership",
    href: SU_PAGE_URL,
    primary: "Join the society £6/yr",
    description: "Official SU membership. Gets you on the roster and into society-only events.",
  },
];

export default function ElsewhereRow() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <header className={styles.head}>
          <Reveal variant="mask-wipe" as="h2" className={styles.heading}>
            Elsewhere.
          </Reveal>
          <p className={styles.blurb}>
            Find us off-site. The membership card is the official one.
          </p>
        </header>
        <Reveal variant="spring-overshoot" staggerChildren staggerMs={110} as="ul" className={styles.grid}>
          {ITEMS.map((item) => (
            <li key={item.platform} className={styles.itemWrap}>
              <ElsewhereCard item={item} />
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
