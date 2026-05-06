/**
 * Per-user notification preferences.
 *
 * Replaces the older `profile.newsletter` shape which couldn't express
 * "send me event announcements but not the newsletter". Reads accept either
 * shape via `normaliseNotifications()` for the duration of the migration
 * window; writes always go to the new `profile.notifications` field, and a
 * one-shot admin backfill (`/api/admin/migrate-notifications`) promotes any
 * users still on the legacy shape.
 */

export type NotificationChannel = "gmail" | "uniEmail";
export const ALL_CHANNELS: NotificationChannel[] = ["gmail", "uniEmail"];

export type NotificationCategory = "newsletter" | "events";
export const ALL_CATEGORIES: NotificationCategory[] = ["newsletter", "events"];

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  newsletter: "Newsletter",
  events: "Event announcements",
};

export const CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  newsletter:
    "Low-frequency updates about our courses, reading groups, and what the committee is working on.",
  events:
    "A short email when we publish a new event — talks, socials, workshops — so you don't have to watch the site or socials.",
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  gmail: "Google account email",
  uniEmail: "University email",
};

export type NotificationPrefs = {
  channels: Record<NotificationChannel, boolean>;
  categories: Record<NotificationCategory, boolean>;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channels: { gmail: true, uniEmail: false },
  categories: { newsletter: false, events: false },
};

type LegacyNewsletter = {
  subscribed?: unknown;
  deliverToGmail?: unknown;
  deliverToUniEmail?: unknown;
};

type MaybeNew = {
  channels?: { gmail?: unknown; uniEmail?: unknown };
  categories?: { newsletter?: unknown; events?: unknown };
};

/**
 * Read the effective notification prefs off a user profile, tolerating either
 * the new `notifications` shape or the legacy `newsletter` shape.
 *
 * Precedence: new shape wins if present. Legacy shape only applies when no
 * `notifications` field is written yet. Once a user saves under the new UI,
 * they move to the new shape permanently.
 */
export function normaliseNotifications(profile: {
  notifications?: unknown;
  newsletter?: unknown;
}): NotificationPrefs {
  const modern = profile.notifications as MaybeNew | undefined;
  if (modern && (modern.channels || modern.categories)) {
    return {
      channels: {
        gmail: Boolean(modern.channels?.gmail),
        uniEmail: Boolean(modern.channels?.uniEmail),
      },
      categories: {
        newsletter: Boolean(modern.categories?.newsletter),
        events: Boolean(modern.categories?.events),
      },
    };
  }
  const legacy = profile.newsletter as LegacyNewsletter | undefined;
  if (legacy) {
    const subscribed = Boolean(legacy.subscribed);
    return {
      channels: {
        gmail: legacy.deliverToGmail === undefined ? true : Boolean(legacy.deliverToGmail),
        uniEmail: Boolean(legacy.deliverToUniEmail),
      },
      categories: {
        // Legacy users were subscribed only to the newsletter; events was never
        // a separate toggle. They opt into events explicitly later.
        newsletter: subscribed,
        events: false,
      },
    };
  }
  return DEFAULT_NOTIFICATION_PREFS;
}

/** True iff the user wants *any* email at all. Cheap pre-filter before a send loop. */
export function isSubscribedToAnything(prefs: NotificationPrefs): boolean {
  return Object.values(prefs.categories).some(Boolean);
}

/** True iff the user wants this specific category. */
export function wantsCategory(
  prefs: NotificationPrefs,
  category: NotificationCategory,
): boolean {
  return Boolean(prefs.categories[category]);
}

/**
 * Resolve the list of delivery addresses for a given category send, given a
 * user's prefs and the two addresses on file. Empty array = skip this user.
 *
 * Guarantees at least one address when `wantsCategory` is true and at least
 * one channel is enabled — falls back to gmail if the channels map is
 * impossibly empty.
 */
export function addressesForSend(args: {
  prefs: NotificationPrefs;
  category: NotificationCategory;
  gmailEmail: string | null;
  universityEmail: string | null;
  gmailOnlyMode?: boolean;
}): string[] {
  const { prefs, category, gmailEmail, universityEmail, gmailOnlyMode } = args;
  if (!wantsCategory(prefs, category)) return [];
  const out: string[] = [];
  if (prefs.channels.gmail && gmailEmail) out.push(gmailEmail);
  if (!gmailOnlyMode && prefs.channels.uniEmail && universityEmail) {
    out.push(universityEmail);
  }
  if (out.length === 0 && gmailEmail) out.push(gmailEmail);
  return out;
}

/** Per-category set/unset helper for UI controls. */
export function setCategory(
  prefs: NotificationPrefs,
  category: NotificationCategory,
  enabled: boolean,
): NotificationPrefs {
  return {
    ...prefs,
    categories: { ...prefs.categories, [category]: enabled },
  };
}

export function setChannel(
  prefs: NotificationPrefs,
  channel: NotificationChannel,
  enabled: boolean,
): NotificationPrefs {
  return {
    ...prefs,
    channels: { ...prefs.channels, [channel]: enabled },
  };
}

/**
 * Shape written to Firestore. Kept identical to the in-memory shape so
 * `setDoc(ref, { "profile.notifications": prefs })` works without a converter.
 */
export function serialiseNotifications(prefs: NotificationPrefs): NotificationPrefs {
  return {
    channels: { gmail: Boolean(prefs.channels.gmail), uniEmail: Boolean(prefs.channels.uniEmail) },
    categories: {
      newsletter: Boolean(prefs.categories.newsletter),
      events: Boolean(prefs.categories.events),
    },
  };
}

/**
 * One verified email address on a user. The list is the single extension
 * point for the per-(email, channel) subscription model: callers iterate
 * the result, write a row per email per channel.
 *
 * Today's slots: the Google account email (always counted as verified —
 * it's the auth identity), and the university email when
 * `profile.uniEmailVerifiedAt` is set on the user doc. Adding more slots
 * later (a personal-email field, a parent-email field, etc.) is a
 * one-place edit here.
 */
export type VerifiedEmail = {
  email: string;
  /** Discriminator for the UI so it can label "Google" vs "Uni". */
  kind: "google" | "uni";
};

type UserShapeForVerifiedEmails = {
  email?: string | null;
  profile?:
    | {
        universityEmail?: unknown;
        uniEmailVerifiedAt?: unknown;
      }
    | undefined;
};

/**
 * Return the user's verified email addresses, deduped, lowercase, trimmed.
 * Order is stable (`google`, then `uni`) so UI columns render predictably.
 *
 * Inline `.trim().toLowerCase()` rather than importing `normaliseEmail`
 * from `lib/firestore/emailDocId` — that module is `server-only`, and this
 * helper needs to run in client components (the /profile matrix and the
 * admin Subscriptions table both use it to know what columns to draw).
 */
export function getVerifiedEmails(user: UserShapeForVerifiedEmails): VerifiedEmail[] {
  const out: VerifiedEmail[] = [];
  const googleRaw = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (googleRaw) {
    out.push({ email: googleRaw, kind: "google" });
  }
  const profile = user.profile ?? {};
  const uniRaw = profile.universityEmail;
  const uniVerifiedAt = profile.uniEmailVerifiedAt;
  if (
    typeof uniRaw === "string" &&
    uniRaw.trim().length > 0 &&
    uniVerifiedAt
  ) {
    const uni = uniRaw.trim().toLowerCase();
    if (uni && uni !== googleRaw) {
      out.push({ email: uni, kind: "uni" });
    }
  }
  return out;
}
