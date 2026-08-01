/**
 * Site-wide maintenance notice — a single world-readable Firestore doc at
 * `publicConfig/siteNotice` that an admin can flip WITHOUT a deploy to tell
 * visitors (signed-out included) that something is temporarily broken and
 * roughly when it will be back. Rendered by <SiteNoticeBanner /> in the root
 * layout; per-surface pause flags soften the failing forms' copy.
 *
 * This module is the shared normaliser — pure, no Firebase imports — so the
 * client banner and any future server guard read the doc identically and
 * cannot diverge.
 *
 * FAIL-OPEN is the load-bearing guarantee, the inverse of its cousin
 * `src/lib/firestore/taskEmailConfig.ts` (missing → enabled): a missing,
 * malformed, unreadable or expired doc must normalise to notice OFF. A banner
 * falsely claiming the site is down IS an outage to visitors.
 *
 * Two invariants:
 * - `bannerVisible = active || anyPaused` — a surface may never be paused
 *   without an on-screen explanation (the motivating incident was exactly a
 *   silent block).
 * - An empty message while visible falls back to DEFAULT_PAUSED_MESSAGE so a
 *   flag flipped with no copy still renders a real sentence.
 *
 * This is NOT a correctness mechanism: pausing a surface disables submits in
 * the browser, nothing more. Anything that genuinely must not happen during
 * an incident needs a Firestore rules deploy, not a flag here. Sign-in and
 * password reset go browser→Firebase on the public API key and cannot be
 * gated by this app at all.
 */

export const SITE_NOTICE_PATH = {
  collection: "publicConfig",
  doc: "siteNotice",
} as const;

export const SITE_NOTICE_LEVELS = ["info", "warn", "critical"] as const;
/** Drives styling ONLY, never behaviour. */
export type SiteNoticeLevel = (typeof SITE_NOTICE_LEVELS)[number];

/**
 * Surface → Firestore field. Flags are named for what they DO (pause the
 * submit UI), never "block": browser→Firestore writes (how member
 * registration completes today) are untouched by any flag here.
 */
export const SITE_NOTICE_SURFACE_FLAGS = {
  newRegistrations: "pauseNewRegistrations",
  collaboratorApplications: "pauseCollaboratorApplications",
  eventSignups: "pauseEventSignups",
} as const;
export type SiteNoticeSurface = keyof typeof SITE_NOTICE_SURFACE_FLAGS;

/**
 * Single point of extension: a new surface is one entry in the map above
 * (the compiler then requires it in DEFAULT_SITE_NOTICE) — the normaliser
 * below and the admin panel's switches both iterate this list. The real work
 * of a new surface is always its client UI (the submit to disable, the
 * inline copy), never this schema.
 */
export const SITE_NOTICE_SURFACES = Object.keys(
  SITE_NOTICE_SURFACE_FLAGS,
) as readonly SiteNoticeSurface[];

/** Visitor-facing display names, shared by the status page, the admin panel
    and the inline paused notices so the services are named consistently. */
export const SITE_NOTICE_SURFACE_NAMES: Record<SiteNoticeSurface, string> = {
  newRegistrations: "New member registrations",
  collaboratorApplications: "Collaborator applications",
  eventSignups: "Event sign-ups",
};

/**
 * Append-only public history of notices, one doc per banner-visible episode,
 * written ONLY by /api/admin/site-notice as it flips the live doc (break-glass
 * console flips bypass the route and are deliberately absent). Powers the
 * /status maintenance log. World-readable AND enumerable by design — nothing
 * sensitive may ever be written here.
 */
export const MAINTENANCE_LOG_PATH = { collection: "maintenanceLog" } as const;
export const MAINTENANCE_LOG_LIMIT = 20;

export type MaintenanceLogEntry = {
  id: string;
  startedAt: Date;
  /** Set when an admin switched the notice off; a natural expiry leaves it
      null and `endsAt` marks the end instead. */
  clearedAt: Date | null;
  endsAt: Date | null;
  level: SiteNoticeLevel;
  message: string;
  details: string;
  paused: Record<SiteNoticeSurface, boolean>;
  ongoing: boolean;
};

export const SITE_NOTICE_LIMITS = {
  message: 500,
  /** Long-form status-page copy. Plain text with line breaks ONLY — the doc
      is world-readable and rendered publicly, so no HTML/markdown, ever. */
  details: 4000,
} as const;

/** Admin-UI expiry choices: default 2h, hard cap 24h. */
export const SITE_NOTICE_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const SITE_NOTICE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PAUSED_MESSAGE =
  "We're working on an issue affecting parts of the site. Some features may " +
  "be temporarily unavailable — please try again shortly.";

