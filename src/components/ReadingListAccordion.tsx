"use client";

import { useId, useState } from "react";
import type { ReadingList } from "@/content/readingLists";
import styles from "./ReadingListAccordion.module.css";

type Props = {
  list: ReadingList;
};

/**
 * One item in the homepage's "Where to start" accordion. Collapsed by
 * default. Clicking the header (or focusing it and pressing space/enter)
 * toggles the items panel open.
 *
 * Animation: a `grid-template-rows` transition between `0fr` and `1fr`.
 * That's the modern, content-height-aware pattern (no max-height guess
 * needed). Browsers without that support fall back to instant toggle, no
 * code path required since the property quietly degrades.
 *
 * Accessibility: rendered as a real `<button>` with `aria-expanded` and
 * `aria-controls`, panel uses `role="region"` and is hidden from a11y
 * tree when collapsed. Honors `prefers-reduced-motion` (animation off).
 */
export default function ReadingListAccordion({ list }: Props) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const panelId = `reading-list-${list.slug}-${reactId}`;

  return (
    <article className={styles.list}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.summaryText}>
          <span className={styles.summaryTitle}>{list.title}</span>
          <span className={styles.summaryBlurb}>{list.blurb}</span>
        </span>
        <span
          className={`${styles.indicator} ${open ? styles.indicatorOpen : ""}`}
          aria-hidden="true"
        >
          {/* Chevron drawn with two lines so the rotation is centred and
              looks like a single element when paused mid-animation. */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 5 L7 9 L11 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-hidden={!open}
        className={`${styles.panel} ${open ? styles.panelOpen : ""}`}
      >
        <div className={styles.panelInner}>
          <ul className={styles.items}>
            {list.items.map((item) => (
              <li key={item.href} className={styles.item}>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={styles.itemLink}
                  // Make the links unfocusable when the panel is collapsed
                  // so tab order does not include them. They become tabbable
                  // again on open.
                  tabIndex={open ? 0 : -1}
                >
                  {item.title}
                </a>
                {item.source ? (
                  <span className={styles.itemSource}>{item.source}</span>
                ) : null}
                {item.blurb ? (
                  <p className={styles.itemBlurb}>{item.blurb}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
