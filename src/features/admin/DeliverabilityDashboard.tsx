"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

type SendStatus = "sent" | "bounced" | "complained";

type Send = {
  id: string;
  to: string;
  subject: string;
  kind: string;
  status: SendStatus;
  statusReason?: string;
  sentAt: string | null;
  statusUpdatedAt: string | null;
  referenceId?: string;
};

type Suppression = {
  id: string;
  email: string;
  reason: string;
  subReason?: string;
  source: string;
  addedAt: string | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusBadge(status: SendStatus, reason?: string) {
  switch (status) {
    case "bounced":
      return (
        <Badge tone="danger" title={reason ? `Reason: ${reason}` : undefined}>
          Bounced{reason ? ` · ${reason}` : ""}
        </Badge>
      );
    case "complained":
      return (
        <Badge tone="warning" title={reason ? `Reason: ${reason}` : undefined}>
          Complaint{reason ? ` · ${reason}` : ""}
        </Badge>
      );
    default:
      return <Badge tone="success">Sent</Badge>;
  }
}

function kindBadge(kind: string) {
  return <Badge tone="neutral">{kind}</Badge>;
}

export default function DeliverabilityDashboard() {
  const [sends, setSends] = useState<Send[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsuppressing, setUnsuppressing] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sendsRes, suppRes] = await Promise.all([
        fetch("/api/admin/deliverability/sends"),
        fetch("/api/admin/deliverability/suppressed"),
      ]);
      if (!sendsRes.ok) throw new Error(`Sends fetch ${sendsRes.status}`);
      if (!suppRes.ok) throw new Error(`Suppressed fetch ${suppRes.status}`);
      const sendsBody = (await sendsRes.json()) as { items: Send[] };
      const suppBody = (await suppRes.json()) as { items: Suppression[] };
      setSends(sendsBody.items ?? []);
      setSuppressions(suppBody.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function onUnsuppress(id: string) {
    setUnsuppressing(id);
    try {
      const res = await fetch(
        `/api/admin/deliverability/suppressed/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Delete ${res.status}`);
      setSuppressions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Un-suppress failed");
    } finally {
      setUnsuppressing(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-1)" }}>
            Deliverability
          </h2>
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", margin: 0 }}>
            Recent sends and the suppression list fed by email provider bounce + complaint events.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void fetchAll()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{error}</p>
        </Card>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <h3 style={{ fontSize: "var(--text-lg)" }}>Recent sends</h3>
        {loading && sends.length === 0 ? (
          <Card padding="md">
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>Loading…</p>
          </Card>
        ) : sends.length === 0 ? (
          <Card padding="md">
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
              No sends logged yet. Rows appear here once anyone triggers an outbound email.
            </p>
          </Card>
        ) : (
          <Card padding="sm">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>To</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Kind</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Subject</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Sent</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sends.map((s) => (
                    <tr key={s.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "var(--space-2)", wordBreak: "break-all" }}>{s.to}</td>
                      <td style={{ padding: "var(--space-2)" }}>{kindBadge(s.kind)}</td>
                      <td style={{ padding: "var(--space-2)" }}>{s.subject}</td>
                      <td style={{ padding: "var(--space-2)", whiteSpace: "nowrap" }}>
                        {formatDate(s.sentAt)}
                      </td>
                      <td style={{ padding: "var(--space-2)" }}>
                        {statusBadge(s.status, s.statusReason)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <h3 style={{ fontSize: "var(--text-lg)" }}>Suppressed addresses</h3>
        {loading && suppressions.length === 0 ? (
          <Card padding="md">
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>Loading…</p>
          </Card>
        ) : suppressions.length === 0 ? (
          <Card padding="md">
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
              No addresses suppressed — healthy list.
            </p>
          </Card>
        ) : (
          <Card padding="sm">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Email</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Reason</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Detail</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }}>Added</th>
                    <th style={{ padding: "var(--space-2)", fontWeight: 500 }} />
                  </tr>
                </thead>
                <tbody>
                  {suppressions.map((s) => (
                    <tr key={s.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "var(--space-2)", wordBreak: "break-all" }}>{s.email}</td>
                      <td style={{ padding: "var(--space-2)" }}>
                        {s.reason === "complaint" ? (
                          <Badge tone="warning">Complaint</Badge>
                        ) : (
                          <Badge tone="danger">Bounce</Badge>
                        )}
                      </td>
                      <td style={{ padding: "var(--space-2)", color: "var(--color-text-muted)" }}>
                        {s.subReason ?? "—"}
                      </td>
                      <td style={{ padding: "var(--space-2)", whiteSpace: "nowrap" }}>
                        {formatDate(s.addedAt)}
                      </td>
                      <td style={{ padding: "var(--space-2)", textAlign: "right" }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onUnsuppress(s.id)}
                          disabled={unsuppressing === s.id}
                        >
                          {unsuppressing === s.id ? "Removing…" : "Un-suppress"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
