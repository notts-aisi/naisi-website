/**
 * `memberConductFlags/{uid}`: a conduct flag on one member, with a required
 * reason.
 *
 * ## Why this is not a field on users/{uid}
 *
 * It was going to be, and that would have been the sharpest own-goal in the
 * project. `users/{uid}` is OWN-ROW READABLE, and `AuthProvider` holds a live
 * `onSnapshot` on that exact document for the whole session. So a required
 * free-text misconduct reason on the user doc would stream into the flagged
 * member's own browser, on every authed page, in real time, the instant an
 * admin wrote it. It would also frequently identify the person who reported
 * them.
 *
 * So the flag lives in its own collection, `allow read, write: if false`,
 * written only by `POST /api/admin/members/[uid]/conduct-flag`. Nothing about
 * the UI changes: the admin control sits on the Members row, and reviewers
 * already see the chip through the queue payload, which is a route.
 *
 * ## What a reviewer sees, and what they do not
 *
 * A BOOLEAN chip, and nothing else. `reason` is admin-only, forever. A
 * reviewer needs to know a flag exists so they can ask an admin; they do not
 * need the allegation, and handing it to a rotating pool of student reviewers
 * is how a conduct process becomes gossip.
 *
 * ## The doc id is the uid
 *
 * One flag per member, addressed. The account-deletion sweep is therefore a
 * single addressed delete with no query and no index, and there is no way to
 * accumulate a history of flags on one person by accident.
 */

export const CONDUCT_FLAG_FIELD_LIMITS = {
  reason: 500,
} as const;

export type MemberConductFlagDoc = {
  /** Firestore doc id: the flagged member's uid. */
  uid: string;
  flagged: boolean;
  /**
   * Required when `flagged`. ADMIN-ONLY: never in a reviewer payload, never
   * in an export, never on the flagged member's own screen. The route
   * refuses a flag with an empty reason, because "flagged, no reason given"
   * is a thing a reviewer would act on and nobody could later defend.
   */
  reason: string;
  byUid: string;
  /** Display name, never an email. The audit idiom used everywhere here. */
  byName: string;
  at: Date | null;
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

export function normalizeMemberConductFlag(
  uid: string,
  data: Raw,
): MemberConductFlagDoc {
  return {
    uid,
    flagged: data.flagged === true,
    reason: str(data.reason, CONDUCT_FLAG_FIELD_LIMITS.reason),
    byUid: str(data.byUid),
    byName: str(data.byName),
    at: tsToDate(data.at),
  };
}

/**
 * The projection a reviewer payload may carry. Exported as a function rather
 * than left to each caller so "reviewers never see the reason" is one line
 * that can be pointed at, and so a new field on the document does not leak by
 * default the way a `...flag` spread would.
 */
export function conductChip(flag: MemberConductFlagDoc | null): { flagged: boolean } {
  return { flagged: flag?.flagged === true };
}

/**
 * What the reviewer queue (and the admin Members row) may carry, decided in
 * ONE place from one boolean rather than at each call site.
 *
 * For a non-admin viewer the returned object has NO `reason` key at all. Not
 * an empty string, not `null`, not `undefined`: absent. A key that is present
 * and empty is one careless `Object.keys` away from being logged, exported or
 * rendered as "reason: (blank)", and a payload with the key missing cannot
 * regain a value by accident downstream.
 *
 * `flaggedAt` is an ISO string rather than a `Date` because this projection's
 * destination is a JSON route payload; a `Date` would arrive at the browser as
 * a string anyway, and the conversion is better done once here than guessed at
 * by each reader.
 *
 * `byName` is part of the admin view rather than a key a caller bolts on
 * beside it. One decision, one object: a route that spreads this projection
 * and adds a sibling key has quietly moved the decision back out to the call
 * site, and the next payload to copy that shape may be a reviewer's.
 */
export type ConductFlagChip = { flagged: boolean };

export type ConductFlagAdminView = ConductFlagChip & {
  reason: string;
  flaggedAt: string | null;
  /** Display name of the admin who set the flag, never an email. */
  byName: string;
};

export function conductFlagForQueue(
  flag: MemberConductFlagDoc | null,
  viewerIsAdmin: false,
): ConductFlagChip;
export function conductFlagForQueue(
  flag: MemberConductFlagDoc | null,
  viewerIsAdmin: true,
): ConductFlagAdminView;
export function conductFlagForQueue(
  flag: MemberConductFlagDoc | null,
  viewerIsAdmin: boolean,
): ConductFlagChip | ConductFlagAdminView;
export function conductFlagForQueue(
  flag: MemberConductFlagDoc | null,
  viewerIsAdmin: boolean,
): ConductFlagChip | ConductFlagAdminView {
  const chip = conductChip(flag);
  if (!viewerIsAdmin) return chip;
  return {
    ...chip,
    reason: flag?.reason ?? "",
    flaggedAt: flag?.at ? flag.at.toISOString() : null,
    byName: flag?.byName ?? "",
  };
}
