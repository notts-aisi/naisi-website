"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/*
  Returns inView=true the first time the element scrolls into view, then
  disconnects the observer so there's no ongoing scroll cost.

  Use rootMargin "-10% bottom" so reveals fire slightly before the section
  fully enters the viewport — reads as the page anticipating you, not
  reacting to you.
*/
export function useInViewOnce<T extends HTMLElement>(
  options: IntersectionObserverInit = { rootMargin: "0px 0px -10% 0px", threshold: 0 },
): { ref: RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || inView) return;

    if (typeof IntersectionObserver === "undefined") {
      // Ancient-browser fallback: reveal immediately rather than never.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
          break;
        }
      }
    }, options);

    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, options]);

  return { ref, inView };
}
