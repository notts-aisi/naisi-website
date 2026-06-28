import type { AffiliationStatus } from "./users";
import { STATUS_LABELS } from "./users";
import {
  isValidBlock,
  newBlockId,
  sanitizeBlocks,
  type Block,
} from "./newsletterBlocks";

/**
 * Well-known template IDs. One doc per ID in `applicationEmailTemplates/{id}`.
 * Rejection reasons are fixed so the admin picker and the defaults table stay
 * in sync; arbitrary free-text rejections go through `rejected-custom` with a
 * {customReason} token.
 */
export const TEMPLATE_IDS = [
  "application-submitted",
  "application-approved",
  "rejected-not-member",
  "rejected-not-in-nottingham",
  "rejected-suspected-spam",
  "rejected-custom",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type TemplateTrigger = "submitted" | "approved" | "rejected";

export type RejectionReasonKey =
  | "not-member"
  | "not-in-nottingham"
  | "suspected-spam"
  | "custom";

export const REJECTION_REASONS: Record<RejectionReasonKey, { label: string; templateId: TemplateId }> = {
  "not-member": {
    label: "Not an interested member",
    templateId: "rejected-not-member",
  },
  "not-in-nottingham": {
    label: "Not based in Nottingham",
    templateId: "rejected-not-in-nottingham",
  },
  "suspected-spam": {
    label: "Suspected spam",
    templateId: "rejected-suspected-spam",
  },
  custom: {
    label: "Custom reason…",
    templateId: "rejected-custom",
  },
};

export type RecipientModifier = "both" | "google" | "university";

export const RECIPIENT_MODIFIER_LABELS: Record<RecipientModifier, string> = {
  both: "Both (Google + university)",
  google: "Google email only",
  university: "University email only",
};

export type TemplateDoc = {
  templateId: TemplateId;
  trigger: TemplateTrigger;
  label: string;
  subject: string;
  blocks: Block[];
  recipients: RecipientModifier;
  fromName?: string;
  updatedAt?: Date | null;
  updatedBy?: string | null;
};

export const SUBJECT_MAX = 200;

/**
 * Trigger each template belongs to. Used by the send route to decide
 * which authorisation branch to take.
 */
export const TEMPLATE_TRIGGER: Record<TemplateId, TemplateTrigger> = {
  "application-submitted": "submitted",
  "application-approved": "approved",
  "rejected-not-member": "rejected",
  "rejected-not-in-nottingham": "rejected",
  "rejected-suspected-spam": "rejected",
  "rejected-custom": "rejected",
};

function isRecipientModifier(v: unknown): v is RecipientModifier {
  return v === "both" || v === "google" || v === "university";
}

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);
}

export function isValidTemplateDoc(raw: unknown): raw is TemplateDoc {
  if (!raw || typeof raw !== "object") return false;
  const d = raw as Record<string, unknown>;
  if (!isTemplateId(d.templateId)) return false;
  if (typeof d.subject !== "string" || d.subject.length === 0) return false;
  if (d.subject.length > SUBJECT_MAX) return false;
  if (!Array.isArray(d.blocks) || !d.blocks.every(isValidBlock)) return false;
  if (!isRecipientModifier(d.recipients)) return false;
  return true;
}

/**
 * Coerce a raw Firestore doc into a TemplateDoc. Unknown fields are dropped;
 * a missing or malformed blocks array becomes [].
 */
