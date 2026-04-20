"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; to: string }
  | { kind: "error"; message: string };

export default function EmailPipeTest() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSend() {
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/admin/test-email", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; sentTo?: string; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setStatus({
          kind: "error",
          message: body?.error ?? `Failed (${res.status})`,
        });
        return;
      }
      setStatus({ kind: "sent", to: body.sentTo ?? "your inbox" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return (
    <Card padding="md">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginBottom: "var(--space-1)",
            }}
          >
            <h3 style={{ fontSize: "var(--text-lg)" }}>Email pipeline</h3>
            {status.kind === "sent" && <Badge tone="success">Sent</Badge>}
            {status.kind === "error" && <Badge tone="danger">Error</Badge>}
          </div>
          <p
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
              margin: 0,
            }}
          >
            Sends a test email to your own address via Gmail SMTP. Use this after changing SMTP
            credentials or templates.
          </p>
        </div>
        <Button size="sm" onClick={onSend} disabled={status.kind === "sending"}>
          {status.kind === "sending" ? "Sending…" : "Send test to myself"}
        </Button>
      </div>
      {status.kind === "sent" && (
        <p
          style={{
            marginTop: "var(--space-3)",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          Sent to {status.to}. If it doesn&apos;t arrive within a minute, check the spam folder and
          the server logs.
        </p>
      )}
      {status.kind === "error" && (
        <p
          style={{
            marginTop: "var(--space-3)",
            fontSize: "var(--text-sm)",
            color: "var(--color-danger)",
          }}
        >
          {status.message}
        </p>
      )}
    </Card>
  );
}
