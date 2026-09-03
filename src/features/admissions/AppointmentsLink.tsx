"use client";

import Link from "next/link";
import styles from "./AppointmentsLink.module.css";

/**
 * The way into a round's appointment queue, shown on an APPOINTMENT round's
 * console and nowhere else.
 *
 * Its own component rather than a line inside `RoundEditor` so the editor
 * carries one conditional mount and this file carries the copy, the styling
 * and the kind rule. The editor is edited by every admissions PR in the wave;
 * a shared file that everybody appends to is how three of them end up
 * conflicting on the same fifteen lines.
 *
 * The link is an affordance, never a gate: the page re-checks the round's kind
 * and the caller's place on the round, and the decide route checks both again.
 *
 * `readOnly` is the round being archived, still a draft or cancelled: states
 * `appointmentDecideBlock` refuses, so the queue behind this link has no
 * buttons. The link stays, because reading a cancelled round's applications is
 * exactly what somebody comes here for, and it says so rather than promising
 * an appointment it cannot make.
 */
export default function AppointmentsLink({
  roundId,
  readOnly = false,
}: {
  roundId: string;
  readOnly?: boolean;
}) {
  return (
    <Link className={styles.link} href={`/admin/admissions/${roundId}/appointments`}>
      <span className={styles.title}>
        Appointments{readOnly ? " (read only)" : ""}
      </span>
      <span className={styles.note}>
        {readOnly
          ? "Read the submitted facilitator applications. This round is not in a state that can appoint anybody."
          : "Read the submitted facilitator applications and appoint people to a run."}
      </span>
    </Link>
  );
}
