import DraftEditor from "@/features/newsletter/DraftEditor";

export default async function NewsletterDraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DraftEditor draftId={id} />;
}
