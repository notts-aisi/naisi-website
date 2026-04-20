import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";

export default function CredentialsPage() {
  return (
    <div>
      <div style={{ marginBottom: "var(--space-10)" }}>
        <Badge tone="accent">Committee</Badge>
        <h1 style={{ marginTop: "var(--space-3)" }}>Credentials</h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-2)" }}>
          Shared committee credentials (social accounts, API keys, etc.), end-to-end encrypted in
          your browser before they reach the database.
        </p>
      </div>

      <Card padding="lg">
        <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>
          Not built yet
        </h3>
        <p style={{ color: "var(--color-text-muted)" }}>
          The encrypted credentials store is planned — client-side AES-GCM with a key derived from a
          shared master password. Until it ships, this page is a placeholder so the nav link works.
        </p>
      </Card>
    </div>
  );
}
