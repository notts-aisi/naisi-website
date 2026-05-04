import "server-only";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { emailDocId, normaliseEmail } from "./emailDocId";

/**
 * Junction collection for newsletter / events / cohort-channel subscriptions.
 * Each row is one (recipient, channel) pair. Replaces per-doc booleans on
 * `users/{uid}.profile.notifications.categories` (members) and the previously
 * planned `subscribers/{id}.subscriptions` shape (guests).
 *
 * Why a junction table:
 *  - Adding a new channel (e.g. `cohort:fall-2026`) is data, not schema.
 *  - "Who's subscribed to channel X?" is a single indexed query on
 *    `(channel, status)` — no full-collection scans of users.
 *  - Member-migration on register is a row-level audience flip
 *    (`guest` → `user`), no merge / delete / duplicate-up risk.
 *
 * Doc-id convention: `sub_<sanitisedEmail>__<channel>`. The slug prefix keeps
 * Firestore browseable (project-wide cleanup-sweep memory). The
 * (sanitisedEmail, channel) suffix is deterministic, so the same pair always
 * maps to the same doc — `set({ merge: true })` gives idempotent upserts.
 *
 * Channel-string convention:
 *  - Top-level lists: lowercase, no prefix. `newsletter`, `events`.
 *  - Scoped lists: `<scope>:<id>`, lowercase kebab after the colon.
 *    Examples: `cohort:fall-2026`, `track:technical`. The colon is purely
 *    informational here — nothing in PR 1 parses it. PR 3 introduces a
 *    `channels/{channelId}` registry collection if/when cohort metadata is
 *    needed.
 *
 * Confirmation is per-EMAIL, not per-channel: once any one row for an email
 * is `confirmed`, subsequent subscriptions for that email mint as
 * `confirmed` directly. The confirmation flow is the inbox-control gate; we
 * gate it once per address, not once per channel.
 */

export type SubscriptionAudience = "user" | "guest";
export type SubscriptionStatus = "pending" | "confirmed" | "unsubscribed";

export type SubscriptionDoc = {
  email: string;
  channel: string;
  audience: SubscriptionAudience;
  audienceId: string;

  /**
   * Optional first name / preferred name captured at signup. Used to greet
   * the recipient in transactional emails ("Hi Marie,") and to give admins
   * a human label in the Subscriptions table. Optional because guests may
   * decline to provide it and pre-name-capture rows pre-date the field.
   */
  name?: string;

  status: SubscriptionStatus;
  source: string;

  createdAt: Timestamp;
  confirmedAt?: Timestamp;
  unsubscribedAt?: Timestamp;
  lastSentAt?: Timestamp;

  lastAttemptAt?: Timestamp;
  attemptCount?: number;
};

const COLLECTION = "subscriptions";

/** `^[a-z0-9:_-]+$` — kept loose enough for `cohort:fall-2026`-style ids. */
const CHANNEL_RE = /^[a-z0-9:_-]+$/;
const CHANNEL_MAX_LEN = 80;

export function isValidChannel(channel: string): boolean {
  return (
    typeof channel === "string" &&
    channel.length > 0 &&
    channel.length <= CHANNEL_MAX_LEN &&
    CHANNEL_RE.test(channel)
  );
}

