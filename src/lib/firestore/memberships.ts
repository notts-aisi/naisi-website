/**
 * Membership periods and the tier rows that hang off them.
 *
 * ## The shape, and why it is zero-migration
 *
 * A PERIOD is one year of society membership: `membershipPeriods/2026-27`,
 * whose `year` field is the string `"2026/27"` verbatim. That string is
 * exactly what `users.paidMembershipYears` has always stored, so the cache
 * every existing badge already reads (the applications queue, the allocation
 * board, the admin Members row) keeps working with nothing migrated. The doc
 * id drops the slash only because a Firestore doc id cannot contain one.
 *
 * A MEMBERSHIP is one person in one period: `memberships/{uid}__{periodId}`.
 * Deterministic and construct-only, so a second grant for the same year is an
 * update to one row rather than a second row nobody would notice.
 *
 * `config/membership` holds the CURRENT pointer (`currentPeriodId`). It lives
 * there rather than as a `current: true` flag on a period because a flag can
 * be true on two documents at once, and "which year is the badge about" has
 * exactly one answer at a time.
 *
 * ## The cache and the row say different things
 *
 * The row is the record: tier, source, how the person was matched, and who
 * granted it. `users.paidMembershipYears` is a QUERYABLE CACHE of one bit of
 * it, "does this account count as a member for that year", written in the same
 * atomic write as the row by the grant route and by nothing else. `alumni` is
 * the tier that separates them: an alumni row exists and is a fact about the
 * person, and it never enters the cache, because they are not a member of the
 * society this year.
 *
 * ## A revoke DELETES the row
 *
 * Taking a membership away removes `memberships/{uid}__{periodId}` and the
 * cache entry together rather than stamping `revokedAt`, because a row that
 * survives its revoke reads as a membership to anything that forgets to check
 * the field. `MembershipDoc.revokedAt` and `revokedByUid` are normalised for a
 * row written by hand or by a later importer that prefers to keep history;
 * nothing in the shipped code writes them.
 *
 * ## Membership gates nothing
 *
 * It is a badge and a record. No route, rule or page may branch access on it:
 * the owner's decision is that members are promoted by hand and that this
 * surface only ever describes what the SU list says. Reviewers do not see it
 * at all; the final decider and admins do.
 */

import { isValidDateKey } from "../courses/weekPlan";
import { ACADEMIC_YEAR_PATTERN } from "./users";

export const MEMBERSHIP_PERIODS_COLLECTION = "membershipPeriods";
export const MEMBERSHIPS_COLLECTION = "memberships";

/** `config/membership`, in the existing server-only `config` collection. */
export const MEMBERSHIP_CONFIG_PATH = {
  collection: "config",
  doc: "membership",
} as const;

export const MEMBERSHIP_FIELD_LIMITS = {
  /** Internal admin note on a period. Never shown to a member. */
  note: 200,
  /** "Autumn 2026 to summer 2027" and the like. */
  label: 80,
} as const;

/**
 * What kind of membership a row records.
 *
 * There is deliberately no "associate" tier. An external collaborator is the
 * existing `collaborators` collection, which is an account type rather than a
 * membership, and inventing a tier for it here would put a person with no SU
 * membership inside the count of people who have one.
 */
export type MembershipTier = "paid" | "comped" | "alumni" | "staff";

export const ALL_MEMBERSHIP_TIERS: MembershipTier[] = [
  "paid",
  "comped",
  "alumni",
  "staff",
];

export const MEMBERSHIP_TIER_LABELS: Record<MembershipTier, string> = {
  paid: "Paid",
  comped: "Comped",
  alumni: "Alumni",
  staff: "Staff",
};

/**
 * Whether a tier counts as a member of the society for its period, and so
 * whether the grant writes the year into `users.paidMembershipYears`.
 *
 * Applied SERVER-SIDE at write time rather than at read time, because the
 * cache is what every existing badge reads and a read-time rule would have to
 * be repeated at each of them. `alumni` is false: the row records that someone
 * was with us, not that they are a member now.
 */
export const TIER_COUNTS_AS_MEMBER: Record<MembershipTier, boolean> = {
  paid: true,
  comped: true,
  alumni: false,
  staff: true,
};

export function isMembershipTier(v: unknown): v is MembershipTier {
  return (
    v === "paid" || v === "comped" || v === "alumni" || v === "staff"
  );
}

/** Where the row came from. `su-import` is PR28's CSV; nothing writes it yet. */
export type MembershipSource = "su-import" | "manual" | "comp";

export function isMembershipSource(v: unknown): v is MembershipSource {
  return v === "su-import" || v === "manual" || v === "comp";
}

/**
 * How the person on the SU list was matched to an account. `manual` is what an
 * admin granting from the Members row records; the other three belong to the
 * import's three-way match and are carried here so PR28 adds no field.
 */
export type MembershipMatchedOn =
  | "uni-email"
  | "personal-email"
  | "name-confirmed"
  | "manual";

