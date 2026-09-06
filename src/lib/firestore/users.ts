import type { Role } from "@/lib/firebase/session";
import type { NotificationPrefs } from "./notifications";

export type AffiliationStatus =
  | "employee"
  | "foundation"
  | "undergraduate"
  | "masters"
  | "phd"
  | "postdoc"
  | "other";

export const STATUS_LABELS: Record<AffiliationStatus, string> = {
  employee: "Employee at the university",
  foundation: "Foundation year",
  undergraduate: "Undergraduate",
  masters: "Master's",
  phd: "PhD",
  postdoc: "Post-doc",
  other: "Other",
};

/** Graduation only makes sense for students on a taught/research programme. */
export const STATUSES_WITH_GRADUATION: AffiliationStatus[] = [
  "foundation",
  "undergraduate",
  "masters",
  "phd",
];

/** Subject field is labelled differently for staff-track / other roles. */
export function subjectLabel(status: AffiliationStatus | undefined): string {
  if (status === "postdoc" || status === "employee") return "Area of work";
  if (status === "other") return "Area of study or work";
  return "Degree name";
}

/**
 * @deprecated Legacy shape kept for compat reads only. New writes use
 * `UserProfile.notifications` (see `./notifications.ts`). Once the admin
 * migration endpoint has backfilled all users, this type can be removed
 * along with the `profile.newsletter` field.
 */
export type NewsletterPrefs = {
  subscribed: boolean;
  deliverToGmail: boolean;
  deliverToUniEmail: boolean;
};

/**
 * Field length budgets. Keep these in sync with firestore.rules — both enforce them.
 * Client-side is for UX (maxLength + counters); rules are the actual security boundary.
 */
export const FIELD_LIMITS = {
  preferredName: 80,
  universityEmail: 120,
  statusOther: 120,
  subject: 120,
  motivation: 1000,
  interests: 1000,
  title: 60,
  bio: 500,
  maxPaidMembershipYears: 10,
} as const;

/**
 * Matches @nottingham.ac.uk with optional subdomain (students.nottingham.ac.uk,
 * exmail.nottingham.ac.uk, etc.). Case-insensitive.
 */
export const UNI_EMAIL_PATTERN = /^[^@\s]+@([a-z0-9-]+\.)*nottingham\.ac\.uk$/i;

/**
 * Broader than UNI_EMAIL_PATTERN: matches ANY University of Nottingham address
 * we don't want used as a permanent sign-in identity — the UK campus
 * (nottingham.ac.uk + subdomains like exmail.nottingham.ac.uk) plus the China
 * (edu.cn) and Malaysia (edu.my) campuses. Used to BLOCK these on email/password
 * sign-up: uni addresses lapse at graduation, and a uni member who signs up with
 * one would double up with the Google member flow. Uni affiliation is proven
 * separately via the magic-link, so blocking the login costs nothing. Anchored
 * on the domain end so it does NOT catch Nottingham Trent (ntu.ac.uk).
 */
export const NOTTINGHAM_DOMAIN_PATTERN =
  /@([a-z0-9-]+\.)*nottingham\.(ac\.uk|edu\.cn|edu\.my)$/i;

export function isNottinghamEmail(email: string): boolean {
  return NOTTINGHAM_DOMAIN_PATTERN.test(email.trim());
}

/**
 * Matches ANY academic / institutional email — UK-style `.ac.<cc>` (ac.uk,
 * ac.nz, …), US `.edu`, and `.edu.<cc>` (edu.cn, edu.au, …), with optional
 * subdomains. Used to require a PERMANENT PERSONAL email as the sign-in identity
 * for everyone: institution emails lapse when you graduate / change jobs, so
 * keying an account to one locks people out. The `[a-z]{2}` ccTLD guard keeps
 * `foo@bar.edu.com`-style domains from false-matching. UoN affiliation is still
 * proven separately via the magic-link.
 */
export const ACADEMIC_DOMAIN_PATTERN =
  /@([a-z0-9-]+\.)*(ac\.[a-z]{2}|edu|edu\.[a-z]{2})$/i;

export function isAcademicEmail(email: string): boolean {
  return ACADEMIC_DOMAIN_PATTERN.test(email.trim());
}

export function validateUniversityEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return "University email is required.";
  if (trimmed.length > FIELD_LIMITS.universityEmail) return "That email is too long.";
  if (!UNI_EMAIL_PATTERN.test(trimmed)) {
    return "That doesn't look like a Nottingham email. If your affiliation uses a different address format, contact ai-safety@uonsu.com and we'll review it.";
  }
  return null;
}

