import {
  Heading as EmailHeading,
  Hr,
  Img,
  Link as EmailLink,
  Section,
  Text,
} from "@react-email/components";
import { youtubeIdFromUrl, type Block } from "@/lib/firestore/newsletterBlocks";

/**
 * Render a single block as email-safe React Email JSX. All styles are inline —
 * Gmail and Outlook strip <style> blocks.
 */
export default function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return <HeadingBlockView block={block} />;
    case "richText":
      return <RichTextBlockView block={block} />;
    case "image":
      return <ImageBlockView block={block} />;
    case "divider":
      return <Hr style={dividerStyle} />;
    case "video":
      return <VideoBlockView block={block} />;
  }
}

function VideoBlockView({ block }: { block: Extract<Block, { type: "video" }> }) {
  const id = youtubeIdFromUrl(block.url);
  if (!id) return null;
  const href = `https://www.youtube.com/watch?v=${id}`;
  // Email clients strip iframes, so fall back to a clickable thumbnail.
  const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return (
    <Section style={sectionStyle}>
      <EmailLink href={href} style={{ textDecoration: "none" }}>
        <Img
          src={thumb}
          alt={block.caption || "Watch on YouTube"}
          width="100%"
          style={imageStyle}
        />
      </EmailLink>
      <Text style={captionStyle}>
        {block.caption ? `${block.caption} · ` : ""}
        <EmailLink href={href} style={{ color: "#2563eb" }}>
          Watch on YouTube
        </EmailLink>
      </Text>
    </Section>
  );
}

function HeadingBlockView({ block }: { block: Extract<Block, { type: "heading" }> }) {
  const style = block.level === 2 ? h2Style : h3Style;
  return (
    <Section style={sectionStyle}>
      <EmailHeading as={block.level === 2 ? "h2" : "h3"} style={style}>
        {block.text || "\u00A0"}
      </EmailHeading>
    </Section>
  );
}

function RichTextBlockView({ block }: { block: Extract<Block, { type: "richText" }> }) {
  return (
    <Section style={sectionStyle}>
      <div
        // Authored by a permissioned drafter and admin-approved pre-send.
        dangerouslySetInnerHTML={{ __html: block.html }}
        style={richTextStyle}
      />
    </Section>
  );
}

function ImageBlockView({ block }: { block: Extract<Block, { type: "image" }> }) {
  if (!block.url) return null;
  return (
    <Section style={sectionStyle}>
      <Img
        src={block.url}
        alt={block.alt}
        width="100%"
        style={imageStyle}
      />
      {block.caption && <Text style={captionStyle}>{block.caption}</Text>}
    </Section>
  );
}

// ---- inline styles (email-safe) ----

const sectionStyle: React.CSSProperties = {
  margin: "0 0 20px",
};

const h2Style: React.CSSProperties = {
  fontSize: "22px",
  fontWeight: 700,
  color: "#09090b",
  margin: "28px 0 12px",
  lineHeight: 1.25,
};

const h3Style: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  color: "#18181b",
  margin: "22px 0 10px",
  lineHeight: 1.3,
};

const richTextStyle: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: 1.7,
  color: "#27272a",
};

const imageStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: "536px",
  height: "auto",
  borderRadius: "8px",
  border: "1px solid #e4e4e7",
};

const captionStyle: React.CSSProperties = {
  fontSize: "13px",
  color: "#71717a",
  fontStyle: "italic",
  margin: "8px 0 0",
  textAlign: "center",
};

const dividerStyle: React.CSSProperties = {
  borderColor: "#e4e4e7",
  margin: "32px 0",
};
