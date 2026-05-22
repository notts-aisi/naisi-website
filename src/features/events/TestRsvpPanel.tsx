"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import type { EventDoc } from "@/lib/firestore/events";
import styles from "./TestRsvpPanel.module.css";

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * Admin-only tool on the attendee dashboard: generate random confirmed RSVPs
 * to trial an event's signup, catering and pizza-helper views before it ships,
 * and clear them again. Backed by /api/events/[id]/test-rsvps.
 */
export default function TestRsvpPanel({
  event,
  syntheticCount,
  onChanged,
}: {
  event: EventDoc;
  syntheticCount: number;
  /** Re-sync the dashboard after test RSVPs are generated or removed. */
  onChanged: () => Promise<void>;
}) {
  const [count, setCount] = useState(12);
  const [state, setState] = useState<State>({ kind: "idle" });

  const published = event.status === "published";
  const busy = state.kind === "working";

  async function generate() {
    setState({ kind: "working" });
    try {
      const res = await fetch(`/api/events/${event.id}/test-rsvps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; created?: number; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setState({ kind: "error", message: body?.error ?? `Failed (${res.status})` });
        return;
      }
      const n = body.created ?? 0;
      // Server-side write: re-pull so the dashboard reflects it without a
      // wait on the realtime listener (or a manual reload).
      await onChanged().catch(() => {});
      setState({ kind: "done", message: `Added ${n} test signup${n === 1 ? "" : "s"}.` });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Generate failed",
      });
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Remove all ${syntheticCount} test signup${syntheticCount === 1 ? "" : "s"} from this event?`,
      )
    ) {
      return;
    }
    setState({ kind: "working" });
    try {
      const res = await fetch(`/api/events/${event.id}/test-rsvps`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; deleted?: number; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setState({ kind: "error", message: body?.error ?? `Failed (${res.status})` });
        return;
      }
      const n = body.deleted ?? 0;
      // Server-side write: re-pull so the dashboard reflects it without a
      // wait on the realtime listener (or a manual reload).
      await onChanged().catch(() => {});
      setState({ kind: "done", message: `Removed ${n} test signup${n === 1 ? "" : "s"}.` });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Remove failed",
      });
    }
  }

  return (
    <section>
      <Card padding="lg">
        <h2 className={styles.title}>Test signups</h2>
        <p className={styles.hint}>
          Generate random confirmed RSVPs to check the signup, catering and
          pizza-helper views are wired up, without entering signups by hand.
          Roughly a third report no requirements; the rest carry a random mix.
          They are tagged as test data and cleared when you delete the event.
        </p>

        {published && (
          <p className={styles.note}>
            This event is published. Generate test signups only on an
            unpublished event. Any already here can still be removed.
          </p>
        )}

        {(!published || syntheticCount > 0) && (
          <div className={styles.row}>
            {!published && (
              <>
                <label className={styles.countField}>
                  How many
                  <input
                    type="number"
                    min={1}
                    max={60}
                    className={styles.countInput}
                    value={count}
                    onChange={(e) => {
                      const n = Math.floor(Number(e.target.value));
                      if (Number.isFinite(n)) setCount(Math.min(60, Math.max(1, n)));
                    }}
                    disabled={busy}
                  />
                </label>
                <Button onClick={generate} disabled={busy}>
                  {busy ? "Working…" : "Generate test signups"}
                </Button>
              </>
            )}
            {syntheticCount > 0 && (
              <Button variant="ghost" onClick={remove} disabled={busy}>
                Remove {syntheticCount} test signup{syntheticCount === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        )}

        {state.kind === "error" && <p className={styles.error}>{state.message}</p>}
        {state.kind === "done" && <p className={styles.done}>{state.message}</p>}
      </Card>
    </section>
  );
}
