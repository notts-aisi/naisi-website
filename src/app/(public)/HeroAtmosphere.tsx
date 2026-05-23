"use client";

import { useEffect, useRef } from "react";
import HeroAurora from "./HeroAurora";
import HeroField from "./HeroField";
import HeroSparkles from "./HeroSparkles";
import styles from "./landing.module.css";

/*
  HeroAtmosphere — mounts the three atmosphere layers (aurora shader,
  constellation field, sparkles) inside .hero and toggles
  data-atmosphere-on on the parent so the fade-in transitions kick in.
*/
export default function HeroAtmosphere() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Walk up to the closest .hero ancestor and mark atmosphere on.
    let cur: HTMLElement | null = node.parentElement;
    while (cur && !cur.dataset.hero) cur = cur.parentElement;
    if (cur) {
      // Use a microtask so the initial 0-opacity styles are committed before
      // the transition begins.
      requestAnimationFrame(() => {
        if (cur) cur.dataset.atmosphereOn = "true";
      });
    }
  }, []);

  return (
    <div ref={ref} aria-hidden="true">
      <div className={`${styles.heroLayer} ${styles.heroLayerShader}`}>
        <HeroAurora />
      </div>
      <div className={`${styles.heroLayer} ${styles.heroLayerField}`}>
        <HeroField />
      </div>
      <div className={`${styles.heroLayer} ${styles.heroLayerSparkles}`}>
        <HeroSparkles />
      </div>
    </div>
  );
}
