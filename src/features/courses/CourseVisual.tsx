import type { CourseTrack } from "@/lib/firestore/courses";
import styles from "./CourseVisual.module.css";

/**
 * THE GENERATED PER-TRACK VISUAL.
 *
 * Every course gets artwork without anybody having to make any. The picture is
 * a pure function of two stored values, the page's `visualSeed` and the
 * course's `track`, so it is stable across renders, identical on the server
 * and the client (no hydration mismatch, no `useId`), and re-rollable by an
 * author typing a new seed.
 *
 * ## Why generated rather than an image
 *
 * Three reasons, in order of how much they cost when ignored:
 *
 *  1. A course with no cover image still has to look like something. The
 *     catalogue is a grid, and a grid of text blocks reads as an unfinished
 *     admin list rather than as a programme worth applying to.
 *  2. There is no image to host, resize, ship or forget the alt text on. This
 *     is inline SVG in the document: no request, no layout shift, no external
 *     asset for the CSP to allow, nothing to regenerate when the brand script
 *     runs.
 *  3. It themes. Every colour is a token, so light mode and any future palette
 *     swap come free, which a baked PNG does not.
 *
 * ## The cover override
 *
 * An author who HAS a picture wins: `coverImageUrl` replaces the generated
 * composition entirely, rendered as a plain `<img>` (never `next/image` — see
 * the repo note; the default import resolves to an object under the Turbopack
 * production build). It requires `coverAlt`, which the write route enforces,
 * because an image with no alternative text is announced as nothing on a page
 * whose whole job is explaining a programme.
 *
 * The generated composition, by contrast, is DECORATIVE: `aria-hidden`, no
 * title, no role. It carries no information the surrounding copy does not, and
 * announcing "abstract pattern of circles" to a screen reader on every card is
 * noise, not access.
 */

type Props = {
  /**
   * `coursePages.visualSeed`. Callers pass the course id when the field is
   * empty, so a page nobody has authored still gets a stable composition
   * rather than the same one as every other unauthored course.
   */
  seed: string;
  track: CourseTrack;
  /** Author's own artwork. Wins outright when present. */
  coverImageUrl?: string | null;
  /** Required alongside `coverImageUrl`; ignored without one. */
  coverAlt?: string;
  /** `hero` is the wide banner, `card` the catalogue tile. */
  size?: "hero" | "card";
  className?: string;
};

/**
 * FNV-1a over the seed. A hash rather than a character sum because two seeds
 * that differ by a letter must not produce two pictures that differ by a
 * pixel: "autumn-2026" and "autumn-2027" are exactly the pair an author will
 * try, and they have to look unrelated.
 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and identical on every runtime. */
function rng(state: number): () => number {
  let a = state || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACK_CLASS: Record<CourseTrack, string> = {
  technical: styles.technical,
  governance: styles.governance,
  general: styles.general,
};

/** The drawing surface. A 3:2 field, cropped by CSS at either size. */
const W = 420;
const H = 280;

export default function CourseVisual({
  seed,
  track,
  coverImageUrl,
  coverAlt,
  size = "card",
  className,
}: Props) {
  const wrap = [
    styles.visual,
    size === "hero" ? styles.hero : styles.card,
    TRACK_CLASS[track],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (coverImageUrl) {
    return (
      <div className={wrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverImageUrl} alt={coverAlt ?? ""} className={styles.cover} />
      </div>
    );
  }

  const hash = hashSeed(`${seed || "naisi"}::${track}`);
  const next = rng(hash);

  // A gradient id has to be unique in the document (two courses on the
  // catalogue would otherwise share one definition and one of them would win),
  // and it has to be the same string on the server and in the browser. The
  // hash is both.
  const gradientId = `cv-grad-${hash.toString(36)}`;

  // Three rings, drifting off the right edge. The composition is deliberately
  // off-centre: a centred bullseye reads as a loading spinner.
  const rings = Array.from({ length: 3 }, (_, i) => ({
    cx: W * (0.62 + next() * 0.22),
    cy: H * (0.3 + next() * 0.4),
    r: 46 + i * (30 + next() * 26),
    width: 1 + next() * 1.4,
  }));

  // A jittered dot field on the left, thinning as it goes right, so the eye
  // travels from the text side of the card toward the rings.
  const dots: { x: number; y: number; r: number }[] = [];
  for (let col = 0; col < 7; col += 1) {
    for (let row = 0; row < 5; row += 1) {
      // Thinning: later columns drop out more often.
      if (next() < col / 9) continue;
      dots.push({
        x: 24 + col * 38 + (next() - 0.5) * 14,
        y: 30 + row * 52 + (next() - 0.5) * 16,
        r: 1.3 + next() * 2.2,
      });
    }
  }

  // One trace across the field: six points, monotonic in x, so it reads as a
  // path through the material rather than as a scribble.
  const trace = Array.from({ length: 6 }, (_, i) => {
    const x = 12 + (i * (W - 24)) / 5;
    const y = H * (0.25 + next() * 0.5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <div className={wrap}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" className={styles.stopStart} />
            <stop offset="100%" className={styles.stopEnd} />
          </linearGradient>
        </defs>
        <rect width={W} height={H} fill={`url(#${gradientId})`} />
        {dots.map((d, i) => (
          <circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r} className={styles.dot} />
        ))}
        <polyline points={trace} className={styles.trace} />
        {rings.map((ring, i) => (
          <circle
            key={`r${i}`}
            cx={ring.cx}
            cy={ring.cy}
            r={ring.r}
            className={styles.ring}
            strokeWidth={ring.width}
          />
        ))}
      </svg>
    </div>
  );
}
