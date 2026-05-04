"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import styles from "./SubscribeForm.module.css";

type Props = {
  /**
   * Subscription channel id. `newsletter` and `events` are the V1 lists.
   * Future cohort channels (e.g. `cohort:fall-2026`) work without code
   * changes here, since the API and copy adapt to whatever string is
   * passed.
   */
  channel: string;
  /** Pre-populates the email field. Useful for re-subscribe links. */
  initialEmail?: string;
  /** Optional copy override for the helper text below the input. */
  hint?: string;
  /** Optional override for the success copy. */
  successMessage?: string;
  /** Width of the input, default "auto". Set "full" inside narrow columns. */
  layout?: "auto" | "full";
};

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function defaultSuccessMessage(channel: string, kind: "added" | "confirmation"): string {
  if (kind === "added") {
    return `You're subscribed. Check your inbox for the receipt.`;
  }
  if (channel === "newsletter") {
    return "Sent. Check your inbox for a confirmation link before the first Sunday digest.";
  }
  if (channel === "events") {
    return "Sent. Check your inbox for a confirmation link before we email about events.";
  }
  return "Sent. Check your inbox for a confirmation link.";
}

export default function SubscribeForm({
  channel,
  initialEmail = "",
  hint,
  successMessage,
  layout = "auto",
}: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "submitting") return;

    const trimmed = email.trim();
    if (!trimmed || !EMAIL_RE.test(trimmed)) {
      setStatus({ kind: "error", message: "That doesn't look like a valid email." });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          channel,
          source: `homepage-${channel}`,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; kind?: "confirmation-sent" | "added" }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body && "error" in body && body.error) || "Couldn't subscribe right now. Try again in a moment.";
        setStatus({ kind: "error", message: msg });
        return;
      }
      const successKind = body.kind === "added" ? "added" : "confirmation";
      setStatus({
        kind: "success",
        message: successMessage ?? defaultSuccessMessage(channel, successKind),
      });
    } catch (err) {
      console.error("[SubscribeForm] submit failed", err);
      setStatus({ kind: "error", message: "Network hiccup. Try again." });
    }
  }

  if (status.kind === "success") {
    return (
      <div className={styles.success} role="status" aria-live="polite">
        <p className={styles.successHeading}>Thanks.</p>
        <p className={styles.successBody}>{status.message}</p>
      </div>
    );
  }

  const submitting = status.kind === "submitting";
  const fieldId = `subscribe-${channel}-email`;

  return (
    <form
      onSubmit={onSubmit}
      className={`${styles.form} ${layout === "full" ? styles.formFull : ""}`}
      noValidate
    >
      <Field id={fieldId} label="Your email" hint={hint ?? " "}>
        <div className={styles.row}>
          <Input
            id={fieldId}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={submitting}
          />
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Sending…" : "Subscribe"}
          </Button>
        </div>
      </Field>
      {status.kind === "error" && (
        <p className={styles.error} role="alert">
          {status.message}
        </p>
      )}
      <p className={styles.micro}>
        We&apos;ll send a confirmation. You can unsubscribe with one click from any email.
      </p>
    </form>
  );
}
