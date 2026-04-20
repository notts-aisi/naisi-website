import { getCurrentUser } from "@/lib/firebase/session";
import Badge from "@/components/ui/Badge";
import MyWorkSummary from "@/features/tasks/components/MyWorkSummary";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  return (
    <div>
      <div style={{ marginBottom: "var(--space-8)" }}>
        <Badge tone="accent">Dashboard</Badge>
        <h1 style={{ marginTop: "var(--space-3)" }}>
          Welcome back{user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}.
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-2)" }}>
          Your home base. Open tasks, overdue items, and what&apos;s coming up next.
        </p>
      </div>

      <MyWorkSummary />
    </div>
  );
}
