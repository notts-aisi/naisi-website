"use client";

import Badge from "@/components/ui/Badge";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import styles from "./PeriodSwitcher.module.css";

/**
 * Which period the table, the counts, the import and the export are all about.
 *
 * SEPARATE FROM THE CURRENT POINTER, on purpose. `config/membership` decides
 * which year every badge on the site reads; this decides which year an admin
 * is LOOKING at. Conflating them is how somebody re-badges the whole society
 * while meaning to check last year's list, so the switcher never writes and
 * says out loud when the period being viewed is not the current one.
 */

export type PeriodOption = {
  id: string;
  year: string;
  label: string;
};

export default function PeriodSwitcher({
  periods,
  value,
  currentPeriodId,
  onChange,
  disabled,
}: {
  periods: PeriodOption[];
  value: string;
  currentPeriodId: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  if (periods.length === 0) return null;
  const viewingCurrent = value !== "" && value === currentPeriodId;
  return (
    <div className={styles.wrap} data-testid="membership-period-switcher">
      <label className={styles.field} htmlFor="membership-period">
        <span className={styles.fieldLabel}>Membership period</span>
        <ResponsiveSelect
          id="membership-period"
          value={value}
          onChange={onChange}
          disabled={disabled}
          ariaLabel="Membership period"
          options={periods.map<ResponsiveSelectOption>((period) => ({
            value: period.id,
            label:
              period.id === currentPeriodId
                ? `${period.label || period.year} (current)`
                : period.label || period.year,
          }))}
        />
      </label>
      {viewingCurrent ? (
        <Badge
          tone="success"
          title="Every membership badge on the site is about this period"
          data-testid="membership-viewing-current"
        >
          Current period
        </Badge>
      ) : (
        <span className={styles.note}>
          You are looking at a period that is not the current one. Badges across
          the site still read the current period.
        </span>
      )}
    </div>
  );
}
