import type { ReactNode } from "react";
import BlockView from "@/features/events/BlockView";
import { youtubeIdFromUrl } from "@/lib/firestore/newsletterBlocks";
import type { CourseWeekDoc, Material } from "@/lib/firestore/courses";
import styles from "./WeekCurriculum.module.css";

/**
 * The shared week-curriculum spine: guide → materials → exercises → checklist.
 *
 * Rendered on BOTH the public week page (`/courses/[courseId]/weeks/[week]`)
 * and — later — the member learning space, which passes `renderMaterialAction`
 * to hang its check-off control off each material row. Everything here is
 * strictly presentational and server-safe (no `"use client"`, no hooks, no
 * event handlers) so the public page can stay an async Server Component; all
 * interactivity arrives through the render prop.
 *
 * XSS boundary: the ONLY `dangerouslySetInnerHTML` in the week body lives
 * inside `BlockView`, and only for guide blocks — trusted content authored by
 * `draftCourse` permission holders. Every other string on this page (material
 * titles, exercise prompts, checklist details) is rendered as a text node.
 */

type Props = {
  week: CourseWeekDoc;
  /**
   * Optional per-material control rendered at the row's leading edge (the
   * member surface's 44×44 check-off button). Omitted on the public page,
   * where materials are plain outbound links.
   */
  renderMaterialAction?: (material: Material) => ReactNode;
};

const KIND_LABEL: Record<Material["type"], string> = {
  video: "Video",
  reading: "Reading",
  link: "Link",
  note: "Note",
};

/**
 * Material URLs are authored by trusted drafters, but a link is still the one
 * place a bad string becomes executable (`javascript:`), so re-validate at
 * render time: anything that isn't a parseable http(s) URL renders as plain
 * text instead of an anchor.
 */
function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The row's muted second line: attribution / note, then time cost. */
function materialMeta(m: Material): string[] {
  const parts: string[] = [];
  if (m.type === "reading" && m.author) parts.push(m.author);
  if (m.type === "link" && m.description) parts.push(m.description);
  if (m.estimatedMinutes) parts.push(`${m.estimatedMinutes} min`);
  return parts;
}

export default function WeekCurriculum({ week, renderMaterialAction }: Props) {
  const hasGuide = week.guideBlocks.length > 0;
  const hasMaterials = week.materials.length > 0;
  const hasExercises = week.exercises.length > 0;
  const hasChecklist = week.checklist.length > 0;

  if (!hasGuide && !hasMaterials && !hasExercises && !hasChecklist) {
    return (
      <p className={styles.empty}>
        This week&apos;s content is still being written. Check back soon.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      {hasGuide && (
        <section className={styles.guide} aria-label="Week guide">
          <BlockView blocks={week.guideBlocks} />
        </section>
      )}

      {hasMaterials && (
        <section className={styles.section} aria-labelledby={`${week.id}-materials`}>
          <h2 className={styles.sectionTitle} id={`${week.id}-materials`}>
            Materials
          </h2>
          <ul className={styles.materials}>
            {week.materials.map((m) => (
              <MaterialRow
                key={m.id}
                material={m}
                action={renderMaterialAction?.(m)}
              />
            ))}
          </ul>
        </section>
      )}

      {hasExercises && (
        <section className={styles.section} aria-labelledby={`${week.id}-exercises`}>
          <h2 className={styles.sectionTitle} id={`${week.id}-exercises`}>
            Exercises
          </h2>
          <ol className={styles.exercises}>
            {week.exercises.map((x, i) => (
              <li key={x.id} className={styles.exercise}>
                <div className={styles.exerciseHead}>
                  <span className={styles.exerciseNumber} aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className={styles.exerciseKind}>
                    {x.responseType === "link" ? "Link answer" : "Written answer"}
                    {x.required ? " · Required" : ""}
                  </span>
                </div>
                {/* Text node, never markup — see the module comment. */}
                <p className={styles.exercisePrompt}>{x.prompt}</p>
                {x.helpText && <p className={styles.exerciseHelp}>{x.helpText}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {hasChecklist && (
        <section className={styles.section} aria-labelledby={`${week.id}-checklist`}>
          <h2 className={styles.sectionTitle} id={`${week.id}-checklist`}>
            Checklist
          </h2>
          <ul className={styles.checklist}>
            {week.checklist.map((c) => (
              <li key={c.id} className={styles.checkItem}>
                <span className={styles.checkBox} aria-hidden="true" />
                <div className={styles.checkText}>
                  <p className={styles.checkTitle}>{c.title}</p>
                  {c.detail && <p className={styles.checkDetail}>{c.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MaterialRow({
  material,
  action,
}: {
  material: Material;
  action: ReactNode | undefined;
}) {
  const href = "url" in material ? safeHttpUrl(material.url) : null;
  const meta = materialMeta(material);
  // Video materials are guaranteed YouTube-parseable by `isValidMaterial`,
  // but re-derive rather than assume — normalised data can be older than the
  // validator that now guards it.
  const videoId = material.type === "video" ? youtubeIdFromUrl(material.url) : null;
  const title = material.title || "Untitled";

  return (
    <li className={styles.materialItem}>
      <div className={styles.materialRow}>
        {action !== undefined && <div className={styles.materialAction}>{action}</div>}
        <span className={styles.kindChip} data-kind={material.type}>
          {KIND_LABEL[material.type]}
        </span>
        <div className={styles.materialMain}>
          {href ? (
            <a
              className={styles.materialTitle}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span>{title}</span>
              <span className={styles.extIcon} aria-hidden="true">
                ↗
              </span>
            </a>
          ) : (
            <span className={styles.materialTitlePlain}>{title}</span>
          )}
          {meta.length > 0 && <p className={styles.materialMeta}>{meta.join(" · ")}</p>}
        </div>
        <span className={material.optional ? styles.markerOptional : styles.markerCore}>
          {material.optional ? "Optional" : "Core"}
        </span>
      </div>

      {material.type === "note" && material.body && (
        <p className={styles.noteBody}>{material.body}</p>
      )}

      {videoId && (
        <div className={styles.videoWrap}>
          <iframe
            className={styles.videoFrame}
            src={`https://www.youtube-nocookie.com/embed/${videoId}`}
            title={title}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
    </li>
  );
}
