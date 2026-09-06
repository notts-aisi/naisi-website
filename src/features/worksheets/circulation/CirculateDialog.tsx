"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import Button from "@/components/ui/Button";
import DateTimePopover from "@/components/ui/DateTimePopover";
import { MEMBER_NAME_FALLBACK } from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import Switch from "@/components/ui/Switch";
import SlotListEditor from "@/features/reminders/SlotListEditor";
import {
  CIRCULATION_LIMITS,
  DEFAULT_REVIEW_CONFIG,
  normalizeNotifications,
  type NotificationEvent,
  type NotificationToggles,
  type ReviewConfig,
} from "@/lib/firestore/circulations";
import { questionsOf, type WorksheetDoc } from "@/lib/firestore/worksheets";
import { validateSlots, type ReminderSlot } from "@/lib/reminders/slots";
import RecipientPicker from "./RecipientPicker";
import { REVIEW_TOGGLES, RETURN_OFF_NOTE } from "./circulationView";
import {
  CHANNEL_LABELS,
  DUE_SOON_ANCHOR_LABEL,
  DUE_SOON_NOT_LIVE_NOTE,
  DUE_SOON_NO_DATE_NOTE,
  NOTIFICATION_ROWS,
} from "./notificationCopy";
import { useRecipientCandidates } from "./useRecipientCandidates";
import styles from "./CirculateDialog.module.css";

/**
 * "Circulate this worksheet": pick people, pick reviewers, set the review
 * toggles and the messages, send.
 *
 * ONE ACT, ONE DIALOG. The alternative shape (create an empty circulation,
 * then configure it) was not taken because every setting here changes what the
 * FIRST batch of recipients is told: the assigned email fires from this same
 * request, the review toggles decide whether a submitted task turns green or
 * queues for review, and a due date that arrives after the mail does is a date
 * nobody was told about. So nothing is written until Send.
 *
 * Everything else about the circulation is server-owned. This dialog posts a
 * description of what it wants and reads back an id; it never writes Firestore
 * directly, because creating a circulation copies a worksheet, writes one
 * response document and one task per recipient, and sends mail.
 */

type Props = {
  worksheet: WorksheetDoc;
  onClose: () => void;
  onCreated: (circulationId: string) => void;
};