function prettifySlug(slug: string): string {
  return slug
    .split("-")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Human-readable label for a channel id, used in emails and the unsubscribe
 * confirmation page. Top-level channels get hand-written labels; scoped
 * channels (`cohort:*`, `track:*`) fall through to a slug-prettify so
 * channels added in PR 3 / later read sensibly without code changes here.
 */
export function channelLabel(channel: string): string {
  if (channel === "all") return "all NAISI emails";
  if (channel === "newsletter") return "our newsletter";
  if (channel === "events") return "event announcements";
  if (channel.startsWith("cohort:")) {
    return `the ${prettifySlug(channel.slice("cohort:".length))} cohort updates`;
  }
  if (channel.startsWith("track:")) {
    return `the ${prettifySlug(channel.slice("track:".length))} track updates`;
  }
  return prettifySlug(channel);
}

export function subscriptionDocId(args: {
  email: string;
  channel: string;
}): string {
  return `sub_${emailDocId(args.email)}__${args.channel}`;
}

/**
 * Has any row for this email reached `confirmed` status? Used by `subscribe`
 * to decide whether a new row should mint as `pending` (first-time
 * confirmation needed) or shortcut to `confirmed` (the inbox already proved
 * itself on a previous channel).
 */
export async function hasAnyConfirmedRowForEmail(
  db: Firestore,
  email: string,
): Promise<boolean> {
  const e = normaliseEmail(email);
  if (!e) return false;
  const snap = await db
    .collection(COLLECTION)
    .where("email", "==", e)
    .where("status", "==", "confirmed")
    .limit(1)
    .get();
  return !snap.empty;
}

export type SubscribeArgs = {
  email: string;
  channel: string;
  audience: SubscriptionAudience;
  audienceId: string;
  source: string;
  /**
   * Optional human name to store on the row. Only written if non-empty after
   * trim, so leaving the form's name field blank does not stamp an empty
   * string. On re-subscribe with a new value, the more-recent one wins.
   */
  name?: string;
};

export type SubscribeResult = {
  /** True iff a brand-new doc was created for this (email, channel). */
  created: boolean;
  /**
   * True iff this row is now `pending` and a confirmation email should be
   * sent. False if it shortcut to `confirmed` (because another row for the
   * same email is already confirmed) — no opt-in click needed.
   */
  requiresConfirmation: boolean;
  /** True iff the caller-requested channel was newly added in this call. */
  newlyAddedChannel: boolean;
  /** Final status of the row after this call. */
  status: SubscriptionStatus;
};

/**
 * Idempotent upsert. Sets the row's status:
 *  - `pending` if creating fresh and no other row for this email is confirmed
 *  - `confirmed` otherwise (existing row was already confirmed; OR another
 *    row for the same email is confirmed and this one rides on it; OR the
 *    caller is a signed-in member, in which case the caller passes
 *    `audience: "user"` and the route enforces the auth check before getting
 *    here, so we trust the caller and skip the click-confirm)
 *
 * The `lastAttemptAt` / `attemptCount` fields are bumped on every call as a
 * cheap per-email cooldown floor (used by the API route).
 */
export async function subscribe(
  db: Firestore,
  args: SubscribeArgs,
): Promise<SubscribeResult> {
  const email = normaliseEmail(args.email);
  if (!email) throw new Error("subscribe: empty email");
  if (!isValidChannel(args.channel)) {
    throw new Error(`subscribe: invalid channel "${args.channel}"`);
  }

  const ref = db
    .collection(COLLECTION)
    .doc(subscriptionDocId({ email, channel: args.channel }));

  const now = Timestamp.now();
  const snap = await ref.get();
  const data = snap.data() as SubscriptionDoc | undefined;

  // Members come in already-trusted (the route checked their session). Their
  // rows skip the click-confirm flow entirely — same as if any other row for
  // this email were already confirmed.
  const memberShortcut = args.audience === "user";
  const inboxAlreadyProven =
    memberShortcut || (await hasAnyConfirmedRowForEmail(db, email));

  const trimmedName = args.name?.trim();

  if (!snap.exists) {
    const initialStatus: SubscriptionStatus = inboxAlreadyProven
      ? "confirmed"
      : "pending";
    const doc: Record<string, unknown> = {
      email,
      channel: args.channel,
      audience: args.audience,
      audienceId: args.audienceId,
      status: initialStatus,
      source: args.source,
      createdAt: now,
      lastAttemptAt: now,
      attemptCount: 1,
    };
    if (initialStatus === "confirmed") doc.confirmedAt = now;
    if (trimmedName) doc.name = trimmedName;
    await ref.set(doc);
    return {
      created: true,
      requiresConfirmation: initialStatus === "pending",
      newlyAddedChannel: true,
      status: initialStatus,
    };
  }

  // Existing row. Possible states:
  //  - confirmed: nothing to do beyond touching attempt counters.
  //  - pending: re-send confirmation (caller decides via requiresConfirmation).
  //  - unsubscribed: resurrect — flip back to pending unless inbox-already-
  //    proven (member shortcut), in which case go straight to confirmed.
  const patch: Record<string, unknown> = {
    lastAttemptAt: now,
    attemptCount: FieldValue.increment(1),
    // Audience can change over a row's lifetime: a guest signs up, then later
    // registers and the row is claimed. We don't downgrade user→guest here;
    // that would only happen via an explicit admin action.
  };
  if (data?.audience === "guest" && args.audience === "user") {
    patch.audience = "user";
    patch.audienceId = args.audienceId;
  }
  // More-recent name wins. Only patch when the caller actually supplied one,
  // so a sync call without a name does not wipe a previously-stored value.
  if (trimmedName) patch.name = trimmedName;

  let nextStatus: SubscriptionStatus = data?.status ?? "pending";
  let requiresConfirmation = false;
  let newlyAddedChannel = false;

  if (data?.status === "unsubscribed") {
    newlyAddedChannel = true; // re-adding a channel they previously dropped
    if (inboxAlreadyProven) {
      nextStatus = "confirmed";
      patch.status = "confirmed";
      patch.confirmedAt = data?.confirmedAt ?? now;
      patch.unsubscribedAt = FieldValue.delete();
    } else {
      nextStatus = "pending";
      patch.status = "pending";
      patch.unsubscribedAt = FieldValue.delete();
      requiresConfirmation = true;
    }
  } else if (data?.status === "pending") {
    requiresConfirmation = true;
    if (inboxAlreadyProven) {
      // A second channel just got confirmed elsewhere; promote this one too.
      nextStatus = "confirmed";
      patch.status = "confirmed";
      patch.confirmedAt = now;
      requiresConfirmation = false;
    }
  }

  await ref.update(patch);

  return {
    created: false,
    requiresConfirmation,
    newlyAddedChannel,
    status: nextStatus,
  };
}

/**
 * Stamp every `pending` row for this email as `confirmed`. Idempotent — safe
 * to run after the user is already confirmed (no-op).
 */
export async function confirmAllForEmail(
  db: Firestore,
  email: string,
): Promise<{ updated: number; channels: string[] }> {
  const e = normaliseEmail(email);
  if (!e) return { updated: 0, channels: [] };
  const snap = await db
    .collection(COLLECTION)
    .where("email", "==", e)
    .where("status", "==", "pending")
    .get();
  if (snap.empty) {
    // Already confirmed (or no rows). Return the active channel list anyway
    // so the welcome email can name them.
    const active = await db
      .collection(COLLECTION)
      .where("email", "==", e)
      .where("status", "==", "confirmed")
      .get();
    return {
      updated: 0,
      channels: active.docs.map((d) => (d.data() as SubscriptionDoc).channel),
    };
  }
  const batch = db.batch();
  const now = Timestamp.now();
  const channels: string[] = [];
  for (const doc of snap.docs) {
    batch.update(doc.ref, { status: "confirmed", confirmedAt: now });
    channels.push((doc.data() as SubscriptionDoc).channel);
  }
  await batch.commit();
  // Return all currently-confirmed channels (the freshly-confirmed batch plus
  // any pre-existing ones), so the welcome email can name everything they're
  // signed up to.
  const after = await db
    .collection(COLLECTION)
    .where("email", "==", e)
    .where("status", "==", "confirmed")
    .get();
  const allChannels = Array.from(
    new Set(
      after.docs.map((d) => (d.data() as SubscriptionDoc).channel),
    ),
  );
  return { updated: snap.size, channels: allChannels };
}

/**
 * Flip one row to `unsubscribed`. Idempotent — repeated calls just touch the
 * timestamp. Returns true if a row existed (regardless of prior status), so
 * the caller can distinguish "found and updated" from "no such row".
 */
export async function unsubscribe(
  db: Firestore,
  args: { email: string; channel: string },
): Promise<boolean> {
  const email = normaliseEmail(args.email);
  if (!email || !isValidChannel(args.channel)) return false;
  const ref = db
    .collection(COLLECTION)
    .doc(subscriptionDocId({ email, channel: args.channel }));
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({
    status: "unsubscribed",
    unsubscribedAt: Timestamp.now(),
  });
  return true;
}

/**
 * Flip every active row for this email to `unsubscribed`. Used by the
 * "unsubscribe from all" path (token with `c: "all"`).
 */
export async function unsubscribeAll(
  db: Firestore,
  email: string,
): Promise<number> {
  const e = normaliseEmail(email);
  if (!e) return 0;
  const snap = await db
    .collection(COLLECTION)
    .where("email", "==", e)
    .get();
  if (snap.empty) return 0;
  const batch = db.batch();
  const now = Timestamp.now();
  let count = 0;
  for (const doc of snap.docs) {
    const status = (doc.data() as SubscriptionDoc).status;
    if (status === "unsubscribed") continue;
    batch.update(doc.ref, { status: "unsubscribed", unsubscribedAt: now });
    count += 1;
  }
  if (count > 0) await batch.commit();
  return count;
}

/**
 * Migrate rows from guest → user audience. Run when a guest signs up for a
 * full account: any `subscriptions` rows tied to their email get re-pointed
 * at their uid. Idempotent — running on an email with no guest rows is a
 * no-op. Running twice is a no-op (rows are already user-audience).
 */
export async function claimGuestSubscriptions(
  db: Firestore,
  args: { email: string; uid: string },
): Promise<number> {
  const email = normaliseEmail(args.email);
  if (!email || !args.uid) return 0;
  const snap = await db
    .collection(COLLECTION)
    .where("email", "==", email)
    .where("audience", "==", "guest")
    .get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { audience: "user", audienceId: args.uid });
  }
  await batch.commit();
  return snap.size;
}

