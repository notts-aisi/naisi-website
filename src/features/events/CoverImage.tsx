import type { CoverBranding } from "@/lib/firestore/events";
import styles from "./CoverImage.module.css";

/**
 * An event cover image with the optional NAISI emblem treatment overlaid.
 * Shared by the public/preview event page (EventDetailView) and the editor's
 * cover-branding picker, so the picker preview is exactly what ships.
 */
export default function CoverImage({
  url,
  alt,
  branding,
}: {
  url: string;
  alt: string;
  branding: CoverBranding;
}) {
  return (
    <div className={styles.frame}>
      {/* User-uploaded Firebase Storage image — next/image optimization isn't
          worth the remote-pattern config here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className={styles.poster} />

      {branding === "strip" && (
        <div className={styles.strip} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/naisi-emblem-white.png"
            alt=""
            className={styles.stripEmblem}
          />
        </div>
      )}

      {branding === "corner" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/brand/naisi-emblem-white.png"
          alt=""
          aria-hidden="true"
          className={styles.cornerEmblem}
        />
      )}
    </div>
  );
}
