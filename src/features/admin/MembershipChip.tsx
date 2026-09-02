"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import { loadCurrentPeriod, type CurrentPeriod } from "./currentPeriodCache";
import styles from "./MembershipChip.module.css";

/**
 * Membership for ONE member, on their admin Members row.
 *
 * ## What it shows, and what it cannot
 *
 * The chip reads `users.paidMembershipYears`, the cache the row already
 * carries, so it answers "is this person recorded as a member for the current
 * period" with no extra read per row. It cannot show WHICH tier: the cache is
 * one bit per year by design, and the tier lives on the `memberships` row,
 * which is `allow read, write: if false` and would cost a route call per
 * member to fetch. So the chip says recorded or not recorded, the popover
 * grants a tier, and the tier breakdown per period is on the console.
 * `alumni` is the tier that reads as "not recorded" here, correctly: an
 * alumni row is deliberately not a membership for the year.
 *
 * ## One fetch for the whole page
 *
 * Which period is current is the same answer for every row, so the request is
 * shared by every chip on the list through `currentPeriodCache`. Without that,
 * opening the Members tab would fire one request per member. That module also
 * owns when the shared answer stops being trusted, which matters most in the
 * one state an admin is likely to be halfway through changing: see its header.
 *
 * The write is `POST /api/admin/membership/grant`, which owns the row, the
 * cache and the period totals together. Nothing here writes Firestore.
 */

/**
 * The current period, as state, for a component that only wants to render off
 * it. `resolved` is separate from the value because "still asking" and "no
 * period is current" are different things and only one of them is worth
 * saying out loud.
 */
function useCurrentPeriod(): { period: CurrentPeriod; resolved: boolean } {
  const [period, setPeriod] = useState<CurrentPeriod>(null);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    let live = true;
    void loadCurrentPeriod().then(
      (p) => {
        if (!live) return;
        setPeriod(p);
        setResolved(true);
      },
      // The fetcher swallows its own failures, so this is belt and braces:
      // whatever happens, the chip stops saying "checking".
      () => {
        if (live) setResolved(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return { period, resolved };
}

/**
 * The read-only half, for the collapsed row's badge strip.
 *
 * Separate from the control below because that strip is inside a `<button>`
 * that expands the row, and a button inside a button is invalid HTML and
 * unreachable by keyboard. Renders nothing at all when there is no membership
 * to report, so a list of members is not a wall of "not recorded".
 */
export function MembershipSummaryBadge({
  recordedYears,
}: {
  recordedYears: string[] | undefined;
}) {
  const { period } = useCurrentPeriod();
  if (!period) return null;
  if (!(recordedYears ?? []).includes(period.year)) return null;
  return (
    <Badge tone="success" title={`Recorded as a member for ${period.year}`}>
      Member {period.year}
    </Badge>
  );
}

export default function MembershipChip({
  uid,
  recordedYears,
}: {
  uid: string;
  recordedYears: string[] | undefined;
}) {
  const { period, resolved } = useCurrentPeriod();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<MembershipTier>("paid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The members list is a one-shot fetch, so the row does not refresh after a
  // write. Remember just this member's state locally (null = no local change
  // yet, read the cache) so the chip settles straight away.
  const [override, setOverride] = useState<boolean | null>(null);

  const recorded =
    override ?? (period ? (recordedYears ?? []).includes(period.year) : false);

  async function send(body: Record<string, unknown>, next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/membership/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not save.");
      setOverride(next);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!resolved) {
    return <span className={styles.muted}>Checking membership…</span>;
  }

  if (!period) {
    return (
      <span className={styles.muted}>
        No membership period is current.{" "}
        <Link href="/admin/membership" className={styles.link}>
          Set one up
        </Link>
      </span>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.chipRow}>
        <Badge
          tone={recorded ? "success" : "neutral"}
          title={
            recorded
              ? `Recorded as a member for ${period.year}`
              : `No membership recorded for ${period.year}`
          }
        >
          {recorded ? `Member ${period.year}` : `Not recorded ${period.year}`}
        </Badge>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} disabled={busy}>
          {open ? "Close" : "Change"}
        </Button>
        <Link href="/admin/membership" className={styles.link}>
          Manage periods
        </Link>
      </div>

      {open && (
        <div className={styles.popover}>
          <span className={styles.hint}>
            Recorded against {period.label || period.year}. Alumni is a record,
            not a membership, so it clears the badge.
          </span>
          <div className={styles.controls}>
            <ResponsiveSelect<MembershipTier>
              value={tier}
              onChange={setTier}
              options={ALL_MEMBERSHIP_TIERS.map<ResponsiveSelectOption<MembershipTier>>(
                (t) => ({ value: t, label: MEMBERSHIP_TIER_LABELS[t] }),
              )}
              disabled={busy}
              ariaLabel="Membership tier"
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                send(
                  { uid, periodId: period.id, tier, source: "manual", matchedOn: "manual" },
                  tier !== "alumni",
                )
              }
            >
              Grant
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => send({ uid, periodId: period.id, revoke: true }, false)}
            >
              Revoke
            </Button>
          </div>
          {error && <span className={styles.error}>{error}</span>}
        </div>
      )}
    </div>
  );
}
