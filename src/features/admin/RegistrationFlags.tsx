"use client";

import Card from "@/components/ui/Card";
import type { RegistrationSummary } from "@/lib/firestore/registrations";
import styles from "./Registrations.module.css";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/** The flagger panel: suspicious-activity flags + signup status counts + signals. */
export default function RegistrationFlags({ summary }: { summary: RegistrationSummary }) {
  const { counts, velocity, recaptcha, flags } = summary;
  return (
    <Card padding="lg">
      <div className={styles.summaryHead}>
        <h2 className={styles.summaryTitle}>Signup activity</h2>
        {flags.length === 0 && <span className={styles.allClear}>No flags</span>}
      </div>

      {flags.length > 0 && (
        <ul className={styles.flagList}>
          {flags.map((f, i) => (
            <li
              key={`${f.kind}-${i}`}
              className={`${styles.flag} ${
                f.level === "red" ? styles.flagRed : styles.flagAmber
              }`}
            >
              <span className={styles.flagDot} aria-hidden="true" />
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.statGrid}>
        <Stat label="Total" value={counts.total} />
        <Stat label="Pending verify" value={counts.pendingVerify} />
        <Stat label="Verified · no password" value={counts.verifiedNoPassword} />
        <Stat label="Completed" value={counts.completed} />
        <Stat label="Orphans" value={counts.orphans} />
      </div>

      <p className={styles.metaLine}>
        <strong>{velocity.last1h}</strong> new in the last hour ·{" "}
        <strong>{velocity.last24h}</strong> in 24h · reCAPTCHA failed{" "}
        <strong>{Math.round(recaptcha.failRate * 100)}%</strong> ({recaptcha.failed}/
        {recaptcha.attempts} over {recaptcha.windowDays}d)
      </p>
    </Card>
  );
}
