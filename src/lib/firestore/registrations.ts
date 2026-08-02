/**
 * Signup / registration tracking — the data model behind the admin orphan
 * tracker and the suspicious-signup flagger.
 *
 * Two server-only stores feed this (both Admin-SDK-written, client-locked in
 * firestore.rules — read by admins through server routes, like emailSends):
 *
 *   registrations/{uid}      One DURABLE doc per account created via the
 *                            email-only register route. Keyed by the Auth uid so
 *                            re-registering the same email updates the same row.
 *                            Powers the tracker, the orphan list, and burst
 *                            detection. (Accounts created before this collection
 *                            shipped, or via Google, have no row — the tracker is
 *                            forward-looking by design.)
 *
 *   signupMetrics/{YYYY-MM-DD}  One BOUNDED daily counter doc aggregating every
 *                            signup ATTEMPT outcome (incl. reCAPTCHA failures,
 *                            which create no account and so can't live on a
 *                            per-account row). Powers the reCAPTCHA-fail-rate
 *                            signal. Bounded at one doc/day so a bot flooding the
 *                            register route can't balloon Firestore — the exact
 *                            abuse the flagger exists to catch.
 *
 * This module is PURE (no firebase-admin import) so both the client admin UI and
 * the server routes can share the types and helpers. The Admin-SDK write helpers
 * live in the server-only sibling `registrationWrites.ts`.
 */

export const REGISTRATIONS_COLLECTION = "registrations";
export const SIGNUP_METRICS_COLLECTION = "signupMetrics";

export type RegistrationAudience = "member" | "collaborator";

/**
 * How the account was created. `email` = the verify-first email-only register
 * route (server-random throwaway password → set after verifying). `google` =
 * Google sign-in (the email is provider-verified up front, there is no password
 * step). The method changes what "incomplete" means — see deriveRegistrationStatus.
 */
export type RegistrationMethod = "email" | "google";

/**
 * The lifecycle of a registration, derived from the booleans we own. Which ones
 * apply depends on `method`:
 *
 *   email
 *     - pending-verify       account exists, email not yet confirmed (never
 *                            clicked the magic link). Random throwaway password →
 *                            can't be signed into. A benign orphan.
 *     - verified-no-password email confirmed (clicked the link) but the real
 *                            password not yet set. Still no usable credential →
 *                            a benign orphan.
 *     - completed            real password set → a usable account.
 *
 *   google (no password step; the email is verified by Google)
 *     - pending-profile      signed in with Google but never wrote a member/
 *                            collaborator profile doc → an abandoned signup.
 *                            An orphan, by the "no profile doc" test.
 *     - completed            profile doc written → a usable account.
 */
export type RegistrationStatus =
  | "pending-verify"
  | "verified-no-password"
  | "pending-profile"
  | "completed";

export const REGISTRATION_STATUSES: RegistrationStatus[] = [
  "pending-verify",
  "verified-no-password",
  "pending-profile",
  "completed",
];

/** Statuses that aren't a usable, finished account yet — the orphans a cleanup sweep targets. */
export const ORPHAN_STATUSES: RegistrationStatus[] = [
  "pending-verify",
  "verified-no-password",
  "pending-profile",
];

/**
 * Single source of truth for status — keep the stored `status` field in sync with
 * this. Method-aware: email orphans are gated on a usable credential (passwordSet),
 * Google orphans on a completed profile (profileComplete), since Google has no
 * password step.
 */
export function deriveRegistrationStatus(
  method: RegistrationMethod,
  flags: { emailVerified?: boolean; passwordSet?: boolean; profileComplete?: boolean },
): RegistrationStatus {
  if (method === "google") {
    return flags.profileComplete ? "completed" : "pending-profile";
  }
  if (flags.passwordSet) return "completed";
  if (flags.emailVerified) return "verified-no-password";
  return "pending-verify";
}

export const REGISTRATION_STATUS_META: Record<
  RegistrationStatus,
  { label: string; tone: "neutral" | "warning" | "success" }
> = {
  "pending-verify": { label: "Pending verify", tone: "neutral" },
  "verified-no-password": { label: "Verified · no password", tone: "warning" },
  "pending-profile": { label: "No profile yet", tone: "neutral" },
  completed: { label: "Completed", tone: "success" },
};

