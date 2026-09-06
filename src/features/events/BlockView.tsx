import { videoEmbedFromUrl, type Block } from "@/lib/firestore/newsletterBlocks";
import styles from "./BlockView.module.css";

/**
 * Renders a sequence of blocks as regular HTML for public web viewing (not
 * email). Used on the public event detail page and anywhere else a block-based
 * body needs to be shown on a webpage.
 */
export default function BlockView({ blocks }: { blocks: Block[] }) {
  return (
    <div className={styles.wrap}>
      {blocks.map((b) => (
        <BlockItem key={b.id} block={b} />
      ))}
    </div>
  );
}

function BlockItem({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2 className={styles.h2}>{block.text}</h2>
      ) : (
        <h3 className={styles.h3}>{block.text}</h3>
      );
    case "richText":
      return (
        <div
          className={styles.richText}
          // Authored by a permissioned drafter and admin-approved pre-publish.
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      );
    case "image":
      if (!block.url) return null;
      return (
        <figure className={styles.figure}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={block.url} alt={block.alt} className={styles.image} />
          {block.caption && <figcaption className={styles.caption}>{block.caption}</figcaption>}
        </figure>
      );
    case "divider":
      return <hr className={styles.divider} />;
    case "video": {
      // Both providers resolve through one helper, so a Loom URL embeds here
      // exactly as a YouTube one does. A URL neither provider recognises still
      // renders nothing at all, which is what this case has always done.
      const embed = videoEmbedFromUrl(block.url);
      if (!embed) return null;
      return (
        <figure className={styles.figure}>
          <div className={styles.videoWrap}>
            <iframe
              className={styles.videoFrame}
              src={embed.embedUrl}
              title={block.caption || "Video"}
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          {block.caption && <figcaption className={styles.caption}>{block.caption}</figcaption>}
        </figure>
      );
    }
  }
}
