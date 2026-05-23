import Reveal from "./Reveal";
import InstagramCard from "./InstagramCard";
import { INSTAGRAM_POSTS } from "@/content/instagramPosts";
import styles from "./InstagramCarousel.module.css";

/*
  InstagramCarousel — horizontal scroll-snap strip of recent Instagram
  posts. Content lives in src/content/instagramPosts.ts. Empty array →
  section hides.
*/
export default function InstagramCarousel() {
  if (INSTAGRAM_POSTS.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <header className={styles.head}>
          <Reveal variant="mask-wipe" as="h2" className={styles.heading}>
            From the gram.
          </Reveal>
          <p className={styles.blurb}>
            What we&apos;ve been up to. Tap a post to see it in full on Instagram.
          </p>
        </header>
        <Reveal variant="tilt-in" staggerChildren staggerMs={90} as="ul" className={styles.strip}>
          {INSTAGRAM_POSTS.map((p) => (
            <li key={p.id} className={styles.itemWrap}>
              <InstagramCard post={p} />
            </li>
          ))}
        </Reveal>
        <p className={styles.footer}>
          <a
            href="https://www.instagram.com/notts.ai.safety/"
            target="_blank"
            rel="noreferrer noopener"
            className={styles.allLink}
          >
            View more on Instagram →
          </a>
        </p>
      </div>
    </section>
  );
}
