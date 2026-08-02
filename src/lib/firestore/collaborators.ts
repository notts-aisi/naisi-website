import { slugify } from "./slugId";

/**
 * External collaborator applications — people NOT at the University of Nottingham
 * who want to collaborate with NAISI. A SEPARATE collection from `users` so the
 * member governance/trust model is untouched; doc id = `<name-slug>__<uid>` for
 * a scannable Firebase Console (same `__` convention as `slugId`), with `uid`
 * also stored as a queryable field. All writes go through server routes (Admin
 * SDK); client writes are locked in firestore.rules (like subscriptions / eventRsvps).
 */

export type CollaboratorStatus = "pending" | "approved" | "rejected";

export const COLLABORATOR_STATUSES: CollaboratorStatus[] = [
  "pending",
  "approved",
  "rejected",
];

/**
 * Field length budgets for the collaborator application. Keep these in sync with
 * the server create/update routes — the routes are the security boundary, these
 * power the client form's `maxLength` + counters (same split as `users.FIELD_LIMITS`).
 */
export const COLLABORATOR_FIELD_LIMITS = {
  fullName: 80,
  projectPitch: 1500,
  background: 1000,
  linkedinUrl: 200,
  portfolioUrl: 200,
  institution: 120,
  roleTitle: 120,
  interests: 1000,
  heardAbout: 200,
  committeeContactName: 120,
  impactJustification: 1000,
} as const;

/** The applicant's pitch. Optional fields are omitted (never `undefined`) before write. */
export type CollaboratorApplication = {
  /** What project they'd do with us. */
  projectPitch: string;
  /** Their background / bio. */
  background: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  /** Current university, lab, company, or "independent". */
  institution: string;
  /** PhD student, research engineer, postdoc, … */
  roleTitle: string;
  /** Areas of AI safety interest (free text). */
  interests: string;
  /** How they heard about NAISI. */
  heardAbout: string;
  /** Whether they already know someone on committee. */
  knowsCommittee: boolean;
  /** Name(s) of the committee contact — present only when knowsCommittee. */
  committeeContactName?: string;
  /** Optional "why I'd be a high-impact collaborator". */
  impactJustification?: string;
};

export type CollaboratorDoc = {
  /** Firestore doc id: `<name-slug>__<uid>`. */
  id: string;
  uid: string;
  email: string | null;
  // NB: emailVerified is intentionally NOT stored — it's Auth-owned and would go
  // stale (it changes when the user clicks the verify link, with no write back
  // here). The admin list reads it live via getUsers; see
  // /api/admin/collaborators/verification + useCollaboratorVerification.
  fullName: string;
  status: CollaboratorStatus;
  application: CollaboratorApplication;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  rejectedAt?: Date | null;
  rejectedBy?: string | null;
  rejectionReason?: string | null;
  /** Set once the collaborator enrols a passkey (passkey phase). */
  passkeyEnrolled?: boolean;
  /** Combined Terms+Privacy version accepted at apply time, and when (server-
   *  stamped). Powers a future "re-consent to the updated policy" prompt. */
  policyVersion?: string;
  policyAgreedAt?: Date | null;
};

/**
 * Compose the doc id `<name-slug>__<uid>`. Reuses the shared `slugify` (lowercase
 * `[a-z0-9-]`, max 40, `"untitled"` fallback) so the `__` separator stays
 * unambiguous and the uid is recoverable. The uid is also stored as a field, so
 * lookups by session uid use a `where("uid","==",uid)` query, not the id.
 */
export function collaboratorDocId(fullName: string, uid: string): string {
  return `${slugify(fullName)}__${uid}`;
}

const HTTP_URL = /^https?:\/\/[^\s.]+\.[^\s]+$/i;

/**
 * Validate an OPTIONAL URL field (LinkedIn / portfolio). Returns an error string,
 * or null when empty (optional) or a well-formed http(s) URL within the cap.
 */
