"use client";

import { Input, Textarea } from "@/components/ui/Input";
import {
  SOURCE_SHEET_LIMITS,
  type SourceItem,
  type SourceItemError,
} from "@/lib/firestore/sourceSheets";
import styles from "./editor.module.css";

type Props = {
  item: SourceItem;
  index: number;
  count: number;
  errors: SourceItemError[];
  onChange: (patch: Partial<Omit<SourceItem, "id">>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  disabled?: boolean;
};

function errorFor(errors: SourceItemError[], field: SourceItemError["field"]) {
  return errors.find((e) => e.field === field)?.message;
}

/**
 * One row of the bibliography: the printed number, the source, the link, and
 * an optional note.
 *
 * The NUMBER is an editable field rather than a rendered position. It is what
 * is set in superscript on the poster, so it has to be settable by hand (the
 * material may have been designed before this entry existed) and it must never
 * move because a row above it was deleted. The editor refuses duplicates and
 * warns when the entry has already been published.
 *
 * The COMMENT is shown on the public page when it has text, and renders
 * nothing when it is empty. It is a note about the source, not an internal
 * one: the label says so, because a field an admin mistakes for private is the
 * worse failure of the two.
 */
export default function SourceRow({
  item,
  index,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
  disabled,
}: Props) {
  const numberError = errorFor(errors, "n");
  const nameError = errorFor(errors, "name");
  const urlError = errorFor(errors, "url");

  return (
    <li className={styles.row}>
      <div className={styles.rowGrid}>
        <label className={styles.numberField}>
          <span className={styles.label}>Number</span>
          <Input
            type="number"
            min={1}
            max={SOURCE_SHEET_LIMITS.maxNumber}
            inputMode="numeric"
            value={Number.isFinite(item.n) ? item.n : ""}
            onChange={(e) => onChange({ n: Number.parseInt(e.target.value, 10) })}
            disabled={disabled}
            className={numberError ? styles.invalid : undefined}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Source</span>
          <Input
            value={item.name}
            maxLength={SOURCE_SHEET_LIMITS.itemName}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Bengio et al., International AI Safety Report 2025"
            disabled={disabled}
            className={nameError ? styles.invalid : undefined}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Link</span>
          <Input
            value={item.url}
            maxLength={SOURCE_SHEET_LIMITS.itemUrl}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://example.ac.uk/report"
            disabled={disabled}
            className={urlError ? styles.invalid : undefined}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Note (optional, shown publicly)</span>
          <Textarea
            value={item.comment ?? ""}
            maxLength={SOURCE_SHEET_LIMITS.itemComment}
            rows={2}
            onChange={(e) => onChange({ comment: e.target.value })}
            placeholder="Which figure or section the claim comes from"
            disabled={disabled}
          />
        </label>
      </div>

      {(numberError || nameError || urlError) && (
        <ul className={styles.rowErrors}>
          {numberError && <li>{numberError}</li>}
          {nameError && <li>{nameError}</li>}
          {urlError && <li>{urlError}</li>}
        </ul>
      )}

      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowButton}
          onClick={() => onMove(-1)}
          disabled={disabled || index === 0}
          aria-label={`Move source ${item.n} up`}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.rowButton}
          onClick={() => onMove(1)}
          disabled={disabled || index === count - 1}
          aria-label={`Move source ${item.n} down`}
        >
          ↓
        </button>
        <button
          type="button"
          className={`${styles.rowButton} ${styles.rowRemove}`}
          onClick={onRemove}
          disabled={disabled}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
