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
 * How the NAISI emblem is composited onto an event's cover image on the
 * detail page. Chosen per event by the organiser, in a popup shown after they
 * crop the cover. `none` leaves the cover untouched.
 */
export type CoverBranding = "none" | "strip" | "corner";

export const COVER_BRANDING_LABEL: Record<CoverBranding, string> = {
  none: "No logo",
  strip: "Gradient strip",
  corner: "Corner badge",
};

/** Ordered choices for the cover-branding picker (default first). */
export const COVER_BRANDING_OPTIONS: {
  id: CoverBranding;
  label: string;
  description: string;
}[] = [
  {
    id: "corner",
    label: "Corner badge",
    description: "A small white emblem tucked into a corner.",
  },
  {
    id: "strip",
    label: "Gradient strip",
    description: "The emblem fades into a soft shadow band along one edge.",
  },
  {
    id: "none",
    label: "No logo",
    description: "Show the cover image on its own, with no NAISI mark.",
  },
];

/**
 * Which emblem asset sits on the cover. The white emblem is built for dark
 * overlays; the full-colour emblem suits lighter cover images.
 */
export type CoverLogoColor = "white" | "colour";

/**
 * The gradient strip's height as a percentage of the cover, for the "strip"
 * branding treatment. Clamped to [MIN, MAX]; absent falls back to DEFAULT.
 */
export const COVER_STRIP_SIZE_MIN = 15;
export const COVER_STRIP_SIZE_MAX = 70;
export const COVER_STRIP_SIZE_DEFAULT = 40;

/**
 * Which edge the gradient-strip treatment sits against. The corner badge is
 * placed freely via coverLogoX/coverLogoY instead. Absent falls back to
 * "bottom", the original behaviour.
 */
export type CoverLogoPosition = "top" | "bottom";

/**
 * Logo size as a percentage of its default footprint, applied to both the
 * strip and corner treatments. Clamped to [MIN, MAX]; absent falls back to
 * DEFAULT.
 */
export const COVER_LOGO_SCALE_MIN = 50;
export const COVER_LOGO_SCALE_MAX = 400;
export const COVER_LOGO_SCALE_DEFAULT = 100;

/**
 * The corner badge is positioned freely by dragging it on the cover. X/Y are
 * the badge centre as a percent of the cover, defaulting to the bottom-right
 * (where the badge used to be fixed).
 */
export const COVER_LOGO_X_DEFAULT = 90;
export const COVER_LOGO_Y_DEFAULT = 86;

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

/**
 * Optional dietary classifiers for an event's food. Orthogonal to the
 * free-text `foodText` description: the tags drive the badges, the text is the
 * plain-language announcement (e.g. "Pizza ordered from Domino's Beeston").
 */
export type FoodTag = "halal" | "kosher" | "vegan" | "vegetarian";

export const FOOD_TAGS: FoodTag[] = ["halal", "kosher", "vegan", "vegetarian"];

export const FOOD_TAG_LABEL: Record<FoodTag, string> = {
  halal: "Halal",
  kosher: "Kosher",
  vegan: "Vegan",
  vegetarian: "Vegetarian",
};

/** Max length of the free-text food description shown on the event page. */
export const FOOD_TEXT_MAX = 280;

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
  /** When true, attendees also get a free-text "Other" box. */
  allowOther?: boolean;
  /** When set, a mutually-exclusive "none of these" choice shown with this label. */
  noneOption?: string;
};

export type YesNoQuestion = BaseQuestion & {
  type: "yesNo";
};

/**
 * A fixed checklist covering both dietary requirements and the common allergens.
 * Lives as its own question type so the dashboard can aggregate it consistently
 * across events without the organizer having to recreate the same list.
 */
export type DietaryAllergiesQuestion = BaseQuestion & {
  type: "dietaryAllergies";
};

/**
 * Checklist for the combined "allergies or dietary requirements" question.
 * Covers lifestyle diets and the major UK allergens. Halal/kosher are
 * deliberately NOT here: most observers eat vegetarian, so a hard halal/kosher
 * checkbox over-constrains catering. A strict religious need goes in the free
 * text "Other" box instead.
 */
