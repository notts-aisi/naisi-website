/*
  Shared utilities for the hero-field option family.

  Palettes are matplotlib sequences sampled at five stops. The full
  256-stop tables would be more faithful but five stops with smoothstep
  interpolation reads identically at canvas resolutions and keeps the
  bundle lean.
*/

export type RGB = { r: number; g: number; b: number };

export const VIRIDIS: RGB[] = [
  { r: 0x44, g: 0x01, b: 0x54 },
  { r: 0x3b, g: 0x52, b: 0x8b },
  { r: 0x21, g: 0x90, b: 0x8c },
  { r: 0x5e, g: 0xc9, b: 0x62 },
  { r: 0xfd, g: 0xe7, b: 0x25 },
];

export const PLASMA: RGB[] = [
  { r: 0x0d, g: 0x08, b: 0x87 },
  { r: 0x6a, g: 0x00, b: 0xa8 },
  { r: 0xb1, g: 0x2a, b: 0x90 },
  { r: 0xe1, g: 0x6b, b: 0x46 },
  { r: 0xf0, g: 0xf9, b: 0x21 },
];

export const INFERNO: RGB[] = [
  { r: 0x00, g: 0x00, b: 0x04 },
  { r: 0x42, g: 0x07, b: 0x5b },
  { r: 0x99, g: 0x26, b: 0x6a },
  { r: 0xeb, g: 0x6e, b: 0x1d },
  { r: 0xfc, g: 0xff, b: 0xa4 },
];

export const MAGMA: RGB[] = [
  { r: 0x00, g: 0x00, b: 0x04 },
  { r: 0x3b, g: 0x0f, b: 0x70 },
  { r: 0x8c, g: 0x29, b: 0x81 },
  { r: 0xde, g: 0x4f, b: 0x68 },
  { r: 0xfc, g: 0xfd, b: 0xbf },
];

export const CIVIDIS: RGB[] = [
  { r: 0x00, g: 0x20, b: 0x4c },
  { r: 0x36, g: 0x49, b: 0x6f },
  { r: 0x66, g: 0x6a, b: 0x73 },
  { r: 0xa0, g: 0x91, b: 0x60 },
  { r: 0xfd, g: 0xea, b: 0x45 },
];

/**
 * NAISI cold palette. Lifted from the site's tokens.css spine
 * (#0a0d1a background, #6a82ff accent, #5fd1e8 cyan) and extended
 * into a 5-stop sequence that mirrors viridis structurally but stays
 * inside a blue->cyan->cool-white range. Useful when the matplotlib
 * palettes feel too warm against the dark NAISI theme.
 */
export const NAISI_COLD: RGB[] = [
  { r: 0x0a, g: 0x0d, b: 0x1a },
  { r: 0x1f, g: 0x2c, b: 0x5c },
  { r: 0x4a, g: 0x65, b: 0xc8 },
  { r: 0x6a, g: 0x82, b: 0xff },
  { r: 0xbc, g: 0xe8, b: 0xf5 },
];

/**
 * NAISI blue + soft pink, kept tight: a deep indigo base, NAISI accent,
 * a transition stop, and pink highlights. The pink reads as warmth but
 * sits next to the blue without going purple-gradient-AI-slop.
 */
export const NAISI_PINK: RGB[] = [
  { r: 0x0a, g: 0x0d, b: 0x1a },
  { r: 0x3a, g: 0x44, b: 0x88 },
  { r: 0x6a, g: 0x82, b: 0xff },
  { r: 0xc8, g: 0x6f, b: 0xff },
  { r: 0xff, g: 0xa8, b: 0xd0 },
];

/**
 * NAISI cool pink. Four NAISI-blue stops (dark indigo through accent
 * blue) and one soft pink terminal at the brightest end. Comets
 * sampling hues 0.55-0.85 land squarely in blue territory; only the
 * brightest highlights (0.85+) pick up pink. The pink reads as an
 * accent rather than a dominant hue.
 */
export const NAISI_COOL_PINK: RGB[] = [
  { r: 0x0a, g: 0x0d, b: 0x1a },
  { r: 0x1f, g: 0x2c, b: 0x5c },
  { r: 0x4a, g: 0x65, b: 0xc8 },
  { r: 0x6a, g: 0x82, b: 0xff },
  { r: 0xff, g: 0xb8, b: 0xd8 },
];

/**
 * NAISI aurora: deep indigo through NAISI blue, cyan, lavender, soft
 * pink. Five distinct hues, all cold-leaning except the pink terminal.
 * The five-stop gradient reads as actual variation, not a single hue.
 */
export const NAISI_AURORA: RGB[] = [
  { r: 0x0a, g: 0x0d, b: 0x1a },
  { r: 0x4a, g: 0x65, b: 0xc8 },
  { r: 0x5f, g: 0xd1, b: 0xe8 },
  { r: 0xb0, g: 0xa0, b: 0xff },
  { r: 0xff, g: 0xb0, b: 0xdb },
];

export const PALETTES = { VIRIDIS, PLASMA, INFERNO, MAGMA, CIVIDIS, NAISI_COLD, NAISI_PINK, NAISI_COOL_PINK, NAISI_AURORA };

export function sample(palette: RGB[], t: number): RGB {
  const tt = Math.max(0, Math.min(0.999, t));
  const segs = palette.length - 1;
  const i = Math.floor(tt * segs);
  const f = tt * segs - i;
  const a = palette[i];
  const b = palette[i + 1];
  // Smoothstep on the local segment param so colour bands don't pop.
  const k = f * f * (3 - 2 * f);
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  };
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// Depth-band constants reused across all field options.
// 0 = far (small, dim, slow), 1 = mid, 2 = near (large, bright, fast).
export const Z_SIZE = [0.65, 1.0, 1.55];
export const Z_ALPHA = [0.36, 0.62, 0.92];
export const Z_PARALLAX = [0.35, 0.7, 1.2];

export function pickZBand(rand: number): 0 | 1 | 2 {
  return rand < 0.25 ? 0 : rand < 0.78 ? 1 : 2;
}

/**
 * Soft horizontal exclusion band centered at y/height = 0.5. Returns 1
 * outside the band and dips to (1 - maxDim) at the band center using a
 * smoothstep falloff. Used to keep the headline area legible without a
 * hard mask cutout.
 */
export function exclusionFactor(
  y: number,
  height: number,
  halfHeight = 0.16,
  maxDim = 0.72,
  centerY = 0.50,
): number {
  const yNorm = y / height;
  const offset = Math.abs(yNorm - centerY);
  if (offset > halfHeight) return 1;
  const t = offset / halfHeight;
  const smooth = t * t * (3 - 2 * t);
  return 1 - maxDim * (1 - smooth);
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// V2 helpers used by the staggered-crystal + path-trail family of options.

/** Brightness floor so every node is at least faintly visible at rest. */
export const NODE_BASE_BRIGHTNESS = 0.42;

/**
 * Per-second multiplicative decay for edge "lit" trails. 0.30 gives a ~4-5s
 * visual half-life, long enough that a 4-layer inference path stays mostly
 * visible from start to finish. 0.55 gives ~8s for long-lingering variants.
 */
export const EDGE_TRAIL_DECAY_PER_S_DEFAULT = 0.30;
export const EDGE_TRAIL_DECAY_PER_S_LONG = 0.55;

/** Cubic ease-out — no overshoot, gentle deceleration. */
export function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

/** Quintic ease-out — even gentler, almost imperceptible final motion. */
export function easeOutQuint(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 5);
}