export function normalizeTemplate(id: string, data: Record<string, unknown>): TemplateDoc | null {
  if (!isTemplateId(id)) return null;
  const trigger = TEMPLATE_TRIGGER[id];
  const recipients: RecipientModifier = isRecipientModifier(data.recipients)
    ? data.recipients
    : "both";
  return {
    templateId: id,
    trigger,
    label: typeof data.label === "string" ? data.label : DEFAULT_LABELS[id],
    subject: typeof data.subject === "string" ? data.subject : "",
    blocks: sanitizeBlocks(data.blocks),
    recipients,
    fromName: typeof data.fromName === "string" ? data.fromName : undefined,
    updatedAt: tsToDate(data.updatedAt),
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

/**
 * Pick the recipient address(es) for a given user + template modifier.
 * Defensive fallback: if the preferred channel is missing, fall back to the
 * other one so a misconfigured user doesn't silently get no mail.
 * Deduped (a user's Google address could also be @nottingham.ac.uk).
 *
 * An UNVERIFIED university address is treated as absent: the applicant typed it
 * but never clicked the verification magic-link, so it commonly bounces. We skip
 * it (falling back to the Google address) rather than mail into the void.
 */
export function resolveRecipients(
  user: {
    email?: string | null;
    profile?: {
      universityEmail?: string | null;
      /** Only mail the university address once the user has verified control of it. */
      uniEmailVerified?: boolean;
    } | null;
  },
  modifier: RecipientModifier,
): string[] {
  const google = normaliseEmail(user.email);
  const uniRaw = normaliseEmail(user.profile?.universityEmail);
  const uni = user.profile?.uniEmailVerified ? uniRaw : null;
  let addresses: (string | null)[];
  if (modifier === "google") {
    addresses = [google ?? uni];
  } else if (modifier === "university") {
    addresses = [uni ?? google];
  } else {
    addresses = [google, uni];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function normaliseEmail(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Token map used at send time. `customReason` is only populated for
 * rejected-custom sends; everything else is derived from the user doc.
 */
export type TokenMap = {
  preferredName: string;
  firstName: string;
  fullName: string;
  fieldOfStudy: string;
  statusLabel: string;
  customReason?: string;
};

export type TokenUserInput = {
  email?: string | null;
  displayName?: string | null;
  profile?: {
    preferredName?: string;
    subject?: string;
    status?: AffiliationStatus;
    statusOther?: string;
  } | null;
};

export function buildTokens(user: TokenUserInput, customReason?: string): TokenMap {
  const preferredName = user.profile?.preferredName?.trim() ?? "";
  const displayName = user.displayName?.trim() ?? "";
  const source = preferredName || displayName;
  const fieldOfStudy = user.profile?.subject?.trim() ?? "";
  const status = user.profile?.status;
  const statusLabel =
    status && status !== "other"
      ? STATUS_LABELS[status]
      : (user.profile?.statusOther?.trim() ?? "");
  return {
    preferredName: preferredName || displayName,
    firstName: firstWord(source),
    fullName: displayName || preferredName,
    fieldOfStudy,
    statusLabel,
    ...(customReason !== undefined ? { customReason } : {}),
  };
}

/** First whitespace-separated token, trimmed. Empty string if no source. */
export function firstWord(s: string): string {
  const parts = s.trim().split(/\s+/);
  return parts[0] ?? "";
}

export const DEFAULT_LABELS: Record<TemplateId, string> = {
  "application-submitted": "Application submitted",
  "application-approved": "Application approved",
  "rejected-not-member": "Rejection — not an interested member",
  "rejected-not-in-nottingham": "Rejection — not based in Nottingham",
  "rejected-suspected-spam": "Rejection — suspected spam",
  "rejected-custom": "Rejection — custom reason",
};

function rt(html: string): Block {
  return { id: newBlockId(), type: "richText", html };
}

function h(text: string, level: 2 | 3 = 2): Block {
  return { id: newBlockId(), type: "heading", text, level };
}

/**
 * Seed copy for each template. Admins can fully rewrite these in the editor;
 * they exist so a fresh deploy has something sensible to send before anyone
 * opens the admin UI.
 */
export const templateDefaults: Record<
  TemplateId,
  { label: string; subject: string; blocks: Block[]; recipients: RecipientModifier }
> = {
  "application-submitted": {
    label: DEFAULT_LABELS["application-submitted"],
    subject: "We got your NAISI application, {firstName}",
    blocks: [
      h("Thanks for applying, {firstName}"),
      rt(
        "<p>Your application to the Nottingham AI Safety Initiative has been received. The committee reviews applications within a few days — we'll be in touch soon.</p>" +
          "<p>In the meantime, feel free to reach out on Instagram if you have any questions.</p>",
      ),
    ],
    recipients: "both",
  },
  "application-approved": {
    label: DEFAULT_LABELS["application-approved"],
    subject: "Welcome to NAISI, {firstName}",
    blocks: [
      h("Welcome to NAISI, {firstName}"),
      rt(
        "<p>Your application has been approved — you're now a member of the Nottingham AI Safety Initiative. Sign back in to see the member dashboard, upcoming events, and our reading groups.</p>" +
          "<p>We're glad to have you.</p>",
      ),
    ],
    recipients: "both",
  },
  "rejected-not-member": {
    label: DEFAULT_LABELS["rejected-not-member"],
    subject: "About your NAISI application",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>Thanks for applying to NAISI. After reviewing your application, we weren't able to approve it at this time.</p>" +
          "<p>You're always welcome to follow us on Instagram for public events and updates.</p>",
      ),
    ],
    recipients: "both",
  },
  "rejected-not-in-nottingham": {
    label: DEFAULT_LABELS["rejected-not-in-nottingham"],
    subject: "About your NAISI application",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>Thanks for your interest in NAISI. Our membership is specifically for people based at the University of Nottingham, so we weren't able to approve your application.</p>" +
          "<p>If you do end up studying or working at Nottingham in future, please do apply again.</p>",
      ),
    ],
    recipients: "both",
  },
  "rejected-suspected-spam": {
    label: DEFAULT_LABELS["rejected-suspected-spam"],
    subject: "About your NAISI application",
    blocks: [
      h("Hi {firstName},"),
      rt(
        "<p>We weren't able to verify the details on your application, so it hasn't been approved. If you believe this was a mistake, please reach out to us via Instagram and we'll take another look.</p>",
      ),
    ],
    recipients: "both",
  },
  "rejected-custom": {
    label: DEFAULT_LABELS["rejected-custom"],
    subject: "About your NAISI application",
    blocks: [
      h("Hi {firstName},"),
      rt("<p>{customReason}</p>"),
      rt(
        "<p>If you'd like to discuss this further, feel free to get in touch with us on Instagram.</p>",
      ),
    ],
    recipients: "both",
  },
};
