"use client";

import HeroFieldStaggerCore from "./HeroFieldStaggerCore";
import { PALETTES } from "./heroFieldUtils";

/*
  Zero-gap baseline. 1.8x slow comets, 2 rounds, gap = 0 (back-to-back:
  round 2 fires exactly when round 1's last comet reaches output, no
  visible quiet between rounds). Mouse can spawn comets throughout the
  inference window. After round 2 completes there are ~3.7s of buffer
  for trails to fade fully before dissolve, then 2.8s dissolve. By the
  next Big Bang the canvas is completely clean.

  Phase math (6-layer desktop):
    Crystal           4.2s
    Coalesce pause    1.5s
    Round 1          ~9.9s
    Round 2 (back-to-back) ~9.9s
    Buffer           ~3.7s   (round 2 trails fade + safety)
    Inference tail    2.5s   (no autobursts, mouse-fires still work)
    Dissolve          2.8s   (comets cleared, trails 4x accelerated)
    Total cycle     ~34s
*/
export default function HeroFieldZeroBase() {
  return (
    <HeroFieldStaggerCore
      introMode="bigBang"
      staggerFn={(n) => n.layer * 450 + Math.random() * 200}
      palettePool={[PALETTES.NAISI_COOL_PINK]}
      singleRoundMode
      nodeCoalesce
      breathing
      cometDurationMul={1.8}
      randomWobble
      cometIntensityMin={0.6}
      responsiveLayers
      cursorAttractStrength={0.4}
      phaseCrystalMs={4200}
      phaseStructuredMs={27000}
      phaseDissolveMs={2800}
      coalescePauseMs={1500}
      inferenceTailMs={2500}
      roundsPerCycle={2}
      roundGapMs={0}
    />
  );
}
