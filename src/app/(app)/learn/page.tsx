import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";

export default function LearnPage() {
  return (
    <div>
      <div style={{ marginBottom: "var(--space-10)" }}>
        <Badge tone="accent">Coming soon</Badge>
        <h1 style={{ marginTop: "var(--space-3)" }}>Courses</h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-2)" }}>
          Your learning space for NAISI fellowships and reading groups: the week your cohort is on,
          the materials for it, and the exercises you owe.
        </p>
      </div>

      <Card padding="lg">
        <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>
          Not built yet
        </h3>
        <p style={{ color: "var(--color-text-muted)" }}>
          The courses learning space is on its way. Once it ships, every run you are
          enrolled in — or facilitate — will appear here, synced to the cohort&apos;s
          current week. Until then, this page is a placeholder so the nav link works.
        </p>
      </Card>
    </div>
  );
}
