import Link from "next/link";
import { notFound } from "next/navigation";
import CourseEmailDesignEditor from "@/features/admin/emailDesigns/CourseEmailDesignEditor";
import {
  isCourseTemplateId,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";

export const dynamic = "force-dynamic";

/**
 * Course email templates live one segment deeper than the application ones
 * (`/admin/email-designs/course/[templateId]`) so the two id spaces can't
 * collide: a static `course` segment beats the sibling `[templateId]` route.
 * Admin gating is the `(app)/admin/layout.tsx` server check.
 */
export default async function CourseEmailDesignDetailPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  if (!isCourseTemplateId(templateId)) notFound();

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
      <CourseEmailDesignEditor templateId={templateId as CourseTemplateId} />
    </div>
  );
}
