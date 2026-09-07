import type { ReactNode } from "react";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";
import EmailChrome from "./EmailChrome";

type Props = {
  subject: string;
  blocks: Block[];
  preheader?: string;
  /**
   * The notice lane's marker, built by `sendNotice` and rendered above the
   * blocks. The template chooses where it sits and never what it says; see
   * `src/emails/NoticeMarker.tsx`. Absent everywhere but the two course notice
   * lanes, which is why it is optional.
   */
  notice?: ReactNode;
};

/**
 * Transactional email template for application lifecycle events (submitted,
 * approved, rejected). All per-trigger variance comes from the admin-editable
 * blocks + subject — chrome is shared with the newsletter via EmailChrome.
 */
export default function ApplicationEmail({
  subject,
  blocks,
  preheader,
  notice,
}: Props) {
  return (
    <EmailChrome subject={subject} preheader={preheader}>
      {notice}
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </EmailChrome>
  );
}
