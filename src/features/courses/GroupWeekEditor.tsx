"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Skeleton from "@/components/ui/Skeleton";
import Switch from "@/components/ui/Switch";
import { youtubeIdFromUrl } from "@/lib/firestore/newsletterBlocks";
import type { WeekPlanEntry } from "@/lib/courses/weekPlan";
import type { GroupSessionMode } from "@/lib/firestore/courseGroups";
import {
  COURSE_FIELD_LIMITS,
  EXERCISE_MAX_LENGTH_DEFAULT,
  emptyChecklistItem,
  emptyExercise,
  newMaterialId,
  validateSubmissionUrl,
  type ChecklistItem,
  type CourseWeekDoc,
  type Exercise,
  type ExerciseResponseType,
  type Material,
  type MaterialType,
} from "@/lib/firestore/courses";
import { EXERCISE_LIMITS } from "@/lib/firestore/courseExercises";
import {
  forkGroupWeek,
  patchGroupWeek,
  setGroupWeekMode,
  useGroupWeek,
  useGroupWeeks,
  type GroupWeekPatch,
  type OrphanCount,
} from "./useGroupWeeks";
import styles from "./GroupWeekEditor.module.css";

/**
 * The facilitator's editing surface for their group's curriculum — the index
 * of weeks and the editor for one of them.
 *
 * ── WHAT THIS SURFACE IS FOR ────────────────────────────────────────────────
 * A group tracks the course's weeks until its facilitator changes one. That
 * moment is a FORK, and it is the only irreversible thing here, so it is the
 * thing the whole design is organised around:
 *
 *  - The index states each week's position in plain words — "Tracking the
 *    course curriculum" or "Customised by your group" with the date it forked.
 *    A facilitator should be able to answer "which of my weeks still follow the
 *    course?" without opening any of them.
 *  - Forking is an explicit button behind a confirm that says what is lost:
 *    course-wide updates to THAT week stop arriving, for this group, forever.
 *    Nothing auto-forks on save — a facilitator who opens a week to read it
 *    must leave with the group still tracking the course.
 *  - Before a week is forked, the editor shows the canonical content READ ONLY.
 *    Disabled form controls would invite the fork by accident; a preview says
 *    "this is what the course gives you" and puts the decision on the button.
 *
 * ── THE TRUST BOUNDARY IS THE SERVER'S, RESTATED HERE ───────────────────────
 * Facilitators may edit text-safe content: materials, exercises, the checklist,
 * the summary, the week's estimated minutes, and whether the week is published
 * to their group. They may NOT edit the week's TITLE (it is how the cohort and
 * every email refer to the week) and they may not touch `guideBlocks` — the
 * rich prose is the one `dangerouslySetInnerHTML` surface in the courses
 * feature and it stays with the course. The route enforces both; this file
 * simply never renders the fields, and says why rather than leaving a gap.
 *
 * ── DELETING SOMEBODY ELSE'S WORK ───────────────────────────────────────────
 * Removing a material, exercise or checklist item that members have already
 * engaged with is allowed, and it is not allowed quietly. The route refuses the
 * first attempt and answers with LIVE counts per removed item; the panel below
 * shows those numbers against the item's own title and requires an explicit
 * tick before it will send the same patch again with `acknowledgeOrphans`. The
 * numbers are the server's, never this component's estimate — an interface that
 * guessed how much work was about to be stranded would be worse than one that
 * said nothing.
 */

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Both ends parsed at T00:00:00Z and formatted in UTC — a civil-date label
 *  can never slide a day across a clock change. */
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const FORK_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/London",
});