export const DIETARY_ALLERGIES: string[] = [
  "Vegetarian",
  "Vegan",
  "Pescatarian",
  "No pork",
  "No beef",
  "Gluten / wheat",
  "Dairy / lactose",
  "Eggs",
  "Peanuts",
  "Tree nuts",
  "Soya",
  "Fish",
  "Shellfish",
  "Sesame",
  "Celery",
  "Mustard",
  "Sulphites",
];

/** Stored in a dietary answer's `checked` when an attendee confirms they have none. */
export const DIETARY_NONE = "No dietary requirements";

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
      return { id, type, label: "Any allergies or dietary requirements?", required: false };
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
  /**
   * @deprecated Legacy food classification. New and edited events use
   * `foodText` + `dietaryTags`; kept so older published events still render.
   */
  foodProvenance: FoodProvenance;
  /** @deprecated See `foodProvenance`. */
  foodProvenanceNote?: string | null;
  /** Free-text food description, shown prominently on the event page. */
  foodText?: string | null;
  /** Optional dietary classifiers, rendered as badges. */
  dietaryTags?: FoodTag[];
  posterUrl?: string | null;
  /** How the NAISI emblem is overlaid on the cover image. Defaults to none. */
  coverBranding: CoverBranding;
  /** Which emblem asset (white or full colour) is overlaid on the cover. */
  coverLogoColor: CoverLogoColor;
  /** Gradient-strip height as a percent of the cover, for the strip treatment. */
  coverStripSize: number;
  /** Which edge the gradient strip sits against. Defaults to bottom. */
  coverLogoPosition: CoverLogoPosition;
  /** Logo size as a percent of its default footprint (strip + corner). */
  coverLogoScale: number;
  /** Corner-badge centre X, as a percent of the cover width. */
  coverLogoX: number;
  /** Corner-badge centre Y, as a percent of the cover height. */
  coverLogoY: number;
  /** Corner badge: whether the emblem sits on a frosted backing box. */
  coverLogoBackdrop: boolean;
  /** Corner badge: whether the logo (or its box) carries a drop shadow. */
  coverLogoShadow: boolean;
  /** Archived events drop out of the normal manage sections. Orthogonal to status. */
  archived: boolean;
  status: EventStatus;
  authorUid: string;
  authorDisplayName?: string | null;
  /**
   * Committee members the author or an admin explicitly granted edit access to
   * this specific event. They can edit it (while it is not published) without
   * holding the draft/approve permissions. Empty/absent on older events.
   */
  collaboratorUids: string[];
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

export function asCoverBranding(v: unknown): CoverBranding {
  return v === "strip" || v === "corner" || v === "none" ? v : "none";
}

export function asCoverLogoColor(v: unknown): CoverLogoColor {
  return v === "colour" ? "colour" : "white";
}

export function asCoverStripSize(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return COVER_STRIP_SIZE_DEFAULT;
  return Math.min(
    COVER_STRIP_SIZE_MAX,
    Math.max(COVER_STRIP_SIZE_MIN, Math.round(v)),
  );
}

export function asCoverLogoPosition(v: unknown): CoverLogoPosition {
  return v === "top" ? "top" : "bottom";
}

/** Clamp an unknown to an integer percent in [0, 100], else the fallback. */
function asPercent(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, Math.round(v)));
}

export function asCoverLogoScale(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return COVER_LOGO_SCALE_DEFAULT;
  return Math.min(
    COVER_LOGO_SCALE_MAX,
    Math.max(COVER_LOGO_SCALE_MIN, Math.round(v)),
  );
}

export function asCoverLogoX(v: unknown): number {
  return asPercent(v, COVER_LOGO_X_DEFAULT);
}

export function asCoverLogoY(v: unknown): number {
  return asPercent(v, COVER_LOGO_Y_DEFAULT);
}

/** Corner-badge box + shadow both default on, matching the original badge. */
export function asCoverLogoBackdrop(v: unknown): boolean {
  return v !== false;
}

