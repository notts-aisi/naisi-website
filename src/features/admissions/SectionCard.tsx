"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import styles from "./RoundEditor.module.css";

/**
 * One editor section: a heading, its fields, and its OWN save.
 *
 * Per-section saves rather than one form for the whole round, and that is a
 * data decision as much as a layout one. The round's PATCH route is partial,
 * so a section save sends only the fields that section owns. The
 * submitted-applications freeze on `criteria` and `programmePreference` then
 * fires only when somebody edits those sections, instead of on every save of a
 * blurb, which is what a single whole-document form would have done.
 *
 * The `id` is the anchor the readiness panel links to, so section ids and
 * `ReadinessSection` are the same vocabulary.
 */
export default function SectionCard({
  id,
  title,
  note,
  children,
  onSave,
  saveLabel = "Save",
  disabled,
  footer,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
  /**
   * Omit for a section that saves through its own controls (stages, status).
   * Resolving to `false` means "nothing was written": the two sections that
   * can be stopped by the submitted-applications freeze open a confirmation
   * instead of saving, and a card that said "Saved." over an unanswered
   * confirmation would be a lie the author would act on.
   */
  onSave?: () => Promise<void | boolean>;
  saveLabel?: string;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const wrote = await onSave();
      setSaved(wrote !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.sectionHead}>
        <h2 id={`${id}-title`} className={styles.sectionTitle}>
          {title}
        </h2>
        {note && <p className={styles.sectionNote}>{note}</p>}
      </div>

      <div className={styles.body}>{children}</div>

      {(onSave || footer) && (
        <div className={styles.actions}>
          {onSave && (
            <Button
              type="button"
              data-testid="section-save"
              onClick={save}
              disabled={busy || disabled}
            >
              {busy ? "Saving…" : saveLabel}
            </Button>
          )}
          {footer}
          {saved && !error && (
            <span className={styles.saved} data-testid="section-saved">
              Saved.
            </span>
          )}
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
