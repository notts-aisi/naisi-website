import type { Role } from "@/lib/firebase/session";

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
} as const;

/**
 * Matches @nottingham.ac.uk with optional subdomain (students.nottingham.ac.uk,
 * exmail.nottingham.ac.uk, etc.). Case-insensitive.
 */
export const UNI_EMAIL_PATTERN = /^[^@\s]+@([a-z0-9-]+\.)*nottingham\.ac\.uk$/i;

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
  newsletter?: NewsletterPrefs;
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
  permissions?: UserPermissions;
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

export function normalizeUser(id: string, data: Raw): UserDoc {
  const rawTracks = Array.isArray(data.tracks) ? (data.tracks as unknown[]) : [];
  const tracks = rawTracks.filter(
    (t): t is Track => t === "technical" || t === "governance",
  );
  const rawPermissions = (data.permissions ?? {}) as Record<string, unknown>;
  const permissions: UserPermissions = {
    draftNewsletter: Boolean(rawPermissions.draftNewsletter),
    approveNewsletter: Boolean(rawPermissions.approveNewsletter),
    draftEvent: Boolean(rawPermissions.draftEvent),
    approveEvent: Boolean(rawPermissions.approveEvent),
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
    permissions,
    approvedAt: tsToDate(data.approvedAt),
    approvedBy: (data.approvedBy as string) ?? null,
    rejectedAt: tsToDate(data.rejectedAt),
    rejectedBy: (data.rejectedBy as string) ?? null,
    createdAt: tsToDate(data.createdAt),
  };
}
