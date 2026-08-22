"use client";

import { useId, useState, type ReactNode } from "react";
import Accordion from "@/components/ui/Accordion";
import Chip from "@/components/ui/Chip";
import Skeleton from "@/components/ui/Skeleton";
import styles from "./TemplatePicker.module.css";

/**
 * The nested curriculum-source picker: a family, expanded, lists its saved
 * iterations newest first.
 *
 * Not a `<select>`. A row here is four facts (what it is called, when it was
 * frozen, how many weeks it holds, who saved it) plus a marker for whether the
 * snapshot carries retrospective evidence — an `<option>` can hold one line of
 * text, and flattening a version history into "Autumn 2026 final · 3 Aug 2026 ·
 * 8 weeks · Zach" is exactly the string nobody reads. The disclosure shape also
 * scales to the five course families the platform is heading for, where a flat
 * list of every snapshot ever taken would be the wrong object entirely.
 *
 * ── WHY NATIVE RADIOS ───────────────────────────────────────────────────────
 * One `<input type="radio">` per row behind the styled label, the
 * SegmentedControl / StarRating technique. It buys the whole selection
 * contract for free: arrow-key navigation, the "checked row is the tab stop"
 * roving behaviour, and an announcement that says "selected" rather than
 * "pressed". The radios in a COLLAPSED group are taken out of the tab order
 * (`tabIndex={-1}`) because the Accordion panel is `aria-hidden` while closed —
 * a focusable node inside an aria-hidden region is the classic trap, and the
 * Accordion's own docs hand that job to its consumer.
 *
 * Each group gets its OWN radio `name`, so arrow keys walk the visible group
 * rather than teleporting into a collapsed one. Selection is controlled by
 * `value`, so the groups still behave as a single choice.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The component knows nothing about templates or runs: callers build rows.
 * That is what lets the run editor offer both in one control, and what will let
 * a future surface offer several course families side by side.
 */

export type TemplatePickerRow = {
  /**
   * Unique across the WHOLE picker. Callers prefix by kind — a template id and
   * a run id are both `slugId` output and can collide.
   */
  id: string;
  kind: "template" | "run";
  label: string;
  /** Second line. Blank / null entries are dropped, so callers can inline conditionals. */
  meta: (string | null | undefined)[];
  /** Template rows: this snapshot froze its cohort's figures alongside the weeks. */
  hasRetrospective?: boolean;
};

export type TemplatePickerGroup = {
  id: string;
  title: string;
  /** Small count beside the title, e.g. "3 iterations". */
  count?: string;
  rows: TemplatePickerRow[];
  /** Shown inside the group when it is expanded and has nothing in it. */
  emptyHint: string;
};

type Props = {
  groups: TemplatePickerGroup[];
  /** The selected row id, or "" for none. */
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  loading?: boolean;
  /** Rendered instead of the groups when every one of them is empty. */
  emptyState?: ReactNode;
  /**
   * Trailing control for a row (a delete button, say). Rendered OUTSIDE the
   * label so pressing it can't also select the row.
   */
  renderRowAction?: (row: TemplatePickerRow) => ReactNode;
  /** Which group starts open. Defaults to the first one that has rows in it. */
  defaultOpenGroupId?: string;
};

export default function TemplatePicker({
  groups,
  value,
  onChange,
  ariaLabel,
  loading = false,
  emptyState,
  renderRowAction,
  defaultOpenGroupId,
}: Props) {
  const name = useId();
  /**
   * Only the groups the reader has actually toggled. Everything else falls back
   * to the default below, so a group whose rows arrive after mount still starts
   * in the right state — an `initialOpen` set captured on the first render
   * would have been computed before the fetch landed.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  if (loading) {
    return (
      <div className={styles.picker}>
        <Skeleton lines={3} height="3rem" ariaLabel="Loading saved templates…" />
      </div>
    );
  }

  const anyRows = groups.some((g) => g.rows.length > 0);
  if (!anyRows && emptyState) {
    return <div className={styles.picker}>{emptyState}</div>;
  }

  // Open the first family that actually has something in it, not simply the
  // first: a course with no snapshots yet but three past runs should land on
  // the runs, rather than on an empty panel explaining that it is empty.
  const defaultOpen =
    defaultOpenGroupId ?? groups.find((g) => g.rows.length > 0)?.id ?? groups[0]?.id;

  return (
    <div className={styles.picker} role="group" aria-label={ariaLabel}>
      {groups.map((group) => {
        const open = toggled[group.id] ?? group.id === defaultOpen;
        const holdsSelection = group.rows.some((r) => r.id === value);

        return (
          <div key={group.id} className={styles.group}>
            <Accordion
              open={open}
              onToggle={() => setToggled((t) => ({ ...t, [group.id]: !open }))}
              summaryClassName={`${styles.groupSummary} ${open ? styles.groupSummaryOpen : ""}`}
              panelClassName={styles.groupPanel}
              summary={
                <>
                  <span
                    className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  <span className={styles.groupTitle}>{group.title}</span>
                  {group.count && <span className={styles.groupCount}>{group.count}</span>}
                  {/* Only while collapsed: expanded, the checked row says it
                      itself, and two "selected" marks on one screen is noise. */}
                  {holdsSelection && !open && (
                    <Chip size="sm" tone="accent">
                      Selected
                    </Chip>
                  )}
                </>
              }
            >
              {group.rows.length === 0 ? (
                <p className={styles.emptyHint}>{group.emptyHint}</p>
              ) : (
                <ul className={styles.rows}>
                  {group.rows.map((row) => {
                    const meta = row.meta.filter(Boolean).join(" · ");
                    const selected = row.id === value;
                    const action = renderRowAction?.(row);
                    return (
                      <li key={row.id} className={styles.rowItem}>
                        <label
                          className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
                        >
                          <input
                            type="radio"
                            className={styles.radio}
                            name={`${name}-${group.id}`}
                            checked={selected}
                            // Collapsed groups sit inside an aria-hidden panel;
                            // nothing in them may be reachable by Tab.
                            tabIndex={open ? undefined : -1}
                            onChange={() => onChange(row.id)}
                          />
                          <span className={styles.rowBody}>
                            <span className={styles.rowLabel}>
                              {row.label}
                              {row.hasRetrospective && (
                                <Chip
                                  size="sm"
                                  tone="success"
                                  title="This snapshot stored its cohort's ratings and completion figures."
                                >
                                  Retrospective
                                </Chip>
                              )}
                            </span>
                            {meta && <span className={styles.rowMeta}>{meta}</span>}
                          </span>
                        </label>
                        {action && <span className={styles.rowAction}>{action}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Accordion>
          </div>
        );
      })}
    </div>
  );
}