export function validateOptionalUrl(
  value: string | undefined,
  label: string,
  max: number,
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return `That ${label} link is too long.`;
  if (!HTTP_URL.test(trimmed)) {
    return `That ${label} link doesn't look like a valid URL (it should start with http:// or https://).`;
  }
  return null;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function normalizeCollaborator(id: string, data: Raw): CollaboratorDoc {
  const rawApp = (data.application ?? {}) as Raw;
  const status = data.status as CollaboratorStatus;
  return {
    id,
    uid: str(data.uid),
    email: (data.email as string | null | undefined) ?? null,
    fullName: str(data.fullName),
    status: COLLABORATOR_STATUSES.includes(status) ? status : "pending",
    application: {
      projectPitch: str(rawApp.projectPitch),
      background: str(rawApp.background),
      linkedinUrl: rawApp.linkedinUrl ? str(rawApp.linkedinUrl) : undefined,
      portfolioUrl: rawApp.portfolioUrl ? str(rawApp.portfolioUrl) : undefined,
      institution: str(rawApp.institution),
      roleTitle: str(rawApp.roleTitle),
      interests: str(rawApp.interests),
      heardAbout: str(rawApp.heardAbout),
      knowsCommittee: Boolean(rawApp.knowsCommittee),
      committeeContactName: rawApp.committeeContactName
        ? str(rawApp.committeeContactName)
        : undefined,
      impactJustification: rawApp.impactJustification
        ? str(rawApp.impactJustification)
        : undefined,
    },
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    approvedAt: tsToDate(data.approvedAt),
    approvedBy: (data.approvedBy as string) ?? null,
    rejectedAt: tsToDate(data.rejectedAt),
    rejectedBy: (data.rejectedBy as string) ?? null,
    rejectionReason: (data.rejectionReason as string) ?? null,
    passkeyEnrolled: Boolean(data.passkeyEnrolled),
    policyVersion: (data.policyVersion as string) ?? undefined,
    policyAgreedAt: tsToDate(data.policyAgreedAt),
  };
}

/** The editable shape submitted from the apply form / collaborator area. */
export type CollaboratorInput = {
  fullName: string;
  application: CollaboratorApplication;
};

/**
 * Validate the application input. Used by BOTH the client form (inline errors)
 * and the server route (the security boundary). Returns an error string, or
 * null when valid.
 */
export function validateCollaboratorInput(input: CollaboratorInput): string | null {
  const L = COLLABORATOR_FIELD_LIMITS;
  const a = input.application;

  if (!input.fullName.trim()) return "Please enter your name.";
  if (input.fullName.length > L.fullName) return "That name is too long.";

  if (!a.projectPitch.trim())
    return "Please describe the project you'd like to do with us.";
  if (a.projectPitch.length > L.projectPitch) return "Your project pitch is too long.";

  if (!a.background.trim()) return "Please tell us a little about your background.";
  if (a.background.length > L.background) return "Your background is too long.";

  if (!a.institution.trim())
    return "Please tell us your institution or affiliation.";
  if (a.institution.length > L.institution) return "That institution is too long.";

  if (!a.roleTitle.trim()) return "Please tell us your role or title.";
  if (a.roleTitle.length > L.roleTitle) return "That role is too long.";

  if (!a.interests.trim()) return "Please tell us your areas of AI safety interest.";
  if (a.interests.length > L.interests) return "That's a little too long.";

  if (!a.heardAbout.trim()) return "Please tell us how you heard about NAISI.";
  if (a.heardAbout.length > L.heardAbout) return "That's a little too long.";

  const linkedinErr = validateOptionalUrl(a.linkedinUrl, "LinkedIn", L.linkedinUrl);
  if (linkedinErr) return linkedinErr;
  const portfolioErr = validateOptionalUrl(a.portfolioUrl, "portfolio", L.portfolioUrl);
  if (portfolioErr) return portfolioErr;

  if (a.knowsCommittee && !(a.committeeContactName ?? "").trim())
    return "You said you know someone on the committee — please add their name.";
  if ((a.committeeContactName ?? "").length > L.committeeContactName)
    return "That name is too long.";

  if ((a.impactJustification ?? "").length > L.impactJustification)
    return "That's a little too long.";

  return null;
}

/**
 * Build a clean `application` object for writing: trims everything and OMITS
 * empty optionals entirely (never writes `undefined` — Firestore rejects it,
 * per the documented no-undefined-in-setDoc convention).
 */
export function buildApplication(input: CollaboratorInput): CollaboratorApplication {
  const a = input.application;
  const app: CollaboratorApplication = {
    projectPitch: a.projectPitch.trim(),
    background: a.background.trim(),
    institution: a.institution.trim(),
    roleTitle: a.roleTitle.trim(),
    interests: a.interests.trim(),
    heardAbout: a.heardAbout.trim(),
    knowsCommittee: Boolean(a.knowsCommittee),
  };
  const linkedin = (a.linkedinUrl ?? "").trim();
  if (linkedin) app.linkedinUrl = linkedin;
  const portfolio = (a.portfolioUrl ?? "").trim();
  if (portfolio) app.portfolioUrl = portfolio;
  if (app.knowsCommittee) {
    const contact = (a.committeeContactName ?? "").trim();
    if (contact) app.committeeContactName = contact;
  }
  const justification = (a.impactJustification ?? "").trim();
  if (justification) app.impactJustification = justification;
  return app;
}

