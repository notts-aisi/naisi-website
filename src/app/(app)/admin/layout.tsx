import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import AdminTabs from "./AdminTabs";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/dashboard");

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
          Admin
        </div>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Committee controls</h1>
      </div>
      <AdminTabs />
      <div style={{ marginTop: "var(--space-8)" }}>{children}</div>
    </div>
  );
}
