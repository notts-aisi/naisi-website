"use client";

import styles from "./landing.module.css";

/*
  Mobile-only "scroll past the hero" affordance.

  The hero is scroll-locked on coarse pointers (touch-action: none in
  landing.module.css) so a finger drag drives the NN cursor attractor
  instead of scrolling the page. This chevron is the explicit signal
  that to advance past the hero, the user taps here rather than
  swiping the page. Display is gated on pointer: coarse so desktop
  users (who scroll normally) never see it.

  Tap scrolls smoothly to just past the hero section.
*/
export default function HeroScrollChevron() {
  const onTap = () => {
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    if (!hero) return;
    // PublicHeader is position: sticky, so subtract its height so the
    // content under the hero lands just below the header, not behind it.
    const header = document.querySelector<HTMLElement>("header");
    const headerHeight = header?.offsetHeight ?? 0;
    const top = hero.offsetTop + hero.offsetHeight - headerHeight;
    window.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <button
      type="button"
      className={styles.scrollChevron}
      onClick={onTap}
      aria-label="Scroll past the hero"
    >
      <span className={styles.scrollChevronStack}>
        <span className={styles.scrollChevronLabel} aria-hidden="true">
          press me
        </span>
        <span className={styles.scrollChevronInner}>
          <svg
            width="28"
            height="16"
            viewBox="0 0 28 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 2L14 14L26 2"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
    </button>
  );
}
