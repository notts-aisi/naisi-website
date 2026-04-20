"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { TITLE_MAX } from "@/lib/firestore/events";
import { createEvent } from "./eventMutations";
import styles from "./EventEditor.module.css";

export default function NewEventForm() {
  const router = useRouter();
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Give the event a title before creating it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createEvent({
        title,
        authorDisplayName: user?.displayName ?? user?.email ?? null,
      });
      router.push(`/events/manage/${id}`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to create event");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.editor}>
      <Card padding="lg">
        <div className={styles.fields}>
          <Field
            id="new-title"
            label="Event title"
            hint="You'll fill in the date, description, and signup questions on the next screen."
          >
            <Input
              id="new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              placeholder="e.g. April fellowship social"
              autoFocus
            />
          </Field>
        </div>
      </Card>

      {error && <p className={styles.danger}>{error}</p>}

      <div className={styles.editorActions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create event"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/events/manage")}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