export type SiteNotice = {
  active: boolean;
  level: SiteNoticeLevel;
  message: string;
  /** Long-form plain text for the /status page (never in the banner). */
  details: string;
  endsAt: Date | null;
  updatedAt: Date | null;
  /** The open maintenance-log entry's id (set by the admin route while the
      notice is visible; null otherwise). Lets /status identify the current
      episode positively instead of guessing "newest entry". */
  logId: string | null;
  paused: Record<SiteNoticeSurface, boolean>;
  /**
   * Effective auto-expiry: `endsAt` when set, else 24h after the last write
   * as a backstop — a forgotten pause flag silently suppressing signups for
   * days is worse than a lapsed gate returning an ugly error someone reports.
   */
  expiresAt: Date | null;
  bannerVisible: boolean;
  /** Message with the DEFAULT_PAUSED_MESSAGE fallback applied; "" when hidden. */
  bannerMessage: string;
};

export const DEFAULT_SITE_NOTICE: SiteNotice = Object.freeze({
  active: false,
  level: "info",
  message: "",
  details: "",
  endsAt: null,
  updatedAt: null,
  logId: null,
  paused: Object.freeze({
    newRegistrations: false,
    collaboratorApplications: false,
    eventSignups: false,
  }),
  expiresAt: null,
  bannerVisible: false,
  bannerMessage: "",
});

/**
 * Accepts a Firestore Timestamp (client or admin SDK, duck-typed on toDate),
 * a Date, or a hand-typed console value (ISO string / epoch ms). Anything
 * else — including an invalid date — is null, never a throw.
 */
function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Per-field coercion of the raw doc (or null when absent). Never throws; any
 * field of the wrong type degrades to its OFF/empty value, and an expired
 * notice degrades to DEFAULT_SITE_NOTICE — gates included, deliberately.
 */
export function normaliseSiteNotice(data: unknown, now: Date): SiteNotice {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return DEFAULT_SITE_NOTICE;
  }
  const raw = data as Record<string, unknown>;

  const active = raw.active === true;
  const level: SiteNoticeLevel = (SITE_NOTICE_LEVELS as readonly unknown[]).includes(raw.level)
    ? (raw.level as SiteNoticeLevel)
    : "info";
  const message =
    typeof raw.message === "string"
      ? raw.message.trim().slice(0, SITE_NOTICE_LIMITS.message)
      : "";
  const details =
    typeof raw.details === "string"
      ? raw.details.trim().slice(0, SITE_NOTICE_LIMITS.details)
      : "";
  const endsAt = coerceDate(raw.endsAt);
  const updatedAt = coerceDate(raw.updatedAt);
  const logId = typeof raw.logId === "string" ? raw.logId : null;

  const paused = {} as Record<SiteNoticeSurface, boolean>;
  for (const surface of SITE_NOTICE_SURFACES) {
    paused[surface] = raw[SITE_NOTICE_SURFACE_FLAGS[surface]] === true;
  }

  const expiresAt =
    endsAt ??
    (updatedAt ? new Date(updatedAt.getTime() + SITE_NOTICE_MAX_TTL_MS) : null);
  if (expiresAt !== null && now.getTime() >= expiresAt.getTime()) {
    return DEFAULT_SITE_NOTICE;
  }

  const anyPaused = SITE_NOTICE_SURFACES.some((surface) => paused[surface]);
  const bannerVisible = active || anyPaused;
  const bannerMessage = bannerVisible ? message || DEFAULT_PAUSED_MESSAGE : "";

  return {
    active,
    level,
    message,
    details,
    endsAt,
    updatedAt,
    logId,
    paused,
    expiresAt,
    bannerVisible,
    bannerMessage,
  };
}

export function isSurfacePaused(
  notice: SiteNotice,
  surface: SiteNoticeSurface,
): boolean {
  return notice.paused[surface];
}

/**
 * Fail-open normalisation of one maintenance-log doc: a malformed entry
 * returns null and is simply omitted from the log, never a throw. Same
 * coercion posture as normaliseSiteNotice above.
 */
export function normaliseLogEntry(
  id: string,
  data: unknown,
  now: Date,
): MaintenanceLogEntry | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const raw = data as Record<string, unknown>;
  const startedAt = coerceDate(raw.startedAt);
  if (startedAt === null) return null;
  const clearedAt = coerceDate(raw.clearedAt);
  const endsAt = coerceDate(raw.endsAt);
  const level: SiteNoticeLevel = (SITE_NOTICE_LEVELS as readonly unknown[]).includes(raw.level)
    ? (raw.level as SiteNoticeLevel)
    : "info";
  const message =
    typeof raw.message === "string"
      ? raw.message.trim().slice(0, SITE_NOTICE_LIMITS.message)
      : "";
  const details =
    typeof raw.details === "string"
      ? raw.details.trim().slice(0, SITE_NOTICE_LIMITS.details)
      : "";
  const rawPaused =
    raw.paused !== null && typeof raw.paused === "object" && !Array.isArray(raw.paused)
      ? (raw.paused as Record<string, unknown>)
      : {};
  const paused = {} as Record<SiteNoticeSurface, boolean>;
  for (const surface of SITE_NOTICE_SURFACES) {
    paused[surface] = rawPaused[surface] === true;
  }
  const ongoing =
    clearedAt === null && (endsAt === null || now.getTime() < endsAt.getTime());
  return { id, startedAt, clearedAt, endsAt, level, message, details, paused, ongoing };
}
