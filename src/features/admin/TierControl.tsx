"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import styles from "./TierControl.module.css";

/**
 * One person's tier, changed in place on the membership table.
 *
 * ## What this closes
 *
 * The grant route already let a `manageMembership` holder record a membership,
 * and until this control there was nowhere for them to do it: the only grant
 * surface was the chip on the admin Members page, which sits inside the
 * admin-only tree. A permission that cannot be exercised is a permission
 * nobody should have been granted, so the table is where the holder works.
 *
 * ## It calls the grant route, and nothing else
 *
 * `POST /api/admin/membership/grant` owns the membership row, the
 * `paidMembershipYears` cache and the period's totals together, in one
 * transaction. This control sends a tier or a revoke and renders what comes
 * back. It never touches Firestore: both collections are
 * `allow read, write: if false`.
 *
 * The parent is told what changed rather than refetching the table, because a
 * refetch would re-page every account to move one row.
 */
export default function TierControl({
  uid,
  periodId,
  tier,
  disabled,
  onChanged,
}: {
  uid: string;
  periodId: string;
  tier: MembershipTier | null;
  disabled?: boolean;
  onChanged: (next: MembershipTier | null) => void;
}) {
  const [pending, setPending] = useState<MembershipTier>(tier ?? "paid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>, next: MembershipTier | null) {
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
      onChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <ResponsiveSelect<MembershipTier>
          value={pending}
          onChange={setPending}
          disabled={busy || disabled}
          ariaLabel="Membership tier"
          className={styles.select}
          options={ALL_MEMBERSHIP_TIERS.map<ResponsiveSelectOption<MembershipTier>>(
            (t) => ({ value: t, label: MEMBERSHIP_TIER_LABELS[t] }),
          )}
        />
        <Button
          size="sm"
          disabled={busy || disabled}
          onClick={() =>
            send(
              {
                uid,
                periodId,
                tier: pending,
                source: "manual",
                matchedOn: "manual",
              },
              pending,
            )
          }
        >
          {tier ? "Change" : "Record"}
        </Button>
        {tier && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => send({ uid, periodId, revoke: true }, null)}
          >
            Remove
          </Button>
        )}
      </div>
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
