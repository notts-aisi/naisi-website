"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { doc, getDoc } from "firebase/firestore";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import Switch from "@/components/ui/Switch";
import { getClientDb } from "@/lib/firebase/client";
import { AdminLoadingBar } from "@/features/admin/adminList";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import {
  COURSE_FIELD_LIMITS,
  emptyChecklistItem,
  normalizeCourseRun,
  normalizeCourseWeek,
  type ChecklistItem,
  type CourseRunDoc,
  type CourseWeekDoc,
  type WeekPlanEntry,
} from "@/lib/firestore/courses";
import { ensureWeekDoc, saveWeek } from "./courseMutations";
import ExerciseBuilder from "./ExerciseBuilder";
import MaterialListEditor from "./MaterialListEditor";
import styles from "./WeekEditor.module.css";

/**
 * The curriculum builder for one week of one run.
 *
 * Saves are per section, not one giant form — the same shape as `RunEditor`.
 * The sections are independent bodies of work (prose, materials, exercises,
 * checklist), they fail independently, and an author part-way through writing
 * an exercise shouldn't have a half-typed material URL validated at them. Each
 * section reports through the one `ActionToast` this page owns.
 *
 * The week's NUMBER is not authored here. It comes from the run's `weekPlan` —
 * the Nth `kind:"week"` slot is week N — because inserting a break has to
 * renumber the calendar without renumbering (or re-keying) the curriculum. The
 * doc id (`w03`) is the stable identity that progress, exercise responses and
 * attendance are keyed on; `weekNumber` is a derived label, re-synced onto the
 * doc on every header save so a plan reorder can't leave it stale.
 */

type Props = { courseId: string; runId: string; weekId: string };

type WeekLoad = {
  run: CourseRunDoc;
  week: CourseWeekDoc;
  /** From the run's plan where the slot still exists, else the doc's own. */
  weekNumber: number;
  /** True when the run's week plan no longer references this week id. */
  orphaned: boolean;
};

type WeekSlot = Extract<WeekPlanEntry, { kind: "week" }>;

/**
 * One-shot read of the run + week pair, with a create-if-absent step between
 * them: opening the editor is what brings the week doc into existence, so
 * adding a slot in the week plan and clicking into it never lands on an empty
 * "not found". Local to the editor rather than in `useAdminCourses` for the
 * same reason `useCourseRun` is — these are single documents, not lists.
 *
 * `loading` is only ever true for the FIRST fetch; `reload()` refetches in
 * place so section drafts settle onto saved values without the editor
 * unmounting.
 */
function useWeekEditorData(runId: string, weekId: string) {
  const [data, setData] = useState<WeekLoad | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState<"run" | "week" | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const db = getClientDb();
      const runSnap = await getDoc(doc(db, "courseRuns", runId));
      if (cancelled) return;
      if (!runSnap.exists()) {
        setMissing("run");
        setData(null);
        return;
      }
      const run = normalizeCourseRun(runSnap.id, runSnap.data());
      const slot = run.weekPlan.find(
        (entry): entry is WeekSlot => entry.kind === "week" && entry.weekId === weekId,
      );

      // Only create when the plan actually claims this slot — a stale link to a
      // removed week must not resurrect it (and must not invent a weekNumber).
      if (slot) await ensureWeekDoc(runId, weekId, slot.weekNumber);
      if (cancelled) return;

      const weekSnap = await getDoc(doc(db, "courseRuns", runId, "weeks", weekId));
      if (cancelled) return;
      if (!weekSnap.exists()) {
        setMissing("week");
        setData(null);
        return;
      }

      setMissing(null);
      setError(null);
      const week = normalizeCourseWeek(weekSnap.id, weekSnap.data());
      setData({
        run,
        week,
        weekNumber: slot ? slot.weekNumber : week.weekNumber,
        orphaned: !slot,
      });
    }

    load()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `nonce` is the refetch trigger — a dependency by design even though the
    // body never reads it. Same shape as `useOneShotList`'s queryKey.
  }, [runId, weekId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, missing, error, reload };
}

/** Flat draft row for the checklist — `detail` is "" rather than absent so the
 *  input always has a string to bind to; the stored item omits it when empty. */
type ChecklistRow = {
  id: string;
  title: string;
  detail: string;
  mirrorToMyWork: boolean;
};

