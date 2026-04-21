import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";
import EmailChrome from "./EmailChrome";

type Props = {
  subject: string;
  blocks: Block[];
  preheader?: string;
};

/**
 * Transactional email template for application lifecycle events (submitted,
 * approved, rejected). All per-trigger variance comes from the admin-editable
 * blocks + subject — chrome is shared with the newsletter via EmailChrome.
 */
export default function ApplicationEmail({ subject, blocks, preheader }: Props) {
  return (
    <EmailChrome subject={subject} preheader={preheader}>
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </EmailChrome>
  );
}
