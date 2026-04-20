import { sanitizeBlocks, type Block } from "./newsletterBlocks";

/**
 * Event lifecycle mirrors the newsletter draft flow (draft → pending → approved
 * → published / rejected) with two event-specific additions:
 *   - "published" takes the place of newsletter's "sent" and is server-only.
 *   - "cancelled" can be set on an already-published event if plans fall through.
 */
export type EventStatus =
  | "draft"
  | "pending"
  | "approved"
  | "published"
  | "rejected"
  | "cancelled";

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  pending: "Pending review",
  approved: "Approved",
  published: "Published",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export type EventVisibility = "public" | "members";

/**
 * Event-level declaration about where/how the food is sourced. Lets organizers
 * proactively notify attendees of religious/dietary-only kitchens (e.g. "food
 * is from a halal restaurant") so attendees don't have to ask.
 */
export type FoodProvenance =
  | "none"
  | "halal"
  | "kosher"
  | "vegetarian"
  | "vegan"
  | "other";

export const FOOD_PROVENANCE_LABEL: Record<FoodProvenance, string> = {
  none: "No declaration / no food",
  halal: "Halal",
  kosher: "Kosher",
  vegetarian: "Vegetarian-only kitchen",
  vegan: "Vegan-only kitchen",
  other: "Other (see note)",
};

/** Short badge-ready labels shown to attendees on the public event page. */
export const FOOD_PROVENANCE_BADGE: Record<Exclude<FoodProvenance, "none">, string> = {
  halal: "Halal food",
  kosher: "Kosher food",
  vegetarian: "Vegetarian kitchen",
  vegan: "Vegan kitchen",
  other: "Special kitchen",
};

// ---- Modular signup form ----

export type FormQuestionType =
  | "shortText"
  | "longText"
  | "singleSelect"
  | "multiSelect"
  | "yesNo"
  | "dietaryAllergies";

type BaseQuestion = {
  id: string;
  label: string;
  required: boolean;
};

export type ShortTextQuestion = BaseQuestion & {
  type: "shortText";
  placeholder?: string;
};

export type LongTextQuestion = BaseQuestion & {
  type: "longText";
  placeholder?: string;
};

export type SingleSelectQuestion = BaseQuestion & {
  type: "singleSelect";
  options: string[];
};

export type MultiSelectQuestion = BaseQuestion & {
  type: "multiSelect";
  options: string[];
};

export type YesNoQuestion = BaseQuestion & {
  type: "yesNo";
};

/**
 * A fixed checklist for common allergies. Lives as its own question type so the
 * dashboard can aggregate it consistently across events without the organizer
 * having to recreate the same list each time.
 */
export type DietaryAllergiesQuestion = BaseQuestion & {
  type: "dietaryAllergies";
};

export const DIETARY_ALLERGIES: string[] = [
  "Peanuts",
  "Tree nuts",
  "Gluten",
  "Dairy",
  "Eggs",
  "Soy",
  "Fish",
  "Shellfish",
  "Sesame",
];

export type FormQuestion =
  | ShortTextQuestion
  | LongTextQuestion
  | SingleSelectQuestion
  | MultiSelectQuestion
  | YesNoQuestion
  | DietaryAllergiesQuestion;

export function newQuestionId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyQuestion(type: FormQuestionType): FormQuestion {
  const id = newQuestionId();
  switch (type) {
    case "shortText":
      return { id, type, label: "", required: false };
    case "longText":
      return { id, type, label: "", required: false };
    case "singleSelect":
      return { id, type, label: "", required: false, options: ["", ""] };
    case "multiSelect":
      return { id, type, label: "", required: false, options: ["", ""] };
    case "yesNo":
      return { id, type, label: "", required: false };
    case "dietaryAllergies":
      return { id, type, label: "Any food allergies we should know about?", required: false };
  }
}

export function isValidQuestion(raw: unknown): raw is FormQuestion {
  if (!raw || typeof raw !== "object") return false;
  const q = raw as Record<string, unknown>;
  if (typeof q.id !== "string" || typeof q.label !== "string") return false;
  if (typeof q.type !== "string") return false;
  switch (q.type) {
    case "shortText":
    case "longText":
    case "yesNo":
    case "dietaryAllergies":
      return true;
    case "singleSelect":
    case "multiSelect":
      return Array.isArray(q.options) && q.options.every((o) => typeof o === "string");
    default:
      return false;
  }
}

export function sanitizeSignupForm(raw: unknown): FormQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidQuestion).map((q) => ({
    ...q,
    required: Boolean((q as { required?: unknown }).required),
  }));
}

// ---- Event doc ----

