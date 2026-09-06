"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  WORKSHEET_LIMITS,
  WORKSHEET_QUESTION_TYPES,
  emptyPageBreak,
  emptyQuestion,
  emptySection,
  questionsOf,
  validateWorksheetItems,
  type WorksheetItem,
  type WorksheetQuestion,
  type WorksheetQuestionType,
  type WorksheetSection,
} from "@/lib/firestore/worksheets";
import ItemRow from "./ItemRow";
import QuestionEditor from "./QuestionEditor";
import SectionEditor from "./SectionEditor";
import {
  duplicateItemAt,
  insertItemAt,
  moveItem,
  problemsByItem,
  removeItemAt,
  reorderItems,
} from "./itemOps";
import styles from "./WorksheetEditor.module.css";

type Props = {
  items: WorksheetItem[];
  onChange: (items: WorksheetItem[]) => void;
  /**
   * The document id images are stored under: `worksheet-images/{ownerId}/…`,
   * which is the path `storage.rules` allows. A worksheet id from the library
   * editor, a circulation id from the mid-flight editor.
   */
  storageOwnerId: string;
  disabled?: boolean;
};

/** What the add menu can insert: any question type, a section, or a page break. */
type Choice = WorksheetQuestionType | "section" | "pageBreak";

const CHOICES: { choice: Choice; label: string }[] = [
  ...WORKSHEET_QUESTION_TYPES.map((t) => ({ choice: t.type as Choice, label: t.label })),
  { choice: "section", label: "Section heading" },
  { choice: "pageBreak", label: "Page break" },
];

function createItem(choice: Choice): WorksheetItem {
  if (choice === "section") return emptySection();
  if (choice === "pageBreak") return emptyPageBreak();
  return emptyQuestion(choice);
}

const QUESTION_TYPE_LABEL = new Map<string, string>(
  WORKSHEET_QUESTION_TYPES.map((t) => [t.type, t.label]),
);

function typeLabelOf(item: WorksheetItem): string {
  if (item.kind === "section") return "Section";
  if (item.kind === "pageBreak") return "Page break";
  return QUESTION_TYPE_LABEL.get(item.type) ?? item.type;
}

/**
 * The worksheet's list of questions, sections and page breaks.
 *
 * CONTROLLED, with no copy of `items`. Every edit is a new array handed
 * straight back to the parent, which owns the autosave, the save button and
 * the "unsaved changes" state. Keeping a copy here would make this component
 * a second source of truth that has to be reconciled with the Firestore
 * listener the parent runs, which is the shape of every stale-editor bug.
 *
 * It VALIDATES ITSELF. The parent passes no problems in: this component calls
 * `validateWorksheetItems` on the items it was given and renders each message
 * against the row it names. That is the same function the saving path runs, so
 * a worksheet this editor shows as clean is one the save accepts, and the
 * author is told which of forty rows is wrong rather than being handed one
 * sentence at the top of the page.
 */
