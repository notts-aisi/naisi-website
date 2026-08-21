"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { CourseWeekDoc, Material } from "@/lib/firestore/courses";
import styles from "./WeekAccordion.module.css";

type Props = {
  courseId: string;
  /** The showcase run's published weeks, already ordered by weekNumber. */
  weeks: CourseWeekDoc[];
};

/**
 * The curriculum browser on a public course page: one collapsed row per week,
 * expanding to the week's material titles and a link through to the full week.
 *
 * Animation is `grid-template-rows` 0fr → 1fr, the same technique as
 * ReadingListAccordion (content-height-aware, no max-height guess). That
 * component is deliberately NOT reused or generalised here — the shared
 * `Accordion` extraction is scheduled with the learning space, and pulling it
 * forward would land a shared primitive in a PR that can't exercise its other
 * two consumers. See WeekAccordion.module.css for the min-height/overflow pair
 * the technique depends on.
 */
export default function WeekAccordion({ courseId, weeks }: Props) {
  if (weeks.length === 0) {
    return (
      <p className={styles.empty}>
        The week-by-week curriculum for this course isn&apos;t published yet.
        It&apos;ll appear here before applications close.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {weeks.map((week) => (
        <WeekRow key={week.id} courseId={courseId} week={week} />
      ))}
    </ol>
  );
}

function WeekRow({ courseId, week }: { courseId: string; week: CourseWeekDoc }) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const panelId = `week-panel-${reactId}`;
  const buttonId = `week-button-${reactId}`;

  const meta = [formatMinutes(week.estimatedMinutes), countLabel(week.materials.length)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={styles.row}>
      <button
        type="button"
        id={buttonId}
        className={styles.summary}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.summaryText}>
          <span className={styles.summaryTitle}>
            <span className={styles.weekNumber}>Week {week.weekNumber}</span>
            {week.title ? (
              <>
                <span aria-hidden="true" className={styles.dot}>
                  ·
                </span>
                <span>{week.title}</span>
              </>
            ) : null}
          </span>
          {meta ? <span className={styles.summaryMeta}>{meta}</span> : null}
        </span>
        <span
          className={`${styles.indicator} ${open ? styles.indicatorOpen : ""}`}
          aria-hidden="true"
        >
          {/* Chevron drawn as one polyline so the rotation stays centred and
              reads as a single element paused mid-animation. */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 5 L7 9 L11 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!open}
        className={`${styles.panel} ${open ? styles.panelOpen : ""}`}
      >
        <div className={styles.panelInner}>
          {week.summary ? <p className={styles.summaryLine}>{week.summary}</p> : null}

          {week.materials.length > 0 ? (
            <ul className={styles.materials}>
              {week.materials.map((m) => (
                <li key={m.id} className={styles.material}>
                  <MaterialTeaser material={m} tabbable={open} />
                </li>
              ))}
            </ul>
          ) : null}

          <p className={styles.more}>
            <Link
              href={`/courses/${courseId}/weeks/${week.weekNumber}`}
              className={styles.moreLink}
              // Collapsed panels stay out of the tab order, matching the
              // material links above.
              tabIndex={open ? 0 : -1}
            >
              Read the full week
              <span aria-hidden="true" className={styles.arrow}>
                →
              </span>
            </Link>
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * One material as a teaser row. Linkable kinds open in a new tab; a `note` is
 * authored prose with nowhere to go, so it renders as plain text.
 */
function MaterialTeaser({
  material,
  tabbable,
}: {
  material: Material;
  tabbable: boolean;
}) {
  const kind = <span className={styles.kind}>{MATERIAL_KIND_LABEL[material.type]}</span>;
  const label = material.title || "Untitled";

  if (material.type === "note") {
    return (
      <span className={styles.materialNote}>
        {kind}
        <span>{label}</span>
      </span>
    );
  }

  return (
    <a
      href={material.url}
      target="_blank"
      rel="noreferrer noopener"
      className={styles.materialLink}
      tabIndex={tabbable ? 0 : -1}
    >
      {kind}
      <span className={styles.materialTitle}>{label}</span>
      {typeof material.estimatedMinutes === "number" ? (
        <span className={styles.materialTime}>{material.estimatedMinutes} min</span>
      ) : null}
    </a>
  );
}

const MATERIAL_KIND_LABEL: Record<Material["type"], string> = {
  video: "Video",
  reading: "Reading",
  link: "Link",
  note: "Note",
};

function countLabel(n: number): string {
  if (n === 0) return "";
  return n === 1 ? "1 material" : `${n} materials`;
}

/** "~45 min" / "~1 hr 15 min" — a rough figure, phrased as one. */
function formatMinutes(minutes: number | null): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes < 60) return `~${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  const hrLabel = hrs === 1 ? "1 hr" : `${hrs} hrs`;
  return rem ? `~${hrLabel} ${rem} min` : `~${hrLabel}`;
}
