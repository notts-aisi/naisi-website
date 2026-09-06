/**
 * Per-user notification preferences.
 *
 * Replaces the older `profile.newsletter` shape which couldn't express
 * "send me event announcements but not the newsletter". Reads accept either
 * shape via `normaliseNotifications()` for the duration of the migration
 * window; writes always go to the new `profile.notifications` field, and a
 * one-shot admin backfill (`/api/admin/migrate-notifications`) promotes any
 * users still on the legacy shape.
 *
 * THE SHAPE IS A GRID: four rows (newsletter, events, courses, tasks) and two
 * columns (email, push), stored as two parallel maps.
 *
 *   channels:   { gmail, uniEmail }                       // address routing
 *   categories: { newsletter, events, courses, tasks }    // the EMAIL column
 *   push:       { newsletter, events, courses, tasks }    // the PUSH column
 *
 * NO `{ email, push }` CONTAINER INSIDE `categories`, deliberately. Such an
 * object is truthy, so every `Boolean(categories.x)` read in the tree would
 * report every row as wanted for every member, `readCourseAnnouncements` and
 * `hasOptedOutOfCourseAnnouncements` (`!== false`) would never see a refusal
 * again, and the three leaf writers that set a category by dotted path would
 * silently replace it. Two sibling maps keep every existing reader and writer
 * type-correct.
 */

export type NotificationChannel = "gmail" | "uniEmail";
export const ALL_CHANNELS: NotificationChannel[] = ["gmail", "uniEmail"];

export type NotificationCategory = "newsletter" | "events" | "courses" | "tasks";
export const ALL_CATEGORIES: NotificationCategory[] = [
  "newsletter",
  "events",
  "courses",
  "tasks",
];

/**
 * The rows a marketing-style unsubscribe link may switch off.
 *
 * `tasks` is deliberately absent. A member clicking "unsubscribe" at the foot
 * of a newsletter is refusing bulk mail; silencing their review requests,
 * mentions and worksheet deadlines on the same click would take away mail they
 * need to do the thing they volunteered for, without ever telling them. That
 * row is switched off on /profile, where it says what it stops, and nowhere
 * else. `/api/unsubscribe` iterates THIS, never `ALL_CATEGORIES`.
 */
export const UNSUBSCRIBABLE_CATEGORIES: NotificationCategory[] = [
  "newsletter",
  "events",
  "courses",
];

/**
 * The categories that are ALSO top-level subscription channels — one
 * `subscriptions` row per (verified email, channel), edited as the per-address
 * matrix on /profile and applied by `/api/subscriptions/sync`.
 *
 * `courses` is deliberately NOT one of them, and this is the split that keeps
 * the two models from colliding. Cohort mail is addressed by `cohort:<runId>`
 * rows, which the allocation route writes to the ONE proven account address
 * when it places a member — so a per-address "Course announcements" checkbox
 * could not change where a cohort email lands. It would only mint a top-level
 * `courses` row nothing ever sends to. `categories.courses` is an
 * account-level OPT-OUT instead; see `DEFAULT_NOTIFICATION_PREFS` below and
 * the module comment on the run email route. `tasks` is out for the same
 * reason: task mail is addressed by uid, not by list membership.
 *
 * Iterate THIS, not `ALL_CATEGORIES`, anywhere a category is being turned
 * into a subscription row.
 *
 * MEMBERSHIP AND ORDER ARE PINNED. `scripts/e2e-fixtures/member-journey.mjs`
 * regex-parses this constant and the two labels below out of this file and
 * refuses to seed a run when they drift, because the browser suite finds each
 * cell by its rendered label.
 */
export type SubscriptionCategory = Extract<
  NotificationCategory,
  "newsletter" | "events"
>;
export const SUBSCRIPTION_CATEGORIES: SubscriptionCategory[] = [
  "newsletter",
  "events",
];

export function isSubscriptionCategory(
  value: string,
): value is SubscriptionCategory {
  return (SUBSCRIPTION_CATEGORIES as string[]).includes(value);
}

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  newsletter: "Newsletter",
  events: "Event announcements",
  courses: "Course announcements",
  tasks: "Tasks and worksheets",
};

export const CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  newsletter:
    "Low-frequency updates about our courses, reading groups, and what the committee is working on.",
  events:
    "A short email when we publish a new event — talks, socials, workshops — so you don't have to watch the site or socials.",
  courses:
    "Announcements sent to a whole cohort you're enrolled in. Untick to stop them — your own group's practical emails (a moved session, a changed reading) still reach you.",
  // Says what it stops, because this row is the one a member can switch off
  // and then wonder why nobody told them about a review. The owner's call on
  // 6 September 2026 was that granularity wins over safety here, so the copy
  // has to carry the warning the default no longer does.
  tasks:
    "Review requests, mentions in a comment, and worksheets sent to you. Switching this off stops those emails too, not just the reminders.",
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  gmail: "Google account email",
  uniEmail: "University email",
};

