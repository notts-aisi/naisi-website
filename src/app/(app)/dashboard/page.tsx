import { getCurrentUser } from "@/lib/firebase/session";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  return (
    <div>
      <div style={{ marginBottom: "var(--space-10)" }}>
        <Badge tone="accent">Dashboard</Badge>
        <h1 style={{ marginTop: "var(--space-3)" }}>
          Welcome back{user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}.
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-2)" }}>
          This is your NAISI home base. The full dashboard (tasks summary, upcoming bookings, course
          progress) will populate as those features come online.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
        }}
      >
        <Card padding="md">
          <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>Tasks</h3>
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            Task manager coming next. You&apos;ll see your open tasks and project progress here.
          </p>
        </Card>
        <Card padding="md">
          <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>Calendar</h3>
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            Upcoming 1-1s will show here once the booking system is live.
          </p>
        </Card>
        <Card padding="md">
          <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>Courses</h3>
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            Once you&apos;re enrolled in a cohort, your materials and homework will appear here.
          </p>
        </Card>
      </div>
    </div>
  );
}
