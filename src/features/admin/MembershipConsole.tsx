"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Input } from "@/components/ui/Input";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIP_FIELD_LIMITS,
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import { currentAcademicYear } from "@/lib/firestore/users";
import { resetCurrentPeriodCache } from "./currentPeriodCache";
import styles from "./MembershipConsole.module.css";

/**
 * The membership console: the periods, their dates, their per-tier totals, and
 * which one is CURRENT.
 *
 * Deliberately small. Grants and revokes live where the people are, on the
 * admin Members row, and the SU CSV import, the filterable member table and
 * the logged export are a later PR. What this page owns is the object those
 * things hang off: a period exists, it has dates, and exactly one of them is
 * the one every badge on the site is about.
 *
 * Every read and write is a route call. `membershipPeriods` is
 * `allow read, write: if false`, so there is no client-direct path to fall
 * back on and no snapshot to listen to; the list is refetched after each
 * write.
 */

type Period = {
  id: string;
  year: string;
  label: string;
  startsOn: string;
  endsOn: string;
  note: string;
  totals: Record<MembershipTier, number>;
  createdAt: string | null;
};

type ListPayload = {
  periods: Period[];
  currentPeriodId: string | null;
  canSetCurrent: boolean;
};

export default function MembershipConsole({ isAdmin }: { isAdmin: boolean }) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [currentPeriodId, setCurrentPeriodId] = useState<string | null>(null);
  const [canSetCurrent, setCanSetCurrent] = useState(isAdmin);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  /**
   * ONE load, called by the mount effect and again after every write. State
   * moves only from the async callbacks, never synchronously in the effect
   * body: the shape `RoundList` uses, and the reason this is a promise chain
   * rather than an awaited call. `isCancelled` is how the effect's cleanup
   * reaches in.
   */
  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetch("/api/admin/membership/periods")
        .then(async (res) => {
          const data = (await res.json()) as ListPayload & { error?: string };
          if (!res.ok) {
            throw new Error(data.error ?? "Could not load the membership periods.");
          }
          return data;
        })
        .then((data) => {
          if (isCancelled()) return;
          setPeriods(data.periods);
          setCurrentPeriodId(data.currentPeriodId);
          setCanSetCurrent(data.canSetCurrent);
          setError(null);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          setError(
            err instanceof Error ? err.message : "Could not load the membership periods.",
          );
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not save.");
      // Creating a period, and above all making one current, changes the
      // answer every membership chip on the Members list is drawn from. That
      // answer is shared and memoised, so it has to be dropped here or the
      // rows keep reporting the state from before this write until a reload.
      resetCurrentPeriodCache();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function patch(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not save.");
      // An edit can move the label the chips render, so it drops the shared
      // answer for the same reason a create does.
      resetCurrentPeriodCache();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <Card padding="lg">
        <h2 className={styles.heading}>Membership periods</h2>
        <p className={styles.blurb}>
          One period per academic year. Marking somebody a member means adding
          them to a period, which is done from their row on the Members tab.
          Membership is a badge and a record: it gates nothing anywhere on the
          site.
        </p>
        {!canSetCurrent && (
          <p className={styles.blurb}>
            Choosing which period is current is an admin job, because it changes
            every member&apos;s badge at once.
          </p>
        )}
      </Card>

      {error && (
        <Card padding="md">
          <p className={styles.error}>{error}</p>
        </Card>
      )}

      <Card padding="lg">
        <div className={styles.sectionHead}>
          <h3 className={styles.subheading}>Periods</h3>
          <Button size="sm" variant="ghost" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New period"}
          </Button>
        </div>

        {creating && (
          <PeriodForm
            busy={busy}
            submitLabel="Create period"
            initial={{
              year: currentAcademicYear(),
              label: "",
              startsOn: "",
              endsOn: "",
              note: "",
            }}
            withYear
            onSubmit={async (values) => {
              const ok = await post("/api/admin/membership/periods", values);
              if (ok) setCreating(false);
            }}
          />
        )}

        {loading ? (
          <p className={styles.muted}>Loading…</p>
        ) : periods.length === 0 ? (
          <p className={styles.muted}>
            No membership periods yet. Create {currentAcademicYear()} and set it
            current, or every badge on the site reads &ldquo;not recorded&rdquo;.
          </p>
        ) : (
          <ul className={styles.list}>
            {periods.map((period) => (
              <li key={period.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <div className={styles.rowTitle}>
                    <strong>{period.label || period.year}</strong>
                    <Badge tone="neutral">{period.year}</Badge>
                    {period.id === currentPeriodId && (
                      <Badge tone="success" title="Every badge on the site is about this period">
                        Current
                      </Badge>
                    )}
                  </div>
                  <div className={styles.rowActions}>
                    {canSetCurrent && period.id !== currentPeriodId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          post("/api/admin/membership/current", { periodId: period.id })
                        }
                      >
                        Make current
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setEditingId((id) => (id === period.id ? null : period.id))
                      }
                    >
                      {editingId === period.id ? "Close" : "Edit"}
                    </Button>
                  </div>
                </div>

                <div className={styles.facts}>
                  <span className={styles.fact}>
                    {period.startsOn || "no start date"} to {period.endsOn || "no end date"}
                  </span>
                  {ALL_MEMBERSHIP_TIERS.map((tier) => (
                    <span key={tier} className={styles.fact}>
                      {MEMBERSHIP_TIER_LABELS[tier]}: {period.totals[tier] ?? 0}
                    </span>
                  ))}
                </div>

                {period.note && <p className={styles.note}>{period.note}</p>}

                {editingId === period.id && (
                  <PeriodForm
                    busy={busy}
                    submitLabel="Save changes"
                    initial={{
                      year: period.year,
                      label: period.label,
                      startsOn: period.startsOn,
                      endsOn: period.endsOn,
                      note: period.note,
                    }}
                    onSubmit={async (values) => {
                      const ok = await patch(
                        `/api/admin/membership/periods/${encodeURIComponent(period.id)}`,
                        {
                          label: values.label,
                          startsOn: values.startsOn,
                          endsOn: values.endsOn,
                          note: values.note,
                        },
                      );
                      if (ok) setEditingId(null);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        <p className={styles.footnote}>
          Recording somebody as a member, or taking it back, is done from their
          row on the Members page and needs a full admin. Membership admin on
          its own reaches the periods and this page; the member table and the
          SU list import are a later change.
        </p>
      </Card>
    </div>
  );
}

type FormValues = {
  year: string;
  label: string;
  startsOn: string;
  endsOn: string;
  note: string;
};

/**
 * Create and edit share one form. The year is editable only on create: it IS
 * the doc id and the string every cached membership year is written against,
 * so changing it later would mean renaming a document and rewriting every
 * badge that points at it.
 */
function PeriodForm({
  initial,
  submitLabel,
  busy,
  withYear = false,
  onSubmit,
}: {
  initial: FormValues;
  submitLabel: string;
  busy: boolean;
  withYear?: boolean;
  onSubmit: (values: FormValues) => void | Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);

  function set(key: keyof FormValues, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(values);
      }}
    >
      {withYear && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Academic year</span>
          <Input
            value={values.year}
            onChange={(e) => set("year", e.target.value)}
            placeholder="2026/27"
            maxLength={7}
          />
        </label>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Label</span>
        <Input
          value={values.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="Membership 2026/27"
          maxLength={MEMBERSHIP_FIELD_LIMITS.label}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Starts on</span>
        <Input
          type="date"
          value={values.startsOn}
          onChange={(e) => set("startsOn", e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Ends on</span>
        <Input
          type="date"
          value={values.endsOn}
          onChange={(e) => set("endsOn", e.target.value)}
        />
      </label>
      <label className={`${styles.field} ${styles.fieldWide}`}>
        <span className={styles.fieldLabel}>Note (internal)</span>
        {/* Two hundred characters is a sentence or three, not a line, and the
            cap is silent: a single-line input just stops accepting keystrokes.
            The counter is how an admin sees the limit coming. */}
        <CountedTextarea
          value={values.note}
          onChange={(e) => set("note", e.target.value)}
          placeholder="Anything the next admin should know about this year"
          max={MEMBERSHIP_FIELD_LIMITS.note}
          rows={3}
        />
      </label>
      <div className={styles.formActions}>
        <Button type="submit" size="sm" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
