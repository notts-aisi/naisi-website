"use client";

import { useTilt } from "@/hooks/useTilt";
import type { InstagramPost } from "@/content/instagramPosts";
import styles from "./InstagramCarousel.module.css";

export default function InstagramCard({ post }: { post: InstagramPost }) {
  const ref = useTilt<HTMLAnchorElement>({ max: 6, perspective: 900 });

  return (
    <a
      ref={ref}
      href={post.permalink}
      target="_blank"
      rel="noreferrer noopener"
      className={styles.card}
      aria-label={post.caption ? `${post.alt} — ${post.caption}` : post.alt}
    >
      <span className={styles.imgWrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={post.imagePath} alt={post.alt} className={styles.img} loading="lazy" />
      </span>
      {post.caption && <span className={styles.caption}>{post.caption}</span>}
      <span className={styles.viewLink}>View on Instagram →</span>
    </a>
  );
}