/**
 * WHICH ROWS DEFAULT ON, AS ONE TABLE, applied to BOTH columns.
 *
 * The two lists are not a style choice: two different consent stories are
 * already live and the resolver has to keep both.
 *
 * OPT-IN (`Boolean(v)`, absent means no): newsletter and events. Nobody
 * consents to bulk mail by having an email address, and these are the two
 * rows that also mint `subscriptions` records, so a default of on would be a
 * consent claim we cannot evidence.
 *
 * OPT-OUT (`v !== false`, absent means "hasn't answered"): courses and tasks.
 * Cohort mail's opt-in is the `cohort:<runId>` subscription row written when
 * a member is placed in a group; task mail's is volunteering for the task.
 * The row is the refusal layered on top, so only a stored `false` counts. A
 * default of off here would silence, for everybody at once, mail members
 * already receive.
 *
 * Both columns use the same table. The push column inherits it rather than
 * defaulting uniformly on: a device only receives anything at all after its
 * owner granted the browser permission and pressed Enable, which is a real
 * per-device opt-in, but that says nothing about whether they want the
 * newsletter on their lock screen.
 */
export const OPT_IN_ROWS: NotificationCategory[] = ["newsletter", "events"];
export const OPT_OUT_ROWS: NotificationCategory[] = ["courses", "tasks"];

/**
 * Resolve ONE stored cell, in either column, against the table above.
 *
 * Junk (a string, a null, a number) reads as the row's default rather than as
 * an answer: an opt-in row needs a truthy value to be on, an opt-out row needs
 * a literal `false` to be off. Nothing else is a preference.
 */
export function resolveRow(row: NotificationCategory, stored: unknown): boolean {
  return OPT_IN_ROWS.includes(row) ? Boolean(stored) : stored !== false;
}

/**
 * PUSH IS ITS OWN COLUMN, and that separation is the point of this block.
 *
 * `channels` is EMAIL-ADDRESS ROUTING (which inbox a send lands in) and
 * `categories` is which mail somebody wants. A push notification has no
 * address and belongs to a device, so folding it into either would break
 * `addressesForSend`, which reads `channels` as a list of inboxes to write
 * into. Push gets a third, sibling map with the SAME keys as `categories` —
 * one row per topic, two switches.
 *
 * `courseDecisions` was the old name of the `courses` push key, from when the
 * push map had two topic-shaped keys of its own rather than one cell per grid
 * row. It is READ as an alias (see `resolvePush`) so stored answers survive,
 * and it is never written again.
 */
export type PushNotificationKey = NotificationCategory;
export const ALL_PUSH_KEYS: PushNotificationKey[] = [...ALL_CATEGORIES];

/** The stored push key this module still reads and never writes. */
export const LEGACY_PUSH_KEY = "courseDecisions";

export const PUSH_LABELS: Record<PushNotificationKey, string> = {
  newsletter: "Newsletter",
  events: "Event announcements",
  courses: "Course announcements",
  tasks: "Tasks and worksheets",
};

export const PUSH_DESCRIPTIONS: Record<PushNotificationKey, string> = {
  newsletter: "A notification when a new newsletter goes out.",
  events: "A notification when we publish a new event.",
  // This copy is exhaustive TODAY, and only because the three moments named
  // are the only ones that push. Anything new put behind this row owns this
  // string as well.
  courses:
    "A notification when a decision on your application lands, when a new part of an application form opens, or when you're placed in a course group. The email is sent either way.",
  tasks:
    "A notification alongside each task and worksheet email: added to a task, a comment, a mention, a review request, a review outcome.",
};

export type NotificationPrefs = {
  channels: Record<NotificationChannel, boolean>;
  /** The EMAIL column, one cell per row. */
  categories: Record<NotificationCategory, boolean>;
  /** The PUSH column, the same rows. A sibling of the two above, never folded in. */
  push: Record<PushNotificationKey, boolean>;
};

/**
 * The resolved value of every cell when nothing at all is stored.
 *
 * Derived from the one table above rather than restated, so a row cannot
 * default one way here and the other way in `normaliseNotifications`.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channels: { gmail: true, uniEmail: false },
  categories: {
    newsletter: false,
    events: false,
    courses: true,
    tasks: true,
  },
  push: {
    newsletter: false,
    events: false,
    courses: true,
    tasks: true,
  },
};

type LegacyNewsletter = {
  subscribed?: unknown;
  deliverToGmail?: unknown;
  deliverToUniEmail?: unknown;
};

type StoredRow = {
  newsletter?: unknown;
  events?: unknown;
  courses?: unknown;
  tasks?: unknown;
};

type MaybeNew = {
  channels?: { gmail?: unknown; uniEmail?: unknown };
  categories?: StoredRow;
  /** `courseDecisions` is the read-only legacy alias of `courses`. */
  push?: StoredRow & { courseDecisions?: unknown };
};

/** Resolve one column off whatever is stored, row by row. */
function resolveColumn(stored: StoredRow | undefined): Record<NotificationCategory, boolean> {
  return {
    newsletter: resolveRow("newsletter", stored?.newsletter),
    events: resolveRow("events", stored?.events),
    courses: resolveRow("courses", stored?.courses),
    tasks: resolveRow("tasks", stored?.tasks),
  };
}

