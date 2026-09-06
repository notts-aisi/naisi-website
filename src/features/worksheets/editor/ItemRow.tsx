"use client";

import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import styles from "./WorksheetEditor.module.css";

type Props = {
  /** The item's id. It is the sortable id AND the React key the parent uses. */
  id: string;
  /** Short chip: the question type, "Section" or "Page break". */
  typeLabel: string;
  /** The collapsed summary line: a question's title or a section's heading. */
  summary: string;
  /** Shown greyed when `summary` is blank, so an unnamed row is still findable. */
  summaryFallback: string;
  /** Position in the list, for the arrow buttons' disabled state and the aria label. */
  index: number;
  count: number;
  expanded: boolean;
  /** Null for a page break, which has nothing to expand. */
  onToggle: (() => void) | null;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Validator messages for THIS item, rendered whether or not it is expanded. */
  problems: string[];
  /**
   * "divider" drops the card chrome for a dashed separator, which is what a
   * page break IS: it has no content of its own and reads as a rule across the
   * list rather than as another card in the stack. It keeps the same controls,
   * because it is still a row somebody has to be able to move and delete.
   */
  variant?: "card" | "divider";
  disabled?: boolean;
  children?: ReactNode;
};

/**
 * The chrome every row of the worksheet editor shares: a drag handle, a type
 * chip, the collapsed summary, the reorder arrows, duplicate and delete, and
 * the validator's messages.
 *
 * BOTH ways to reorder, on purpose. Drag is the fast one and the one people
 * reach for; the arrows are the one that works with a keyboard, with a screen
 * reader, on a touch screen where the drag competes with the page's own
 * scroll, and for a one-position nudge where aiming a drag is more work than
 * the move is worth. dnd-kit's keyboard sensor covers the keyboard case on its
 * own, but only once the handle has focus and only if the person guesses that
 * space then arrows is the gesture, which is not a thing to make them guess.
 *
 * PROBLEMS RENDER WHILE COLLAPSED. A message hidden inside a collapsed row is
 * a save the author cannot explain: they see a refusal at the top of the page
 * and no indication of which of forty rows it is about.
 *
 * `disabled` NEVER REACHES THE EXPAND TOGGLE. It is a read affordance, not a
 * write one, and the editor is rendered with `disabled` set for every reader
 * who did not author the worksheet: committee members who may read a
 * non-private worksheet and take a copy of it. Disabling the toggle would show
 * them a stack of collapsed titles they cannot open, on a page whose own copy
 * invites them to read it, and would then offer "Make a copy" of a document
 * they were never shown. The inputs inside `QuestionEditor` and
 * `SectionEditor` take `disabled` themselves, so an expanded row under a
 * reader renders its content without offering an edit.
 */
export default function ItemRow({
  id,
  typeLabel,
  summary,
  summaryFallback,
  index,
  count,
  expanded,
  onToggle,
  onMove,
  onDuplicate,
  onDelete,
  problems,
  variant = "card",
  disabled,
  children,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const label = summary.trim();
  /**
   * Only pointed at while the body is actually in the document. The body is
   * mounted on expand rather than hidden with an attribute, because each one
   * carries a rich text editor per block and forty of them mounted at once is
   * a page that takes seconds to become interactive. An `aria-controls` naming
   * an element that is not there resolves to nothing, so it is set only when
   * there is something to name.
   */
  const bodyId = `ws-item-body-${id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.row} ${variant === "divider" ? styles.rowDivider : ""} ${
        problems.length > 0 ? styles.rowProblem : ""
      }`}
    >
      <div className={styles.rowHeader}>
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={`Drag to reorder: ${label || summaryFallback}`}
          title="Drag to reorder"
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          ≡
        </button>

        <span className={styles.typeChip}>{typeLabel}</span>

        {onToggle ? (
          <button
            type="button"
            className={styles.summaryBtn}
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={expanded && children ? bodyId : undefined}
          >
            <span className={label ? styles.summary : styles.summaryEmpty}>
              {label || summaryFallback}
            </span>
            <span aria-hidden className={styles.chevron}>
              {expanded ? "▾" : "▸"}
            </span>
          </button>
        ) : (
          <span className={`${styles.summaryBtn} ${styles.summaryStatic}`}>
            <span className={styles.summaryEmpty}>{summaryFallback}</span>
          </span>
        )}

        <div className={styles.rowControls}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => onMove(-1)}
            disabled={disabled || index === 0}
            aria-label="Move up"
            title="Move up"
          >
            ▲
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => onMove(1)}
            disabled={disabled || index === count - 1}
            aria-label="Move down"
            title="Move down"
          >
            ▼
          </button>
          <button
            type="button"
            className={styles.textBtn}
            onClick={onDuplicate}
            disabled={disabled}
            title="Duplicate"
          >
            Duplicate
          </button>
          <button
            type="button"
            className={`${styles.textBtn} ${styles.deleteBtn}`}
            onClick={onDelete}
            disabled={disabled}
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className={styles.problems}>
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {expanded && children && (
        <div id={bodyId} className={styles.rowBody}>
          {children}
        </div>
      )}
    </div>
  );
}
