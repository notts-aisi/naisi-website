"use client";

import type { CSSProperties } from "react";
import type { StatColumn } from "@/lib/campaign/linkStats";
import styles from "./links.module.css";

/**
 * A small column chart of scans over time. One series, so one colour and no
 * legend: the caption says what it is.
 *
 * No chart library, like the other two charts in this codebase: a column is a
 * div with a percentage height, and every colour on it is a token. Only the
 * tallest column carries its number, because a number on every column stops
 * anybody reading any of them; the rest are one hover or one tab away, and the
 * list is a real list, so a screen reader gets every value in order.
 */
export function ScanColumns({ caption, columns }: { caption: string; columns: StatColumn[] }) {
  const peak = Math.max(0, ...columns.map((c) => c.value));
  if (peak === 0) return null;
  // The first column to reach the peak wears the label, so a tie shows one.
  const labelled = columns.findIndex((c) => c.value === peak);

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartCaption}>{caption}</figcaption>
      <ol className={styles.columns} style={{ "--columns": columns.length } as CSSProperties}>
        {columns.map((column, i) => {
          const text = `${column.name}: ${column.value} ${column.value === 1 ? "scan" : "scans"}`;
          return (
            <li key={column.key} className={styles.column} title={text} aria-label={text}>
              <span className={styles.columnPlot} aria-hidden="true">
                <span
                  className={styles.columnFill}
                  style={{ height: `${(column.value / peak) * 100}%` }}
                >
                  {i === labelled && <span className={styles.columnValue}>{column.value}</span>}
                </span>
              </span>
              <span className={styles.columnTick} aria-hidden="true">
                {column.tick}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
