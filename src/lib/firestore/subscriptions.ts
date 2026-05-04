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
 *  - "Who is subscribed to channel X right now?" is a single indexed query
 *    on `(channel, confirmed, subscribed)`.
 *  - Member-migration on register is a row-level audience flip
 *    (`guest` → `user`), no merge / delete / duplicate-up risk.
 *
 * Doc-id convention: `sub_<sanitisedEmail>__<channel>`. The slug prefix keeps
 * Firestore browseable. The (sanitisedEmail, channel) suffix is deterministic,
 * so the same pair always maps to the same doc — `set({ merge: true })` gives
 * idempotent upserts.
 *
 * Channel-string convention:
 *  - Top-level lists: lowercase, no prefix. `newsletter`, `events`.
 *  - Scoped lists: `<scope>:<id>`, lowercase kebab after the colon.
 *    Examples: `cohort:fall-2026`, `track:technical`.
 *
 * STATE MODEL (the orthogonal-axes thing):
 *
 * Two separate, orthogonal axes per row, instead of one collapsed enum:
 *
 *   confirmed: boolean             // has this email proven inbox control?
 *   confirmedAt: Timestamp?        // when first confirmed (audit + lifetime stamp)
 *   subscribed: boolean            // does the recipient currently want this channel?
 *   subscribedAt: Timestamp?       // last time it became true (audit)
 *   unsubscribedAt: Timestamp?     // last time it became false (audit, never wiped)
 *
 * Rationale: previously a single `status: pending | confirmed | unsubscribed`
 * collapsed both axes, so re-subscribing after unsubscribing wiped the
 * "they were once confirmed" signal and lost the unsub history. The split
 * keeps a complete audit trail and makes the sender query a clean two-
 * predicate filter (`confirmed && subscribed`).
 *
 * `confirmed` is a sticky-once-true boolean: after a row's confirmedAt is
 * stamped, the boolean never flips back to false. Toggling subscribed
 * doesn't touch confirmed. Re-subscribe is a one-step "set subscribed=true",
 * not a re-confirmation flow, because the inbox is already proven.
 *
 * Confirmation is per-EMAIL, not per-channel: once any one row for an email
 * is confirmed, subsequent subscriptions for that email mint as confirmed
 * directly. The confirmation flow is the inbox-control gate; we gate it
 * once per address, not once per channel.
 */

export type SubscriptionAudience = "user" | "guest";

/**
 * Display state derived from the (confirmed, subscribed) pair. Not stored.
 *  - "subscribed":          confirmed && subscribed                  (delivers email)
 *  - "unsubscribed":        confirmed && !subscribed                 (no email, was confirmed once)
 *  - "pending":             !confirmed && subscribed                 (waiting on click)
 *  - "lapsed":              !confirmed && !subscribed                (signed up, never confirmed, then dropped)
 */
export type SubscriptionDisplayStatus =
  | "subscribed"
  | "unsubscribed"
  | "pending"
  | "lapsed";

export type SubscriptionDoc = {
  email: string;
  channel: string;
  audience: SubscriptionAudience;
  audienceId: string;

  /** Optional first / preferred name. Used to greet in transactional emails. */
  name?: string;

  /** Sticky once true. Set on first confirmation; never reset. */
  confirmed: boolean;
  /** When confirmed first became true. */
  confirmedAt?: Timestamp;

  /** Current state. Toggleable forever. */
  subscribed: boolean;
  /** When subscribed last became true. */
  subscribedAt?: Timestamp;
  /** When subscribed last became false. Never wiped. */
  unsubscribedAt?: Timestamp;

  source: string;
  createdAt: Timestamp;
  lastSentAt?: Timestamp;

  lastAttemptAt?: Timestamp;
  attemptCount?: number;
};

/**
 * Legacy single-axis enum used before the (confirmed, subscribed) split.
 * Only referenced by the migration helper below, which translates rows
 * still carrying it. Backfill nukes the field from the doc once the new
 * fields are in place. Type kept exported for the helper signature; no
 * code path reads this off a `SubscriptionDoc` anymore.
 */
export type LegacyStatus = "pending" | "confirmed" | "unsubscribed";

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
 * channels added later read sensibly without code changes here.
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
 * Derive the four-state display label from a row. Used by the admin UI
 * (Subscriptions table status pill) and other read sites that want a
 * single-string label.
 */
export function displayStatusOf(row: {
  confirmed: boolean;
  subscribed: boolean;
}): SubscriptionDisplayStatus {
  if (row.confirmed && row.subscribed) return "subscribed";
  if (row.confirmed && !row.subscribed) return "unsubscribed";
  if (!row.confirmed && row.subscribed) return "pending";
  return "lapsed";
}

/**
 * Has any row for this email been confirmed at any point? Used by `subscribe`
 * to decide whether a fresh row should mint as confirmed (the inbox already
 * proved itself on a previous channel) or pending (first-time signup).
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
    .where("confirmed", "==", true)
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
   * trim. On re-subscribe with a new value, the more-recent one wins.
   */
  name?: string;
};

