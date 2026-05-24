"use client";

import HeroFieldZeroBase from "./HeroFieldZeroBase";
import { bgRadialDim } from "./heroOptionBg";
import styles from "./landing.module.css";

/*
  Production hero atmosphere — the locked-in vision.

  Big Bang layer-sequential intro into a layered neural network, two
  rounds of single-round inference per cycle with 0s gap, cool-pink
  palette, breathing, per-node random wobble, brightness variation,
  responsive layer count, subtle cursor attractor.

  Wrapper div is intentional. Removing it caused the canvas (which is
  a replaced element) to use its intrinsic 300×150 size on desktop
  instead of stretching via abs positioning. The .heroLayerField div
  provides the abs-positioned containing block that the canvas's
  width:100% / height:100% resolve against.
*/
export default function HeroAtmosphere() {
  return (
    <div aria-hidden="true">
      <div style={bgRadialDim} />
      <div className={`${styles.heroLayer} ${styles.heroLayerField}`}>
        <HeroFieldZeroBase />
      </div>
    </div>
  );
}
