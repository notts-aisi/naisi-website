import {
  COVER_STRIP_SIZE_DEFAULT,
  type CoverBranding,
  type CoverLogoColor,
} from "@/lib/firestore/events";
import styles from "./CoverImage.module.css";

const EMBLEM_SRC: Record<CoverLogoColor, string> = {
  white: "/brand/naisi-emblem-white.png",
  colour: "/brand/naisi-emblem.png",
};

/**
 * An event cover image with the optional NAISI emblem treatment overlaid.
 * Shared by the public/preview event page (EventDetailView) and the editor's
 * cover-branding picker, so the picker preview is exactly what ships.
 */
export default function CoverImage({
  url,
  alt,
  branding,
  logoColor = "white",
  stripSize = COVER_STRIP_SIZE_DEFAULT,
}: {
  url: string;
  alt: string;
  branding: CoverBranding;
  /** Emblem asset to overlay. Defaults to the white emblem. */
  logoColor?: CoverLogoColor;
  /** Gradient-strip height as a percent of the cover. Strip treatment only. */
  stripSize?: number;
}) {
  const emblemSrc = EMBLEM_SRC[logoColor];

  return (
    <div className={styles.frame}>
      {/* User-uploaded Firebase Storage image — next/image optimization isn't
          worth the remote-pattern config here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className={styles.poster} />

      {branding === "strip" && (
        <div
          className={styles.strip}
          style={{ height: `${stripSize}%` }}
          aria-hidden="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={emblemSrc} alt="" className={styles.stripEmblem} />
        </div>
      )}

      {branding === "corner" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={emblemSrc}
          alt=""
          aria-hidden="true"
          className={`${styles.cornerEmblem}${
            logoColor === "colour" ? ` ${styles.cornerEmblemLight}` : ""
          }`}
        />
      )}
    </div>
  );
}