/** Display labels for the sign-up method. */
export const REGISTRATION_METHOD_META: Record<
  RegistrationMethod,
  { label: string; tone: "neutral" | "accent" }
> = {
  email: { label: "Email", tone: "neutral" },
  google: { label: "Google", tone: "accent" },
};

/**
 * Outcome buckets recorded on the daily signupMetrics doc. `created` /
 * `existing-verified` / `existing-unverified` all passed the reCAPTCHA gate;
 * `recaptcha-failed` was blocked at it; `invalid-email` was rejected before it
 * (bad format / academic address); `error` is an unexpected server failure.
 */
export type SignupOutcome =
  | "created"
  | "existing-verified"
  | "existing-unverified"
  | "recaptcha-failed"
  | "invalid-email"
  | "error";

/** Map an outcome to the signupMetrics counter field it increments. */
export const SIGNUP_OUTCOME_FIELD: Record<SignupOutcome, string> = {
  created: "created",
  "existing-verified": "existingVerified",
  "existing-unverified": "existingUnverified",
  "recaptcha-failed": "recaptchaFailed",
  "invalid-email": "invalidEmail",
  error: "error",
};

/**
 * The JSON-wire shape the admin list route returns (timestamps as ISO strings —
 * the client formats them). Built from a Firestore doc via `toRegistrationView`.
 */
export type RegistrationView = {
  uid: string;
  email: string;
  audience: RegistrationAudience;
  method: RegistrationMethod;
  status: RegistrationStatus;
  emailVerified: boolean;
  passwordSet: boolean;
  /** True once a member/collaborator profile doc has been written. */
  profileComplete: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastSentAt: string | null;
  sendCount: number;
};

type Raw = Record<string, unknown>;

/** Firestore Timestamp | Date | null → ISO string | null. Duck-typed so this stays admin-import-free. */
function tsToIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const obj = v as { toDate?: () => Date };
  if (typeof obj?.toDate === "function") {
    try {
      return obj.toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function toRegistrationView(uid: string, data: Raw): RegistrationView {
  const emailVerified = Boolean(data.emailVerified);
  const passwordSet = Boolean(data.passwordSet);
  const profileComplete = Boolean(data.profileComplete);
  // Legacy rows (pre-`method`) are all from the email flow.
  const method: RegistrationMethod = data.method === "google" ? "google" : "email";
  const status = REGISTRATION_STATUSES.includes(data.status as RegistrationStatus)
    ? (data.status as RegistrationStatus)
    : deriveRegistrationStatus(method, { emailVerified, passwordSet, profileComplete });
  return {
    uid,
    email: typeof data.email === "string" ? data.email : "",
    audience: data.audience === "collaborator" ? "collaborator" : "member",
    method,
    status,
    emailVerified,
    passwordSet,
    profileComplete,
    createdAt: tsToIso(data.createdAt),
    updatedAt: tsToIso(data.updatedAt),
    lastSentAt: tsToIso(data.lastSentAt),
    sendCount: num(data.sendCount),
  };
}

/** UTC `YYYY-MM-DD` bucket key for the signupMetrics daily counter doc. */
export function metricsDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The last `n` daily bucket keys, newest first (today, yesterday, …). */
export function recentMetricsDateKeys(now: Date, n: number): string[] {
  const keys: string[] = [];
  const d = new Date(now.getTime());
  for (let i = 0; i < n; i++) {
    keys.push(metricsDateKey(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return keys;
}

// === Flagger summary (shared between the summary route and the admin UI) ===

export type RegistrationFlag = {
  level: "amber" | "red";
  kind: "burst" | "recaptcha" | "orphans";
  message: string;
};

export type RegistrationSummary = {
  counts: {
    total: number;
    pendingVerify: number;
    verifiedNoPassword: number;
    /** Google sign-ins that never completed a profile (Google orphans). */
    pendingProfile: number;
    completed: number;
    orphans: number;
  };
  /** New ACCOUNTS created in the trailing window (burst signal). */
  velocity: { last1h: number; last24h: number };
  /** reCAPTCHA outcomes among attempts that reached the gate, over `windowDays`. */
  recaptcha: {
    windowDays: number;
    attempts: number;
    failed: number;
    failRate: number;
  };
  flags: RegistrationFlag[];
};