function formatDateKey(key: string): string {
  return key ? DAY_MONTH.format(new Date(`${key}T00:00:00Z`)) : "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 materials · 2 exercises · 4 checklist items" — the same line everywhere. */
function contentLine(week: CourseWeekDoc): string {
  return [
    plural(week.materials.length, "material", "materials"),
    plural(week.exercises.length, "exercise", "exercises"),
    plural(week.checklist.length, "checklist item", "checklist items"),
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// The fork confirm — one dialog, both entry points
// ---------------------------------------------------------------------------

function ForkConfirm({
  open,
  weekLabel,
  groupName,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  weekLabel: string;
  groupName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={`Take your own copy of ${weekLabel}`}
      width="sm"
    >
      <div className={styles.confirm}>
        <h2 className={styles.confirmTitle}>Take your own copy of {weekLabel}?</h2>
        <p className={styles.confirmBody}>
          From this point {groupName} stops receiving course-wide updates to{" "}
          {weekLabel}. A reading the course swaps, a link it fixes, an exercise it
          adds — every other group gets it and yours does not.
        </p>
        <p className={styles.confirmBody}>
          Only this week forks. Your other weeks keep following the course until
          you customise them too, one at a time.
        </p>
        <p className={styles.confirmBody}>
          There is no undo on this page. Putting your group back onto the
          course&apos;s version of {weekLabel} is something an admin has to do by
          hand.
        </p>
        <div className={styles.confirmActions}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            Take a copy and edit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// GroupWeekIndex — every week, and whether it still follows the course
// ---------------------------------------------------------------------------

type IndexProps = {
  runId: string;
  groupId: string;
  groupName: string;
  /**
   * The calendar this group actually teaches to — resolved by the page shell
   * through `resolveCalendar`, so it is the group's own plan when it has one
   * and the run's otherwise. This component never picks between them.
   */
  weekPlan: WeekPlanEntry[];
  startDate: string;
  calendarSource: "run" | "group";
  /** The plan slot the group is in right now, or null (undated / outside). */
  nowIndex: number | null;
};

export function GroupWeekIndex({
  runId,
  groupId,
  groupName,
  weekPlan,
  startDate,
  calendarSource,
  nowIndex,
}: IndexProps) {
  const { toast, run: runAction, dismiss } = useActionToast();
  const { rows, forkedCount, loading, error, reload } = useGroupWeeks(
    runId,
    groupId,
    weekPlan,
    startDate,
  );
  const [forking, setForking] = useState<{ weekId: string; label: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const editBase = `/learn/${encodeURIComponent(runId)}/group/${encodeURIComponent(groupId)}/edit`;
  const taughtWeeks = rows.filter((row) => row.kind === "week").length;

  async function fork(weekId: string, label: string) {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        const result = await forkGroupWeek(groupId, weekId);
        ok = true;
        if (result.alreadyForked) {
          // Someone else got there first (or a double click did). Not an error:
          // the week IS forked, which is what the button asked for.
          return;
        }
      },
      {
        savingMessage: "Taking your own copy…",
        successMessage: `${label} is now yours to edit`,
      },
    );
    setBusy(false);
    setForking(null);
    if (ok) reload();
  }

  return (
    <>
      <Card as="section" padding="lg">
        <h2 className={styles.sectionTitle}>Your group&apos;s weeks</h2>
        <p className={styles.hint}>
          Every week here follows the course until you customise it. Customising
          takes your own copy of that week — after that, changes the course team
          make to it reach every other group and not yours. The weeks you leave
          alone keep updating.
          {calendarSource === "group" ? (
            <>
              {" "}
              The dates come from {groupName}&apos;s own schedule, set below.
            </>
          ) : (
            <> The dates come from the course&apos;s schedule.</>
          )}
        </p>

        {loading && rows.length === 0 && (
          <Skeleton width="100%" height="10rem" ariaLabel="Loading your group's weeks…" />
        )}

        {error && (
          <>
            <p className={styles.error}>
              Couldn&apos;t read your group&apos;s weeks: {error.message}
            </p>
            <div className={styles.actions}>
              <Button type="button" variant="secondary" size="sm" onClick={reload}>
                Try again
              </Button>
            </div>
          </>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className={styles.empty}>
            This course has no weeks in its plan yet, so there is nothing to
            customise. It will appear here once the course team adds the weeks.
          </p>
        )}

        {rows.length > 0 && (
          <ol className={styles.indexList}>
            {rows.map((row) => {
              const isNow = nowIndex === row.planIndex;
              const dates =
                row.from && row.to
                  ? `${formatDateKey(row.from)} – ${formatDateKey(row.to)}`
                  : "—";

              if (row.kind === "break") {
                return (
                  <li
                    key={`break-${row.planIndex}`}
                    className={`${styles.indexRow} ${styles.indexRowBreak} ${isNow ? styles.indexNow : ""}`}
                  >
                    <span className={styles.indexWeek}>Break</span>
                    <span className={styles.indexTitle}>
                      {row.label || "Unnamed break"}
                      <span className={styles.indexState}>
                        No week content — the group pauses.
                      </span>
                    </span>
                    <span className={styles.indexDates}>{dates}</span>
                    <span className={styles.indexActions} />
                  </li>
                );
              }

              const title = row.effective?.title || "Untitled week";
              const forkedOn = row.fork?.forkedAt
                ? FORK_DATE.format(row.fork.forkedAt)
                : null;
              const weekLabel = `Week ${row.weekNumber}`;

              return (
                <li
                  key={row.weekId}
                  className={`${styles.indexRow} ${row.forked ? styles.indexRowForked : ""} ${isNow ? styles.indexNow : ""}`}
                >
                  <span className={styles.indexWeek}>
                    {weekLabel}
                    {isNow && (
                      <>
                        {" "}
                        <Badge tone="accent">Now</Badge>
                      </>
                    )}
                  </span>

                  <span className={styles.indexTitle}>
                    {title}
                    <span className={styles.indexState}>
                      {row.forked ? (
                        <>
                          Customised by your group
                          {forkedOn ? ` — your copy since ${forkedOn}` : ""}.{" "}
                          {row.effective ? contentLine(row.effective) : ""}
                        </>
                      ) : row.canonical ? (
                        <>
                          Tracking the course curriculum.{" "}
                          {contentLine(row.canonical)}
                        </>
                      ) : (
                        <>The course hasn&apos;t written this week yet.</>
                      )}
                    </span>
                  </span>

                  <span className={styles.indexDates}>{dates}</span>

                  <span className={styles.indexActions}>
                    {!row.forked && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy || !row.canonical}
                        onClick={() =>
                          setForking({ weekId: row.weekId, label: weekLabel })
                        }
                      >
                        Customise
                      </Button>
                    )}
                    <Link
                      href={`${editBase}/${encodeURIComponent(row.weekId)}`}
                      className={styles.indexLink}
                    >
                      {row.forked ? "Edit" : "Open"}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {rows.length > 0 && (
          <p className={`${styles.hint} ${styles.spaced}`}>
            {forkedCount === 0
              ? `All ${taughtWeeks} weeks still follow the course.`
              : `${plural(forkedCount, "week is", "weeks are")} customised for ${groupName}; the other ${taughtWeeks - forkedCount} still follow the course.`}
          </p>
        )}
      </Card>

      <ForkConfirm
        open={forking !== null}
        weekLabel={forking?.label ?? "this week"}
        groupName={groupName}
        busy={busy}
        onClose={() => setForking(null)}
        onConfirm={() => {
          if (forking) void fork(forking.weekId, forking.label);
        }}
      />

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Row drafts (materials / exercises / checklist)
// ---------------------------------------------------------------------------

/**
 * Flat draft rows, exactly as the admin `MaterialListEditor` / `ExerciseBuilder`
 * use them: switching a material's kind keeps everything already typed, and
 * every bound value is a string or boolean so a cleared number field is `""`
 * and never `undefined` (Firestore refuses `undefined`, and the stored object
 * is assembled key-by-key at save time instead).
 *
 * Duplicated rather than imported because those two components save straight to
 * `courseRuns/{runId}/weeks/{weekId}` with the client SDK. A group's fork is
 * writable only through its route, so the save target — not the form — is what
 * differs, and there is no seam in them to pass one through.
 */
type MaterialRow = {
  id: string;
  type: MaterialType;
  title: string;
  url: string;
  author: string;
  description: string;
  body: string;
  minutes: string;
  /** Inverse of the stored `optional` flag: authors think in "required". */
  required: boolean;
};

const KIND_OPTIONS: { value: MaterialType; label: string }[] = [
  { value: "reading", label: "Reading" },
  { value: "video", label: "Video" },
  { value: "link", label: "Link" },
  { value: "note", label: "Note" },
];

const KIND_HINT: Record<MaterialType, string> = {
  reading: "A paper, post or chapter. Opens in a new tab.",
  video: "Embedded from YouTube — anything else belongs under Link.",
  link: "Any other resource: a tool, a dataset, a slide deck.",
  note: "A short aside from you, shown inline in the list. Plain text.",
};

function materialToRow(m: Material): MaterialRow {
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    url: "url" in m ? m.url : "",
    author: m.type === "reading" ? (m.author ?? "") : "",
    description: m.type === "link" ? (m.description ?? "") : "",
    body: m.type === "note" ? m.body : "",
    minutes: m.estimatedMinutes != null ? String(m.estimatedMinutes) : "",
    required: !m.optional,
  };
}

function emptyMaterialRow(): MaterialRow {
  return {
    id: newMaterialId(),
    type: "reading",
    title: "",
    url: "",
    author: "",
    description: "",
    body: "",
    minutes: "",
    required: true,
  };
}

function buildMaterial(row: MaterialRow): Material {
  const minutes = Number(row.minutes.trim());
  const hasMinutes =
    row.minutes.trim() !== "" && Number.isFinite(minutes) && minutes > 0;
  const base = {
    id: row.id,
    title: row.title.trim().slice(0, COURSE_FIELD_LIMITS.materialTitle),
    optional: !row.required,
    ...(hasMinutes ? { estimatedMinutes: Math.round(minutes) } : {}),
  };
  const url = row.url.trim().slice(0, COURSE_FIELD_LIMITS.materialUrl);

  switch (row.type) {
    case "video":
      return { ...base, type: "video", url };
    case "reading": {
      const author = row.author.trim().slice(0, COURSE_FIELD_LIMITS.materialAuthor);
      return { ...base, type: "reading", url, ...(author ? { author } : {}) };
    }
    case "link": {
      const description = row.description
        .trim()
        .slice(0, COURSE_FIELD_LIMITS.materialDescription);
      return { ...base, type: "link", url, ...(description ? { description } : {}) };
    }
    case "note":
      return {
        ...base,
        type: "note",
        body: row.body.trim().slice(0, COURSE_FIELD_LIMITS.materialNoteBody),
      };
  }
}

/** Returns an error message for the row, or null when it is safe to store. */
function validateMaterialRow(row: MaterialRow): string | null {
  if (!row.title.trim()) return "Give this material a title.";

  const minutes = row.minutes.trim();
  if (minutes) {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return "Minutes must be a positive number, or blank.";
    }
  }

  switch (row.type) {
    case "video":
      // `sanitizeMaterials` DROPS a video whose URL has no parseable YouTube
      // id, so an unvalidated save would look like it worked and lose the row
      // on the next read. Caught here, with the fix named.
      if (youtubeIdFromUrl(row.url) === null) {
        return "Video needs a YouTube link (or a bare 11-character video id). For anything else, switch this row to Link.";
      }
      if (row.url.trim().length > COURSE_FIELD_LIMITS.materialUrl) {
        return "That link is too long.";
      }
      return null;
    case "reading":
    case "link":
      // The same validator the submit route uses: http(s) only, no embedded
      // credentials. Links are the one thing a facilitator may put in front of
      // a cohort, so they go through the shared check, not a looser one.
      return validateSubmissionUrl(row.url, COURSE_FIELD_LIMITS.materialUrl);
    case "note":
      return row.body.trim() ? null : "A note needs some text, or remove the row.";
  }
}

type ExerciseRow = {
  id: string;
  prompt: string;
  helpText: string;
  responseType: ExerciseResponseType;
  required: boolean;
  maxLength: string;
  peerVisible: boolean;
};

const RESPONSE_OPTIONS = [
  { value: "text", label: "Written answer" },
  { value: "link", label: "Link" },
] as const satisfies readonly { value: ExerciseResponseType; label: string }[];

function exerciseToRow(x: Exercise): ExerciseRow {
  return {
    id: x.id,
    prompt: x.prompt,
    helpText: x.helpText ?? "",
    responseType: x.responseType,
    required: x.required,
    maxLength: String(x.maxLength),
    peerVisible: x.peerVisible,
  };
}

function buildExercise(row: ExerciseRow): Exercise {
  const helpText = row.helpText.trim().slice(0, COURSE_FIELD_LIMITS.exerciseHelpText);
  const parsed = Number(row.maxLength.trim());
  const maxLength =
    row.maxLength.trim() && Number.isFinite(parsed)
      ? Math.min(EXERCISE_LIMITS.responseText, Math.max(1, Math.round(parsed)))
      : EXERCISE_MAX_LENGTH_DEFAULT;

  return {
    id: row.id,
    prompt: row.prompt.trim().slice(0, COURSE_FIELD_LIMITS.exercisePrompt),
    ...(helpText ? { helpText } : {}),
    responseType: row.responseType,
    required: row.required,
    maxLength,
    peerVisible: row.peerVisible,
  };
}

function validateExerciseRow(row: ExerciseRow): string | null {
  if (!row.prompt.trim()) return "Write the prompt, or remove this exercise.";
  if (row.responseType === "text" && row.maxLength.trim()) {
    const parsed = Number(row.maxLength.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return "The answer limit must be a positive number, or blank for the default.";
    }
  }
  return null;
}

type ChecklistRow = {
  id: string;
  title: string;
  detail: string;
  mirrorToMyWork: boolean;
};

function checklistToRows(items: ChecklistItem[]): ChecklistRow[] {
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

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Saves a patch. Resolves true when the week actually changed. */
type SaveFn = (label: string, patch: GroupWeekPatch) => Promise<boolean>;

function MaterialsSection({
  materials,
  save,
  busy,
}: {
  materials: Material[];
  save: SaveFn;
  busy: boolean;
}) {
  const [rows, setRows] = useState<MaterialRow[]>(() => materials.map(materialToRow));
  const [synced, setSynced] = useState<Material[]>(materials);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Reseed when the saved list changes identity (a reload after a save),
  // adjusted during render rather than in an effect — an effect would render
  // the stale rows for a frame first and trips the repo's lint.
  if (materials !== synced) {
    setSynced(materials);
    setRows(materials.map(materialToRow));
    setRowErrors({});
    setFormError(null);
  }

  const baseline = useMemo(
    () => JSON.stringify(materials.map(materialToRow)),
    [materials],
  );
  const dirty = JSON.stringify(rows) !== baseline;
  const full = rows.length >= COURSE_FIELD_LIMITS.maxMaterials;

  function patchRow(index: number, fields: Partial<MaterialRow>) {
    setRows((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function onSave() {
    const errors: Record<string, string> = {};
    for (const row of rows) {
      const error = validateMaterialRow(row);
      if (error) errors[row.id] = error;
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      const count = Object.keys(errors).length;
      setFormError(
        `Fix the ${count} highlighted material${count === 1 ? "" : "s"} — a material that doesn't validate is dropped when the week is read back.`,
      );
      return;
    }
    setRowErrors({});
    setFormError(null);
    await save("materials", { materials: rows.map(buildMaterial) });
  }

  return (
    <Card padding="lg">
      <h3 className={styles.sectionTitle}>Materials</h3>
      <p className={styles.hint}>
        The order here is the order your group works through. Optional rows stay
        visible but don&apos;t count toward anyone&apos;s week progress.
      </p>

      {rows.length === 0 && (
        <p className={styles.empty}>
          No materials in your copy of this week. Add the readings, videos and
          links your group works from.
        </p>
      )}

      <ol className={styles.rows}>
        {rows.map((row, i) => {
          const error = rowErrors[row.id];
          return (
            <li key={row.id}>
              <Card padding="md" className={error ? styles.rowCardError : undefined}>
                <div className={styles.rowHeader}>
                  <span className={styles.rowTitle}>{i + 1}</span>
                  <div className={styles.kind}>
                    <ResponsiveSelect<MaterialType>
                      value={row.type}
                      onChange={(type) => patchRow(i, { type })}
                      options={KIND_OPTIONS}
                      ariaLabel={`Kind for material ${i + 1}`}
                      disabled={busy}
                    />
                  </div>
                  <span className={styles.kindHint}>{KIND_HINT[row.type]}</span>
                  <div className={styles.controls}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, -1)}
                      disabled={busy || i === 0}
                      aria-label={`Move material ${i + 1} earlier`}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, 1)}
                      disabled={busy || i === rows.length - 1}
                      aria-label={`Move material ${i + 1} later`}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() =>
                        setRows((current) => current.filter((_, at) => at !== i))
                      }
                      disabled={busy}
                      aria-label={`Remove material ${i + 1}`}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className={styles.fields}>
                  <div className={styles.span}>
                    <Field id={`gm-title-${row.id}`} label="Title">
                      <Input
                        id={`gm-title-${row.id}`}
                        value={row.title}
                        onChange={(e) => patchRow(i, { title: e.target.value })}
                        maxLength={COURSE_FIELD_LIMITS.materialTitle}
                        placeholder="What your group sees in the list"
                        disabled={busy}
                      />
                    </Field>
                  </div>

                  {row.type !== "note" && (
                    <div className={styles.span}>
                      <Field
                        id={`gm-url-${row.id}`}
                        label={row.type === "video" ? "YouTube link" : "Link"}
                        hint={
                          row.type === "video"
                            ? "A youtube.com or youtu.be URL, or the bare video id."
                            : "Opens in a new tab, with rel=noreferrer."
                        }
                      >
                        <Input
                          id={`gm-url-${row.id}`}
                          type="url"
                          inputMode="url"
                          value={row.url}
                          onChange={(e) => patchRow(i, { url: e.target.value })}
                          maxLength={COURSE_FIELD_LIMITS.materialUrl}
                          placeholder="https://"
                          disabled={busy}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "reading" && (
                    <div className={styles.span}>
                      <Field
                        id={`gm-author-${row.id}`}
                        label="Author or source"
                        hint="Optional attribution, e.g. “Ngo et al.”."
                      >
                        <Input
                          id={`gm-author-${row.id}`}
                          value={row.author}
                          onChange={(e) => patchRow(i, { author: e.target.value })}
                          maxLength={COURSE_FIELD_LIMITS.materialAuthor}
                          disabled={busy}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "link" && (
                    <div className={styles.span}>
                      <Field
                        id={`gm-desc-${row.id}`}
                        label="Why this link"
                        hint="Optional one-liner shown under the title."
                      >
                        <Input
                          id={`gm-desc-${row.id}`}
                          value={row.description}
                          onChange={(e) =>
                            patchRow(i, { description: e.target.value })
                          }
                          maxLength={COURSE_FIELD_LIMITS.materialDescription}
                          disabled={busy}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "note" && (
                    <div className={styles.span}>
                      <Field id={`gm-body-${row.id}`} label="Note">
                        <CountedTextarea
                          id={`gm-body-${row.id}`}
                          value={row.body}
                          onChange={(e) => patchRow(i, { body: e.target.value })}
                          max={COURSE_FIELD_LIMITS.materialNoteBody}
                          rows={3}
                          placeholder="A short aside — context, a warning, what to look for."
                          disabled={busy}
                        />
                      </Field>
                    </div>
                  )}

                  <Field
                    id={`gm-minutes-${row.id}`}
                    label="Minutes"
                    hint="Rough time cost. Blank if it varies."
                  >
                    <Input
                      id={`gm-minutes-${row.id}`}
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={row.minutes}
                      onChange={(e) => patchRow(i, { minutes: e.target.value })}
                      disabled={busy}
                    />
                  </Field>

                  <div className={styles.switchCell}>
                    <Switch
                      checked={row.required}
                      onChange={(required) => patchRow(i, { required })}
                      label="Required"
                      description="Off = optional extension, excluded from progress."
                      disabled={busy}
                    />
                  </div>
                </div>

                {error && <p className={styles.error}>{error}</p>}
              </Card>
            </li>
          );
        })}
      </ol>

      {formError && <p className={styles.error}>{formError}</p>}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            setRows((current) => (full ? current : [...current, emptyMaterialRow()]))
          }
          disabled={busy || full}
        >
          Add material
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rows.length}/{COURSE_FIELD_LIMITS.maxMaterials} materials
          {full ? " — that's the cap" : ""}
        </span>
        <Button type="button" onClick={onSave} disabled={busy || !dirty}>
          Save materials
        </Button>
      </div>
    </Card>
  );
}

function ExercisesSection({
  exercises,
  save,
  busy,
}: {
  exercises: Exercise[];
  save: SaveFn;
  busy: boolean;
}) {
  const [rows, setRows] = useState<ExerciseRow[]>(() => exercises.map(exerciseToRow));
  const [synced, setSynced] = useState<Exercise[]>(exercises);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (exercises !== synced) {
    setSynced(exercises);
    setRows(exercises.map(exerciseToRow));
    setRowErrors({});
    setFormError(null);
  }

  const baseline = useMemo(
    () => JSON.stringify(exercises.map(exerciseToRow)),
    [exercises],
  );
  const dirty = JSON.stringify(rows) !== baseline;
  const full = rows.length >= COURSE_FIELD_LIMITS.maxExercises;

  function patchRow(index: number, fields: Partial<ExerciseRow>) {
    setRows((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function onSave() {
    const errors: Record<string, string> = {};
    for (const row of rows) {
      const error = validateExerciseRow(row);
      if (error) errors[row.id] = error;
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      const count = Object.keys(errors).length;
      setFormError(`Fix the ${count} highlighted exercise${count === 1 ? "" : "s"}.`);
      return;
    }
    setRowErrors({});
    setFormError(null);
    await save("exercises", { exercises: rows.map(buildExercise) });
  }

  return (
    <Card padding="lg">
      <h3 className={styles.sectionTitle}>Exercises</h3>
      <p className={styles.hint}>
        Your group answers these before the session. Responses are plain text or
        a link — never uploads — and the response type is re-checked when someone
        submits, so changing it after people have answered can invalidate their
        work.
      </p>

      {rows.length === 0 && (
        <p className={styles.empty}>
          No exercises in your copy of this week. Add the prompts you want your
          group thinking about beforehand.
        </p>
      )}

      <ol className={styles.rows}>
        {rows.map((row, i) => {
          const error = rowErrors[row.id];
          return (
            <li key={row.id}>
              <Card padding="md" className={error ? styles.rowCardError : undefined}>
                <div className={styles.rowHeader}>
                  <span className={styles.rowTitle}>Exercise {i + 1}</span>
                  <span className={styles.kindHint} />
                  <div className={styles.controls}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, -1)}
                      disabled={busy || i === 0}
                      aria-label={`Move exercise ${i + 1} earlier`}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, 1)}
                      disabled={busy || i === rows.length - 1}
                      aria-label={`Move exercise ${i + 1} later`}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() =>
                        setRows((current) => current.filter((_, at) => at !== i))
                      }
                      disabled={busy}
                      aria-label={`Remove exercise ${i + 1}`}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className={styles.stack}>
                  <Field id={`gx-prompt-${row.id}`} label="Prompt">
                    <CountedTextarea
                      id={`gx-prompt-${row.id}`}
                      value={row.prompt}
                      onChange={(e) => patchRow(i, { prompt: e.target.value })}
                      max={COURSE_FIELD_LIMITS.exercisePrompt}
                      rows={3}
                      placeholder="The question your group answers."
                      disabled={busy}
                    />
                  </Field>

                  <Field
                    id={`gx-help-${row.id}`}
                    label="Help text"
                    hint="Optional. Shown under the prompt — what a good answer looks like."
                  >
                    <CountedTextarea
                      id={`gx-help-${row.id}`}
                      value={row.helpText}
                      onChange={(e) => patchRow(i, { helpText: e.target.value })}
                      max={COURSE_FIELD_LIMITS.exerciseHelpText}
                      rows={2}
                      disabled={busy}
                    />
                  </Field>

                  <div className={styles.twoCol}>
                    <Field
                      id={`gx-type-${row.id}`}
                      label="Response"
                      hint="Enforced at submit — a link answer can't be pasted into a written one."
                    >
                      <SegmentedControl<ExerciseResponseType>
                        value={row.responseType}
                        onChange={(responseType) => patchRow(i, { responseType })}
                        options={RESPONSE_OPTIONS}
                        ariaLabel={`Response type for exercise ${i + 1}`}
                        size="md"
                        disabled={busy}
                      />
                    </Field>

                    {row.responseType === "text" && (
                      <Field
                        id={`gx-max-${row.id}`}
                        label="Answer limit"
                        hint={`Characters, up to ${EXERCISE_LIMITS.responseText}. Blank uses ${EXERCISE_MAX_LENGTH_DEFAULT}.`}
                      >
                        <Input
                          id={`gx-max-${row.id}`}
                          type="number"
                          min={1}
                          max={EXERCISE_LIMITS.responseText}
                          step={100}
                          inputMode="numeric"
                          value={row.maxLength}
                          onChange={(e) => patchRow(i, { maxLength: e.target.value })}
                          disabled={busy}
                        />
                      </Field>
                    )}
                  </div>

                  <div className={styles.switches}>
                    <Switch
                      checked={row.required}
                      onChange={(required) => patchRow(i, { required })}
                      label="Required"
                      description="Members must answer this before the week counts as done."
                      disabled={busy}
                    />
                    <Switch
                      checked={row.peerVisible}
                      onChange={(peerVisible) => patchRow(i, { peerVisible })}
                      label="Share with the group"
                      description="Visible to the rest of your group before the session."
                      disabled={busy}
                    />
                  </div>
                </div>

                {error && <p className={styles.error}>{error}</p>}
              </Card>
            </li>
          );
        })}
      </ol>

      {formError && <p className={styles.error}>{formError}</p>}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            setRows((current) =>
              full ? current : [...current, exerciseToRow(emptyExercise())],
            )
          }
          disabled={busy || full}
        >
          Add exercise
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rows.length}/{COURSE_FIELD_LIMITS.maxExercises} exercises
          {full ? " — that's the cap" : ""}
        </span>
        <Button type="button" onClick={onSave} disabled={busy || !dirty}>
          Save exercises
        </Button>
      </div>
    </Card>
  );
}

function ChecklistSection({
  checklist,
  save,
  busy,
}: {
  checklist: ChecklistItem[];
  save: SaveFn;
  busy: boolean;
}) {
  const [rows, setRows] = useState<ChecklistRow[]>(() => checklistToRows(checklist));
  const [synced, setSynced] = useState<ChecklistItem[]>(checklist);
  const [error, setError] = useState<string | null>(null);

  if (checklist !== synced) {
    setSynced(checklist);
    setRows(checklistToRows(checklist));
    setError(null);
  }

  const baseline = useMemo(
    () => JSON.stringify(checklistToRows(checklist)),
    [checklist],
  );
  const dirty = JSON.stringify(rows) !== baseline;
  const full = rows.length >= COURSE_FIELD_LIMITS.maxChecklistItems;

  function patchRow(index: number, fields: Partial<ChecklistRow>) {
    setRows((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function onSave() {
    const blank = rows.findIndex((row) => !row.title.trim());
    if (blank !== -1) {
      setError(`Item ${blank + 1} needs a title, or remove it.`);
      return;
    }
    setError(null);
    await save("checklist", { checklist: rows.map(buildChecklistItem) });
  }

  return (
    <Card padding="lg">
      <h3 className={styles.sectionTitle}>Checklist</h3>
      <p className={styles.hint}>
        The week&apos;s to-do list, ticked off in the learning space. Items marked
        “Also appears in My Work” are projected as subtasks on each
        member&apos;s mirrored task.
      </p>

      {rows.length === 0 && (
        <p className={styles.empty}>
          No checklist items. Add the concrete steps — read the paper, post in the
          channel, come to the session.
        </p>
      )}

      <ol className={styles.checklistRows}>
        {rows.map((row, i) => (
          <li key={row.id} className={styles.checklistRow}>
            <span className={styles.rowIndex} aria-hidden>
              {i + 1}
            </span>

            <div className={styles.checklistFields}>
              <Input
                value={row.title}
                onChange={(e) => patchRow(i, { title: e.target.value })}
                maxLength={COURSE_FIELD_LIMITS.checklistTitle}
                placeholder="What to do"
                aria-label={`Checklist item ${i + 1} title`}
                disabled={busy}
              />
              <Input
                value={row.detail}
                onChange={(e) => patchRow(i, { detail: e.target.value })}
                maxLength={COURSE_FIELD_LIMITS.checklistDetail}
                placeholder="Optional detail"
                aria-label={`Checklist item ${i + 1} detail`}
                disabled={busy}
              />
              <Switch
                checked={row.mirrorToMyWork}
                onChange={(mirrorToMyWork) => patchRow(i, { mirrorToMyWork })}
                label="Also appears in My Work"
                disabled={busy}
              />
            </div>

            <div className={styles.controls}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => move(i, -1)}
                disabled={busy || i === 0}
                aria-label={`Move checklist item ${i + 1} earlier`}
                title="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => move(i, 1)}
                disabled={busy || i === rows.length - 1}
                aria-label={`Move checklist item ${i + 1} later`}
                title="Move down"
              >
                ▼
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                onClick={() => setRows((current) => current.filter((_, at) => at !== i))}
                disabled={busy}
                aria-label={`Remove checklist item ${i + 1}`}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            setRows((current) =>
              full ? current : [...current, { ...emptyChecklistItem(), detail: "" }],
            )
          }
          disabled={busy || full}
        >
          Add item
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rows.length}/{COURSE_FIELD_LIMITS.maxChecklistItems} items
          {full ? " — that's the cap" : ""}
        </span>
        <Button type="button" onClick={onSave} disabled={busy || !dirty}>
          Save checklist
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The read-only preview of a week that has not been forked
// ---------------------------------------------------------------------------

function WeekPreview({ week }: { week: CourseWeekDoc }) {
  const rows: { kind: string; title: string; meta?: string }[] = [
    ...week.materials.map((m) => ({
      kind: m.type,
      title: m.title || "Untitled",
      meta: [
        m.optional ? "Optional" : null,
        m.estimatedMinutes != null ? `${m.estimatedMinutes} min` : null,
        "url" in m && m.url ? m.url : null,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...week.exercises.map((x) => ({
      kind: "exercise",
      title: x.prompt || "Untitled prompt",
      meta: [
        x.responseType === "link" ? "Link answer" : "Written answer",
        x.required ? "Required" : "Optional",
        x.peerVisible ? "Shared with the group" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...week.checklist.map((c) => ({
      kind: "checklist",
      title: c.title || "Untitled item",
      meta: c.detail || undefined,
    })),
  ];

  return (
    <Card padding="lg">
      <h3 className={styles.sectionTitle}>What the course gives your group</h3>
      <p className={styles.hint}>
        Read-only until you take your own copy. This is live: if the course team
        change it tomorrow, your group sees the change.
      </p>

      {week.summary && <p className={styles.hint}>{week.summary}</p>}

      {rows.length === 0 ? (
        <p className={styles.empty}>
          This week has no materials, exercises or checklist items yet.
        </p>
      ) : (
        <ul className={styles.previewList}>
          {rows.map((row, i) => (
            <li key={`${row.kind}-${i}`} className={styles.previewRow}>
              <span className={styles.previewKind}>{row.kind}</span>
              <span className={styles.previewTitle}>
                {row.title}
                {row.meta && <span className={styles.previewMeta}>{row.meta}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// GroupWeekEditor — one week
// ---------------------------------------------------------------------------

type EditorProps = {
  runId: string;
  courseId: string;
  groupId: string;
  groupName: string;
  weekId: string;
  weekNumber: number;
  /** The group's civil dates for this slot, "" when the calendar is undated. */
  from: string;
  to: string;
  /**
   * The stored mode for this (group, week), or null when the facilitator has
   * never set one. Null is NOT "in person": it is "no week-level override", so
   * the group sees whatever its usual session carries. The distinction is what
   * makes the clear-back action meaningful.
   */
  mode: GroupSessionMode | null;
  /** The effective session, for the location/link swap explanation. */
  location: string;
  meetingUrl: string | null;
  viewerIsAdmin: boolean;
};

export default function GroupWeekEditor({
  runId,
  courseId,
  groupId,
  groupName,
  weekId,
  weekNumber,
  from,
  to,
  mode,
  location,
  meetingUrl,
  viewerIsAdmin,
}: EditorProps) {
  const router = useRouter();
  const { toast, run: runAction, dismiss } = useActionToast();
  const { canonical, fork, forked, loading, error, reload } = useGroupWeek(
    runId,
    groupId,
    weekId,
  );

  const [busy, setBusy] = useState(false);
  const [forking, setForking] = useState(false);
  /**
   * A patch the route refused because it would strand member work, held with
   * the counts it answered with. Cleared on any successful save.
   */
  const [pending, setPending] = useState<{
    label: string;
    patch: GroupWeekPatch;
    message: string;
    orphans: OrphanCount[];
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // ---- Header draft (summary / minutes / published) ----
  const week = fork?.week ?? null;
  const [synced, setSynced] = useState<CourseWeekDoc | null>(null);
  const [summary, setSummary] = useState("");
  const [minutes, setMinutes] = useState("");
  const [published, setPublished] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  if (week !== synced) {
    setSynced(week);
    setSummary(week?.summary ?? "");
    setMinutes(week?.estimatedMinutes == null ? "" : String(week.estimatedMinutes));
    setPublished(week?.published ?? false);
    setHeaderError(null);
  }

  // ---- Mode draft ----
  // The control is binary because the DECISION is binary; the stored value has
  // a third state (never set) which the draft collapses to "in person" for the
  // pills while `mode === null` keeps driving the copy and the clear action.
  const [modeDraft, setModeDraft] = useState<GroupSessionMode>(mode ?? "in-person");
  const [syncedMode, setSyncedMode] = useState<GroupSessionMode | null>(mode);
  if (mode !== syncedMode) {
    setSyncedMode(mode);
    setModeDraft(mode ?? "in-person");
  }

  const groupPath = `/learn/${encodeURIComponent(runId)}/group/${encodeURIComponent(groupId)}`;
  const indexHref = `${groupPath}/edit`;
  const weekLabel = `Week ${weekNumber}`;
  const dateLine =
    from && to ? `${formatDateKey(from)} – ${formatDateKey(to)}` : "No dates yet";

  /**
   * The one save path. Every section hands its built payload here, so the
   * orphan refusal is handled once — a facilitator who deletes a material and
   * an exercise in the same sitting gets the same panel, with the same numbers,
   * both times.
   */
  async function save(label: string, patch: GroupWeekPatch): Promise<boolean> {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        const result = await patchGroupWeek(groupId, weekId, patch);
        if (result.kind === "ok") {
          ok = true;
          setPending(null);
          setAcknowledged(false);
          return;
        }
        if (result.kind === "orphans") {
          setPending({ label, patch, message: result.message, orphans: result.orphans });
          setAcknowledged(false);
        }
        throw new Error(result.message);
      },
      {
        savingMessage: `Saving ${label}…`,
        successMessage: `Saved — ${groupName} sees the change now`,
      },
    );
    setBusy(false);
    if (ok) reload();
    return ok;
  }

  async function saveHeader() {
    let estimatedMinutes: number | null = null;
    const trimmed = minutes.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setHeaderError("Estimated minutes must be a positive number, or blank.");
        return;
      }
      estimatedMinutes = Math.round(parsed);
    }
    setHeaderError(null);
    await save("week details", {
      summary: summary.trim().slice(0, COURSE_FIELD_LIMITS.weekSummary),
      estimatedMinutes,
      published,
    });
  }

  async function saveMode() {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        await setGroupWeekMode(groupId, weekId, modeDraft);
        ok = true;
      },
      {
        savingMessage: "Saving how this week meets…",
        successMessage:
          modeDraft === "virtual"
            ? "This week now shows the meeting link"
            : "This week now shows the room",
      },
    );
    setBusy(false);
    // The mode lives on the GROUP doc, which `courseGroups` rules keep away
    // from a facilitator's client — the page shell read it server-side. A
    // server re-render is the only honest way to show what was actually
    // stored, so ask for one rather than assuming the write landed as sent.
    if (ok) router.refresh();
  }

  async function clearMode() {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        await setGroupWeekMode(groupId, weekId, null);
        ok = true;
      },
      {
        savingMessage: "Clearing this week's override…",
        successMessage: "Back to your group's usual arrangement",
      },
    );
    setBusy(false);
    if (ok) router.refresh();
  }

  async function doFork() {
    setBusy(true);
    let ok = false;
    await runAction(
      async () => {
        await forkGroupWeek(groupId, weekId);
        ok = true;
      },
      {
        savingMessage: "Taking your own copy…",
        successMessage: `${weekLabel} is now yours to edit`,
      },
    );
    setBusy(false);
    setForking(false);
    if (ok) reload();
  }

  /** Item titles for the orphan panel, read off the SAVED week. */
  const itemTitles = useMemo(() => {
    const map = new Map<string, string>();
    if (!week) return map;
    for (const m of week.materials) map.set(m.id, m.title || "Untitled material");
    for (const x of week.exercises) map.set(x.id, x.prompt || "Untitled prompt");
    for (const c of week.checklist) map.set(c.id, c.title || "Untitled checklist item");
    return map;
  }, [week]);

  // Header dirtiness, matching every other section: a Save that would write
  // exactly what is already stored is a route call for nothing, and a live
  // button that does nothing reads as a bug.
  const savedMinutes =
    week?.estimatedMinutes == null ? "" : String(week.estimatedMinutes);
  const headerDirty = week
    ? summary !== week.summary || minutes !== savedMinutes || published !== week.published
    : false;

  if (loading) {
    return <Skeleton width="100%" height="18rem" ariaLabel="Loading this week…" />;
  }

  if (error) {
    return (
      <Card padding="lg">
        <h2 className={styles.sectionTitle}>Couldn&apos;t load this week</h2>
        <p className={styles.error}>{error.message}</p>
        <div className={styles.actions}>
          <Button type="button" onClick={reload}>
            Try again
          </Button>
          <Link href={indexHref} className={styles.backLink}>
            Back to your group&apos;s weeks
          </Link>
        </div>
      </Card>
    );
  }

  const shown = week ?? canonical;

  return (
    <div className={styles.editor}>
      <div className={styles.breadcrumb}>
        <Link href={indexHref} className={styles.backLink}>
          ← {groupName || "Your group"}&apos;s weeks
        </Link>
      </div>

      <div className={styles.statusBar}>
        <div className={styles.statusMeta}>
          <span className={styles.eyebrow}>{weekLabel}</span>
          <h1 className={styles.weekTitle}>{shown?.title || "Untitled week"}</h1>
          <Badge tone={forked ? "accent" : "neutral"}>
            {forked ? "Customised by your group" : "Tracking the course"}
          </Badge>
          {forked && (
            <Badge tone={published ? "success" : "neutral"}>
              {published ? "Visible to your group" : "Hidden from your group"}
            </Badge>
          )}
        </div>
        <span className={styles.muted}>{dateLine}</span>
      </div>

      {/* ---- How this week meets — independent of the fork ---------------- */}
      <Card padding="lg">
        <h2 className={styles.sectionTitle}>How this week meets</h2>
        <p className={styles.hint}>
          One switch, one week. <strong>In person</strong> shows your group the
          room and hides the meeting link; <strong>online</strong> shows the link
          and hides the room. It changes what {groupName} sees on the week page
          and in the reminder emails — it does not move the day or the time, and
          it does not touch any other week.
        </p>

        <div className={styles.modeRow}>
          <SegmentedControl<GroupSessionMode>
            value={modeDraft}
            onChange={setModeDraft}
            options={[
              { value: "in-person", label: "In person" },
              { value: "virtual", label: "Online" },
            ]}
            ariaLabel={`How ${weekLabel} meets`}
            disabled={busy}
          />
          <Button
            type="button"
            onClick={saveMode}
            disabled={busy || modeDraft === mode}
          >
            Save
          </Button>
          {mode !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearMode}
              disabled={busy}
            >
              Use your group&apos;s usual arrangement
            </Button>
          )}
        </div>

        {mode === null && (
          <p className={styles.modeNow}>
            Nothing set for {weekLabel} yet, so your group sees its usual
            arrangement — whatever the session carries. Saving one of these makes
            the choice explicit for this week only.
          </p>
        )}

        {/* States what the pills currently SAY, and is careful about tense: an
            unsaved choice describes what would happen, not what does. */}
        <p className={styles.modeNow}>
          {modeDraft === "virtual" ? (
            meetingUrl ? (
              <>
                {modeDraft === mode
                  ? "Your group sees the meeting link "
                  : "If you save this, your group will see the meeting link "}
                <span className={styles.modeNowValue}>{meetingUrl}</span> and not
                the room.
              </>
            ) : (
              <>
                Your group has no meeting link saved, so an online week would show
                them nowhere to go. Add the link on your group&apos;s session
                before you switch, or send it in a room notice.
              </>
            )
          ) : location ? (
            <>
              {modeDraft === mode
                ? "Your group sees "
                : "If you save this, your group will see "}
              <span className={styles.modeNowValue}>{location}</span> and not the
              meeting link.
            </>
          ) : (
            <>
              Your group has no room saved, so an in-person week would show them
              no location. Set one on your group&apos;s session, or say where in a
              room notice.
            </>
          )}
        </p>
      </Card>

      {/* ---- Not forked: the door, then the preview ----------------------- */}
      {!forked && (
        <>
          <div className={styles.forkCard}>
            <h2 className={styles.forkTitle}>
              {weekLabel} follows the course curriculum
            </h2>
            <p className={styles.forkBody}>
              {groupName} reads exactly what the course publishes, and keeps
              getting its updates. To change anything — swap a reading, cut an
              exercise, add a step to the checklist — your group needs its own
              copy of this week.
            </p>
            <ul className={styles.forkList}>
              <li>Your group stops receiving course-wide updates to {weekLabel}.</li>
              <li>Your other weeks carry on following the course.</li>
              <li>
                Everyone&apos;s existing progress and answers carry over — the
                copy keeps the same item ids.
              </li>
              <li>There is no un-fork here; putting it back is an admin job.</li>
            </ul>
            <div className={styles.forkActions}>
              <Button
                type="button"
                onClick={() => setForking(true)}
                disabled={busy || !canonical}
              >
                Customise {weekLabel} for {groupName}
              </Button>
              {!canonical && (
                <span className={styles.muted}>
                  Nothing to copy yet — the course hasn&apos;t written this week.
                </span>
              )}
            </div>
          </div>

          {canonical && <WeekPreview week={canonical} />}
        </>
      )}

      {/* ---- Forked: the editor ------------------------------------------ */}
      {forked && week && (
        <>
          {pending && (
            <div className={styles.orphanPanel}>
              <h2 className={styles.orphanTitle}>
                This would strand work your group has already done
              </h2>
              <p className={styles.orphanBody}>{pending.message}</p>
              <ul className={styles.orphanTable}>
                {pending.orphans.map((o) => (
                  <li key={o.itemId} className={styles.orphanRow}>
                    <span className={styles.orphanName}>
                      {itemTitles.get(o.itemId) ?? o.itemId}
                    </span>
                    <span className={styles.orphanNums}>
                      {o.progress > 0 && (
                        <>{plural(o.progress, "person ticked", "people ticked")}</>
                      )}
                      {o.progress > 0 && o.responses > 0 && " · "}
                      {o.responses > 0 && (
                        <>{plural(o.responses, "answer", "answers")}</>
                      )}
                      {o.progress === 0 && o.responses === 0 && "no work yet"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.orphanBody}>
                These are live counts from right now, not an estimate. Removing the
                items does not delete anyone&apos;s work — it stops counting it.
                The answers stay in the review queue and in each member&apos;s own
                record; they simply no longer belong to a prompt your group is
                being asked.
              </p>
              <label className={styles.orphanActions}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  disabled={busy}
                />
                <span className={styles.orphanBody}>
                  I&apos;ve read the numbers above and still want to remove these.
                </span>
              </label>
              <div className={styles.orphanActions}>
                <Button
                  type="button"
                  variant="danger"
                  disabled={!acknowledged || busy}
                  onClick={() =>
                    void save(pending.label, {
                      ...pending.patch,
                      acknowledgeOrphans: true,
                    })
                  }
                >
                  Save {pending.label} anyway
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setPending(null);
                    setAcknowledged(false);
                  }}
                >
                  Leave them in
                </Button>
              </div>
            </div>
          )}

          <Card padding="lg">
            <h2 className={styles.sectionTitle}>Week details</h2>
            <p className={styles.hint}>
              The week&apos;s title stays with the course — it is how every email
              and every rail refers to this week, and your group needs to be
              talking about the same week as everybody else. The written guide
              stays with the course too.
              {viewerIsAdmin && (
                <>
                  {" "}
                  You&apos;re an admin: the course-wide version lives in the{" "}
                  <Link
                    href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}/weeks/${encodeURIComponent(weekId)}`}
                  >
                    admin week editor
                  </Link>
                  .
                </>
              )}
            </p>

            <div className={styles.stack}>
              <Field
                id="gw-summary"
                label="Summary"
                hint="Plain text. It doubles as the description of the mirrored My Work task."
              >
                <CountedTextarea
                  id="gw-summary"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  max={COURSE_FIELD_LIMITS.weekSummary}
                  rows={3}
                  placeholder="A couple of lines on what your group covers and why."
                  disabled={busy}
                />
              </Field>

              <div className={styles.twoCol}>
                <Field
                  id="gw-minutes"
                  label="Estimated minutes"
                  hint="Rough total for this week's materials. Blank if it varies."
                >
                  <Input
                    id="gw-minutes"
                    type="number"
                    min={1}
                    step={5}
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    placeholder="e.g. 120"
                    disabled={busy}
                  />
                </Field>

                <div className={styles.switchCell}>
                  <Switch
                    checked={published}
                    onChange={setPublished}
                    label="Visible to your group"
                    description="Off hides your copy of this week from everyone in the group."
                    size="lg"
                    disabled={busy}
                  />
                </div>
              </div>
            </div>

            {headerError && <p className={styles.error}>{headerError}</p>}

            <div className={styles.actions}>
              <Button type="button" onClick={saveHeader} disabled={busy || !headerDirty}>
                Save week details
              </Button>
            </div>
          </Card>

          <MaterialsSection materials={week.materials} save={save} busy={busy} />
          <ExercisesSection exercises={week.exercises} save={save} busy={busy} />
          <ChecklistSection checklist={week.checklist} save={save} busy={busy} />

          {canonical && (
            <p className={styles.warn}>
              This is your group&apos;s own copy. Changes the course team make to{" "}
              {weekLabel} no longer reach {groupName}.
            </p>
          )}
        </>
      )}

      {!forked && !canonical && (
        <p className={styles.warn}>
          <code>{weekId}</code> is in your group&apos;s schedule but the course has
          not written it. Nothing is shown to your group for this slot yet.
        </p>
      )}

      <ForkConfirm
        open={forking}
        weekLabel={weekLabel}
        groupName={groupName}
        busy={busy}
        onClose={() => setForking(false)}
        onConfirm={() => void doFork()}
      />

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