export type SubscribeResult = {
  /** True iff a brand-new doc was created for this (email, channel). */
  created: boolean;
  /**
   * True iff this row is now `subscribed && !confirmed` and a confirmation
   * email should be sent. False if it shortcut to confirmed (member or any
   * prior confirmed row for the email).
   */
  requiresConfirmation: boolean;
  /**
   * True iff `subscribed` was newly set to true on this call (either
   * creating a fresh row, or re-subscribing an existing row that was
   * unsubscribed). Used by callers to decide whether to send the
   * "you're now subscribed" notice.
   */
  newlyAddedChannel: boolean;
};

/**
 * Idempotent upsert. Sets `subscribed = true` and stamps `subscribedAt`.
 * Sets `confirmed = true` and stamps `confirmedAt` iff the row's email has
 * any prior confirmation, OR the caller is a signed-in member (`audience:
 * "user"`, trusted by the route).
 *
 * Re-subscribe path: an existing row whose subscribed is currently false
 * just flips back to true. confirmedAt and confirmed are unchanged.
 * unsubscribedAt is left intact as audit history.
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

  // Members come in already-trusted (the route checked their session).
  // Their rows skip the click-confirm flow entirely, same as if any other
  // row for this email were already confirmed.
  const memberShortcut = args.audience === "user";
  const inboxAlreadyProven =
    memberShortcut || (await hasAnyConfirmedRowForEmail(db, email));

  const trimmedName = args.name?.trim();

  if (!snap.exists) {
    const confirmed = inboxAlreadyProven;
    const doc: Record<string, unknown> = {
      email,
      channel: args.channel,
      audience: args.audience,
      audienceId: args.audienceId,
      confirmed,
      subscribed: true,
      subscribedAt: now,
      source: args.source,
      createdAt: now,
      lastAttemptAt: now,
      attemptCount: 1,
    };
    if (confirmed) doc.confirmedAt = now;
    if (trimmedName) doc.name = trimmedName;
    await ref.set(doc);
    return {
      created: true,
      requiresConfirmation: !confirmed,
      newlyAddedChannel: true,
    };
  }

  // Existing row. Three meaningful prior states:
  //  - subscribed: already on the list, possibly already confirmed.
  //  - !subscribed: unsubscribed previously; flip back on.
  //  - !confirmed: pending confirmation. Either flip to confirmed if the
  //    email has been proven elsewhere, or re-send confirmation.
  const prevSubscribed = Boolean(data?.subscribed);
  const prevConfirmed = Boolean(data?.confirmed);

  const patch: Record<string, unknown> = {
    lastAttemptAt: now,
    attemptCount: FieldValue.increment(1),
  };

  // Audience can change over a row's lifetime: a guest signs up, then later
  // registers and the row is claimed. Don't downgrade user→guest here.
  if (data?.audience === "guest" && args.audience === "user") {
    patch.audience = "user";
    patch.audienceId = args.audienceId;
  }
  // More-recent name wins. Only patch when the caller actually supplied one.
  if (trimmedName) patch.name = trimmedName;

  let requiresConfirmation = false;
  let newlyAddedChannel = false;

  // Subscribed-axis flip: turn it on (it was off, or it stays on).
  if (!prevSubscribed) {
    patch.subscribed = true;
    patch.subscribedAt = now;
    newlyAddedChannel = true;
  }

  // Confirmed-axis flip: turn it on iff inbox is now proven and it wasn't
  // already.
  if (!prevConfirmed && inboxAlreadyProven) {
    patch.confirmed = true;
    patch.confirmedAt = data?.confirmedAt ?? now;
  } else if (!prevConfirmed && !inboxAlreadyProven) {
    // Pending row, still not proven elsewhere: caller should re-send the
    // confirmation email.
    requiresConfirmation = true;
  }

  await ref.update(patch);

  return {
    created: false,
    requiresConfirmation,
    newlyAddedChannel,
  };
}

/**
 * Stamp every unconfirmed row for this email as confirmed. Idempotent: rows
 * that are already confirmed are left alone. Returns the full list of
 * channels currently confirmed for the email so callers can build a
 * personalised welcome email.
 */
export async function confirmAllForEmail(
  db: Firestore,
  email: string,
): Promise<{ updated: number; channels: string[] }> {
  const e = normaliseEmail(email);
  if (!e) return { updated: 0, channels: [] };

  // All rows for this email, so we can both flip the unconfirmed ones and
  // gather every confirmed channel for the welcome email's body.
  const allSnap = await db
    .collection(COLLECTION)
    .where("email", "==", e)
    .get();
  if (allSnap.empty) return { updated: 0, channels: [] };

  const batch = db.batch();
  const now = Timestamp.now();
  let updated = 0;
  for (const doc of allSnap.docs) {
    const data = doc.data() as SubscriptionDoc;
    if (!data.confirmed) {
      batch.update(doc.ref, { confirmed: true, confirmedAt: now });
      updated += 1;
    }
  }
  if (updated > 0) await batch.commit();

  // Build the channel list from the post-update state. We just confirmed
  // every previously-unconfirmed row, so any row whose `subscribed` is true
  // is now confirmed-and-active.
  const channels = Array.from(
    new Set(
      allSnap.docs
        .map((d) => d.data() as SubscriptionDoc)
        .filter((d) => d.subscribed)
        .map((d) => d.channel),
    ),
  );
  return { updated, channels };
}

