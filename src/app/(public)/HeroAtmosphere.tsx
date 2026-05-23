"use client";

import { useEffect, useRef } from "react";
import HeroFieldZeroBase from "./HeroFieldZeroBase";
import { bgRadialDim } from "./heroOptionBg";
import styles from "./landing.module.css";

/*
  Production hero atmosphere — the locked-in vision.

  Big Bang layer-sequential intro into a layered neural network, two
  rounds of single-round inference per cycle with 0s gap (back-to-back),
  cool-pink palette (NAISI blue with pink only at the brightest stop),
  breathing, per-node random wobble, brightness variation, responsive
  layer count (4 / 5 / 6 by viewport width), subtle cursor attractor
  with envelope-fading so it never bugs the layer entry/exit.

  Rendering is one canvas on a dark radial backdrop. No aurora cloud
  layer, no sparkles layer — those were earlier iterations and read as
  clutter against the neural-network animation.

  The wrapping div toggles data-atmosphere-on on the closest .hero
  ancestor so the existing fade-in CSS still kicks in once the canvas
  is mounted.
*/
export default function HeroAtmosphere() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cur: HTMLElement | null = node.parentElement;
    while (cur && !cur.dataset.hero) cur = cur.parentElement;
    if (cur) {
      requestAnimationFrame(() => {
        if (cur) cur.dataset.atmosphereOn = "true";
      });
    }
  }, []);

  return (
    <div ref={ref} aria-hidden="true">
      <div style={bgRadialDim} />
      <div className={`${styles.heroLayer} ${styles.heroLayerField}`}>
        <HeroFieldZeroBase />
      </div>
    </div>
  );
}
