"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import Modal from "@/components/ui/Modal";
import { ATTENDANCE_LIMITS } from "@/lib/firestore/courseAttendance";
import styles from "./ParticipantNoteDrawer.module.css";
import type { AttendanceSession } from "./useAttendance";

/**
 * The private note a facilitator keeps about ONE person after ONE session.
 *
 * ── THE DISCLOSURE LINE IS THE POINT ────────────────────────────────────────
 * A note here is personal data about a named student, written by another
 * student, and the person it is about can ask to read it. That sentence sits
 * above the box, in plain words, every time the drawer opens. It is not a
 * disclaimer and it is not small print: it is the thing that keeps these notes
 * worth having, because a note nobody would stand behind is a note that should
 * not have been written.
 *
 * ── WHO SEES IT ─────────────────────────────────────────────────────────────
 * The group's facilitators, reviewers and admins. Never the cohort, and never
 * the member it is about on their own surfaces. `courseAttendance` is
 * `read, write: if false`, so the only readers are the routes that serve those
 * people.
 *
 * ── PLAIN TEXT, AND A REAL DELETE ───────────────────────────────────────────
 * Text in, text out: it is rendered as a text node everywhere it appears,
 * never as HTML. Clearing the box and saving REMOVES the note rather than
 * storing an empty one, and deleting an account removes every note about that
 * person by field path, on the same document as their marks.
 *
 * ── NOT LOCKED BY THE PUSH ──────────────────────────────────────────────────
 * Deliberately, and the drawer says so when the register is locked. The push
 * locks the MARKS, because those are what the mirrors and the reviewers read.
 * A note is often written after the session, on the way home, and locking it
 * would mean the more considered version could never be written down.
 */

export type ParticipantNoteDrawerProps = {
  open: boolean;
  onClose: () => void;
  session: AttendanceSession | null;
  member: { uid: string; displayName: string } | null;
  /** The stored note, or "" when there is none. */
  note: string;
  /** Resolves with the saved note. Throws with the route's own sentence. */
  onSave: (note: string) => Promise<void>;
};

export default function ParticipantNoteDrawer({
  open,
  onClose,
  session,
  member,
  note,
  onSave,
}: ParticipantNoteDrawerProps) {
  // Seeded ONCE, from the note this cell holds. The caller gives this
  // component a `key` per (session, member), so pointing the drawer at a
  // different cell REMOUNTS it and the seed is fresh by construction. That is
  // deliberately not a reseeding effect: an effect would fire again when a
  // save merged the stored note back into the payload, wiping anything typed
  // since, and it is the shape the lint rule exists to prevent.
  const [draft, setDraft] = useState(note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session || !member) return null;

  const dirty = draft.trim() !== note.trim();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That note didn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Session note about a participant">
      <div className={styles.root}>
        <div>
          <h2 className={styles.title}>Note on {member.displayName}</h2>
          <p className={styles.meta}>
            Week {session.weekNumber}
            {session.occurrence > 1 ? `, session ${session.occurrence}` : ""}
            {session.title ? ` · ${session.title}` : ""}
          </p>
        </div>

        {/* The standing disclosure. Same words every time, above the box. */}
        <p className={styles.disclosure}>
          Notes are personal data about a named student and can be disclosed to them
          on request.
        </p>

        <label className={styles.label} htmlFor="participant-note">
          What is worth remembering about this session
        </label>
        <CountedTextarea
          id="participant-note"
          value={draft}
          max={ATTENDANCE_LIMITS.participantNote}
          rows={6}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Kept for reviewers and admins. Empty it to remove the note."
        />

        {session.pushedAt && (
          <p className={styles.meta}>
            The register for this session is locked, but notes stay open: they are
            often written after the session rather than during it.
          </p>
        )}

        {error && (
          <p className={styles.error} role="status">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Saving..." : draft.trim() ? "Save note" : "Remove note"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
