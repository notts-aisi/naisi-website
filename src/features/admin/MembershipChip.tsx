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
 * Which period is current is the same answer for every row, so the periods
 * request is memoised at module scope and shared by every chip on the list.
 * Without that, opening the Members tab would fire one request per member.
 *
 * The write is `POST /api/admin/membership/grant`, which owns the row, the
 * cache and the period totals together. Nothing here writes Firestore.
 */

type CurrentPeriod = { id: string; year: string; label: string } | null;

let periodPromise: Promise<CurrentPeriod> | null = null;

/** The current period, fetched once per page load and shared by every row. */
function loadCurrentPeriod(): Promise<CurrentPeriod> {
  if (!periodPromise) {
    periodPromise = fetch("/api/admin/membership/periods")
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as {
          periods: { id: string; year: string; label: string }[];
          currentPeriodId: string | null;
        };
        const match = data.periods.find((p) => p.id === data.currentPeriodId);
        return match ? { id: match.id, year: match.year, label: match.label } : null;
      })
      .catch(() => null);
  }
  return periodPromise;
}

export default function MembershipChip({
  uid,
  recordedYears,
}: {
  uid: string;
  recordedYears: string[] | undefined;
}) {
  const [period, setPeriod] = useState<CurrentPeriod>(null);
  const [resolved, setResolved] = useState(false);
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<MembershipTier>("paid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The members list is a one-shot fetch, so the row does not refresh after a
  // write. Remember just this member's state locally (null = no local change
  // yet, read the cache) so the chip settles straight away.
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void loadCurrentPeriod().then((p) => {
      if (!live) return;
      setPeriod(p);
      setResolved(true);
    });
    return () => {
      live = false;
    };
  }, []);

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