export default function CirculateDialog({ worksheet, onClose, onCreated }: Props) {
  const { user, role } = useAuth();
  const senderUid = user?.uid ?? null;
  const isAdmin = role === "admin";

  const { candidates, loading, error: candidatesError } = useRecipientCandidates();

  const [recipientUids, setRecipientUids] = useState<string[]>([]);
  /**
   * The reviewers the sender ADDED. The sender themselves is held separately
   * and merged below, because `useAuth` resolves asynchronously: seeding this
   * state with their uid would seed it with null on the first render and there
   * is no honest way to correct that later without fighting the user's own
   * edits.
   */
  const [extraReviewerUids, setExtraReviewerUids] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState<Date | null>(null);
  /**
   * The documented resolution of a worksheet's stored default (it normalises
   * to null when the map is absent or partial, so the fallback constant is
   * applied here rather than twice in the model), SPREAD into a new object so
   * the switches below cannot edit the exported constant every other caller
   * reads.
   */
  const [reviewConfig, setReviewConfig] = useState<ReviewConfig>(() => ({
    ...(worksheet.defaultReviewConfig ?? DEFAULT_REVIEW_CONFIG),
  }));
  /**
   * `normalizeNotifications(undefined)` rather than a copy of
   * `DEFAULT_NOTIFICATIONS`: it returns a FRESH object every call, so this
   * dialog's edits cannot reach into the exported constant that every other
   * caller reads, and the defaults stay written down in exactly one place.
   */
  const [notifications, setNotifications] = useState<NotificationToggles>(() =>
    normalizeNotifications(undefined),
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * The circulation that EXISTS but has nobody in it.
   *
   * The create route writes the circulation first and mints the recipients
   * second, so a failure between the two leaves a real document, and it names
   * that document in its 500 precisely so the sender can go and finish the job.
   * Holding the id here turns Send off: pressing it again would not retry the
   * minting, it would create a second circulation and send a second round of
   * "you have been assigned" mail for the same worksheet.
   */
  const [strandedId, setStrandedId] = useState<string | null>(null);

  const sectionId = useId();

  const reviewerUids = useMemo(() => {
    if (!senderUid) return extraReviewerUids;
    return [senderUid, ...extraReviewerUids.filter((uid) => uid !== senderUid)];
  }, [senderUid, extraReviewerUids]);

  const questionCount = useMemo(() => questionsOf(worksheet.items).length, [worksheet.items]);

  /**
   * People chosen as both. The route allows it and there are real reasons to
   * want it (a facilitator answering the same worksheet they mark), but a
   * reviewer is in `staffUids` and therefore reads EVERY response, so choosing
   * somebody twice quietly hands one recipient the rest of the room's answers.
   * Said out loud here rather than refused, because refusing it would be this
   * dialog overruling the route about who may be staff.
   */
  const bothNames = useMemo(() => {
    const nameByUid = new Map(candidates.map((c) => [c.uid, c.displayName] as const));
    const chosen = new Set(recipientUids);
    return reviewerUids
      .filter((uid) => chosen.has(uid))
      .map((uid) => nameByUid.get(uid)?.trim() || MEMBER_NAME_FALLBACK);
  }, [candidates, recipientUids, reviewerUids]);

  function setReview(key: keyof ReviewConfig, value: boolean) {
    setReviewConfig((prev) => ({ ...prev, [key]: value }));
  }

  function setChannel(event: NotificationEvent, channel: "email" | "push", value: boolean) {
    // `dueSoon` is spelled out rather than reached through the computed key,
    // because it is the one event carrying a third field (its schedule) and
    // the widened key would let a rebuild of the map drop it.
    setNotifications((prev) =>
      event === "dueSoon"
        ? { ...prev, dueSoon: { ...prev.dueSoon, [channel]: value } }
        : { ...prev, [event]: { ...prev[event], [channel]: value } },
    );
  }

  function setSlots(slots: ReminderSlot[]) {
    setNotifications((prev) => ({ ...prev, dueSoon: { ...prev.dueSoon, slots } }));
  }

  /**
   * A schedule the create route would refuse, held here so the refusal is a
   * sentence under the row that caused it rather than a 400 after the send
   * has been attempted. Send is off while there is one.
   */
  const slotProblems = validateSlots(notifications.dueSoon.slots);

  async function send() {
    // The button is already off for each of these. Repeated here because a
    // schedule with a half-typed row in it carries `NaN`, and a `NaN` that
    // reaches the route is a 400 at best and a stored non-number at worst.
    if (recipientUids.length === 0 || sending || slotProblems.length > 0) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/worksheets/circulations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          worksheetId: worksheet.id,
          recipientUids,
          reviewerUids,
          dueDate: dueDate ? dueDate.toISOString() : null,
          reviewConfig,
          notifications,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { circulationId?: string; error?: string }
        | null;
      if (!res.ok || !body?.circulationId) {
        // The route's own sentence, verbatim. It knows things this dialog does
        // not (the worksheet was deleted, the cap was exceeded, the permission
        // was revoked between opening this and pressing Send).
        setSendError(body?.error ?? `Couldn't send this worksheet (${res.status}).`);
        // A failure that still names a circulation is the half-written one: see
        // `strandedId`. Sending again is the wrong move and the link is the
        // right one.
        if (body?.circulationId) setStrandedId(body.circulationId);
        setSending(false);
        return;
      }
      onCreated(body.circulationId);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Couldn't send this worksheet.");
      setSending(false);
    }
  }

  const sendLabel = sending
    ? "Sending…"
    : `Send to ${recipientUids.length} ${recipientUids.length === 1 ? "person" : "people"}`;

  return (
    <Modal open onClose={onClose} ariaLabel={`Circulate: ${worksheet.title}`} width="md">
      <div className={styles.dialog}>
        <header className={styles.head}>
          <h2 className={styles.title}>Circulate: {worksheet.title}</h2>
          <p className={styles.subtitle}>
            {questionCount === 0
              ? "This worksheet has no questions yet. You can still send it, but there will be nothing to answer."
              : `${questionCount} question${questionCount === 1 ? "" : "s"}. Everyone you pick gets their own copy and their own task.`}
          </p>
        </header>

        <section className={styles.section} aria-labelledby={`${sectionId}-recipients`}>
          <h3 className={styles.sectionTitle} id={`${sectionId}-recipients`}>
            Recipients
          </h3>
          <RecipientPicker
            candidates={candidates}
            loading={loading}
            error={candidatesError}
            selected={recipientUids}
            onChange={setRecipientUids}
            ariaLabel="Recipients"
            max={CIRCULATION_LIMITS.maxRecipientsPerRequest}
            disabled={sending}
          />
        </section>

        <section className={styles.section} aria-labelledby={`${sectionId}-reviewers`}>
          <h3 className={styles.sectionTitle} id={`${sectionId}-reviewers`}>
            Reviewers
          </h3>
          <p className={styles.note}>
            Up to {CIRCULATION_LIMITS.maxReviewers}, including you. Reviewers read every
            response and write the feedback.
          </p>
          <RecipientPicker
            candidates={candidates}
            loading={loading}
            error={candidatesError}
            selected={reviewerUids}
            onChange={(next) => setExtraReviewerUids(next.filter((uid) => uid !== senderUid))}
            ariaLabel="Reviewers"
            pinnedUids={senderUid ? [senderUid] : []}
            max={CIRCULATION_LIMITS.maxReviewers}
            compact
            disabled={sending}
          />
          {bothNames.length > 0 && (
            <p className={styles.warnNote}>
              {bothNames.join(", ")} {bothNames.length === 1 ? "is" : "are"} answering this
              and reviewing it, so they can read everybody else&apos;s answers.
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby={`${sectionId}-due`}>
          <h3 className={styles.sectionTitle} id={`${sectionId}-due`}>
            Due date
          </h3>
          <div className={styles.dueRow}>
            <DateTimePopover
              value={dueDate}
              onChange={setDueDate}
              disabled={sending}
              placeholder="No due date"
            />
            {dueDate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDueDate(null)}
                disabled={sending}
              >
                Clear
              </Button>
            )}
          </div>
        </section>

        <section className={styles.section} aria-labelledby={`${sectionId}-review`}>
          <h3 className={styles.sectionTitle} id={`${sectionId}-review`}>
            Review
          </h3>
          <div className={styles.switches}>
            {REVIEW_TOGGLES.map((toggle) => (
              <Switch
                key={toggle.key}
                checked={reviewConfig[toggle.key]}
                onChange={(next) => setReview(toggle.key, next)}
                label={toggle.label}
                disabled={sending}
              />
            ))}
          </div>
          {!reviewConfig.returnToRecipient && <p className={styles.note}>{RETURN_OFF_NOTE}</p>}
        </section>

        <section className={styles.section} aria-labelledby={`${sectionId}-notifications`}>
          <h3 className={styles.sectionTitle} id={`${sectionId}-notifications`}>
            Notifications
          </h3>
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
                    checked={notifications[row.event].email}
                    onChange={(next) => setChannel(row.event, "email", next)}
                    label={CHANNEL_LABELS.email}
                    disabled={sending}
                  />
                  <Switch
                    checked={notifications[row.event].push}
                    onChange={(next) => setChannel(row.event, "push", next)}
                    label={CHANNEL_LABELS.push}
                    disabled={sending}
                  />
                </div>
                {/* The schedule belongs to the reminder, so it sits under the
                    reminder's own row and spans both columns rather than
                    becoming a section of its own. With no due date there is
                    nothing to count back from, and saying so here is more use
                    than an editor whose rows could never resolve. */}
                {row.event === "dueSoon" &&
                  (dueDate ? (
                    <div className={styles.eventExtra}>
                      <SlotListEditor
                        slots={notifications.dueSoon.slots}
                        onChange={setSlots}
                        anchorLabel={DUE_SOON_ANCHOR_LABEL}
                        anchorAt={dueDate}
                        disabled={sending}
                      />
                    </div>
                  ) : (
                    <p className={styles.eventExtraNote}>
                      {DUE_SOON_NO_DATE_NOTE}
                    </p>
                  ))}
              </li>
            ))}
          </ul>
        </section>

        {sendError && (
          <div className={styles.errorBox} role="status">
            <p className={styles.error}>{sendError}</p>
            {strandedId && (
              <Link
                href={`/worksheets/${worksheet.id}/circulations/${strandedId}`}
                className={styles.errorLink}
              >
                Open it and add people
              </Link>
            )}
          </div>
        )}

        <footer className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={send}
            disabled={
              sending ||
              recipientUids.length === 0 ||
              strandedId !== null ||
              slotProblems.length > 0
            }
          >
            {sendLabel}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