export type UserProfile = {
  preferredName: string;
  universityEmail?: string;
  status?: AffiliationStatus;
  statusOther?: string; // free-text description when status === "other"
  subject?: string; // degree name, or area of work if employee/postdoc
  /** @deprecated kept for legacy users created before the status/subject split. */
  course?: string;
  /** @deprecated kept for legacy users created before the status/subject split. */
  year?: string;
  expectedGraduation?: string; // ISO month like "2027-06"
  motivation: string;
  interests?: string;
  /** @deprecated Use `notifications` instead — kept for compat reads on
   * un-migrated user docs. `normaliseNotifications()` in `./notifications.ts`
   * picks between the two. */
  newsletter?: NewsletterPrefs;
  /**
   * Per-category notification preferences. New shape. Once all users are
   * migrated (via the admin backfill endpoint) the `newsletter` field above
   * can be removed.
   */
  notifications?: NotificationPrefs;
  /**
   * ISO timestamp of when the user verified control of `universityEmail` via
   * the magic-link flow. Unset for legacy users (they get a non-blocking
   * nudge in ProfileForm); required for public-signup merges to be safe.
   */
  uniEmailVerifiedAt?: Date;
  /**
   * Set to true by the SES webhook when a Bounce or Complaint event names
   * this user's universityEmail. Cleared on the next uni-email change, which
   * also stamps universityEmailLockUntil — abuse-cycle break.
   */
  universityEmailWasSuppressed?: boolean;
  /**
   * ISO timestamp until which further uni-email changes are blocked on the
   * self-serve profile form. Stamped `now + 24h` when the user changes their
   * email while universityEmailWasSuppressed was true. Admin edits bypass.
   */
  universityEmailLockUntil?: Date;
};

/**
 * Private admin-assigned tags indicating which side(s) of our course programme a
 * user is aligned with. Admin-only in Firestore rules; not shown on public pages.
 */
export type Track = "technical" | "governance";
export const ALL_TRACKS: Track[] = ["technical", "governance"];
export const TRACK_LABELS: Record<Track, string> = {
  technical: "Technical",
  governance: "Governance",
};

/**
 * Orthogonal-to-role permissions an admin can grant. Admins always have all
 * permissions implicitly (see `canDraftNewsletter` / `canApproveNewsletter`);
 * the `permissions` field only matters for non-admin roles.
 */
export type UserPermissions = {
  draftNewsletter?: boolean;
  approveNewsletter?: boolean;
  draftEvent?: boolean;
  approveEvent?: boolean;
  draftCourse?: boolean;
  approveCourse?: boolean;
  /**
   * Membership periods, tier grants and revokes, and the `/admin/membership`
   * console. Deliberately NOT part of the SU-recognised PII tier: membership
   * is money and provenance rather than roster data, so recognising a
   * committee member does not hand them the society's payment record.
   *
   * Moving the CURRENT period pointer is full-admin only even with this key,
   * because it silently re-badges every member on the site at once.
   */
  manageMembership?: boolean;
  /**
   * Circulating a worksheet: sending one to people, adding recipients to a
   * circulation already in flight, and the recipient picker route
   * (`GET /api/worksheets/recipients`) that both need.
   *
   * Granted PER PERSON by an admin, and deliberately NOT automatic for
   * SU-recognised committee. Building and reading worksheets is open to the
   * whole committee; putting one in front of named people, with a task and an
   * email each, is the act worth naming somebody for. Admins hold it
   * implicitly like every other key.
   *
   * It is also what stands in for a users-collection read: the picker never
   * lists `users` from the browser, it calls the route, which requires this
   * key and answers with uids, display names and photos only. So a non-SU
   * committee member can be given the key without being given member PII,
   * and the users rule is untouched.
   */
  circulateWorksheet?: boolean;
};

export function canDraftNewsletter(user: Pick<UserDoc, "role" | "permissions">): boolean {
  return user.role === "admin" || Boolean(user.permissions?.draftNewsletter);
}

export function canApproveNewsletter(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.approveNewsletter);
}

export function canDraftEvent(user: Pick<UserDoc, "role" | "permissions">): boolean {
  return user.role === "admin" || Boolean(user.permissions?.draftEvent);
}

export function canApproveEvent(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.approveEvent);
}

export function canDraftCourse(user: Pick<UserDoc, "role" | "permissions">): boolean {
  return user.role === "admin" || Boolean(user.permissions?.draftCourse);
}

export function canApproveCourse(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.approveCourse);
}

