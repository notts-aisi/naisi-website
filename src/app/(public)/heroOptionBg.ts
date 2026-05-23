/*
  Named dark backgrounds for the hero option previews. Mix of solid
  fills, gradients, radial vignettes, and a low-opacity SVG fractal-
  noise texture overlay for variants that want a touch of grain. Each
  returns a React style object intended for an absolutely-positioned
  div behind the variant's canvas.
*/

import type { CSSProperties } from "react";

const NOISE_URL =
  "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.6' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const base = (style: CSSProperties): CSSProperties => ({
  position: "absolute",
  inset: 0,
  ...style,
});

export const bgPureBlack = base({ background: "#000000" });
export const bgNaisiDark = base({ background: "#0a0d1a" });
export const bgDeepMidnight = base({ background: "#040611" });
export const bgNearBlack = base({ background: "#050810" });
export const bgTwilight = base({ background: "linear-gradient(to bottom, #0d1340 0%, #050810 100%)" });
export const bgPolar = base({ background: "linear-gradient(to bottom, #0a1c3a 0%, #050810 100%)" });
export const bgPurpleTwilight = base({ background: "linear-gradient(180deg, #0d1340 0%, #1a0f30 100%)" });
export const bgSapphire = base({ background: "linear-gradient(135deg, #061233 0%, #0a0f24 100%)" });
export const bgPinkDeep = base({ background: "linear-gradient(180deg, #1a0a2a 0%, #050810 100%)" });
export const bgRadialDim = base({ background: "radial-gradient(ellipse at center, #14193a 0%, #050810 70%)" });
export const bgRadialSapphire = base({ background: "radial-gradient(ellipse at center, #1a1f4c 0%, #050810 70%)" });
export const bgRadialPinkHint = base({ background: "radial-gradient(ellipse at center, #2a1140 0%, #050810 70%)" });
export const bgInverseVignette = base({ background: "radial-gradient(ellipse at center, #050810 0%, #14193a 100%)" });

const withNoise = (style: CSSProperties): CSSProperties => ({
  ...style,
  backgroundImage: `${NOISE_URL}, ${style.background ?? "none"}`,
  backgroundRepeat: "repeat, no-repeat",
  backgroundSize: "220px 220px, cover",
});

export const bgNaisiDarkNoise = withNoise(base({ background: "#0a0d1a" }));
export const bgDeepMidnightNoise = withNoise(base({ background: "#040611" }));
export const bgTwilightNoise = withNoise(base({ background: "linear-gradient(to bottom, #0d1340 0%, #050810 100%)" }));
export const bgRadialDimNoise = withNoise(base({ background: "radial-gradient(ellipse at center, #14193a 0%, #050810 70%)" }));