export function isMembershipMatchedOn(v: unknown): v is MembershipMatchedOn {
  return (
    v === "uni-email"
    || v === "personal-email"
    || v === "name-confirmed"
    || v === "manual"
  );
}

/**
 * The doc id for a period: the academic year with the slash replaced.
 * `"2026/27"` becomes `"2026-27"`. Throws on anything that is not an academic
 * year, so a caller cannot invent a period id from free text.
 */
export function periodIdForYear(year: string): string {
  if (typeof year !== "string" || !ACADEMIC_YEAR_PATTERN.test(year)) {
    throw new RangeError(
      `"${year}" is not an academic year (expected e.g. 2026/27).`,
    );
  }
  return year.replace("/", "-");
}

/**
 * The inverse. The period id is the only thing a membership row carries, and
 * the year is what the cache and every badge speak in, so this round-trip is
 * how `/api/membership/me` builds a history without reading a period document
 * per row.
 */
export function yearForPeriodId(periodId: string): string {
  if (typeof periodId !== "string" || !/^\d{4}-\d{2}$/.test(periodId)) {
    throw new RangeError(
      `"${periodId}" is not a membership period id (expected e.g. 2026-27).`,
    );
  }
  return periodId.replace("-", "/");
}

/** `memberships/{uid}__{periodId}`. One row per person per period. */
export function membershipId(uid: string, periodId: string): string {
  return `${uid}__${periodId}`;
}

export type MembershipPeriodTotals = Record<MembershipTier, number>;

export function zeroMembershipTotals(): MembershipPeriodTotals {
  return { paid: 0, comped: 0, alumni: 0, staff: 0 };
}

export type MembershipPeriodDoc = {
  /** Doc id, e.g. "2026-27". */
  id: string;
  /** "2026/27", the string `users.paidMembershipYears` stores. */
  year: string;
  label: string;
  /** Civil dates, `YYYY-MM-DD`. Empty while unset. */
  startsOn: string;
  endsOn: string;
  /** INTERNAL. Never leaves an admin surface; not in the `/me` payload. */
  note: string;
  /** Cached per-tier counts, maintained by the grant route. */
  totals: MembershipPeriodTotals;
  createdAt: Date | null;
  createdByUid: string;
};

export type MembershipDoc = {
  /** Doc id: `${uid}__${periodId}`. */
  id: string;
  uid: string;
  periodId: string;
  tier: MembershipTier;
  source: MembershipSource;
  matchedOn: MembershipMatchedOn;
  provenance: {
    at: Date | null;
    byUid: string;
    /** Set only by an import; absent on a manual grant. */
    batchId: string | null;
  };
  /**
   * Reserved for a soft revoke. The shipped revoke DELETES the row and the
   * cache entry together, so nothing writes these today; they are normalised
   * so a row written by hand (or by a later importer that prefers to keep
   * history) reads back correctly rather than as an active membership.
   */
  revokedAt: Date | null;
  revokedByUid: string;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max?: number): string {
  const s = typeof v === "string" ? v : "";
  return max === undefined ? s : s.slice(0, max);
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function normalizeMembershipPeriod(id: string, data: Raw): MembershipPeriodDoc {
  const rawTotals = (data.totals ?? {}) as Raw;
  return {
    id,
    year: str(data.year),
    label: str(data.label, MEMBERSHIP_FIELD_LIMITS.label),
    startsOn: str(data.startsOn),
    endsOn: str(data.endsOn),
    note: str(data.note, MEMBERSHIP_FIELD_LIMITS.note),
    totals: {
      paid: count(rawTotals.paid),
      comped: count(rawTotals.comped),
      alumni: count(rawTotals.alumni),
      staff: count(rawTotals.staff),
    },
    createdAt: tsToDate(data.createdAt),
    createdByUid: str(data.createdByUid),
  };
}

export function normalizeMembership(id: string, data: Raw): MembershipDoc {
  const rawProvenance = (data.provenance ?? {}) as Raw;
  const tier = data.tier;
  const source = data.source;
  const matchedOn = data.matchedOn;
  return {
    id,
    uid: str(data.uid),
    periodId: str(data.periodId),
    // A row with an unreadable tier is treated as `paid` nowhere: it falls to
    // `alumni`, the one tier that counts as nothing, so a hand-edited document
    // cannot promote itself into the member count.
    tier: isMembershipTier(tier) ? tier : "alumni",
    source: isMembershipSource(source) ? source : "manual",
    matchedOn: isMembershipMatchedOn(matchedOn) ? matchedOn : "manual",
    provenance: {
      at: tsToDate(rawProvenance.at),
      byUid: str(rawProvenance.byUid),
      batchId: typeof rawProvenance.batchId === "string" ? rawProvenance.batchId : null,
    },
    revokedAt: tsToDate(data.revokedAt),
    revokedByUid: str(data.revokedByUid),
  };
}

/**
 * The error the grant route refuses a cap-busting grant with.
 *
 * NAMED rather than a bare `Error` because the alternative was silence:
 * `normalizeUser` keeps only the first `FIELD_LIMITS.maxPaidMembershipYears`
 * entries of the cache, so an eleventh year written anyway would push a year
 * off the end and the member would simply stop having a badge, with nothing
 * anywhere saying why. A refusal an admin can read and act on is the whole
 * point of the class.
 */
export class MembershipYearCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipYearCapError";
  }
}