/**
 * Who may author an admission round: an admin, or a member holding
 * `approveCourse`.
 *
 * Deliberately NOT `canDraftCourse`, and deliberately not a new permission
 * key. Authoring a round means writing the questions a cohort is judged on,
 * the criteria they are scored against and the dates the whole intake hangs
 * off, which sits with whoever may already sign off a course rather than with
 * everyone who may draft one. A separate `manageAdmissions` key was
 * considered and dropped: admissions authority is `reviewerUids` and
 * `finalDeciderUid` on the round itself, plus this gate for authoring, and a
 * third axis would only be a thing to forget to grant.
 */
export function canAuthorAdmissionRound(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.approveCourse);
}

/**
 * Who may create and edit membership periods, grant and revoke tiers, and
 * open the membership console. Admins implicitly, like every other key.
 *
 * Membership GATES NOTHING anywhere: it is a badge and a record. This key
 * decides who may write that record, never what anybody may reach.
 */
export function canManageMembership(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.manageMembership);
}

/**
 * Who may circulate a worksheet and add recipients to one. Admins
 * implicitly, like every other key.
 *
 * The circulation ROUTES are the enforcement point (no Firestore rule keys
 * off this in v1, because creating a circulation is a route and not a client
 * write). Anything that gates on it must call this rather than test the raw
 * key, so the admin-implicit half is never forgotten in one place and
 * remembered in another.
 */
export function canCirculateWorksheet(
  user: Pick<UserDoc, "role" | "permissions">,
): boolean {
  return user.role === "admin" || Boolean(user.permissions?.circulateWorksheet);
}

/**
 * Who may be APPOINTED a reviewer or a final decider on a round.
 *
 * Admins, and SU-recognised committee. Reviewers read applications, which are
 * member PII plus free text about the applicant's circumstances, so the bar is
 * the same trust boundary that already gates the `users` collection and the
 * committee task board rather than a looser one invented for admissions. A
 * non-SU committee member or a plain member cannot be appointed however the
 * request is shaped: the roles route checks this against each candidate's live
 * user document, never against what the browser sent.
 */
export function isEligibleAdmissionsReviewer(
  user: Pick<UserDoc, "role" | "suRecognised">,
): boolean {
  return user.role === "admin" || (user.role === "committee" && Boolean(user.suRecognised));
}

/**
 * A UK academic year label: four-digit start year, slash, two-digit end year —
 * "2026/27". The same shape a course run carries in `academicYear`, and what
 * Firestore rules check before letting an admin add a paid-membership tag.
 */
export const ACADEMIC_YEAR_PATTERN = /^\d{4}\/\d{2}$/;

/** 1-indexed month the UK academic year rolls over on (1 August). */
const ACADEMIC_YEAR_START_MONTH = 8;

const LONDON_YEAR_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
});

/**
 * The academic year containing `now`, e.g. "2026/27". Rolls over on 1 August,
 * so September 2026 and January 2027 both return "2026/27".
 *
 * The month is read in Europe/London rather than off `Date.getMonth()`: App
 * Hosting runs UTC, and during BST an instant like 23:30 UTC on 31 July is
 * already 1 August in London. That hour is the whole reason this goes through
 * Intl. (The courses week-plan helpers carry the fuller civil-date maths for
 * run pacing; this one stays local so `users.ts` — which auth, admin, and email
 * code all import — takes on no dependency of its own.)
 */
