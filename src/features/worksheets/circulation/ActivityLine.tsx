"use client";

import type { ResponseActivity } from "@/lib/firestore/circulations";
import { activityLineOf } from "./circulationView";
import styles from "./ActivityLine.module.css";

/**
 * "First opened yesterday, 4 page opens, 12 min active", or "Not opened yet".
 *
 * The same line is shown to the RECIPIENT on their own task and respond page.
 * That is a deliberate constraint on what it may ever say: anything a sender
 * would not want the recipient reading back about themselves does not belong
 * in the activity model in the first place. The sentence is built by
 * `activityLineOf`, which is pure and tested.
 *
 * `new Date()` at render, the `DueDateBadge` precedent. The relative day only
 * changes at local midnight, so a server render and the client render that
 * hydrates it disagree in a window measured in milliseconds a day.
 */
export default function ActivityLine({ activity }: { activity: ResponseActivity }) {
  return <span className={styles.line}>{activityLineOf(activity, new Date())}</span>;
}
