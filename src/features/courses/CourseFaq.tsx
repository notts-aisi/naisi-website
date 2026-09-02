import type { CoursePageFaq } from "@/lib/firestore/coursePages";
import styles from "./CourseFaq.module.css";

/**
 * The programme page's FAQ.
 *
 * Native `<details>` / `<summary>`, not the shared `ui/Accordion`. Three
 * reasons, and the first is the one that decides it:
 *
 *  1. `Accordion` is a `"use client"` component with controlled open state, so
 *     using it would turn this section into a client island on a page that is
 *     otherwise entirely server-rendered, for a disclosure the platform
 *     implements natively.
 *  2. `<details>` works before hydration and without JavaScript at all, which
 *     on a marketing page reached from a poster QR code on patchy campus
 *     Wi-Fi is the difference between an answer and a stub.
 *  3. Its content is in the document whether or not it is open, so a search
 *     engine indexes the answers.
 *
 * The trade is that the open/close cannot be animated the way the shared
 * accordion animates. On a list of five questions that is a fair price.
 *
 * Questions and answers are TEXT NODES; `white-space: pre-line` keeps the
 * author's paragraph breaks without anything parsing the string.
 */

export default function CourseFaq({ items }: { items: CoursePageFaq[] }) {
  if (items.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="course-faq-heading">
      <h2 id="course-faq-heading" className={styles.heading}>
        Questions people ask
      </h2>
      <div className={styles.list}>
        {items.map((item, i) => (
          <details key={`${item.q}-${i}`} className={styles.item}>
            <summary className={styles.summary}>
              <span className={styles.question}>{item.q}</span>
              <span aria-hidden="true" className={styles.chevron}>
                +
              </span>
            </summary>
            <p className={styles.answer}>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