/**
 * Resolve the push column, honouring the `courseDecisions` alias.
 *
 * The alias applies only when `courses` is ABSENT: a member who has answered
 * under the new key has answered, and an older value must not overrule them.
 */
function resolvePush(stored: MaybeNew["push"]): Record<PushNotificationKey, boolean> {
  const courses = stored?.courses === undefined ? stored?.courseDecisions : stored?.courses;
  return {
    ...resolveColumn(stored),
    courses: resolveRow("courses", courses),
  };
}

/**
 * Read the effective notification prefs off a user profile, tolerating either
 * the new `notifications` shape or the legacy `newsletter` shape.
 *
 * Precedence: new shape wins if present. Legacy shape only applies when no
 * `notifications` field is written yet. Once a user saves under the new UI,
 * they move to the new shape permanently.
 *
 * PUSH IS RESOLVED OUTSIDE THAT CHOICE, on purpose. The email shapes are two
 * competing versions of one answer, so exactly one of them may win; push is a
 * third axis that neither version ever carried, so it is read once and
 * attached to whichever branch returns. That is what makes a LEGACY profile,
 * which has `newsletter` and no `notifications` at all, still come out with
 * the opt-out push rows on, and it is why a member who has only ever touched
 * the push switches (leaving `channels` and `categories` unwritten) still has
 * their stored `false` honoured instead of quietly reverting to the default.
 */
export function normaliseNotifications(profile: {
  notifications?: unknown;
  newsletter?: unknown;
}): NotificationPrefs {
  const modern = profile.notifications as MaybeNew | undefined;
  const push = resolvePush(modern?.push);
  if (modern && (modern.channels || modern.categories)) {
    return {
      channels: {
        gmail: Boolean(modern.channels?.gmail),
        uniEmail: Boolean(modern.channels?.uniEmail),
      },
      categories: resolveColumn(modern.categories),
      push,
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
        // Legacy users were subscribed only to the newsletter; events was
        // never a separate toggle on the old shape, and they opt in later.
        newsletter: subscribed,
        events: false,
        // The OPT-OUT rows resolve TRUE here, and that is the whole reason
        // this branch spells them out. Under the resolver a stored `false`
        // means a refusal, and the legacy shape cannot express one: it has no
        // slot for either row. Returning `false` would invent a refusal
        // nobody made and silence a legacy member's cohort and task mail.
        courses: true,
        tasks: true,
      },
      push,
    };
  }
  return { ...DEFAULT_NOTIFICATION_PREFS, push };
}

/**
 * True iff the user wants *any* email at all. Cheap pre-filter before a send loop.
 *
 * Counts EVERY row, including the two that default ON and are not backed by a
 * subscription row, so in practice it is true for nearly everybody. Callers
 * asking "does this person have any subscriptions?" want
 * `SUBSCRIPTION_CATEGORIES` instead; the two answers diverge for a member who
 * wants neither the newsletter nor events.
 */
export function isSubscribedToAnything(prefs: NotificationPrefs): boolean {
  return Object.values(prefs.categories).some(Boolean);
}

/** True iff the user wants email for this row. */
export function wantsCategory(
  prefs: NotificationPrefs,
  category: NotificationCategory,
): boolean {
  return resolveRow(category, prefs.categories[category]);
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

/** Per-row set/unset helper for the email column. */
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

/** True iff this member wants push for this row. */
export function wantsPush(
  prefs: NotificationPrefs,
  key: PushNotificationKey,
): boolean {
  return resolveRow(key, prefs.push[key]);
}

/** Per-row set/unset helper for the push column. */
export function setPushPreference(
  prefs: NotificationPrefs,
  key: PushNotificationKey,
  enabled: boolean,
): NotificationPrefs {
  return {
    ...prefs,
    push: { ...prefs.push, [key]: enabled },
  };
}

/**
 * The push half of the stored shape, on its own.
 *
 * Written under the `profile.notifications.push` field path so the push
 * switches can save without restating `channels` and `categories`, which
 * belong to the profile form. Both writers use the same normalising read, so
 * neither can invent a value for the other's half.
 *
 * Four booleans and NO `courseDecisions`: the alias is a read, and writing it
 * back would keep a second name for one cell alive forever.
 */
export function serialisePush(
  push: Record<PushNotificationKey, boolean>,
): Record<PushNotificationKey, boolean> {
  return {
    newsletter: Boolean(push.newsletter),
    events: Boolean(push.events),
    courses: Boolean(push.courses),
    tasks: Boolean(push.tasks),
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
      courses: Boolean(prefs.categories.courses),
      tasks: Boolean(prefs.categories.tasks),
    },
    // This write REPLACES the whole map, so push has to be carried even
    // though nothing in the profile form edits it: dropping it here would
    // reset every switch to the default on every unrelated profile save.
    // ProfileForm reads the stored value off its live snapshot for exactly
    // this reason, and does the same for the rows it does not yet draw.
    push: serialisePush(prefs.push),
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