export function asCoverLogoShadow(v: unknown): boolean {
  return v !== false;
}

function asFoodProvenance(v: unknown): FoodProvenance {
  const ok: FoodProvenance[] = ["none", "halal", "kosher", "vegetarian", "vegan", "other"];
  return ok.includes(v as FoodProvenance) ? (v as FoodProvenance) : "none";
}

/** Normalize an unknown value into a de-duplicated list of uid strings. */
export function asUidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const u of v) {
    if (typeof u === "string" && u) seen.add(u);
  }
  return Array.from(seen);
}

function asFoodTags(v: unknown): FoodTag[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<FoodTag>();
  for (const t of v) {
    if (FOOD_TAGS.includes(t as FoodTag)) seen.add(t as FoodTag);
  }
  return Array.from(seen);
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
    foodText: (data.foodText as string | null | undefined) ?? null,
    dietaryTags: asFoodTags(data.dietaryTags),
    posterUrl: (data.posterUrl as string | null | undefined) ?? null,
    coverBranding: asCoverBranding(data.coverBranding),
    coverLogoColor: asCoverLogoColor(data.coverLogoColor),
    coverStripSize: asCoverStripSize(data.coverStripSize),
    coverLogoPosition: asCoverLogoPosition(data.coverLogoPosition),
    coverLogoScale: asCoverLogoScale(data.coverLogoScale),
    coverLogoX: asCoverLogoX(data.coverLogoX),
    coverLogoY: asCoverLogoY(data.coverLogoY),
    coverLogoBackdrop: asCoverLogoBackdrop(data.coverLogoBackdrop),
    coverLogoShadow: asCoverLogoShadow(data.coverLogoShadow),
    archived: data.archived === true,
    status: asStatus(data.status),
    authorUid: (data.authorUid as string) ?? "",
    authorDisplayName: (data.authorDisplayName as string | null | undefined) ?? null,
    collaboratorUids: asUidList(data.collaboratorUids),
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

/**
 * The schedule and location an attendee saw when they signed up. Lets the
 * approve route diff against the live event and flag what changed since.
 * Absent on RSVPs created before this was introduced.
 */
export type SignupSnapshot = {
  /** Event date/time as shown at signup (see formatEventWhen). */
  scheduleLabel: string;
  /** Exact event location as it stood at signup. */
  locationLabel: string;
};

export function asSignupSnapshot(v: unknown): SignupSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.scheduleLabel !== "string" || typeof o.locationLabel !== "string") {
    return null;
  }
  return { scheduleLabel: o.scheduleLabel, locationLabel: o.locationLabel };
}

export type RsvpDoc = {
  id: string;
  eventId: string;
  uid: string | null;
  name: string;
  email: string;
  answers: Record<string, RsvpAnswer>;
  status: RsvpStatus;
  /** True for organiser-generated test RSVPs (see /api/events/[id]/test-rsvps). */
  synthetic: boolean;
  /** Organiser-facing note on why an RSVP was denied (optional). */
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** Pending attendee-proposed changes to their answers, awaiting approval. */
  pendingAnswers: Record<string, RsvpAnswer> | null;
  pendingAnswersRequestedAt: Date | null;
  /** Schedule/location as the attendee saw them at signup; null for older RSVPs. */
  signupSnapshot: SignupSnapshot | null;
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
    synthetic: data.synthetic === true,
    decisionNote: (data.decisionNote as string | null | undefined) ?? null,
    decidedBy: (data.decidedBy as string | null | undefined) ?? null,
    decidedAt: tsToDate(data.decidedAt),
    pendingAnswers:
      (data.pendingAnswers as Record<string, RsvpAnswer> | null | undefined) ?? null,
    pendingAnswersRequestedAt: tsToDate(data.pendingAnswersRequestedAt),
    signupSnapshot: asSignupSnapshot(data.signupSnapshot),
    createdAt: tsToDate(data.createdAt),
    cancelledAt: tsToDate(data.cancelledAt),
  };
}

export const NAME_MAX = 80;
export const EMAIL_MAX = 120;
export const ANSWER_TEXT_MAX = 500;
