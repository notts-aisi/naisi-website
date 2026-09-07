import "server-only";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

/**
 * THE NOTICE LANE'S CAPS.
 *
 * A notice reaches its audience whatever their notification grid says, so the
 * usual backstop is gone: nobody on the receiving end can turn the volume down.
 * The volume is therefore bounded on the sending side, and it is bounded
 * DURABLY, in Firestore, for the reason `reserveSendSlot` already gives in
 * `courseFacilitatorEmails.ts`: `lib/rateLimit.ts` is per instance and forgets
 * on a cold start, which is the right trade for an anonymous public route and
 * the wrong one for real mail to real members.
 *
 * ── THE SHAPE IS THE ROOM NOTICE'S, DELIBERATELY ────────────────────────────
 * Same collection (`courseNudges`), same `emailrate__` doc-id prefix, same
 * document fields, same claim-then-count discipline: the slot is spent when the
 * send is ATTEMPTED, not when it succeeds, because a request that dies half way
 * through a forty-person dispatch has already delivered part of the mail and
 * its retry has to be rationed like any other send. Fail closed is the only
 * safe direction for a throttle on outbound mail.
 *
 * The collection name is course-flavoured for historical reasons (the course
 * email routes needed a durable counter first) and it is the key PREFIX, not
 * the collection, that separates the lanes. Reusing it is what lets
 * every existing counter carry on counting: the group email route and the run
 * composer pass the SAME keys they passed to `reserveSendSlot`, so a facilitator
 * who has sent two emails this hour still has one slot, not three. It also
 * means this ships with no `firestore.rules` change, which matters because a
 * rules edit landing ahead of or behind its code has broken production here
 * before. `firestore.rules` already locks `courseNudges` to `read, write: if
 * false` as server-side email bookkeeping.
 *
 * ── TWO WINDOWS, ONE TRANSACTION ────────────────────────────────────────────
 * The lane's caps are 3 an hour per (sender, audience) and 10 a day per
 * audience: the first stops one person's runaway composer, the second stops an
 * audience being mailed ten times by five different people. Claiming them in
 * two separate transactions would spend the hour slot on a send the day cap
 * then refuses, so both are read and both are written inside ONE transaction,
 * and a refusal on either leaves both counters untouched. Firestore wants every
 * read before every write, which is what the two-phase body below is.
 *
 * Either window may be omitted. The room notice omits the hourly one on
 * purpose: v2 decision 8 requires that lane to survive the evening where the
 * room changes twice and the mode flips once, and its 10-a-day per-group
 * counter is the cap that decision pinned. An omitted window is stated at the
 * call site, never defaulted here.
 *
 * ── AND A REFUSAL, NEVER A TRUNCATION ───────────────────────────────────────
 * {@link MAX_NOTICE_RECIPIENTS} is a ceiling the whole request FAILS against.
 * A partial send is the worst outcome available to this feature because it
 * looks successful: an arbitrary three hundred get the mail, the report says
 * three hundred sent and none skipped, and the retry re-mails the same three
 * hundred. Lanes with a TIGHTER ceiling of their own keep it (the group routes
 * refuse over 100, the cohort resolver over 200); this is the lane's outer
 * bound, not a licence to raise theirs.
 */

/** Where the estate's durable send counters live. See the header. */
const THROTTLE_COLLECTION = "courseNudges";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Notices an hour per (sender, audience). */
export const NOTICES_PER_HOUR = 3;
/** Notices a day per audience, whoever sends them. */
export const NOTICES_PER_DAY = 10;

/**
 * The lane's outer recipient bound. A request over it is REFUSED, not trimmed.
 * Both event lanes judge against this; the course lanes' own ceilings are
 * lower and stay where they are.
 */
export const MAX_NOTICE_RECIPIENTS = 300;

/** One window to claim: the counter's key, its limit, and how long it runs. */
export type NoticeWindow = {
  /** Appended to the `emailrate__` prefix. Existing lanes pass existing keys. */
  key: string;
  limit: number;
  windowMs: number;
};