function toChecklistRows(items: ChecklistItem[]): ChecklistRow[] {
  return items.map((c) => ({
    id: c.id,
    title: c.title,
    detail: c.detail ?? "",
    mirrorToMyWork: c.mirrorToMyWork,
  }));
}

function buildChecklistItem(row: ChecklistRow): ChecklistItem {
  const detail = row.detail.trim().slice(0, COURSE_FIELD_LIMITS.checklistDetail);
  return {
    id: row.id,
    title: row.title.trim().slice(0, COURSE_FIELD_LIMITS.checklistTitle),
    ...(detail ? { detail } : {}),
    mirrorToMyWork: row.mirrorToMyWork,
  };
}

export default function WeekEditor({ courseId, runId, weekId }: Props) {
  const { toast, run: runAction, dismiss } = useActionToast();
  const { data, loading, missing, error, reload } = useWeekEditorData(runId, weekId);

  // ---- Header ----
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [minutes, setMinutes] = useState("");
  const [published, setPublished] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // ---- Guide ----
  const [guide, setGuide] = useState<Block[]>([]);
  const [guideError, setGuideError] = useState<string | null>(null);

  // ---- Checklist ----
  const [checklist, setChecklist] = useState<ChecklistRow[]>([]);
  const [checklistError, setChecklistError] = useState<string | null>(null);

  // Reseed every section draft whenever the week doc is (re)read. Adjusted
  // during render rather than in an effect, per the React docs and RunEditor's
  // precedent — an effect would render the stale values for a frame first.
  const week = data?.week ?? null;
  const [syncedWeek, setSyncedWeek] = useState<CourseWeekDoc | null>(null);
  if (week !== syncedWeek) {
    setSyncedWeek(week);
    if (week) {
      setTitle(week.title);
      setSummary(week.summary);
      setMinutes(week.estimatedMinutes == null ? "" : String(week.estimatedMinutes));
      setPublished(week.published);
      setHeaderError(null);
      setGuide(week.guideBlocks);
      setGuideError(null);
      setChecklist(toChecklistRows(week.checklist));
      setChecklistError(null);
    }
  }

  const runHref = `/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}`;

  if (loading) return <AdminLoadingBar label="Loading week…" />;

  if (missing) {
    return (
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>
          {missing === "run" ? "Run not found" : "Week not found"}
        </h3>
        <p className={styles.hint}>
          {missing === "run" ? (
            <>
              No run with the id <code>{runId}</code> exists.
            </>
          ) : (
            <>
              <code>{weekId}</code> isn&apos;t in this run&apos;s week plan and has
              no saved content. Add the slot in the run&apos;s week plan first —
              opening it from there creates the week.
            </>
          )}{" "}
          <Link href={runHref}>Back to the run</Link>.
        </p>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Couldn&apos;t load this week</h3>
        <p className={styles.error}>{error?.message ?? "Unknown error."}</p>
        <div className={styles.actions}>
          <Button type="button" onClick={reload}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  // Captured before the handlers below: they are hoisted function declarations,
  // so TypeScript can't carry the "data is loaded" narrowing into them.
  const { run, weekNumber, orphaned } = data;
  const saved = data.week;
  const savedMinutes = saved.estimatedMinutes == null ? "" : String(saved.estimatedMinutes);
  const headerDirty =
    title !== saved.title ||
    summary !== saved.summary ||
    minutes !== savedMinutes ||
    published !== saved.published;
  const guideDirty = JSON.stringify(guide) !== JSON.stringify(saved.guideBlocks);
  const checklistDirty =
    JSON.stringify(checklist) !== JSON.stringify(toChecklistRows(saved.checklist));
  const checklistFull = checklist.length >= COURSE_FIELD_LIMITS.maxChecklistItems;

  async function saveHeader() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setHeaderError("Give the week a title — it's the line the cohort navigates by.");
      return;
    }
    let estimatedMinutes: number | null = null;
    const trimmedMinutes = minutes.trim();
    if (trimmedMinutes) {
      const parsed = Number(trimmedMinutes);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setHeaderError("Estimated minutes must be a positive number, or blank.");
        return;
      }
      estimatedMinutes = Math.round(parsed);
    }
    setHeaderError(null);

    let ok = false;
    await runAction(
      async () => {
        await saveWeek(runId, weekId, {
          // `weekNumber` rides along on every header save so a week plan that
          // has since been reordered heals the stored label rather than
          // drifting from it. It is derived, never typed.
          weekNumber,
          title: trimmedTitle,
          summary: summary.trim().slice(0, COURSE_FIELD_LIMITS.weekSummary),
          estimatedMinutes,
          published,
        });
        ok = true;
      },
      { savingMessage: "Saving week…", successMessage: "Week saved" },
    );
    if (ok) reload();
  }

  async function saveGuide() {
    if (guide.length > COURSE_FIELD_LIMITS.maxGuideBlocks) {
      setGuideError(
        `The guide is capped at ${COURSE_FIELD_LIMITS.maxGuideBlocks} blocks — remove ${guide.length - COURSE_FIELD_LIMITS.maxGuideBlocks}.`,
      );
      return;
    }
    setGuideError(null);

    let ok = false;
    await runAction(
      async () => {
        await saveWeek(runId, weekId, { guideBlocks: guide });
        ok = true;
      },
      { savingMessage: "Saving guide…", successMessage: "Guide saved" },
    );
    if (ok) reload();
  }

  async function saveChecklist() {
    const blank = checklist.findIndex((row) => !row.title.trim());
    if (blank !== -1) {
      setChecklistError(`Item ${blank + 1} needs a title, or remove it.`);
      return;
    }
    setChecklistError(null);

    const built = checklist.map(buildChecklistItem);
    let ok = false;
    await runAction(
      async () => {
        await saveWeek(runId, weekId, { checklist: built });
        ok = true;
      },
      { savingMessage: "Saving checklist…", successMessage: "Checklist saved" },
    );
    if (ok) reload();
  }

  function patchChecklist(index: number, fields: Partial<ChecklistRow>) {
    setChecklist((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function moveChecklist(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= checklist.length) return;
    setChecklist((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div className={styles.editor}>
      <div className={styles.breadcrumb}>
        <Link href={runHref} className={styles.backLink}>
          ← {run.label || run.courseTitle || "Run"}
        </Link>
      </div>

      <div className={styles.statusBar}>
        <div className={styles.statusMeta}>
          <span className={styles.eyebrow}>Week {weekNumber}</span>
          <h2 className={styles.weekTitle}>{saved.title || "Untitled week"}</h2>
          <Badge tone={saved.published ? "success" : "neutral"}>
            {saved.published ? "Published" : "Unpublished"}
          </Badge>
          <Badge tone="neutral">{weekId}</Badge>
        </div>
        <span className={styles.muted}>
          {saved.materials.length} material{saved.materials.length === 1 ? "" : "s"} ·{" "}
          {saved.exercises.length} exercise{saved.exercises.length === 1 ? "" : "s"} ·{" "}
          {saved.checklist.length} checklist item
          {saved.checklist.length === 1 ? "" : "s"}
        </span>
      </div>

      {run.courseId !== courseId && (
        <p className={styles.warn}>
          This run belongs to course <code>{run.courseId}</code>, not{" "}
          <code>{courseId}</code>. Check the link you followed.
        </p>
      )}

      {orphaned && (
        <p className={styles.warn}>
          <code>{weekId}</code> is no longer a slot in this run&apos;s week plan, so
          nobody can reach it. Its content is safe and still editable — add the
          slot back in the run&apos;s week plan to put it in front of the cohort.
        </p>
      )}

      {/* ---- Week details ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Week details</h3>
        <div className={styles.fields}>
          <Field
            id="week-title"
            label="Title"
            hint="What this week is about, e.g. “Goal misgeneralisation”."
          >
            <Input
              id="week-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={COURSE_FIELD_LIMITS.weekTitle}
              placeholder="Week title"
            />
          </Field>

          <Field
            id="week-summary"
            label="Summary"
            hint="Plain text — it doubles as the description of the mirrored My Work task."
          >
            <CountedTextarea
              id="week-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              max={COURSE_FIELD_LIMITS.weekSummary}
              rows={3}
              placeholder="A couple of lines on what the cohort covers and why."
            />
          </Field>

          <div className={styles.twoCol}>
            <Field
              id="week-minutes"
              label="Estimated minutes"
              hint="Rough total for the week's materials. Blank if it varies."
            >
              <Input
                id="week-minutes"
                type="number"
                min={1}
                step={5}
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="e.g. 120"
              />
            </Field>

            <div className={styles.switchCell}>
              <Switch
                checked={published}
                onChange={setPublished}
                label="Published"
                description="Unpublished weeks are hidden from the public page and from members."
                size="lg"
              />
            </div>
          </div>
        </div>

        {headerError && <p className={styles.error}>{headerError}</p>}

        <div className={styles.actions}>
          <Button type="button" onClick={saveHeader} disabled={!headerDirty}>
            Save week details
          </Button>
        </div>
      </Card>

      {/* ---- Guide ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Guide</h3>
        <p className={styles.hint}>
          The week&apos;s prose — what to look for, how the materials connect,
          what the session will dig into. Shown above the material list on both
          the public curriculum and the member week page.
        </p>
        {/*
          Same wiring as the email-designs and course editors: BlockEditor owns a
          Block[] field and hands the whole array back on change. `draftId` is
          the run+week pair so uploads land under a folder that belongs to this
          week alone; like the course editor it needs a matching storage.rules
          block for `course-images/{folder}/**` — image uploads fail closed
          without one.
        */}
        <BlockEditor
          draftId={`${runId}__${weekId}`}
          storagePrefix="course-images"
          blocks={guide}
          onChange={setGuide}
        />

        {guideError && <p className={styles.error}>{guideError}</p>}

        <div className={styles.actions}>
          <Button type="button" onClick={saveGuide} disabled={!guideDirty}>
            Save guide
          </Button>
          <span className={styles.muted}>
            {guide.length}/{COURSE_FIELD_LIMITS.maxGuideBlocks} blocks
          </span>
        </div>
      </Card>

      {/* ---- Materials ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Materials</h3>
        <MaterialListEditor
          runId={runId}
          weekId={weekId}
          materials={saved.materials}
          runAction={runAction}
          onSaved={reload}
        />
      </Card>

      {/* ---- Exercises ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Exercises</h3>
        <ExerciseBuilder
          runId={runId}
          weekId={weekId}
          exercises={saved.exercises}
          runAction={runAction}
          onSaved={reload}
        />
      </Card>

      {/* ---- Checklist ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Checklist</h3>
        <p className={styles.hint}>
          The week&apos;s to-do list, ticked off in the learning space. Items
          marked “Also appears in My Work” are projected as subtasks on the
          member&apos;s mirrored task — a one-way projection, so ticking them
          here is the source of truth.
        </p>

        {checklist.length === 0 && (
          <p className={styles.empty}>
            No checklist items yet. Add the concrete steps — read the paper, post
            in the channel, come to the session.
          </p>
        )}

        <ol className={styles.checklistRows}>
          {checklist.map((row, i) => (
            <li key={row.id} className={styles.checklistRow}>
              <span className={styles.rowIndex} aria-hidden>
                {i + 1}
              </span>

              <div className={styles.checklistFields}>
                <Input
                  value={row.title}
                  onChange={(e) => patchChecklist(i, { title: e.target.value })}
                  maxLength={COURSE_FIELD_LIMITS.checklistTitle}
                  placeholder="What to do"
                  aria-label={`Checklist item ${i + 1} title`}
                />
                <Input
                  value={row.detail}
                  onChange={(e) => patchChecklist(i, { detail: e.target.value })}
                  maxLength={COURSE_FIELD_LIMITS.checklistDetail}
                  placeholder="Optional detail"
                  aria-label={`Checklist item ${i + 1} detail`}
                />
                <Switch
                  checked={row.mirrorToMyWork}
                  onChange={(mirrorToMyWork) => patchChecklist(i, { mirrorToMyWork })}
                  label="Also appears in My Work"
                />
              </div>

              <div className={styles.controls}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => moveChecklist(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move checklist item ${i + 1} earlier`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => moveChecklist(i, 1)}
                  disabled={i === checklist.length - 1}
                  aria-label={`Move checklist item ${i + 1} later`}
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() =>
                    setChecklist((current) => current.filter((_, at) => at !== i))
                  }
                  aria-label={`Remove checklist item ${i + 1}`}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>

        {checklistError && <p className={styles.error}>{checklistError}</p>}

        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setChecklist((current) =>
                current.length >= COURSE_FIELD_LIMITS.maxChecklistItems
                  ? current
                  : [...current, { ...emptyChecklistItem(), detail: "" }],
              )
            }
            disabled={checklistFull}
          >
            Add item
          </Button>
          <span className={styles.spacer} />
          <span className={styles.muted}>
            {checklist.length}/{COURSE_FIELD_LIMITS.maxChecklistItems} items
            {checklistFull ? " — that's the cap" : ""}
          </span>
          <Button type="button" onClick={saveChecklist} disabled={!checklistDirty}>
            Save checklist
          </Button>
        </div>
      </Card>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
