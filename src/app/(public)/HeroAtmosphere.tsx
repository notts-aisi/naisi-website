"use client";

import HeroFieldZeroBase from "./HeroFieldZeroBase";
import { bgRadialDim } from "./heroOptionBg";

/*
  Production hero atmosphere — the locked-in vision.

  Big Bang layer-sequential intro into a layered neural network, two
  rounds of single-round inference per cycle with 0s gap (back-to-back),
  cool-pink palette, breathing, per-node random wobble, brightness
  variation, responsive layer count, subtle cursor attractor.

  Returns a fragment with two direct children of the parent .hero
  section: the dark radial backdrop and the HeroFieldZeroBase canvas.
  No wrapper div, no data-atmosphere-on dance. iOS WebKit was leaving
  the canvas invisible in some configurations when there was an
  unpositioned wrapper between the .hero section and the abs-positioned
  layer that the canvas lived in — removing the wrapper makes both the
  bg div and the canvas siblings of .heroInner, all anchored directly
  off .hero's position: relative.
*/
export default function HeroAtmosphere() {
  return (
    <>
      <div style={bgRadialDim} aria-hidden="true" />
      <HeroFieldZeroBase />
    </>
  );
}
