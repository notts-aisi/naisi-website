"use client";

import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import EmptyState from "@/components/ui/EmptyState";
import InitialsChip from "@/components/ui/InitialsChip";
import MemberName from "@/components/ui/MemberName";
import Skeleton from "@/components/ui/Skeleton";
import { useGroupRoster, type RosterPerson } from "./useGroupRoster";
import styles from "./GroupRoster.module.css";

/**
 * Who is in this group, on the facilitator's own group page.
 *
 * ── NAMES ONLY, AND THE NOTE SAYS SO ────────────────────────────────────────
 * The roster route sends display names and nothing else; this component adds
 * no lookup of its own and every name renders through `MemberName` (fallback
 * chain ends at "NAISI member", never an email). The note under the heading is
 * not decoration — a facilitator who cannot see why an address is missing will
 * go looking for one, and the answer is that reaching these people by email is
 * the email composer's job, which resolves addresses server-side and never
 * hands them out.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Presentational apart from its own fetch: no attendance, no progress, no
 * per-member state. The register lives in `AttendanceGrid` beneath it, and the
 * week's work in the review queue — this answers "who am I facilitating" and
 * stops there.
 */

type Props = {
  groupId: string;
  /**
   * From the page's server gate, not from the payload — it is already known
   * before the fetch lands, so the empty state can name the group instead of
   * saying "this group".
   */
  groupName: string;
};

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

/**
 * Layout-matched to the real list (a label row plus three name rows at the
 * same height), so arrival costs no reflow — the shift a skeleton exists to
 * prevent. One announcement, not one per bar: `Skeleton`'s wrapper is its own
 * live region, so only the first carries a label and the rest pass an empty
 * one.
 */
function RosterSkeleton() {
  return (
    <div className={styles.skeleton}>
      <Skeleton width="8rem" height="0.75rem" ariaLabel="Loading the roster…" />
      <Skeleton width="100%" height="2.25rem" radius="var(--radius-sm)" ariaLabel="" />
      <Skeleton width="100%" height="2.25rem" radius="var(--radius-sm)" ariaLabel="" />
      <Skeleton width="100%" height="2.25rem" radius="var(--radius-sm)" ariaLabel="" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One list of people
// ---------------------------------------------------------------------------

/**
 * `InitialsChip` is decorative by contract (`aria-hidden`), so the name always
 * renders beside it — two initials are not an identity.
 */
function PeopleList({ people, label }: { people: readonly RosterPerson[]; label: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {people.map((person) => (
        <li key={person.uid} className={styles.item}>
          <InitialsChip name={person.displayName} uid={person.uid} size="sm" />
          <span className={styles.name}>
            <MemberName name={person.displayName} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// GroupRoster
// ---------------------------------------------------------------------------

export default function GroupRoster({ groupId, groupName }: Props) {
  const { group, facilitators, members, loading, error, reload } = useGroupRoster(groupId);

  return (
    <Card
      as="section"
      padding="md"
      // Addressed by the browser end-to-end suite, which counts the people in
      // the group here before it marks them present in the register below.
      data-testid="group-roster"
      className={styles.card}
    >
      {/* h3, not h2, to match SessionCard's own heading on the same page — one
          consistent card tier under the page's h1, rather than a mix the page
          would have to invent an h2 to justify (the RunHome precedent). The
          two lists below carry `aria-label`s instead of headings for the same
          reason: they label a list, they are not another tier of the page. */}
      <header className={styles.head}>
        <h3 className={styles.title}>Who is in this group</h3>
        {group && (
          <Chip size="sm" tone="neutral">
            {members.length} {members.length === 1 ? "member" : "members"}
          </Chip>
        )}
        <span className={styles.headAction}>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </span>
      </header>

      <p className={styles.note}>
        Names only. Nobody&apos;s email address appears on this page — to reach the
        group, use the email composer, which looks the addresses up when it sends
        and never shows them.
      </p>

      {/* Three states, in the house order: layout-matched Skeleton →
          EmptyState → content. */}
      {!group && loading ? (
        <RosterSkeleton />
      ) : !group ? (
        <EmptyState
          title="Couldn't load the roster"
          body={error?.message ?? "The list of members didn't come back."}
          action={<Button onClick={reload}>Try again</Button>}
        />
      ) : (
        <>
          {error && (
            <p className={styles.error} role="status">
              Couldn&apos;t refresh: {error.message} — showing the last version that
              loaded.
            </p>
          )}

          {facilitators.length > 0 && (
            <section className={styles.section}>
              <p className={styles.sectionTitle}>
                {facilitators.length === 1 ? "Facilitator" : "Facilitators"}
              </p>
              <PeopleList people={facilitators} label="Facilitators of this group" />
            </section>
          )}

          <section className={styles.section}>
            <p className={styles.sectionTitle}>Members</p>
            {members.length === 0 ? (
              <EmptyState
                title={`No one is placed in ${groupName || "this group"} yet`}
                body="Places are allocated by an admin before the run starts. Everyone allocated here shows up on this list, in the register below, and in the review queue."
              />
            ) : (
              <PeopleList people={members} label="Members of this group" />
            )}
          </section>
        </>
      )}
    </Card>
  );
}
