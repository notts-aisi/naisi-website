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
 * The lifecycle of a registration, derived from the booleans we own.
 *
 * ONE RULE ABOVE THE REST: `completed` MEANS A PROFILE EXISTS, for either
 * method. A member or collaborator profile is the only thing that puts a
 * person in front of an admin, so it is the only thing the tracker may call
 * finished.
 *
 * Until October 2026 an email sign-up read `completed` the moment its password
 * was set, on the reasoning that a usable credential is a finished account.
 * It is not a finished REGISTRATION: the profile form comes after the
 * password. When the step between them broke on production (the project's
 * Email/Password provider was switched off, so the sign-in straight after the
 * password was refused), every email sign-up stopped there, nothing reached
 * Approvals, and this tracker reported each one as done. A status that claims
 * more than the data proves hides exactly the failure it exists to show.
 *
 *   pending-verify        (email) the account exists and the address is not
 *                         confirmed. Its password is a server-random throwaway,
 *                         so nobody can sign in to it.
 *   verified-no-password  (email) the address is confirmed and the real
 *                         password is not set. Still no usable credential.
 *   pending-profile       (both) the account CAN sign in and has submitted no
 *                         profile: a Google sign-in that never finished the
 *                         form, or an email sign-up that set its password and
 *                         got no further. Nothing is waiting on Approvals.
 *   completed             (both) a profile document exists.
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

/**
 * Statuses with no profile behind them: the unfinished rows a cleanup sweep
 * targets. `pending-profile` is the one to read before deleting, because the
 * account behind it can sign in and its owner may still mean to finish.
 */
export const ORPHAN_STATUSES: RegistrationStatus[] = [
  "pending-verify",
  "verified-no-password",
  "pending-profile",
];

/**
 * Single source of truth for status. The stored `status` field is written from
 * this, but a row written before October 2026 carries the old meaning of
 * `completed`, so nothing that SHOWS a status may trust the stored word:
 * `toRegistrationView` derives it again from the flags, every time.
 *
 * A profile wins over every other flag. An email row whose owner later signed
 * in with Google and finished the form has no password set and is finished
 * all the same.
 */
export function deriveRegistrationStatus(
  method: RegistrationMethod,
  flags: { emailVerified?: boolean; passwordSet?: boolean; profileComplete?: boolean },
): RegistrationStatus {
  if (flags.profileComplete) return "completed";
  // Google verifies the address and has no password step, so a Google row
  // with no profile is already at the last step.
  if (method === "google") return "pending-profile";
  if (flags.passwordSet) return "pending-profile";
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

/**
 * What a caller knows that the row does not: whether a profile document exists
 * for this account right now. The list route looks it up for every row it
 * returns (`uidsWithProfile` in the server-only `registrationProfiles.ts`).
 */
export type RegistrationTruth = { hasProfile: boolean };

export function toRegistrationView(
  uid: string,
  data: Raw,
  truth?: RegistrationTruth,
): RegistrationView {
  const emailVerified = Boolean(data.emailVerified);
  const passwordSet = Boolean(data.passwordSet);
  // The row's own flag is set by a request the browser makes after it has
  // written the profile, so it can trail the document (or, on an old row,
  // never have been set). Where the caller has looked the document up, that
  // answer wins in both directions.
  const profileComplete = truth ? truth.hasProfile : Boolean(data.profileComplete);
  // Legacy rows (pre-`method`) are all from the email flow.
  const method: RegistrationMethod = data.method === "google" ? "google" : "email";
  // DERIVED, never read from `data.status`. A row written before October 2026
  // stores "completed" for an email sign-up with a password and no profile,
  // and showing the stored word is how the tracker came to report stranded
  // registrations as finished.
  const status = deriveRegistrationStatus(method, { emailVerified, passwordSet, profileComplete });
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
    /** Accounts that can sign in and have submitted no profile, either method. */
    pendingProfile: number;
    /** Registrations with a profile behind them. */
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

/**
 * The status counts for the whole collection, from the six aggregation reads
 * the summary route makes.
 *
 * `completed` is counted on the `profileComplete` FLAG and never on the stored
 * `status` word, which says "completed" on every email row whose password was
 * set before October 2026, profile or no profile. The two early statuses are
 * safe to count on the stored word (their meaning never changed), less any row
 * that has since gained a profile another way (an email sign-up finished
 * through Google). `pendingProfile` is whatever is left, so the four always
 * add up to the total and a row whose stored word is stale lands where its
 * flags put it, with no backfill.
 *
 * The flag can trail the profile document (see `toRegistrationView`), so
 * `completed` may briefly under-count. It cannot over-count, which is the
 * direction that matters: the flag is only ever set once a document exists.
 */
export function registrationCounts(read: {
  total: number;
  withProfile: number;
  storedPendingVerify: number;
  storedPendingVerifyWithProfile: number;
  storedVerifiedNoPassword: number;
  storedVerifiedNoPasswordWithProfile: number;
}): RegistrationSummary["counts"] {
  const atLeastZero = (n: number) => Math.max(0, n);
  const completed = read.withProfile;
  const pendingVerify = atLeastZero(read.storedPendingVerify - read.storedPendingVerifyWithProfile);
  const verifiedNoPassword = atLeastZero(
    read.storedVerifiedNoPassword - read.storedVerifiedNoPasswordWithProfile,
  );
  const pendingProfile = atLeastZero(read.total - completed - pendingVerify - verifiedNoPassword);
  return {
    total: read.total,
    pendingVerify,
    verifiedNoPassword,
    pendingProfile,
    completed,
    orphans: pendingVerify + verifiedNoPassword + pendingProfile,
  };
}
