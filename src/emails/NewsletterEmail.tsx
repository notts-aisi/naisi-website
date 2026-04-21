import { Link, Text } from "@react-email/components";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import BlockRenderer from "./blocks/BlockRenderer";
import EmailChrome, {
  emailFooterTextStyle,
  emailLinkStyle,
} from "./EmailChrome";

type Props = {
  subject: string;
  blocks: Block[];
  recipientName: string;
  unsubscribeUrl: string;
  preheader?: string;
};

export default function NewsletterEmail({
  subject,
  blocks,
  recipientName,
  unsubscribeUrl,
  preheader,
}: Props) {
  return (
    <EmailChrome
      subject={subject}
      preheader={preheader}
      greeting={`Hi ${recipientName},`}
      footerSlot={
        <Text style={emailFooterTextStyle}>
          You&apos;re getting this because you subscribed on the NAISI website. You can change
          your subscription preferences or unsubscribe at any time by visiting{" "}
          <Link href={unsubscribeUrl} style={emailLinkStyle}>
            your profile
          </Link>
          .
        </Text>
      }
    >
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </EmailChrome>
  );
}