export type EventDoc = {
  id: string;
  title: string;
  blocks: Block[];
  /** ISO-ish timestamp (Firestore Timestamp on the wire). */
  startAt: Date | null;
  endAt: Date | null;
  location: string;
  /**
   * When true, the exact `location` is hidden from the public page until a
   * user's RSVP is approved. The email sent on approval still includes the
   * real location. Day and time are always public regardless of this flag.
   */
  locationHidden: boolean;
  /**
   * Fuzzy placeholder shown on the public page in place of `location` when
   * `locationHidden` is true (e.g. "somewhere on University Park campus").
   */
  locationPublicText: string | null;
  visibility: EventVisibility;
  capacity: number | null;
  waitlistEnabled: boolean;
  signupForm: FormQuestion[];
  foodProvenance: FoodProvenance;
  foodProvenanceNote?: string | null;
  posterUrl?: string | null;
  status: EventStatus;
  authorUid: string;
  authorDisplayName?: string | null;
  reviewerNotes?: string | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  publishedAt?: Date | null;
  rsvpCountPending?: number | null;
  rsvpCountConfirmed?: number | null;
  rsvpCountWaitlisted?: number | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function asStatus(v: unknown): EventStatus {
  const ok = [
    "draft",
    "pending",
    "approved",
    "published",
    "rejected",
    "cancelled",
  ] as const;
  return ok.includes(v as EventStatus) ? (v as EventStatus) : "draft";
}

function asVisibility(v: unknown): EventVisibility {
  return v === "public" ? "public" : "members";
}

function asFoodProvenance(v: unknown): FoodProvenance {
  const ok: FoodProvenance[] = ["none", "halal", "kosher", "vegetarian", "vegan", "other"];
  return ok.includes(v as FoodProvenance) ? (v as FoodProvenance) : "none";
}

export function normalizeEvent(id: string, data: Raw): EventDoc {
  const capacityRaw = data.capacity;
  const capacity =
    typeof capacityRaw === "number" && Number.isFinite(capacityRaw) && capacityRaw > 0
      ? Math.floor(capacityRaw)
      : null;
  return {
    id,
    title: (data.title as string) ?? "",
    blocks: sanitizeBlocks(data.blocks),
    startAt: tsToDate(data.startAt),
    endAt: tsToDate(data.endAt),
    location: (data.location as string) ?? "",
    locationHidden: Boolean(data.locationHidden),
    locationPublicText: (data.locationPublicText as string | null | undefined) ?? null,
    visibility: asVisibility(data.visibility),
    capacity,
    waitlistEnabled:
      capacity === null ? false : data.waitlistEnabled !== false,
    signupForm: sanitizeSignupForm(data.signupForm),
    foodProvenance: asFoodProvenance(data.foodProvenance),
    foodProvenanceNote: (data.foodProvenanceNote as string | null | undefined) ?? null,
    posterUrl: (data.posterUrl as string | null | undefined) ?? null,
    status: asStatus(data.status),
    authorUid: (data.authorUid as string) ?? "",
    authorDisplayName: (data.authorDisplayName as string | null | undefined) ?? null,
    reviewerNotes: (data.reviewerNotes as string | null | undefined) ?? null,
    approvedBy: (data.approvedBy as string | null | undefined) ?? null,
    approvedAt: tsToDate(data.approvedAt),
    publishedAt: tsToDate(data.publishedAt),
    rsvpCountPending:
      typeof data.rsvpCountPending === "number"
        ? (data.rsvpCountPending as number)
        : null,
    rsvpCountConfirmed:
      typeof data.rsvpCountConfirmed === "number"
        ? (data.rsvpCountConfirmed as number)
        : null,
    rsvpCountWaitlisted:
      typeof data.rsvpCountWaitlisted === "number"
        ? (data.rsvpCountWaitlisted as number)
        : null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export const TITLE_MAX = 120;
export const LOCATION_MAX = 200;

// ---- RSVP ----

export type RsvpStatus =
  | "pending"
  | "confirmed"
  | "waitlisted"
  | "denied"
  | "cancelled";

export const RSVP_STATUS_LABEL: Record<RsvpStatus, string> = {
  pending: "Pending review",
  confirmed: "Confirmed",
  waitlisted: "Waitlisted",
  denied: "Denied",
  cancelled: "Cancelled",
};

export const RSVP_STATUSES: RsvpStatus[] = [
  "pending",
  "confirmed",
  "waitlisted",
  "denied",
  "cancelled",
];

/** Answer shape for each FormQuestion type. Kept loose — validated at write time. */
export type RsvpAnswer =
  | string
  | string[]
  | boolean
  | { checked: string[]; other: string };

export type RsvpDoc = {
  id: string;
  eventId: string;
  uid: string | null;
  name: string;
  email: string;
  answers: Record<string, RsvpAnswer>;
  status: RsvpStatus;
  /** Organiser-facing note on why an RSVP was denied (optional). */
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** Pending attendee-proposed changes to their answers, awaiting approval. */
  pendingAnswers: Record<string, RsvpAnswer> | null;
  pendingAnswersRequestedAt: Date | null;
  createdAt: Date | null;
  cancelledAt: Date | null;
};

function asRsvpStatus(v: unknown): RsvpStatus {
  return RSVP_STATUSES.includes(v as RsvpStatus) ? (v as RsvpStatus) : "pending";
}

export function normalizeRsvp(id: string, data: Raw): RsvpDoc {
  return {
    id,
    eventId: (data.eventId as string) ?? "",
    uid: (data.uid as string | null | undefined) ?? null,
    name: (data.name as string) ?? "",
    email: (data.email as string) ?? "",
    answers: (data.answers as Record<string, RsvpAnswer>) ?? {},
    status: asRsvpStatus(data.status),
    decisionNote: (data.decisionNote as string | null | undefined) ?? null,
    decidedBy: (data.decidedBy as string | null | undefined) ?? null,
    decidedAt: tsToDate(data.decidedAt),
    pendingAnswers:
      (data.pendingAnswers as Record<string, RsvpAnswer> | null | undefined) ?? null,
    pendingAnswersRequestedAt: tsToDate(data.pendingAnswersRequestedAt),
    createdAt: tsToDate(data.createdAt),
    cancelledAt: tsToDate(data.cancelledAt),
  };
}

export const NAME_MAX = 80;
export const EMAIL_MAX = 120;
export const ANSWER_TEXT_MAX = 500;
