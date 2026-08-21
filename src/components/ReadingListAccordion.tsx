"use client";

import { useState } from "react";
import Accordion from "@/components/ui/Accordion";
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
 * The button/panel pair and the `grid-template-rows` collapse come from the
 * shared `Accordion`; this file owns the styling and the panel contents. Open
 * state stays here because the item links need it to leave the tab order while
 * collapsed.
 */
export default function ReadingListAccordion({ list }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <article className={styles.list}>
      <Accordion
        open={open}
        onToggle={() => setOpen((v) => !v)}
        summaryClassName={styles.summary}
        summary={
          <>
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
          </>
        }
      >
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
      </Accordion>
    </article>
  );
}
