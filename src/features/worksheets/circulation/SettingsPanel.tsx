"use client";

import { useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import DateTimePopover from "@/components/ui/DateTimePopover";
import MemberName from "@/components/ui/MemberName";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import Switch from "@/components/ui/Switch";
import { getClientDb } from "@/lib/firebase/client";
import {
  CIRCULATIONS_COLLECTION,
  type CirculationDoc,
  type NotificationEvent,
  type ReviewConfig,
} from "@/lib/firestore/circulations";
import { REVIEW_TOGGLES, RETURN_OFF_NOTE } from "./circulationView";
import { CHANNEL_LABELS, DUE_SOON_NOT_LIVE_NOTE, NOTIFICATION_ROWS } from "./notificationCopy";
import styles from "./SettingsPanel.module.css";

/**
 * The settings of a circulation that has already gone out: its due date, what
 * reviewers may write, and which messages it sends.
 *
 * ── WHY THESE ARE EDITABLE AT ALL, HAVING BEEN SET AT SEND TIME ─────────────
 * Wave 1 rendered them read-only with a note saying so, because "what should
 * somebody already told about a message hear when it is switched off" is a
 * real question. The answer this wave takes is: NOTHING, and that is fine.
 * Every message these switches gate is fired by a FUTURE event (a new
 * recipient, a submission, a deadline two days out, a return), so turning one
 * off silences what has not happened yet and cannot unsend what has. The one
 * setting with any reach backwards is `returnToRecipient`, and it is honest
 * there too: it decides what happens to responses returned FROM NOW ON, which
 * the note under those switches says out loud.
 *
 * ── EVERY CHANGE SAVES ITSELF ───────────────────────────────────────────────
 * No Save button and no draft state. Each switch writes its own field with
 * `updateDoc`, inside the key list the circulations update rule allows, and
 * the page's live listener is what re-renders it: the Firestore client applies
 * a local write to the snapshot before the server answers, so the switch moves
 * at once and settles when the write lands. Holding a local copy beside a live
 * listener would mean two sources of truth fighting over one switch, which is
 * how a toggle ends up flicking back under somebody's finger.
 *
 * The consequence, stated because it is a real one: two staff editing the same
 * circulation at the same time is last-write-wins per field. The whole feature
 * says so (`docs/worksheets.md`, out of scope in v1), and a switch is a small
 * enough unit that the loser can see what happened and flick it back.
 *
 * ── WHO MAY BE HERE ─────────────────────────────────────────────────────────
 * Nothing in this component checks. It is mounted by `CirculationPage`, which
 * renders the whole page as an EmptyState for anybody who is not staff, and
 * the rule refuses the write regardless. A second check here would be a second
 * place for the answer to drift.
 */

type Props = {
  circulation: CirculationDoc;
  /** The page's resolver: the task roster, then the recipient roster. */
  nameOf: (uid: string) => string;
  /** Admins alone are told the scheduler is not running yet. */
  isAdmin: boolean;
};

/**
 * One `updateDoc` payload: FIELD PATHS and their values, never a rebuilt map.
 *
 * A dotted path (`notifications.dueSoon.email`) writes one leaf. Rebuilding
 * the whole `notifications` object from the prop, which is what this panel
 * used to do, carries every OTHER switch's value as it stood when this render
 * read it: two switches flipped inside one render window would both write the
 * pre-first-write map, and the first change would silently revert under
 * somebody's finger. Lossy, and invisible when it happens.
 *
 * The rule is satisfied either way. `affectedKeys()` reports the TOP-LEVEL key
 * (`notifications`, `reviewConfig`, `dueDate`), all three of which are in the
 * circulations update rule's list, whether the write replaced a map or changed
 * one boolean inside it.
 *
 * A leaf write on a document whose map is incomplete is safe too:
 * `normalizeNotifications` fills every missing event AND every missing channel
 * from `DEFAULT_NOTIFICATIONS` on the way in, so a sibling this write never
 * mentions is read as its default rather than as `undefined`.
 */
type SettingsPatch = Record<string, boolean | Date | null>;

/**
 * Local YYYY-MM-DD for today, the earliest day the picker offers.
 *
 * A due date behind the clock is not a due date: the reminder job scans
 * `dueDate >= now`, so a past deadline silently leaves the audience and the
 * note under this field becomes a promise nothing can keep. The same one-line
 * helper the events editor uses to keep an end date on or after its start.
 */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export default function SettingsPanel({ circulation, nameOf, isAdmin }: Props) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const closed = circulation.status === "closed";

  async function save(patch: SettingsPatch) {
    setState("saving");
    setError(null);
    try {
      const db = getClientDb();
      // Every value in `patch` is a concrete boolean, Date or null by its type:
      // Firestore refuses `undefined` outright on a client-direct write, and
      // there is no "leave this alone" value to pass by accident.
      await updateDoc(doc(db, CIRCULATIONS_COLLECTION, circulation.id), {
        ...patch,
        updatedAt: serverTimestamp(),
      });
      setState("saved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Couldn't save that change.");
    }
  }

  function setReview(key: keyof ReviewConfig, value: boolean) {
    save({ [`reviewConfig.${key}`]: value });
  }

  function setChannel(event: NotificationEvent, channel: "email" | "push", value: boolean) {
    save({ [`notifications.${event}.${channel}`]: value });
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.heading}>Settings</h2>
        <SavedFlash state={state} />
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {closed && (
        <p className={styles.note}>
          This circulation is closed, so nobody can submit and no reminders go out. The
          review settings still decide what happens to feedback you return.
        </p>
      )}

      <Card as="section" padding="md" className={styles.card}>
        <h3 className={styles.cardTitle}>Reviewers</h3>
        {circulation.reviewerUids.length === 0 ? (
          <p className={styles.note}>Nobody was named as a reviewer.</p>
        ) : (
          <ul className={styles.people}>
            {circulation.reviewerUids.map((uid) => (
              <li key={uid} className={styles.person}>
                <MemberName name={nameOf(uid)} />
              </li>
            ))}
          </ul>
        )}
        {/* Read-only, and the reason is the rules rather than the layout:
            `reviewerUids` and `staffUids` are server-owned (the update rule's
            key list leaves both out), because a staff member who could edit
            them could add themselves to somebody else's circulation. Changing
            who reviews is a job for the route that owns those arrays. */}
        <p className={styles.note}>
          Reviewers are set when the worksheet goes out. They read every response and
          write the feedback.
        </p>
      </Card>

      <Card as="section" padding="md" className={styles.card}>
        <h3 className={styles.cardTitle}>Due date</h3>
        <div className={styles.dueRow}>
          <DateTimePopover
            value={circulation.dueDate}
            onChange={(next) => save({ dueDate: next ?? null })}
            placeholder="No due date"
            minDate={todayKey()}
          />
          {circulation.dueDate && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => save({ dueDate: null })}
            >
              Clear
            </Button>
          )}
        </div>
        <p className={styles.note}>
          Moving the date moves the reminder with it: anybody who has not submitted is
          reminded about the new deadline rather than the old one. Today is the earliest
          date you can pick, because a deadline behind the clock reminds nobody.
        </p>
      </Card>

      <Card as="section" padding="md" className={styles.card}>
        <h3 className={styles.cardTitle}>Review</h3>
        <div className={styles.switches}>
          {REVIEW_TOGGLES.map((toggle) => (
            <Switch
              key={toggle.key}
              checked={circulation.reviewConfig[toggle.key]}
              onChange={(next) => setReview(toggle.key, next)}
              label={toggle.label}
            />
          ))}
        </div>
        {!circulation.reviewConfig.returnToRecipient && (
          <p className={styles.note}>{RETURN_OFF_NOTE}</p>
        )}
        {/* The one setting with any reach backwards, said plainly: feedback
            already returned stays on the response it was copied onto. */}
        <p className={styles.note}>
          These apply to responses returned from now on. Feedback already sent back
          stays as it was.
        </p>
      </Card>

      <Card as="section" padding="md" className={styles.card}>
        <h3 className={styles.cardTitle}>Notifications</h3>
        <ul className={styles.events}>
          {NOTIFICATION_ROWS.map((row) => (
            <li key={row.event} className={styles.event}>
              <div className={styles.eventText}>
                <span className={styles.eventLabel}>{row.label}</span>
                <span className={styles.eventDescription}>{row.description}</span>
                {/* Only an admin can turn the scheduler job on, so only an
                    admin is told it is off. See DUE_SOON_NOT_LIVE_NOTE. */}
                {row.event === "dueSoon" && isAdmin && (
                  <span className={styles.eventNote}>{DUE_SOON_NOT_LIVE_NOTE}</span>
                )}
              </div>
              <div className={styles.eventChannels}>
                <Switch
                  checked={circulation.notifications[row.event].email}
                  onChange={(next) => setChannel(row.event, "email", next)}
                  label={CHANNEL_LABELS.email}
                />
                <Switch
                  checked={circulation.notifications[row.event].push}
                  onChange={(next) => setChannel(row.event, "push", next)}
                  label={CHANNEL_LABELS.push}
                />
              </div>
            </li>
          ))}
        </ul>
        <p className={styles.note}>
          Switching one off stops the next message of that kind. It cannot unsend one
          that has already gone.
        </p>
      </Card>
    </div>
  );
}
