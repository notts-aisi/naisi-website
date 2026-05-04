"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import styles from "./SubscribeForm.module.css";

type ChannelOption = {
  /** Channel id sent to the API (e.g. "newsletter", "events"). */
  id: string;
  /** Human label shown next to the checkbox. */
  label: string;
  /** Optional one-line description shown beneath the label. */
  description?: string;
  /** Whether the box is ticked when the form first renders. */
  defaultChecked?: boolean;
};

type Props = {
  /**
   * One option per ticked-or-untickable channel. If exactly one option is
   * passed, the checkbox is hidden and the form auto-subscribes to that
   * single channel; this keeps the form usable as a "subscribe to X" CTA
   * embed where the channel is the section's whole point.
   */
  channels: ChannelOption[];
  /** Pre-populates the email field. */
  initialEmail?: string;
  /** Pre-populates the name field. */
  initialName?: string;
  /** Source string sent on the API call (e.g. "homepage-combined"). */
  source: string;
  /** Optional copy override for the helper text below the input. */
  hint?: string;
  /** Optional override for the success copy. */
  successMessage?: string;
};

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NAME_MAX_LEN = 80;

function defaultSuccessMessage(
  selectedChannels: string[],
  kind: "added" | "confirmation",
): string {
  if (kind === "added") {
    return `You're subscribed. Check your inbox for the receipt.`;
  }
  if (selectedChannels.length > 1) {
    return "Sent. Check your inbox for a single confirmation link covering both lists.";
  }
  if (selectedChannels[0] === "newsletter") {
    return "Sent. Check your inbox for a confirmation link before the next newsletter.";
  }
  if (selectedChannels[0] === "events") {
    return "Sent. Check your inbox for a confirmation link before we email about events.";
  }
  return "Sent. Check your inbox for a confirmation link.";
}

/**
 * Single-form, multi-channel subscribe widget. Renders a name field, an
 * email field, and one checkbox per channel option. Submits all selected
 * channels in a single call to /api/subscriptions, which sends one
 * confirmation email listing them.
 *
 * If only one channel is passed, the checkbox UI is suppressed and the
 * form auto-subscribes to that channel on submit.
 */
export default function SubscribeForm({
  channels,
  initialEmail = "",
  initialName = "",
  source,
  hint,
  successMessage,
}: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(channels.map((c) => [c.id, Boolean(c.defaultChecked)])),
  );
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const reactId = useId();
  const emailFieldId = `subscribe-email-${reactId}`;
  const nameFieldId = `subscribe-name-${reactId}`;
  const showCheckboxes = channels.length > 1;

  const selectedChannels = showCheckboxes
    ? channels.filter((c) => selected[c.id]).map((c) => c.id)
    : channels.map((c) => c.id);

  function toggleChannel(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "submitting") return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
      setStatus({ kind: "error", message: "That doesn't look like a valid email." });
      return;
    }
    if (showCheckboxes && selectedChannels.length === 0) {
      setStatus({ kind: "error", message: "Pick at least one list to subscribe to." });
      return;
    }
    const trimmedName = name.trim().slice(0, NAME_MAX_LEN);

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          channels: selectedChannels,
          source,
          ...(trimmedName ? { name: trimmedName } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; kind?: "confirmation-sent" | "added" }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body && "error" in body && body.error) ||
          "Couldn't subscribe right now. Try again in a moment.";
        setStatus({ kind: "error", message: msg });
        return;
      }
      const successKind = body.kind === "added" ? "added" : "confirmation";
      setStatus({
        kind: "success",
        message:
          successMessage ?? defaultSuccessMessage(selectedChannels, successKind),
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

  return (
    <form onSubmit={onSubmit} className={styles.form} noValidate>
      <Field
        id={nameFieldId}
        label="Your first name"
        hint="Just so we can address you properly. Optional."
      >
        <Input
          id={nameFieldId}
          type="text"
          autoComplete="given-name"
          maxLength={NAME_MAX_LEN}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Marie"
          disabled={submitting}
        />
      </Field>

      <Field id={emailFieldId} label="Your email" hint={hint ?? " "}>
        <Input
          id={emailFieldId}
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={submitting}
        />
      </Field>

      {showCheckboxes ? (
        <fieldset className={styles.channels} disabled={submitting}>
          <legend className={styles.channelsLegend}>
            What would you like?
          </legend>
          <ul className={styles.channelsList}>
            {channels.map((c) => {
              const checked = Boolean(selected[c.id]);
              const id = `subscribe-${c.id}-${reactId}`;
              return (
                <li key={c.id} className={styles.channelRow}>
                  <label htmlFor={id} className={styles.channelLabel}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleChannel(c.id)}
                      className={styles.channelCheckbox}
                    />
                    <span className={styles.channelText}>
                      <span className={styles.channelName}>{c.label}</span>
                      {c.description ? (
                        <span className={styles.channelDescription}>
                          {c.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}

      <div className={styles.submitRow}>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Sending…" : "Subscribe"}
        </Button>
        {status.kind === "error" && (
          <p className={styles.error} role="alert">
            {status.message}
          </p>
        )}
      </div>

      <p className={styles.micro}>
        We&apos;ll send a confirmation. You can unsubscribe with one click from
        any email.
      </p>
    </form>
  );
}
