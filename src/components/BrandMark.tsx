import styles from "./BrandMark.module.css";

/*
  NAISI brand mark: the castle + shield + head emblem, optionally followed by
  the "NAISI" wordmark. Every site surface that uses this sits on the dark
  theme, so the emblem is the monochrome white export
  (public/brand/naisi-emblem-white.png). Regenerate brand assets with
  scripts/generate-brand-assets.mjs.
*/

// Intrinsic dimensions of public/brand/naisi-emblem-white.png (391 x 480).
const EMBLEM_ASPECT = 391 / 480;

type Props = {
  /** Rendered emblem height in pixels. */
  size?: number;
  showWordmark?: boolean;
  className?: string;
};

export default function BrandMark({ size = 32, showWordmark = true, className }: Props) {
  return (
    <span className={className ? `${styles.brand} ${className}` : styles.brand}>
      {/* Small static brand asset — a plain <img> matches the rest of the
          codebase and skips next/image's loader for a tiny logo. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/naisi-emblem-white.png"
        alt=""
        width={Math.round(size * EMBLEM_ASPECT)}
        height={size}
        className={styles.emblem}
      />
      {showWordmark && <span className={styles.wordmark}>NAISI</span>}
    </span>
  );
}