export function currentAcademicYear(now: Date = new Date()): string {
  const parts = LONDON_YEAR_MONTH.formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const startYear = month >= ACADEMIC_YEAR_START_MONTH ? year : year - 1;
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Whether an admin has tagged this user as a paid member for `year`.
 *
 * This is a BADGE, never a gate. Course applications are open to every
 * signed-in user (including `pending` ones) and the tag is surfaced only to
 * reviewers deciding an application — nothing may branch access on it.
 */
export function hasPaidMembership(
  user: Pick<UserDoc, "paidMembershipYears">,
  year: string = currentAcademicYear(),
): boolean {
  return Boolean(user.paidMembershipYears?.includes(year));
}

export type UserDoc = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: Role;
  profile?: UserProfile;
  title?: string | null;
  bio?: string | null;
  showOnMembers?: boolean;
  tracks?: Track[];
  /**
   * Academic years ("2026/27") an admin has tagged this user as a paid member
   * for. Admin-set and pinned against self-edits in Firestore rules, exactly
   * like `tracks`; array-contains-queryable, capped at
   * `FIELD_LIMITS.maxPaidMembershipYears`. Absent — not empty — on users who
   * have never been tagged, so a membership badge never renders off a stray
   * empty array. Read it through `hasPaidMembership()`.
   */
  paidMembershipYears?: string[];
  permissions?: UserPermissions;
  /**
   * True only for committee members the Students' Union formally recognises.
   * Admin-set (locked against self-edits in Firestore rules). Gates access to
   * member PII (the users collection) and the committee task board; non-SU
   * committee are scoped to the tasks they are on.
   */
  suRecognised?: boolean;
  /**
   * SERVER-OWNED. True while this user is a reviewer or the final decider on
   * at least one admission round. Written only by
   * `PUT /api/admissions/rounds/[roundId]/roles`, and pinned in
   * `firestore.rules` absent-at-create and unchanged-on-self-update exactly
   * like `suRecognised`.
   *
   * It is a DENORMALISATION of `admissionRounds.reviewerUids` /
   * `finalDeciderUid`, and it exists for one reason: the Admissions sidebar
   * entry. `AppShell` gates every nav item client-side from the `useAuth()`
   * snapshot, which is a live `onSnapshot` on this document. Gating on "does
   * this uid appear in some round's reviewerUids" has no field behind it, so
   * it would cost an `admissionRounds` query on every authed navigation for
   * every user, or the entry would simply never appear for exactly the
   * non-admin SU reviewers the reviewer surface exists to serve.
   *
   * The round arrays remain the AUTHORITY: every admissions route re-checks
   * membership of the round it is acting on. This flag decides whether a link
   * is drawn, never what may be read.
   */
  admissionsReviewer?: boolean;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  rejectedAt?: Date | null;
  rejectedBy?: string | null;
  createdAt?: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

/**
 * De-duplicated list of well-formed academic-year tags. Anything that isn't a
 * string matching ACADEMIC_YEAR_PATTERN is dropped rather than carried through,
 * so a hand-edited doc can't put junk in front of a reviewer.
 */
function asAcademicYearList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const y of v) {
    if (typeof y === "string" && ACADEMIC_YEAR_PATTERN.test(y)) seen.add(y);
  }
  // NEWEST FIRST, before the slice. The slice used to keep whichever ten
  // happened to be stored first, so a document that had grown past the cap
  // could drop the CURRENT year and blank a member's badge while ten stale
  // ones stayed. A four-digit start year leads the string, so a plain
  // descending comparison is the right order and needs no parsing.
  return Array.from(seen)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, FIELD_LIMITS.maxPaidMembershipYears);
}

export function normalizeUser(id: string, data: Raw): UserDoc {
  const rawTracks = Array.isArray(data.tracks) ? (data.tracks as unknown[]) : [];
  const tracks = rawTracks.filter(
    (t): t is Track => t === "technical" || t === "governance",
  );
  // Absent rather than empty when there is nothing to show — see UserDoc.
  const paidMembershipYears = asAcademicYearList(data.paidMembershipYears);
  const rawPermissions = (data.permissions ?? {}) as Record<string, unknown>;
  const permissions: UserPermissions = {
    draftNewsletter: Boolean(rawPermissions.draftNewsletter),
    approveNewsletter: Boolean(rawPermissions.approveNewsletter),
    draftEvent: Boolean(rawPermissions.draftEvent),
    approveEvent: Boolean(rawPermissions.approveEvent),
    draftCourse: Boolean(rawPermissions.draftCourse),
    approveCourse: Boolean(rawPermissions.approveCourse),
    manageMembership: Boolean(rawPermissions.manageMembership),
    circulateWorksheet: Boolean(rawPermissions.circulateWorksheet),
  };
  return {
    uid: id,
    email: (data.email as string) ?? null,
    displayName: (data.displayName as string) ?? null,
    photoURL: (data.photoURL as string) ?? null,
    role: (data.role as Role) ?? "pending",
    profile: data.profile as UserProfile | undefined,
    title: (data.title as string | null | undefined) ?? null,
    bio: (data.bio as string | null | undefined) ?? null,
    showOnMembers: Boolean(data.showOnMembers),
    tracks,
    ...(paidMembershipYears.length > 0 ? { paidMembershipYears } : {}),
    permissions,
    suRecognised: Boolean(data.suRecognised),
    admissionsReviewer: Boolean(data.admissionsReviewer),
    approvedAt: tsToDate(data.approvedAt),
    approvedBy: (data.approvedBy as string) ?? null,
    rejectedAt: tsToDate(data.rejectedAt),
    rejectedBy: (data.rejectedBy as string) ?? null,
    createdAt: tsToDate(data.createdAt),
  };
}