export type NoticeSlotClaim = {
  ok: boolean;
  /** The sentence to hand back verbatim on a refusal. Null when `ok`. */
  refusal: string | null;
  /** Seconds until the refusing window rolls over. 0 when `ok`. */
  retryAfterSeconds: number;
  /**
   * Slots left in each claimed window AFTER this claim, or null for a window
   * this call did not claim. Computed inside the transaction because it is the
   * only place that has seen the committed count: a caller re-reading the
   * counter afterwards would race the next send and report a number that was
   * never true.
   */
  remaining: { hour: number | null; day: number | null };
};

function windowStartMs(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return 0;
}

type WindowState = {
  window: NoticeWindow;
  ref: FirebaseFirestore.DocumentReference;
  startedAt: number;
  count: number;
  inWindow: boolean;
};

/**
 * The refusal a recipient count over the ceiling earns. Exported so a lane can
 * word its own limit the same way; `max` is the lane's ceiling, not necessarily
 * {@link MAX_NOTICE_RECIPIENTS}.
 */
export function noticeRecipientRefusal(count: number, max: number, advice: string): string {
  return (
    `This notice would go to ${count} people, over the ${max}-recipient limit for a ` +
    `single send. Nothing was sent: ${advice}.`
  );
}

/**
 * Claim one notice against every window given, atomically, or refuse and claim
 * none of them.
 */
export async function reserveNoticeSlots(
  db: Firestore,
  args: {
    hour?: NoticeWindow | null;
    day?: NoticeWindow | null;
    /**
     * The noun the refusal sentences use: "notices", "emails", "announcements".
     * Named per lane because a facilitator reads the sentence in a composer
     * that has its own word for what they just wrote.
     */
    noun: string;
  },
): Promise<NoticeSlotClaim> {
  const windows: Array<{ slot: "hour" | "day"; window: NoticeWindow }> = [];
  if (args.hour) windows.push({ slot: "hour", window: args.hour });
  if (args.day) windows.push({ slot: "day", window: args.day });
  if (windows.length === 0) {
    // A lane that claims nothing is a lane with no cap, which this helper must
    // not quietly grant. Callers state their windows; an empty call is a bug.
    throw new Error("reserveNoticeSlots was given no window to claim.");
  }

  return db.runTransaction(async (tx) => {
    const now = Date.now();

    // Every read first: Firestore refuses a read after a write in the same
    // transaction, and a refusal has to be decided across BOTH windows before
    // either is incremented.
    const states: Array<{ slot: "hour" | "day"; state: WindowState }> = [];
    for (const { slot, window } of windows) {
      const ref = db.collection(THROTTLE_COLLECTION).doc(`emailrate__${window.key}`);
      const snap = await tx.get(ref);
      const data = snap.data() ?? {};
      const startedAt = windowStartMs(data.windowStartAt);
      const count = typeof data.count === "number" ? data.count : 0;
      states.push({
        slot,
        state: {
          window,
          ref,
          startedAt,
          count,
          inWindow: startedAt > 0 && now - startedAt < window.windowMs,
        },
      });
    }

    for (const { slot, state } of states) {
      if (!state.inWindow || state.count < state.window.limit) continue;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((state.startedAt + state.window.windowMs - now) / 1000),
      );
      const period = slot === "hour" ? "in the last hour" : "in the last day";
      const advice =
        slot === "hour" ? "Try again shortly." : "Try again tomorrow, or ask an admin.";
      return {
        ok: false,
        refusal:
          `This audience has already had ${state.window.limit} ${args.noun} ${period}. ` +
          `Nothing was sent. ${advice}`,
        retryAfterSeconds,
        remaining: { hour: null, day: null },
      };
    }

    const remaining: { hour: number | null; day: number | null } = { hour: null, day: null };
    for (const { slot, state } of states) {
      const claimed = state.inWindow ? state.count + 1 : 1;
      tx.set(state.ref, {
        kind: "staff-email-throttle",
        key: state.window.key,
        windowStartAt: Timestamp.fromMillis(state.inWindow ? state.startedAt : now),
        count: claimed,
        updatedAt: Timestamp.fromMillis(now),
      });
      // Floored at 0: a limit lowered between two sends can leave `claimed`
      // above it, and a negative "remaining" reads as a bug wherever it lands.
      remaining[slot] = Math.max(0, state.window.limit - claimed);
    }

    return { ok: true, refusal: null, retryAfterSeconds: 0, remaining };
  });
}
