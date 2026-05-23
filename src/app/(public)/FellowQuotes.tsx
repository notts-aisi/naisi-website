import { FELLOW_QUOTES } from "@/content/fellowQuotes";
import styles from "./FellowQuotes.module.css";

/*
  FellowQuotes — short pull-quotes from past fellows. Dev-only until
  content is collected; gated by NEXT_PUBLIC_HOMEPAGE_PREVIEW_SECTIONS.
*/
export default function FellowQuotes() {
  const dev = process.env.NEXT_PUBLIC_HOMEPAGE_PREVIEW_SECTIONS === "true";
  if (!dev || FELLOW_QUOTES.length === 0) return null;

  return (
    <ul className={styles.list}>
      {FELLOW_QUOTES.map((q, i) => (
        <li key={i} className={styles.item}>
          <blockquote className={styles.quote}>&ldquo;{q.quote}&rdquo;</blockquote>
          <p className={styles.attribution}>— {q.attribution}</p>
        </li>
      ))}
    </ul>
  );
}
