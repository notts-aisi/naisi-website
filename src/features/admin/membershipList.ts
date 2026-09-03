/**
 * The membership table's row shape and its projection, in one pure module so
 * the route that builds a row and the table that renders one cannot drift.
 *
 * PROJECTED FIELD BY FIELD, never spread. The source is a whole `users`
 * document, which carries the motivation essay somebody wrote at registration,
 * their interests, their notification preferences and whatever the next PR
 * adds. A `...user` here would put all of it in a payload nobody re-reads.
 * What a row carries is the six things this table is for (who they are, how to
 * recognise them on an SU list, and what is recorded for the period) and
 * nothing else.
 */

import type {
  MembershipMatchedOn,
  MembershipSource,
  MembershipTier,
} from "@/lib/firestore/memberships";
import {
  isMembershipMatchedOn,
  isMembershipSource,
  isMembershipTier,
} from "@/lib/firestore/memberships";

/**
 * Accounts per page. The console follows the cursor to the end, so this is a
 * response-size budget rather than a limit on what an admin sees.
 */
export const MEMBERSHIP_LIST_PAGE_SIZE = 200;

/** How many pages the console will follow before it stops and says so. */
export const MEMBERSHIP_LIST_MAX_PAGES = 25;

export type MembershipListRow = {
  uid: string;
  displayName: string;
  preferredName: string;
  email: string;
  universityEmail: string;
  /** Whether that address was proved by clicking a link sent to it. */
  uniEmailVerified: boolean;
  /** The governance role, verbatim. A string: this table renders it and
   *  never branches on it, and a role this build predates must still show. */
  role: string;
  /** The membership half. Null all the way down when there is no row. */
  tier: MembershipTier | null;
  source: MembershipSource | null;
  matchedOn: MembershipMatchedOn | null;
  recordedAt: string | null;
  recordedByName: string;
  /**
   * Recorded for the period BEFORE this one and not for this one. Derived on
   * every read rather than stored, so it cannot go stale when somebody is
   * granted this year's membership.
   */
  lapsed: boolean;
};

type Raw = Record<string, unknown>;

type MembershipLike = {
  tier: MembershipTier;
  source: MembershipSource;
  matchedOn: MembershipMatchedOn;
  provenance: { at: Date | null; byUid: string };
};

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * One account plus its membership row for the period, as the table needs it.
 *
 * `nameByUid` resolves who recorded the membership. A uid with no name behind
 * it (an admin whose account has since been deleted) renders as an empty
 * string, which the table shows as "not known" rather than as a raw uid: a uid
 * in a provenance tooltip tells a reader nothing they can act on.
 */
export function projectMembershipRow(
  uid: string,
  user: Raw,
  membership: MembershipLike | null,
  hadPreviousPeriod: boolean,
  nameByUid: ReadonlyMap<string, string>,
): MembershipListRow {
  const profile = (user.profile ?? {}) as Raw;
  const role = typeof user.role === "string" ? user.role : "pending";
  return {
    uid,
    displayName: str(user.displayName, 120),
    preferredName: str(profile.preferredName, 120),
    email: str(user.email, 160),
    universityEmail: str(profile.universityEmail, 160),
    uniEmailVerified: Boolean(profile.uniEmailVerifiedAt),
    role,
    tier: membership && isMembershipTier(membership.tier) ? membership.tier : null,
    source: membership && isMembershipSource(membership.source) ? membership.source : null,
    matchedOn:
      membership && isMembershipMatchedOn(membership.matchedOn)
        ? membership.matchedOn
        : null,
    recordedAt:
      membership && membership.provenance.at
        ? membership.provenance.at.toISOString()
        : null,
    recordedByName: membership
      ? (nameByUid.get(membership.provenance.byUid) ?? "")
      : "",
    lapsed: membership === null && hadPreviousPeriod,
  };
}

/**
 * The period immediately before `periodId` among the periods that EXIST, or
 * null when this is the earliest one.
 *
 * Period ids are `YYYY-YY`, so a plain descending string sort is chronological
 * and "the one before" is the next id down the list. Derived from the periods
 * that exist rather than by subtracting a year, because a society that skipped
 * a year would otherwise have every member of the year before last read as
 * lapsed against a period nobody ever created.
 */
export function previousPeriodId(
  allPeriodIds: readonly string[],
  periodId: string,
): string | null {
  const earlier = allPeriodIds
    .filter((id) => id < periodId)
    .sort((a, b) => b.localeCompare(a));
  return earlier[0] ?? null;
}

/** The counts strip. Tier counts come from the period document's cache; these
 *  two are derived from the rows the table has loaded, and the console says so. */
export type MembershipListDerivedCounts = {
  untagged: number;
  lapsed: number;
};

export function deriveCounts(
  rows: readonly MembershipListRow[],
): MembershipListDerivedCounts {
  let untagged = 0;
  let lapsed = 0;
  for (const row of rows) {
    if (row.tier === null) untagged += 1;
    if (row.lapsed) lapsed += 1;
  }
  return { untagged, lapsed };
}

/**
 * The table's own filter, pure so the test can state what "search" means:
 * a case-insensitive substring of the display name, the preferred name, or
 * either address. Not the uid: nobody searches by uid, and matching it would
 * make a paste of somebody else's uid look like a hit on a person.
 *
 * `includeUnapproved` covers `pending` AND `rejected`, which is why it is not
 * called `includePending`: the switch it drives hides both, and a control that
 * quietly hides rejected accounts under a label naming only pending ones is a
 * roster somebody would trust as complete when it is not.
 */
export function filterMembershipRows(
  rows: readonly MembershipListRow[],
  {
    query = "",
    tier = "all",
    onlyLapsed = false,
    includeUnapproved = true,
  }: {
    query?: string;
    tier?: MembershipTier | "all" | "untagged";
    onlyLapsed?: boolean;
    includeUnapproved?: boolean;
  },
): MembershipListRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!includeUnapproved && (row.role === "pending" || row.role === "rejected")) {
      return false;
    }
    if (tier === "untagged" && row.tier !== null) return false;
    if (tier !== "all" && tier !== "untagged" && row.tier !== tier) return false;
    if (onlyLapsed && !row.lapsed) return false;
    if (needle === "") return true;
    return [row.displayName, row.preferredName, row.email, row.universityEmail].some(
      (field) => field.toLowerCase().includes(needle),
    );
  });
}