/**
 * Read-side helper for member settings UI: which channels does this user
 * (audienceId === uid) currently have an active subscription on?
 */
export async function findActiveSubscriptions(
  db: Firestore,
  args: { audienceId: string },
): Promise<SubscriptionDoc[]> {
  if (!args.audienceId) return [];
  const snap = await db
    .collection(COLLECTION)
    .where("audienceId", "==", args.audienceId)
    .get();
  return snap.docs
    .map((d) => d.data() as SubscriptionDoc)
    .filter((d) => d.status !== "unsubscribed");
}

export type ChannelRecipient = {
  email: string;
  audience: SubscriptionAudience;
  audienceId: string;
};

/**
 * Read-side helper for the digest sender: every confirmed recipient on a
 * given channel. The sender uses `email` directly for guest rows; for user
 * rows it can optionally hydrate the user doc to apply gmail/uniEmail
 * channel-routing rules (existing `addressesForSend` logic).
 */
export async function findRecipientsForChannel(
  db: Firestore,
  channel: string,
): Promise<ChannelRecipient[]> {
  if (!isValidChannel(channel)) return [];
  const snap = await db
    .collection(COLLECTION)
    .where("channel", "==", channel)
    .where("status", "==", "confirmed")
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as SubscriptionDoc;
    return {
      email: data.email,
      audience: data.audience,
      audienceId: data.audienceId,
    };
  });
}
