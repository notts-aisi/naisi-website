import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";

export default async function NewsletterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const allowed =
    user.role === "admin" ||
    user.permissions.draftNewsletter ||
    user.permissions.approveNewsletter;
  if (!allowed) redirect("/dashboard");

  return (
    <div>
      <div style={{ marginBottom: "var(--space-8)" }}>
        <div
          style={{
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "var(--space-2)",
          }}
        >
          Newsletter
        </div>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Drafts & publishing</h1>
      </div>
      {children}
    </div>
  );
}
