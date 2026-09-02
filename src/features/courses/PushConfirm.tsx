"use client";

import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import styles from "./PushConfirm.module.css";
import type { AttendanceSession } from "./useAttendance";

/**
 * The confirm in front of PUSH ATTENDANCE.
 *
 * Push is the only irreversible thing a facilitator can do on this page, and
 * it does three things at once, so the dialog names all three in the order
 * they matter to the person pressing it:
 *
 *   1. WHO GETS AN EMAIL. Named as a count of their own group, because that is
 *      what a facilitator can check against the room they were just in.
 *   2. THE REGISTER LOCKS. Said plainly, with the remedy: an admin can still
 *      correct it. A confirm that says "are you sure?" and nothing else teaches
 *      people to press through it.
 *   3. THE RECORD MOVES. Everyone's attendance figures are rebuilt from this
 *      register, which is what a reviewer will read months later.
 *
 * ── UNMARKED PEOPLE ARE THE THING WORTH INTERRUPTING FOR ────────────────────
 * A pushed register counts an unmarked person as absent, because the push is
 * the facilitator saying the register is finished. That is right, and it is
 * also the single easiest mistake to make on a busy evening, so the dialog
 * says how many are unmarked and what will happen to them, in their own
 * paragraph, before the button.
 *
 * ── A SESSION THAT DID NOT HAPPEN ───────────────────────────────────────────
 * When the held switch is off the copy changes completely: nobody is marked
 * absent, the session leaves every denominator, and the group still gets the
 * reminder about the next one. Same button, a different fact.
 */

export type PushConfirmProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  session: AttendanceSession | null;
  /** The group's name, for the sentence that names who is being emailed. */
  groupName: string;
  /** Everyone eligible to be marked in this session. */
  eligible: number;
  /** How many of them carry no mark yet. */
  unmarked: number;
  /** The next session, when there is one, so the dialog can name what the email is about. */
  nextLabel: string | null;
};

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

export default function PushConfirm({
  open,
  onClose,
  onConfirm,
  busy,
  session,
  groupName,
  eligible,
  unmarked,
  nextLabel,
}: PushConfirmProps) {
  if (!session) return null;
  const held = session.held;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Push this register" width="sm">
      <div className={styles.root}>
        <h2 className={styles.title}>
          Push week {session.weekNumber}
          {session.occurrence > 1 ? `, session ${session.occurrence}` : ""}?
        </h2>

        <ul className={styles.points}>
          <li>
            {nextLabel
              ? `Everyone in ${groupName || "this group"} gets one email about ${nextLabel}.`
              : "Nobody is emailed: this is the group's last session, so there is nothing to remind them about."}
          </li>
          <li>
            The register locks. An admin can still correct it afterwards, and every
            change they make is recorded.
          </li>
          <li>
            {held
              ? "Everyone's attendance figures are rebuilt from this register."
              : "This session is marked as not held, so it leaves everyone's attendance figures rather than counting against them."}
          </li>
        </ul>

        {held && unmarked > 0 && (
          <p className={styles.warning}>
            {people(unmarked)} of {eligible} {unmarked === 1 ? "has" : "have"} no mark
            yet, and pushing counts them absent. Close this and mark them if that is
            not right.
          </p>
        )}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Not yet
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? "Pushing..." : "Push attendance"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
