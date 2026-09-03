import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import { CONTACT_EMAIL, SOCIAL_LINKS } from "@/content/socials";
import styles from "./PublicFooter.module.css";

export default function PublicFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.brandBlock}>
          <BrandMark size={28} />
          <p className={styles.tagline}>
            Nottingham AI Safety Initiative. A student community at the University of Nottingham.
          </p>
        </div>
        <nav className={styles.col} aria-label="Site">
          <span className={styles.colTitle}>Site</span>
          <Link href="/courses">Courses</Link>
          <Link href="/members">Members</Link>
          <Link href="/resources">Resources</Link>
          <Link href="/news">News</Link>
          <Link href="/register">Join us</Link>
        </nav>
        <nav className={styles.col} aria-label="Elsewhere">
          <span className={styles.colTitle}>Elsewhere</span>
          {SOCIAL_LINKS.map((s) => (
            <a key={s.label} href={s.href} target="_blank" rel="noreferrer noopener">
              {s.label}
            </a>
          ))}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </nav>
      </div>
      <div className={`container ${styles.meta}`}>
        <span>© {new Date().getFullYear()} NAISI</span>
        <span className={styles.legalLinks}>
          <Link href="/privacy">Privacy</Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms">Terms</Link>
        </span>
        <span>
          Built at Nottingham ·{" "}
          <a
            href="https://github.com/notts-aisi/naisi-website"
            target="_blank"
            rel="noreferrer noopener"
          >
            Source on GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}