export default function WorksheetEditor({ items, onChange, storageOwnerId, disabled }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Which add menu is open: the id of the row it sits under, or "end". */
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // `activationConstraint` keeps a click on an input inside a row from
  // starting a drag; the keyboard sensor gives the handle space-then-arrows,
  // which is what a screen reader user expects of a sortable list.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const problems = useMemo(() => problemsByItem(validateWorksheetItems(items)), [items]);
  const questionCount = questionsOf(items).length;
  const ids = items.map((item) => item.id);

  /**
   * Why a choice cannot be added right now, or null when it can.
   *
   * REFUSED IN THE MENU rather than in the validator. `firestore.rules` caps
   * `items.size()` at the same number, and the autosave writes client-direct,
   * so the item past the cap does not come back as a message under a row: it
   * comes back as a permission error on a save the author cannot connect to
   * anything they did. The two caps are different shapes, though. The item cap
   * closes the menu completely, while the question cap still leaves sections
   * and page breaks addable, because those are not questions and the document
   * has room.
   */
  function capReason(choice: Choice): string | null {
    if (items.length >= WORKSHEET_LIMITS.maxItems) {
      return `A worksheet can hold ${WORKSHEET_LIMITS.maxItems} items. Delete one to add another.`;
    }
    const isQuestion = choice !== "section" && choice !== "pageBreak";
    if (isQuestion && questionCount >= WORKSHEET_LIMITS.maxQuestions) {
      return `A worksheet can hold ${WORKSHEET_LIMITS.maxQuestions} questions. Delete one to add another.`;
    }
    return null;
  }

  function replaceAt(index: number, item: WorksheetItem) {
    const next = items.slice();
    next[index] = item;
    onChange(next);
  }

  function addAt(choice: Choice, afterIndex: number | null) {
    const item = createItem(choice);
    onChange(insertItemAt(items, item, afterIndex));
    setExpandedId(item.kind === "pageBreak" ? null : item.id);
    setOpenMenu(null);
  }

  function handleDelete(index: number) {
    const removed = items[index];
    onChange(removeItemAt(items, index));
    if (removed && expandedId === removed.id) setExpandedId(null);
  }

  function handleDuplicate(index: number) {
    const next = duplicateItemAt(items, index);
    onChange(next);
    const copy = next[index + 1];
    if (copy && copy.kind !== "pageBreak") setExpandedId(copy.id);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === String(active.id));
    const to = items.findIndex((item) => item.id === String(over.id));
    if (from < 0 || to < 0) return;
    onChange(reorderItems(items, from, to));
  }

  return (
    <div className={styles.wrap}>
      {items.length === 0 && (
        <p className={styles.empty}>
          Nothing in this worksheet yet. Add the first question below.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className={styles.list}>
            {items.map((item, index) => (
              <div key={item.id} className={styles.slot}>
                <ItemRow
                  id={item.id}
                  typeLabel={typeLabelOf(item)}
                  summary={
                    item.kind === "question"
                      ? item.title
                      : item.kind === "section"
                        ? item.heading
                        : ""
                  }
                  summaryFallback={
                    item.kind === "question"
                      ? "Untitled question"
                      : item.kind === "section"
                        ? "Untitled section"
                        : "Everything after this starts a new page"
                  }
                  index={index}
                  count={items.length}
                  expanded={expandedId === item.id}
                  onToggle={
                    item.kind === "pageBreak"
                      ? null
                      : () => setExpandedId(expandedId === item.id ? null : item.id)
                  }
                  onMove={(direction) => onChange(moveItem(items, index, direction))}
                  onDuplicate={() => handleDuplicate(index)}
                  onDelete={() => handleDelete(index)}
                  problems={problems.get(item.id) ?? []}
                  variant={item.kind === "pageBreak" ? "divider" : "card"}
                  disabled={disabled}
                >
                  {item.kind === "question" && (
                    <QuestionEditor
                      question={item}
                      onChange={(next: WorksheetQuestion) => replaceAt(index, next)}
                      storageOwnerId={storageOwnerId}
                      disabled={disabled}
                    />
                  )}
                  {item.kind === "section" && (
                    <SectionEditor
                      section={item}
                      onChange={(next: WorksheetSection) => replaceAt(index, next)}
                      storageOwnerId={storageOwnerId}
                      disabled={disabled}
                    />
                  )}
                </ItemRow>

                <AddMenu
                  variant="between"
                  open={openMenu === item.id}
                  onOpen={() => setOpenMenu(item.id)}
                  onClose={() => setOpenMenu(null)}
                  onPick={(choice) => addAt(choice, index)}
                  disabled={disabled}
                  capReason={capReason}
                />
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <AddMenu
        variant="end"
        open={openMenu === "end"}
        onOpen={() => setOpenMenu("end")}
        onClose={() => setOpenMenu(null)}
        onPick={(choice) => addAt(choice, null)}
        disabled={disabled}
        capReason={capReason}
      />

      <p className={styles.counts}>
        {questionCount} of {WORKSHEET_LIMITS.maxQuestions} questions · {items.length} of{" "}
        {WORKSHEET_LIMITS.maxItems} items
      </p>
    </div>
  );
}

function AddMenu({
  variant,
  open,
  onOpen,
  onClose,
  onPick,
  disabled,
  capReason,
}: {
  variant: "end" | "between";
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (choice: Choice) => void;
  disabled?: boolean;
  capReason: (choice: Choice) => string | null;
}) {
  // A page break is the choice with no cap of its own beyond the item cap, so
  // a reason against IT is a reason against opening the menu at all: there is
  // nothing left inside that could be picked.
  const fullReason = capReason("pageBreak");

  if (!open) {
    return variant === "end" ? (
      <button
        type="button"
        className={styles.addBigBtn}
        onClick={onOpen}
        disabled={disabled || fullReason !== null}
        title={fullReason ?? undefined}
      >
        + Add a question, section or page break
      </button>
    ) : (
      <div className={styles.insertRow}>
        <button
          type="button"
          className={styles.insertBtn}
          onClick={onOpen}
          disabled={disabled || fullReason !== null}
          aria-label="Insert here"
          title={fullReason ?? "Insert here"}
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className={styles.addMenu}>
      <div className={styles.addMenuHeader}>
        <strong>{variant === "end" ? "Add to the end" : "Insert here"}</strong>
        <button type="button" className={styles.addMenuClose} onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className={styles.addMenuGrid}>
        {CHOICES.map((item) => {
          const reason = capReason(item.choice);
          return (
            <button
              key={item.choice}
              type="button"
              className={styles.addMenuItem}
              onClick={() => onPick(item.choice)}
              disabled={disabled || reason !== null}
              title={reason ?? undefined}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
