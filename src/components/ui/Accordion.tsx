"use client";

import { useId, type ReactNode } from "react";
import styles from "./Accordion.module.css";

type Props = {
  /** Contents of the summary button. The button itself is rendered here. */
  summary: ReactNode;
  children: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Override the generated panel id when something outside needs to name it. */
  panelId?: string;
  summaryClassName?: string;
  panelClassName?: string;
};

/**
 * The collapse machinery only — a summary button and a `grid-template-rows`
 * 0fr → 1fr panel, rendered as siblings with no wrapper of their own. The
 * consumer supplies the list/row element around them and every visual class,
 * so two very differently styled accordions can share one animation.
 *
 * Browsers without animatable `grid-template-rows` fall back to an instant
 * toggle; the property degrades quietly, so there is no second code path.
 *
 * Controlled: `open` and `onToggle` live with the consumer, because both
 * current callers need the flag anyway to keep collapsed links out of the tab
 * order (`tabIndex={open ? 0 : -1}`). That stays their job — `children` is an
 * opaque ReactNode here and cannot be rewritten from the inside.
 */
export default function Accordion({
  summary,
  children,
  open,
  onToggle,
  panelId,
  summaryClassName,
  panelClassName,
}: Props) {
  const reactId = useId();
  const resolvedPanelId = panelId ?? `accordion-panel-${reactId}`;
  const buttonId = `accordion-button-${reactId}`;

  return (
    <>
      <button
        type="button"
        id={buttonId}
        className={summaryClassName}
        aria-expanded={open}
        aria-controls={resolvedPanelId}
        onClick={onToggle}
      >
        {summary}
      </button>
      <div
        id={resolvedPanelId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!open}
        className={`${styles.panel} ${open ? styles.panelOpen : ""} ${panelClassName ?? ""}`}
      >
        <div className={styles.panelInner}>{children}</div>
      </div>
    </>
  );
}
