import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import socials from "@/content/socials.json";
import styles from "./PublicFooter.module.css";

export default function PublicFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.brandBlock}>
          <BrandMark size={28} />
          <p className={styles.tagline}>
            Nottingham AI Safety Initiative — a student community at the University of Nottingham.
          </p>
        </div>
        <nav className={styles.col} aria-label="Site">
          <span className={styles.colTitle}>Site</span>
          <Link href="/members">Members</Link>
          <Link href="/resources">Resources</Link>
          <Link href="/news">News</Link>
          <Link href="/register">Join us</Link>
        </nav>
        <nav className={styles.col} aria-label="Elsewhere">
          <span className={styles.colTitle}>Elsewhere</span>
          {socials.socials.map((s) => (
            <a key={s.label} href={s.href} target="_blank" rel="noreferrer noopener">
              {s.label}
            </a>
          ))}
          <a href={`mailto:${socials.contactEmail}`}>{socials.contactEmail}</a>
        </nav>
      </div>
      <div className={`container ${styles.meta}`}>
        <span>© {new Date().getFullYear()} NAISI</span>
        <span>Built at Nottingham · Designed to be re-themed easily</span>
      </div>
    </footer>
  );
}
