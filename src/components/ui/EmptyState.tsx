import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

type Props = {
  title: string;
  body?: string;
  action?: ReactNode;
};

/**
 * An empty screen is an invitation to act, so write the copy that way: `title`
 * names what isn't here yet, `body` says what to do about it, `action` is the
 * doing. Copy that only reports the absence ("No items") leaves the member
 * with nowhere to go.
 *
 * The title is a <p>, not a heading: these mount inside pages that already own
 * their heading order, and a stray h2/h3 per empty list breaks it.
 */
export default function EmptyState({ title, body, action }: Props) {
  return (
    <div className={styles.root}>
      <p className={styles.title}>{title}</p>
      {body && <p className={styles.body}>{body}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
