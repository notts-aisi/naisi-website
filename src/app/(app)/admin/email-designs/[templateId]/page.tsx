import Link from "next/link";
import { notFound } from "next/navigation";
import EmailDesignEditor from "@/features/admin/emailDesigns/EmailDesignEditor";
import {
  isTemplateId,
  type TemplateId,
} from "@/lib/firestore/applicationEmails";

export const dynamic = "force-dynamic";

export default async function EmailDesignDetailPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  if (!isTemplateId(templateId)) notFound();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <Link
        href="/admin/email-designs"
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted)",
          textDecoration: "none",
        }}
      >
        ← All email designs
      </Link>
      <EmailDesignEditor templateId={templateId as TemplateId} />
    </div>
  );
}