/**
 * Flip one row to subscribed=false. Idempotent. Returns true if a row
 * existed (regardless of prior state).
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
    subscribed: false,
    unsubscribedAt: Timestamp.now(),
  });
  return true;
}

/**
 * Flip every currently-subscribed row for this email to subscribed=false.
 * Used by the "unsubscribe from all" path (token with `c: "all"`).
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
    const data = doc.data() as SubscriptionDoc;
    if (!data.subscribed) continue;
    batch.update(doc.ref, { subscribed: false, unsubscribedAt: now });
    count += 1;
  }
  if (count > 0) await batch.commit();
  return count;
}

/**
 * Migrate rows from guest → user audience. Idempotent.
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
 * (audienceId === uid) currently have subscribed = true on? Excludes any
 * that are currently subscribed=false even if confirmed.
 */
export async function findActiveSubscriptions(
  db: Firestore,
  args: { audienceId: string },
): Promise<SubscriptionDoc[]> {
  if (!args.audienceId) return [];
  const snap = await db
    .collection(COLLECTION)
    .where("audienceId", "==", args.audienceId)
    .where("subscribed", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as SubscriptionDoc);
}

export type ChannelRecipient = {
  email: string;
  audience: SubscriptionAudience;
  audienceId: string;
};

/**
 * Read-side helper for the digest sender: every confirmed-AND-subscribed
 * recipient on a given channel. The sender uses `email` directly for guest
 * rows; for user rows it can hydrate the user doc to apply gmail/uniEmail
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
    .where("confirmed", "==", true)
    .where("subscribed", "==", true)
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

/**
 * Convert an old-shape row (one that uses the legacy `status` enum, no
 * `confirmed` / `subscribed` booleans) into the new shape, AND mark the
 * legacy `status` field for deletion. Used by the backfill route to
 * migrate any pre-existing rows. Returns the patch to apply (callers
 * `update()` with it via the admin SDK), or null if the row already has
 * the new fields AND no legacy field, i.e. nothing to do.
 *
 * The returned patch always includes `status: FieldValue.delete()` if
 * the legacy field is present on the row, so even rows that already have
 * the new booleans get their dead-byte legacy field removed in the same
 * pass.
 */
export function migrationPatchFromLegacyStatus(
  row: Record<string, unknown>,
  fieldDelete: FirebaseFirestore.FieldValue,
): Record<string, unknown> | null {
  const hasNew =
    typeof row.confirmed === "boolean" && typeof row.subscribed === "boolean";
  const legacyStatus = row.status;
  const hasLegacyStatus = legacyStatus !== undefined;

  if (hasNew && !hasLegacyStatus) {
    // Already migrated and clean. No-op.
    return null;
  }

  const patch: Record<string, unknown> = {};

  if (!hasNew) {
    if (
      legacyStatus !== "pending" &&
      legacyStatus !== "confirmed" &&
      legacyStatus !== "unsubscribed"
    ) {
      // Row missing new fields AND missing recognisable legacy status.
      // Defensive default: treat as lapsed so the row at least carries
      // the booleans without lying about state. Shouldn't happen in
      // practice; logged for posterity if it does.
      patch.confirmed = false;
      patch.subscribed = false;
    } else {
      const confirmedAt = row.confirmedAt;
      const unsubscribedAt = row.unsubscribedAt;
      const createdAt = row.createdAt;
      if (legacyStatus === "pending") {
        patch.confirmed = false;
        patch.subscribed = true;
        if (createdAt !== undefined) patch.subscribedAt = createdAt;
      } else if (legacyStatus === "confirmed") {
        patch.confirmed = true;
        patch.subscribed = true;
        const ts = confirmedAt ?? createdAt;
        if (ts !== undefined) {
          patch.confirmedAt = ts;
          patch.subscribedAt = ts;
        }
      } else {
        // unsubscribed
        const wasConfirmed = Boolean(confirmedAt);
        patch.confirmed = wasConfirmed;
        patch.subscribed = false;
        if (wasConfirmed) patch.confirmedAt = confirmedAt;
        if (unsubscribedAt !== undefined) patch.unsubscribedAt = unsubscribedAt;
      }
    }
  }

  // Always nuke the legacy field if it's present. Cleans up dead bytes
  // on already-migrated rows in the same pass.
  if (hasLegacyStatus) {
    patch.status = fieldDelete;
  }

  return patch;
}
