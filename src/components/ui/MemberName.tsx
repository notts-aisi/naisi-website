/**
 * The display-name fallback chain for every surface where members see other
 * members. It ends at "NAISI member", never at an email address: cohort
 * surfaces (rosters, comments, the allocation board) are visible to peers, and
 * a missing display name is not a reason to hand out someone's email. This
 * component existing is the lint — if a name is rendered any other way on a
 * cohort surface, that is the thing to question.
 *
 * Mirrors displayNameOf() in the courses routes, which resolves the same chain
 * server-side from the user doc.
 */

export const MEMBER_NAME_FALLBACK = "NAISI member";

export default function MemberName({ name }: { name?: string | null }) {
  return <>{name?.trim() || MEMBER_NAME_FALLBACK}</>;
}
