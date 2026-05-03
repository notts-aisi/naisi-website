import EmailPipeTest from "@/features/admin/EmailPipeTest";
import NewsletterTable from "@/features/admin/NewsletterTable";

export default function NewsletterAdminPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        Anyone who has opted in via their profile. Members manage their
        own subscription. You can pull the list to send a newsletter, but
        you shouldn&apos;t change anyone&apos;s state here.
      </p>
      <EmailPipeTest />
      <NewsletterTable />
    </div>
  );
}
