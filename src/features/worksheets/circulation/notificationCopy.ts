/**
 * The words on the notification switches, in one place.
 *
 * The LABELS and the descriptions themselves live in
 * `src/lib/firestore/circulations.ts`, beside the event union they describe,
 * because the email senders read them too. What lives here is the presentation
 * layer's own copy: the two channel names, and the one note that is not about
 * an event at all but about this environment.
 *
 * That note is the reason this file exists rather than a couple of literals
 * inside the dialog. `docs/worksheets.md` ships the due-soon reminder job dark
 * (`enabledByDefault: false`, and no tick at all without `SCHEDULER_SECRET`),
 * so the switch beside it is honest about being wired and not yet firing. When
 * the scheduler is turned on, exactly one string has to be deleted, and it is
 * findable by name rather than by reading two components.
 */
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_DESCRIPTIONS,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEvent,
  type NotificationToggles,
} from "@/lib/firestore/circulations";

export type NotificationRow = {
  event: NotificationEvent;
  label: string;
  description: string;
};

/**
 * One row per event, in the order the union declares them, so the dialog and
 * the circulation page's read-only summary cannot drift into two orders.
 */
export const NOTIFICATION_ROWS: NotificationRow[] = NOTIFICATION_EVENTS.map((event) => ({
  event,
  label: NOTIFICATION_EVENT_LABELS[event],
  description: NOTIFICATION_EVENT_DESCRIPTIONS[event],
}));

export const CHANNEL_LABELS = { email: "Email", push: "Push" } as const;

/**
 * Shown to ADMINS ONLY, beside the due-soon switch. Everybody else is better
 * served by a switch that simply does what it says once the job is running;
 * the person who can turn the job on is the person who needs to know it is
 * off. Deleting this line is the last step of enabling the scheduler job.
 */
export const DUE_SOON_NOT_LIVE_NOTE =
  "Reminders are wired but not yet live: the scheduler is not running on this environment yet.";

/**
 * The date a worksheet's reminders count back from, as the phrase the slot
 * editor builds its rows around ("3 days before the due date at 10:00").
 *
 * A constant rather than a literal in each of the two surfaces that mount the
 * editor, because the two must agree: a sender who sets a schedule in the
 * dialog and reads it back on the circulation page is reading the same rows,
 * and two spellings of the anchor would make them look like two settings.
 * The admission rounds pass their own phrase ("the closing date").
 */
export const DUE_SOON_ANCHOR_LABEL = "the due date";

/**
 * Shown in place of the schedule when the circulation has no due date.
 *
 * The editor is hidden rather than disabled: every row it could show would
 * count back from a date that does not exist, so there is nothing honest for
 * it to say. This sentence names the field that fixes it instead.
 */
export const DUE_SOON_NO_DATE_NOTE = "Set a due date to schedule reminders.";

/**
 * A plain-English list of what this circulation will send, for the read-only
 * summary on the circulation page. An event with both channels off is dropped
 * rather than listed as "off", because a summary of eleven lines where six say
 * nothing happens is not a summary.
 */
export function notificationSummaryOf(
  toggles: NotificationToggles,
): { event: NotificationEvent; label: string; channels: string }[] {
  const out: { event: NotificationEvent; label: string; channels: string }[] = [];
  for (const row of NOTIFICATION_ROWS) {
    const toggle = toggles[row.event];
    if (!toggle) continue;
    const channels: string[] = [];
    if (toggle.email) channels.push(CHANNEL_LABELS.email);
    if (toggle.push) channels.push(CHANNEL_LABELS.push);
    if (channels.length === 0) continue;
    out.push({ event: row.event, label: row.label, channels: channels.join(" and ") });
  }
  return out;
}
