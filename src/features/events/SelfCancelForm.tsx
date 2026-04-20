"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

type Props = {
  eventId: string;
  rsvpId: string;
  token: string;
  name: string;
  eventTitle: string;
};

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export default function SelfCancelForm({
  eventId,
  rsvpId,
  token,
  name,
  eventTitle,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onConfirm() {
    setState({ kind: "submitting" });
    try {
      const res = await fetch(
        `/api/events/${eventId}/rsvp/${rsvpId}/cancel?t=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setState({
          kind: "error",
          message: body?.error ?? `Cancel failed (${res.status})`,
        });
        return;
      }
      setState({ kind: "cancelled" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Cancel failed",
      });
    }
  }

  if (state.kind === "cancelled") {
    return (
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Your RSVP is cancelled.
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          Thanks for letting us know. If you change your mind, you can sign up again
          from the event page.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
        Cancel your RSVP for {eventTitle}?
      </h2>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-4)" }}>
        Hi {name || "there"} — confirm below and we&apos;ll free up your spot.
      </p>

      {state.kind === "error" && (
        <p style={{ color: "var(--color-danger)" }}>{state.message}</p>
      )}

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <Button onClick={onConfirm} disabled={state.kind === "submitting"}>
          {state.kind === "submitting" ? "Cancelling…" : "Yes, cancel my RSVP"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => router.push(`/events/${eventId}`)}
          disabled={state.kind === "submitting"}
        >
          Never mind
        </Button>
      </div>
    </Card>
  );
}
