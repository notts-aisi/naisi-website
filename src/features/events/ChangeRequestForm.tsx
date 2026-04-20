"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import FormRenderer from "./FormRenderer";
import type { FormQuestion, RsvpAnswer } from "@/lib/firestore/events";

type Props = {
  eventId: string;
  rsvpId: string;
  token: string;
  eventTitle: string;
  name: string;
  questions: FormQuestion[];
  initialAnswers: Record<string, RsvpAnswer>;
  hasPending: boolean;
};

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted" }
  | { kind: "error"; message: string };

export default function ChangeRequestForm({
  eventId,
  rsvpId,
  token,
  eventTitle,
  name,
  questions,
  initialAnswers,
  hasPending,
}: Props) {
  const [answers, setAnswers] = useState<Record<string, RsvpAnswer>>(initialAnswers);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "submitting" });
    try {
      const res = await fetch(
        `/api/events/${eventId}/rsvp/${rsvpId}/request-change`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers, t: token }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setState({
          kind: "error",
          message: body?.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      setState({ kind: "submitted" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  if (state.kind === "submitted") {
    return (
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
          Request sent.
        </h2>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          A NAISI organiser will review your proposed changes. We&apos;ll be in touch if
          anything else is needed.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <h2 style={{ fontSize: "var(--text-xl)", margin: "0 0 var(--space-2)" }}>
        Update your answers for {eventTitle}
      </h2>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-4)" }}>
        Hi {name || "there"} — adjust anything below and we&apos;ll review the change.
        Your original answers stay in place until we approve the update.
      </p>
      {hasPending && (
        <p
          style={{
            color: "var(--color-warning)",
            fontSize: "var(--text-sm)",
            background: "var(--color-warning-soft, rgba(255,180,0,0.08))",
            border: "1px solid var(--color-border)",
            padding: "var(--space-2) var(--space-3)",
            borderRadius: "var(--radius-md)",
            marginBottom: "var(--space-3)",
          }}
        >
          You already have a change request pending review — submitting again will
          overwrite it.
        </p>
      )}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <FormRenderer
          questions={questions}
          answers={answers}
          onChange={setAnswers}
          disabled={state.kind === "submitting"}
        />

        {state.kind === "error" && (
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{state.message}</p>
        )}

        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <Button type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Sending…" : "Send change request"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