/**
 * The cache array after adding `year`, or a throw when that would exceed
 * `cap`.
 *
 * Pure, so the route's pre-check and its test are the same code. Adding a year
 * that is already present is a no-op and is allowed at any size: only a
 * genuinely new year has to fit.
 *
 * The result is sorted DESCENDING, which is the order `normalizeUser` now
 * keeps: newest first, so if an array ever does grow past the cap the year
 * that falls off the end is the oldest one rather than whichever happened to
 * be stored last.
 */
export function addPaidMembershipYear(
  existing: readonly string[],
  year: string,
  cap: number,
): string[] {
  const years = existing.filter((y) => typeof y === "string");
  if (years.includes(year)) return sortYearsDescending(years);
  if (years.length >= cap) {
    throw new MembershipYearCapError(
      `This member already has ${cap} membership years recorded. `
        + `Revoke an older one before granting ${year}.`,
    );
  }
  return sortYearsDescending([...years, year]);
}

/** The cache array after removing `year`. */
export function removePaidMembershipYear(
  existing: readonly string[],
  year: string,
): string[] {
  return sortYearsDescending(
    existing.filter((y) => typeof y === "string" && y !== year),
  );
}

/**
 * Academic years, newest first. `"2026/27"` sorts above `"2025/26"` on a plain
 * string comparison because the four-digit start year leads, so no parsing is
 * needed and a malformed entry sorts predictably rather than throwing.
 */
export function sortYearsDescending(years: readonly string[]): string[] {
  return [...years].sort((a, b) => b.localeCompare(a));
}

// ---------------------------------------------------------------------------
// The member-facing projection
// ---------------------------------------------------------------------------

export type MembershipMePayload = {
  currentPeriod: { id: string; year: string; label: string } | null;
  membership: { tier: MembershipTier; since: string | null } | null;
  history: { year: string; tier: MembershipTier }[];
};

/**
 * What `GET /api/membership/me` returns.
 *
 * A PROJECTION, written here as one function rather than spread across the
 * route, so "the member never sees provenance and never sees the internal
 * note" is a single line that can be pointed at and tested. A `...row` spread
 * in the route would leak the next field somebody adds to either document by
 * default; this leaks nothing by default.
 *
 * `since` is the provenance date rendered as an ISO instant, which is the one
 * piece of provenance a person is entitled to about their own record: when the
 * membership was recorded. Who recorded it, from which import batch, and the
 * admin's note about the period all stay behind.
 */
export function projectMembershipForMe(
  currentPeriod: MembershipPeriodDoc | null,
  current: MembershipDoc | null,
  history: MembershipDoc[],
): MembershipMePayload {
  const active = current && current.revokedAt === null ? current : null;
  return {
    currentPeriod: currentPeriod
      ? {
          id: currentPeriod.id,
          year: currentPeriod.year,
          label: currentPeriod.label,
        }
      : null,
    membership: active
      ? {
          tier: active.tier,
          since: active.provenance.at ? active.provenance.at.toISOString() : null,
        }
      : null,
    history: history
      .filter((row) => row.revokedAt === null && row.periodId !== "")
      .map((row) => ({ year: safeYear(row.periodId), tier: row.tier }))
      .filter((row) => row.year !== "")
      .sort((a, b) => b.year.localeCompare(a.year)),
  };
}

/** `yearForPeriodId` that answers "" instead of throwing, for a stored id
 *  that predates or sidesteps the constructor. */
function safeYear(periodId: string): string {
  try {
    return yearForPeriodId(periodId);
  } catch {
    return "";
  }
}

/**
 * A period's two civil dates, validated together.
 *
 * `isValidDateKey` is the shared courses helper, so a membership period's
 * dates are the same kind of date a run's are and `2026-02-31` is refused in
 * both places rather than in one.
 *
 * Both dates may be EMPTY. A period created before the SU has settled its
 * dates is a real state, and an empty date is honest where a made-up one is
 * not. If both are given they must be in order.
 */
export function validatePeriodDates(
  rawStart: unknown,
  rawEnd: unknown,
): { startsOn: string; endsOn: string } | { error: string } {
  const startsOn = typeof rawStart === "string" ? rawStart.trim() : "";
  const endsOn = typeof rawEnd === "string" ? rawEnd.trim() : "";
  if (startsOn && !isValidDateKey(startsOn)) {
    return { error: "The start date must be a real date." };
  }
  if (endsOn && !isValidDateKey(endsOn)) {
    return { error: "The end date must be a real date." };
  }
  if (startsOn && endsOn && endsOn < startsOn) {
    return { error: "The end date cannot be before the start date." };
  }
  return { startsOn, endsOn };
}
