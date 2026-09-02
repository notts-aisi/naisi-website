"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { doc, getDoc } from "firebase/firestore";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import DateTimePopover from "@/components/ui/DateTimePopover";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import { getClientDb } from "@/lib/firebase/client";
import { AdminLoadingBar } from "@/features/admin/adminList";
import { useMembers } from "@/features/admin/useMembers";
import FormBuilder from "@/features/events/FormBuilder";
import { sanitizeSignupForm, type FormQuestion } from "@/lib/firestore/events";
import { ACADEMIC_YEAR_PATTERN } from "@/lib/firestore/users";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import { ALLOWED_TRANSITIONS } from "@/lib/courses/runStatus";
import {
  COURSE_FIELD_LIMITS,
  COURSE_RUN_STATUSES,
  COURSE_RUN_STATUS_LABEL,
  normalizeCourseRun,
  type CourseRunDoc,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import type { CourseTemplateRow } from "@/lib/firestore/courseTemplates";
import { formatCivilDate, taughtWeekCount } from "./AdminCourseList";
import { setRunStatus, updateRun } from "./courseMutations";
import { useCourseGroups, useCourseRuns, useCourseWeeks } from "./useAdminCourses";
import {
  applyCurriculumSource,
  formatWireStamp,
  useCourseTemplates,
  type ApplyOutcome,
  type CurriculumSource,
} from "./useTemplates";
import GroupEditor, { NewGroupForm } from "./GroupEditor";
import RolePickers from "./RolePickers";
import RunDangerZone from "./RunDangerZone";
import SaveTemplateDialog from "./SaveTemplateDialog";
import TemplatePicker, { type TemplatePickerGroup } from "./TemplatePicker";
import WeekPlanBuilder from "./WeekPlanBuilder";
import styles from "./RunEditor.module.css";
// The template section's own classes. RunEditor.module.css is not this
// feature's to extend, and the picker, the dialogs and the outcome block are
// one visual family anyway — see the header of TemplatePicker.module.css.
import pickerStyles from "./TemplatePicker.module.css";

/**
 * The run editor — everything about one delivery of a course that isn't
 * curriculum: when it runs, when applications are open, who reviews them, and
 * which groups the cohort splits into.
 *
 * Saves are per section, not one giant form. The sections write through
 * different paths (client-direct `updateRun` where the rules express the
 * invariant; routes for status and role arrays), they fail independently, and
 * an admin editing the week plan shouldn't have their half-typed group name
 * validated at them. Each section reports through the one `ActionToast` this
 * page owns.
 */

type Props = { courseId: string; runId: string };

function statusTone(
  status: CourseRunStatus,
): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "draft":
      return "neutral";
    case "applications-open":
      return "success";
    case "applications-closed":
      return "warning";
    case "running":
      return "accent";
    case "completed":
      return "neutral";
    case "cancelled":
      return "danger";
  }
}

/**
 * Cap on a run's application form. Mirrors the number firestore.rules enforces
 * on `courseRuns` (`applicationForm.size() <= 30`) and the identical constant
 * `courseMutations.ts` slices with — this copy exists so the editor can show
 * the budget and refuse a save before the write is rejected. Keep all three in
 * sync.
 */
const MAX_APPLICATION_FORM_QUESTIONS = 30;

/**
 * Tidy one authored question for storage.
 *
 * Two jobs, both load-bearing on THIS path specifically. Trimming keeps a
 * stray space out of a label the public apply page renders verbatim, and
 * dropping blank options stops the renderer drawing an unlabelled radio.
 *
 * More important: FormBuilder writes `undefined` into optional keys as you
 * clear them (`noneOption: e.target.value || undefined`). Events gets away
 * with that because its form crosses a `JSON.stringify` on the way to a route,
 * which silently drops undefined keys. A run's form is a CLIENT-DIRECT write,
 * so an `undefined` nested in the array would be refused by Firestore outright.
 */
function cleanQuestion(q: FormQuestion): FormQuestion {
  const label = q.label.trim();
  const cleaned =
    q.type === "singleSelect" || q.type === "multiSelect"
      ? { ...q, label, options: q.options.map((o) => o.trim()).filter(Boolean) }
      : { ...q, label };
  return Object.fromEntries(
    Object.entries(cleaned).filter(([, v]) => v !== undefined),
  ) as FormQuestion;
}

/**
 * Editor-side validation of the application form. Not a security boundary —
 * `sanitizeSignupForm` is the shape check and the rules cap the size. This
 * catches the two half-finished states the builder can leave behind, both of
 * which would otherwise ship to a public page as a blank question or an
 * unanswerable choice.
 */
function applicationFormError(questions: FormQuestion[]): string | null {
  if (questions.length > MAX_APPLICATION_FORM_QUESTIONS) {
    const over = questions.length - MAX_APPLICATION_FORM_QUESTIONS;
    return `That's ${over} question${over === 1 ? "" : "s"} over the limit of ${MAX_APPLICATION_FORM_QUESTIONS} — remove some before saving.`;
  }
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    if (!q.label.trim()) {
      return `Question ${i + 1} has no wording yet.`;
    }
    if (q.type === "singleSelect" || q.type === "multiSelect") {
      const filled = q.options.filter((o) => o.trim());
      if (filled.length < 2) {
        return `Question ${i + 1} needs at least two options to choose between.`;
      }
    }
  }
  return null;
}

/**
 * One-shot read of the run doc. Local to the editor rather than in the shared
 * hooks module: this is a single document, not a list, so it has no business
 * in `useOneShotList` territory.
 *
 * `loading` is deliberately only ever true for the FIRST fetch. `reload()`
 * refetches in place so the section drafts (which reseed on the run object's
 * identity) settle onto saved values without the whole editor unmounting.
 */
function useCourseRun(runId: string) {
  const [run, setRun] = useState<CourseRunDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getClientDb(), "courseRuns", runId))
      .then((snap) => {
        if (cancelled) return;
        if (!snap.exists()) {
          setNotFound(true);
          setRun(null);
          return;
        }
        setNotFound(false);
        setRun(normalizeCourseRun(snap.id, snap.data()));
        setError(null);
      })
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
  }, [runId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { run, loading, notFound, error, reload };
}

export default function RunEditor({ courseId, runId }: Props) {
  const { toast, run: runAction, dismiss } = useActionToast();
  const { run, loading, notFound, error, reload } = useCourseRun(runId);
  const { users: members, loading: membersLoading } = useMembers();
  const {
    items: groups,
    loading: groupsLoading,
    refreshing: groupsRefreshing,
    error: groupsError,
    reload: reloadGroups,
  } = useCourseGroups(runId);
  const {
    items: weeks,
    loading: weeksLoading,
    refreshing: weeksRefreshing,
    error: weeksError,
    reload: reloadWeeks,
  } = useCourseWeeks(runId);
  // The course's other runs, for copy-forward. Keyed on the RUN's courseId
  // rather than the URL's: if the two disagree (the warning below), the only
  // runs worth offering are the ones the clone route would actually accept.
  const { items: courseRuns, loading: courseRunsLoading } = useCourseRuns(
    run?.courseId ?? courseId,
  );
  // Saved snapshots of this course, the other half of the source picker. Same
  // courseId reasoning as the runs above.
  const templates = useCourseTemplates(run?.courseId ?? courseId);

  // ---- Run details ----
  const [label, setLabel] = useState("");
  const [academicYear, setAcademicYear] = useState("");
  const [startDate, setStartDate] = useState("");
  const [metaError, setMetaError] = useState<string | null>(null);

  // ---- Applications ----
  const [openAt, setOpenAt] = useState<Date | null>(null);
  const [closeAt, setCloseAt] = useState<Date | null>(null);
  const [cap, setCap] = useState("");
  const [applicationsError, setApplicationsError] = useState<string | null>(null);

  // ---- Application form ----
  const [applicationForm, setApplicationForm] = useState<FormQuestion[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  // ---- Weeks / curriculum source ----
  // One selection across both families in the picker, so the id carries which
  // kind it is: `t:<templateId>` or `r:<runId>`. Template ids and run ids are
  // both `slugId` output and could otherwise collide.
  const [sourceId, setSourceId] = useState("");
  const [replaceWeeks, setReplaceWeeks] = useState(false);
  const [applyOutcome, setApplyOutcome] = useState<ApplyOutcome | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CourseTemplateRow | null>(null);

  // ---- Groups ----
  // Archived groups are shown by default, greyed rather than hidden: that is
  // what `useCourseGroups` fetches for, and it keeps "restore" discoverable
  // instead of parked behind a toggle nobody flips.
  const [showArchived, setShowArchived] = useState(true);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Reseed every section draft whenever the run doc is (re)read. Adjusted
  // during render rather than in an effect, per the React docs and TimeField's
  // precedent — an effect would render the stale values for a frame first.
  const [syncedRun, setSyncedRun] = useState<CourseRunDoc | null>(null);
  if (run !== syncedRun) {
    setSyncedRun(run);
    if (run) {
      setLabel(run.label);
      setAcademicYear(run.academicYear);
      setStartDate(run.startDate);
      setMetaError(null);
      setOpenAt(run.applicationsOpenAt);
      setCloseAt(run.applicationsCloseAt);
      setCap(run.applicationCap === null ? "" : String(run.applicationCap));
      setApplicationsError(null);
      setApplicationForm(run.applicationForm);
      setFormError(null);
    }
  }

  if (loading) return <AdminLoadingBar label="Loading run…" />;

  if (notFound) {
    return (
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Run not found</h3>
        <p className={styles.hint}>
          No run with the id <code>{runId}</code> exists.{" "}
          <Link href={`/admin/courses/${encodeURIComponent(courseId)}`}>
            Back to the course
          </Link>
          .
        </p>
      </Card>
    );
  }

  if (error || !run) {
    return (
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Couldn&apos;t load this run</h3>
        <p className={styles.error}>{error?.message ?? "Unknown error."}</p>
        <div className={styles.actions}>
          <Button type="button" onClick={reload}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  // Captured before the handlers below: they are hoisted function
  // declarations, so TypeScript can't carry the "run is loaded" narrowing into
  // them (a hoisted function could, in principle, be called before the guard).
  const currentStatus = run.status;
  // The SERVER's table, imported rather than restated, so the dropdown can
  // never offer a move the status route refuses. Cancelling is subtracted
  // from it: that move is irreversible and lives in the danger zone behind a
  // typed confirmation, not one keystroke away in a select.
  const allowedStatuses: CourseRunStatus[] = ALLOWED_TRANSITIONS[currentStatus].filter(
    (s) => s !== "cancelled",
  );
  // A cancelled run still has to be able to show its own status in the select.
  const statusOptions = COURSE_RUN_STATUSES.filter(
    (s) => s !== "cancelled" || currentStatus === "cancelled",
  );
  const saving = toast?.phase === "saving";
  const visibleGroups = groups.filter((g) => (showArchived ? true : !g.archived));
  const counts = run.applicationCounts;
  // Everyone who has actually filled the form in, whatever admissions has
  // since decided about them. Withdrawn rows count too: the row (and its
  // answers) is kept, so a question removed now still has their answer behind
  // it. Only this figure justifies the "form is live" warning.
  const submittedApplications =
    counts.pending +
    counts.accepted +
    counts.rejected +
    counts.waitlisted +
    counts.withdrawn;

  // The taught slots of the SAVED plan — the week rows below are the plan's
  // rows, not the subcollection's, because the plan is what the cohort is paced
  // by. A week doc with no slot is surfaced separately rather than listed.
  const plannedWeeks = run.weekPlan.flatMap((e) => (e.kind === "week" ? [e] : []));
  const weekById = new Map(weeks.map((w) => [w.id, w] as const));
  const plannedIds = new Set(plannedWeeks.map((e) => e.weekId));
  const orphanWeeks = weeks.filter((w) => !plannedIds.has(w.id));
  const otherRuns = courseRuns.filter((r) => r.id !== runId);

  // ---- Curriculum source picker ----
  // Two families in one control: the frozen snapshots of this course, and its
  // other deliveries. Built plainly rather than memoised — these are tens of
  // rows, and the hooks above already sit behind the loaded-run guard, so a
  // `useMemo` down here would be a hook after an early return.
  const templateRows = templates.templates.map((t) => ({
    id: `t:${t.id}`,
    kind: "template" as const,
    label: t.label || t.id,
    meta: [
      `saved ${formatWireStamp(t.savedAt)}`,
      t.savedByName ? `by ${t.savedByName}` : null,
      `${t.weekCount} week${t.weekCount === 1 ? "" : "s"}`,
    ],
    hasRetrospective: t.retrospective !== null,
  }));
  const runRows = otherRuns.map((r) => {
    // The PLAN's taught slots, the same figure the course list shows. A run has
    // no `weekCount` field to read, and counting the authored subcollection
    // would mean a read per run just to label a picker row.
    const taught = taughtWeekCount(r);
    return {
      id: `r:${r.id}`,
      kind: "run" as const,
      label: r.label || r.id,
      meta: [
        r.academicYear || null,
        `starts ${formatCivilDate(r.startDate)}`,
        `${taught} week${taught === 1 ? "" : "s"}`,
        r.archived ? "archived" : null,
      ],
    };
  });
  const sourceGroups: TemplatePickerGroup[] = [
    {
      id: "templates",
      title: `Saved templates · ${run.courseTitle || "this course"}`,
      count:
        templateRows.length === 0
          ? undefined
          : `${templateRows.length} iteration${templateRows.length === 1 ? "" : "s"}`,
      rows: templateRows,
      emptyHint:
        "No snapshot of this course has been saved yet. Save one from a finished run and it becomes the master to start from.",
    },
    {
      id: "runs",
      title: "Other runs of this course",
      count:
        runRows.length === 0
          ? undefined
          : `${runRows.length} run${runRows.length === 1 ? "" : "s"}`,
      rows: runRows,
      emptyHint: "This is the only run of this course, so there is nothing to copy from.",
    },
  ];

  /** Turn the picker's prefixed id back into the source it names. */
  function selectedSource(): CurriculumSource | null {
    if (sourceId.startsWith("t:")) return { kind: "template", id: sourceId.slice(2) };
    if (sourceId.startsWith("r:")) return { kind: "run", id: sourceId.slice(2) };
    return null;
  }

  const selectedTemplate =
    templates.templates.find((t) => `t:${t.id}` === sourceId) ?? null;

  // Weeks this run holds that the chosen snapshot cannot possibly account for.
  //
  // A replace does not only OVERWRITE: apply-template deletes every existing
  // week the snapshot has no counterpart for, so "replace" can mean "and lose
  // two weeks". The receipt says so afterwards; this says so BEFORE the press,
  // which is the only moment the information can change a decision. Both
  // numbers are already on the client — the run's authored week docs and the
  // snapshot's `weekCount` — so nothing has to be fetched to ask the question.
  //
  // A LOWER BOUND, deliberately: the route removes existing week IDS the
  // snapshot lacks, and the two id sets need not overlap at all, so the real
  // figure can be higher than the difference in counts. Never lower — which
  // is the direction a warning has to err in.
  const templateWeekCount = selectedTemplate?.weekCount ?? 0;
  const minWeeksRemoved = selectedTemplate
    ? Math.max(0, weeks.length - templateWeekCount)
    : 0;

  async function saveMeta() {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setMetaError("Give the run a label, e.g. Autumn 2026.");
      return;
    }
    const trimmedYear = academicYear.trim();
    if (!ACADEMIC_YEAR_PATTERN.test(trimmedYear)) {
      setMetaError("Academic year must look like 2026/27.");
      return;
    }
    // Every run has a start date from the moment it is created (`createRun`
    // insists), and a garbled one poisons every derived week number for the
    // whole cohort — so this is a hard requirement, not a nicety. `updateRun`
    // re-checks it and the rules check it again.
    if (!isValidDateKey(startDate)) {
      setMetaError("Start date must be a real date — every run needs one.");
      return;
    }
    setMetaError(null);

    let ok = false;
    await runAction(
      async () => {
        await updateRun(runId, {
          label: trimmedLabel,
          academicYear: trimmedYear,
          startDate,
        });
        ok = true;
      },
      { savingMessage: "Saving run details…", successMessage: "Run details saved" },
    );
    if (ok) reload();
  }

  async function saveApplications() {
    if (openAt && closeAt && closeAt.getTime() <= openAt.getTime()) {
      setApplicationsError("Applications must close after they open.");
      return;
    }
    const trimmedCap = cap.trim();
    const capValue = trimmedCap ? Number(trimmedCap) : null;
    if (capValue !== null && (!Number.isFinite(capValue) || capValue <= 0)) {
      setApplicationsError("Cap must be a positive number, or blank for none.");
      return;
    }
    setApplicationsError(null);

    let ok = false;
    await runAction(
      async () => {
        await updateRun(runId, {
          applicationsOpenAt: openAt,
          applicationsCloseAt: closeAt,
          applicationCap: capValue === null ? null : Math.floor(capValue),
        });
        ok = true;
      },
      {
        savingMessage: "Saving application window…",
        successMessage: "Application window saved",
      },
    );
    if (ok) reload();
  }

  async function saveApplicationForm() {
    // Clean first, then validate: trimming is what turns a label of spaces
    // into the blank the check below is looking for.
    const cleaned = sanitizeSignupForm(applicationForm.map(cleanQuestion));
    const problem = applicationFormError(cleaned);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);

    let ok = false;
    await runAction(
      async () => {
        await updateRun(runId, { applicationForm: cleaned });
        ok = true;
      },
      {
        savingMessage: "Saving application form…",
        successMessage: "Application form saved",
      },
    );
    if (ok) reload();
  }

  async function applySource() {
    const source = selectedSource();
    if (!source) return;
    // Held on an object, not a `let`: TypeScript keeps a plain local narrowed to
    // its initialiser across the await (it can't see that the closure ran),
    // whereas a property read after a call re-widens to its declared type.
    const outcome: { result: ApplyOutcome | null } = { result: null };
    await runAction(
      async () => {
        const result = await applyCurriculumSource(runId, source, replaceWeeks);
        outcome.result = result;
        // `applyCurriculumSource` returns refusals rather than throwing, so the
        // rethrow here is what paints the toast red with the ROUTE's sentence.
        // The same sentence also lands inline below, where it survives the
        // toast being dismissed — a refusal is a work item, not a notification.
        if (!result.ok) throw new Error(result.error);
      },
      { savingMessage: "Copying curriculum…", successMessage: "Curriculum copied" },
    );
    if (!outcome.result) return;
    setApplyOutcome(outcome.result);
    if (outcome.result.ok) {
      reloadWeeks();
      // The run doc too: apply-template stamps `templateId` / `templateLabel`,
      // and the provenance badge reads them.
      reload();
    }
  }

  async function saveAsTemplate(label: string) {
    let ok = false;
    await runAction(
      async () => {
        await templates.saveTemplate({
          label,
          sourceRunId: runId,
          // Always the run canonical weeks today. The field is reserved for
          // V2-3, where an admin picks which diverged group copy to freeze.
          sourceGroupId: null,
        });
        ok = true;
      },
      { savingMessage: "Saving template…", successMessage: "Template saved" },
    );
    if (ok) setSavingTemplate(false);
  }

  async function confirmDeleteTemplate() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    await runAction(
      async () => {
        await templates.deleteTemplate(target.id);
        // Clear a selection that no longer points at anything.
        setSourceId((current) => (current === `t:${target.id}` ? "" : current));
      },
      { savingMessage: "Deleting template…", successMessage: "Template deleted" },
    );
  }

  async function changeStatus(next: CourseRunStatus) {
    if (next === currentStatus) return;
    let ok = false;
    await runAction(
      async () => {
        await setRunStatus(runId, next);
        ok = true;
      },
      {
        savingMessage: "Changing status…",
        successMessage: `Status set to ${COURSE_RUN_STATUS_LABEL[next]}`,
      },
    );
    if (ok) reload();
  }

  return (
    <div className={styles.editor}>
      <div className={styles.breadcrumb}>
        <Link
          href={`/admin/courses/${encodeURIComponent(courseId)}`}
          className={styles.backLink}
        >
          ← {run.courseTitle || "Course"}
        </Link>
      </div>

      <div className={styles.statusBar}>
        <div className={styles.statusMeta}>
          <h2 className={styles.runTitle}>{run.label || "Untitled run"}</h2>
          <Badge tone={statusTone(run.status)}>
            {COURSE_RUN_STATUS_LABEL[run.status]}
          </Badge>
          {run.academicYear && <Badge tone="neutral">{run.academicYear}</Badge>}
          {/* Provenance (v2 decision 3). A point-in-time copy of the label, so
              it keeps reading true after the snapshot is relabelled or deleted
              — which is exactly when "what was this cohort given" gets asked. */}
          {run.templateLabel && (
            <Badge tone="accent">Spawned from {run.templateLabel}</Badge>
          )}
        </div>
        {/* Counts and the way into review, grouped so the flex row reads as
            two ends rather than three scattered items. `.statusMeta` is a
            plain wrapping flex row — no second class needed for the same job. */}
        <div className={styles.statusMeta}>
          {/* Application figures come from the run's server-owned counters. The
              group figure deliberately does NOT: `groupCount` only moves on the
              server (recount / allocation), so it lags a group created here,
              and the fetched list is the honest number. */}
          <span className={styles.muted}>
            {counts.pending} pending · {counts.accepted} accepted ·{" "}
            {counts.waitlisted} waitlisted · {groups.length} group
            {groups.length === 1 ? "" : "s"}
          </span>
          {/* Admissions is its own surface, not a panel on this page: reviewing
              never edits the run, and reviewers who aren't admins reach the
              queue from /learn instead. The pending figure comes from the run
              doc already loaded above — no second read for a link label. */}
          <Link
            href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}/applications`}
          >
            <Button type="button" variant="secondary">
              {counts.pending > 0
                ? `Review applications (${counts.pending} pending) →`
                : "Review applications →"}
            </Button>
          </Link>
          {/* Allocation is the step after review: it only ever places ACCEPTED
              applicants, so the accepted figure — not the pending one — is what
              tells you whether there is anything to do there. Same server-owned
              counters, so still no extra read. */}
          <Link
            href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}/allocation`}
          >
            <Button type="button" variant="secondary">
              {counts.accepted > 0
                ? `Allocate places (${counts.accepted} accepted) →`
                : "Allocate places →"}
            </Button>
          </Link>
          {/* The look-back surface. It sits with the other "where to go next"
              links rather than beside the curriculum controls: it is read while
              drafting the NEXT run's weeks, and the ratings behind it belong to
              the cohort, not to the editor's week list. */}
          <Link
            href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}/retrospective`}
          >
            <Button type="button" variant="secondary">
              Retrospective →
            </Button>
          </Link>
        </div>
      </div>

      {run.courseId !== courseId && (
        <p className={styles.warn}>
          This run belongs to course <code>{run.courseId}</code>, not{" "}
          <code>{courseId}</code>. Check the link you followed.
        </p>
      )}

      {/* ---- Run details ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Run details</h3>
        <div className={styles.fields}>
          <div className={styles.twoCol}>
            <Field
              id="run-label"
              label="Run label"
              hint="How the cohort is named, e.g. Autumn 2026."
            >
              <Input
                id="run-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={COURSE_FIELD_LIMITS.runLabel}
                placeholder="e.g. Autumn 2026"
              />
            </Field>
            <Field
              id="run-year"
              label="Academic year"
              hint="Matches the paid-membership tag, e.g. 2026/27."
            >
              <Input
                id="run-year"
                value={academicYear}
                onChange={(e) => setAcademicYear(e.target.value)}
                maxLength={COURSE_FIELD_LIMITS.academicYear}
                placeholder="2026/27"
              />
            </Field>
          </div>

          <Field
            id="run-start"
            label="Start date"
            hint="The day week 1 begins. Every week window is counted forward from here in London civil dates."
          >
            {/* A native date input, on purpose: `startDate` IS the civil date
                string "YYYY-MM-DD". Wrapping it in DateTimePopover would mean
                inventing an instant and a timezone that the data model
                deliberately doesn't have. */}
            <Input
              id="run-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
        </div>

        {metaError && <p className={styles.error}>{metaError}</p>}

        <div className={styles.actions}>
          <Button type="button" onClick={saveMeta}>
            Save run details
          </Button>
        </div>
      </Card>

      {/* ---- Status ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Status</h3>
        <p className={styles.hint}>
          Status drives who can see and apply to this run. It only moves
          forwards. Transitions that aren&apos;t available from{" "}
          <strong>{COURSE_RUN_STATUS_LABEL[run.status]}</strong> are listed but
          disabled. Cancelling a cohort lives in the danger zone below.
        </p>
        <div className={styles.statusRow}>
          <ResponsiveSelect
            value={run.status}
            onChange={(next) => changeStatus(next as CourseRunStatus)}
            options={statusOptions.map((s) => ({
              value: s,
              label: COURSE_RUN_STATUS_LABEL[s],
              disabled: s !== run.status && !allowedStatuses.includes(s),
            }))}
            ariaLabel="Run status"
          />
          {/* Both terminal states have an empty transition row, and they are
              not the same news: a cancelled cohort was called off, not
              delivered. Saying "finished" over it read as a run that had run. */}
          {allowedStatuses.length === 0 && (
            <span className={styles.muted}>
              {run.status === "cancelled"
                ? "This cohort was cancelled. Start a new run to deliver the course again."
                : "This run is finished. Start a new run to deliver the course again."}
            </span>
          )}
        </div>
      </Card>

      {/* ---- Applications ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Applications</h3>
        <p className={styles.hint}>
          Leave a date blank for no automatic bound on that side; the status
          above still gates whether the form is reachable at all.
        </p>
        <div className={styles.fields}>
          <div className={styles.twoCol}>
            <Field id="run-open-at" label="Applications open">
              <DateTimePopover
                value={openAt}
                onChange={setOpenAt}
                placeholder="No opening date"
              />
            </Field>
            <Field id="run-close-at" label="Applications close">
              <DateTimePopover
                value={closeAt}
                onChange={setCloseAt}
                placeholder="No closing date"
                invalid={
                  !!openAt && !!closeAt && closeAt.getTime() <= openAt.getTime()
                }
              />
            </Field>
          </div>

          <Field
            id="run-cap"
            label="Application cap"
            hint="Soft cap on accepted applicants. Blank for uncapped."
          >
            <Input
              id="run-cap"
              type="number"
              min={1}
              inputMode="numeric"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="e.g. 40"
            />
          </Field>
        </div>

        {applicationsError && <p className={styles.error}>{applicationsError}</p>}

        <div className={styles.actions}>
          <Button type="button" onClick={saveApplications}>
            Save application window
          </Button>
        </div>
      </Card>

      {/* ---- Application form ---- */}
      <Card padding="lg">
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Application form</h3>
          {/* Preview only makes sense once the public page will actually
              render the form — before that the apply route has no open run to
              show. A plain anchor with target=_blank so the editor (and its
              unsaved drafts in the other sections) stays put. */}
          {run.status === "applications-open" && (
            <a
              href={`/courses/${encodeURIComponent(run.courseId)}/apply`}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.previewLink}
            >
              Open the public apply page ↗
            </a>
          )}
        </div>
        <p className={styles.hint}>
          These are the questions applicants answer on the public apply page.
          Their name and email come from their account, so only ask for what
          admissions will actually read. Applicants don&apos;t pick a
          facilitator here — group and facilitator preferences are recorded at
          review, not by the applicant.
        </p>

        {submittedApplications > 0 && (
          <p className={`${styles.warn} ${styles.blockWarn}`}>
            {submittedApplications} application
            {submittedApplications === 1 ? " has" : "s have"} already been
            submitted. Editing the questions changes the form for everyone who
            hasn&apos;t submitted yet; answers already given are kept exactly as
            they were, so removing a question hides the answers it collected
            rather than deleting them.
          </p>
        )}

        <FormBuilder
          questions={applicationForm}
          onChange={setApplicationForm}
          showPresets={false}
          hiddenTypes={["dietaryAllergies"]}
          emptyStateHint="No questions yet. Applicants' name and email come from their account — add only what admissions will actually read."
        />

        <p className={`${styles.muted} ${styles.formCount}`}>
          {applicationForm.length} of {MAX_APPLICATION_FORM_QUESTIONS} questions.
        </p>

        {formError && <p className={styles.error}>{formError}</p>}

        <div className={styles.actions}>
          <Button type="button" onClick={saveApplicationForm}>
            Save application form
          </Button>
        </div>
      </Card>

      {/* ---- Week plan ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Week plan</h3>
        {/* `status` is threaded through rather than left to the builder's own
            getDoc fallback: without it every open of a DRAFT run rendered the
            locked state until a round trip came back and said otherwise. */}
        <WeekPlanBuilder
          runId={runId}
          startDate={run.startDate}
          weekPlan={run.weekPlan}
          status={run.status}
          runAction={runAction}
          onSaved={reload}
        />
      </Card>

      {/* ---- Weeks ---- */}
      <Card padding="lg">
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Weeks</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={reloadWeeks}
            disabled={weeksRefreshing}
          >
            {weeksRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <p className={styles.hint}>
          One row per taught slot in the saved week plan. Content belongs to the
          week, not the plan — reordering slots above moves the calendar without
          moving anyone&apos;s curriculum or progress.
        </p>

        {weeksError && (
          <p className={styles.error}>
            Couldn&apos;t load this run&apos;s weeks: {weeksError.message}
          </p>
        )}
        {weeksLoading && <AdminLoadingBar label="Loading weeks…" />}

        {!weeksLoading && plannedWeeks.length === 0 && (
          <p className={styles.hint}>
            No taught weeks in the plan yet — add week slots above, then author
            them here.
          </p>
        )}

        {plannedWeeks.length > 0 && (
          <ul className={styles.weekRows}>
            {plannedWeeks.map((entry) => {
              const week = weekById.get(entry.weekId);
              return (
                <li key={entry.weekId} className={styles.weekRow}>
                  <span className={styles.weekName}>
                    Week {entry.weekNumber}
                    <span className={styles.weekId}>{entry.weekId}</span>
                  </span>
                  <span
                    className={
                      week?.title ? styles.weekTitle : styles.weekTitleEmpty
                    }
                  >
                    {week?.title || "No content yet"}
                  </span>
                  <Badge
                    tone={week?.published ? "success" : "neutral"}
                    className={styles.weekBadge}
                  >
                    {week?.published ? "Published" : "Unpublished"}
                  </Badge>
                  <Link
                    href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}/weeks/${encodeURIComponent(entry.weekId)}`}
                    className={styles.weekLink}
                  >
                    Edit content →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {orphanWeeks.length > 0 && (
          <p className={styles.hint}>
            {orphanWeeks.length} authored week
            {orphanWeeks.length === 1 ? " has" : "s have"} no slot in the plan
            ({orphanWeeks.map((w) => w.id).join(", ")}). Their content is safe —
            add a week slot above to bring{" "}
            {orphanWeeks.length === 1 ? "it" : "them"} back into the calendar.
          </p>
        )}

        {/* ---- Start from a template or another run ---- */}
        <div className={styles.copyForward}>
          <h4 className={styles.subTitle}>Start from a template or another run</h4>
          <p className={styles.hint}>
            A template is a frozen snapshot of what a finished cohort was taught;
            a run is another delivery&apos;s live weeks. Either way the copy keeps
            week ids and every material, exercise and checklist id, so progress on
            a re-run still lines up with the item it belongs to.
          </p>

          {templates.error && (
            <p className={styles.error}>
              Couldn&apos;t load saved templates: {templates.error.message}
            </p>
          )}

          <TemplatePicker
            ariaLabel="Curriculum source"
            groups={sourceGroups}
            value={sourceId}
            onChange={setSourceId}
            loading={templates.loading || courseRunsLoading}
            emptyState={
              <p className={styles.hint}>
                Nothing to copy from yet — this is the only run of this course and
                no template has been saved.
              </p>
            }
            renderRowAction={(row) =>
              row.kind === "template" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    const target = templates.templates.find(
                      (t) => `t:${t.id}` === row.id,
                    );
                    if (target) setDeleteTarget(target);
                  }}
                >
                  Delete
                </Button>
              ) : null
            }
          />

          <div className={styles.copyRow}>
            <Switch
              checked={replaceWeeks}
              onChange={setReplaceWeeks}
              label="Replace"
              description="overwrite weeks that already exist here"
            />
            <Button
              type="button"
              onClick={applySource}
              disabled={!sourceId || saving}
            >
              Copy curriculum in
            </Button>
          </div>

          {selectedTemplate && (
            <p className={styles.muted}>
              Copying a template also records it as this run&apos;s provenance.
            </p>
          )}

          {/* The two sources are guarded differently, so the warning says which
              guard you actually have. Only apply-template checks for member
              work; clone-weeks (the older copy-forward route) does not. And
              only apply-template DELETES — hence the second sentence, which
              names the removal before the press rather than in the receipt. */}
          {replaceWeeks && weeks.length > 0 && (
            <p className={`${styles.warn} ${styles.blockWarn}`}>
              This run already has {weeks.length} authored week
              {weeks.length === 1 ? "" : "s"}. Replacing rewrites{" "}
              {weeks.length === 1 ? "it" : "them"} from the source.{" "}
              {selectedTemplate
                ? "If anyone on this run has already checked an item off or answered an exercise, the server refuses the whole copy rather than orphan their work — you get a refusal here, not a half-applied curriculum."
                : "Copying from a run isn't guarded that way: if anyone here has already checked an item off, a rewritten week can leave their row pointing at material the week no longer contains."}
              {minWeeksRemoved > 0 && (
                <>
                  {" "}
                  Replacing also <strong>deletes</strong> weeks the version
                  doesn&apos;t have: it holds {templateWeekCount} week
                  {templateWeekCount === 1 ? "" : "s"} against this run&apos;s{" "}
                  {weeks.length}, so at least {minWeeksRemoved} of this
                  run&apos;s weeks will be removed rather than overwritten.
                </>
              )}
            </p>
          )}

          {applyOutcome && (
            <p
              className={
                applyOutcome.ok
                  ? pickerStyles.outcome
                  : `${pickerStyles.outcome} ${pickerStyles.outcomeRefused}`
              }
            >
              {applyOutcome.ok
                ? applyOutcome.message
                : applyOutcome.refused
                  ? `${applyOutcome.error} Nothing was copied.`
                  : applyOutcome.error}
            </p>
          )}
        </div>

        {/* ---- Save this run as a template ---- */}
        <div className={styles.copyForward}>
          <h4 className={styles.subTitle}>Save this run as a template</h4>
          <p className={styles.hint}>
            Freezes this run&apos;s canonical curriculum as a named iteration
            under {run.courseTitle || "this course"}, so a future year starts from
            what was actually taught rather than from whatever the last run has
            since been edited into. Append-only: saving never overwrites an
            earlier snapshot.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSavingTemplate(true)}
              disabled={saving || weeks.length === 0}
            >
              Save as template
            </Button>
            {weeks.length === 0 && (
              <span className={styles.muted}>
                Author a week first — there is nothing to snapshot yet.
              </span>
            )}
            {templates.templates.length > 0 && (
              <span className={styles.muted}>
                {templates.templates.length} saved iteration
                {templates.templates.length === 1 ? "" : "s"} of this course.
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ---- Groups ---- */}
      <Card padding="lg">
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Groups</h3>
          <div className={styles.sectionHeaderActions}>
            <Switch
              checked={showArchived}
              onChange={setShowArchived}
              label="Show archived groups"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCreatingGroup((c) => !c)}
            >
              {creatingGroup ? "Close" : "New group"}
            </Button>
          </div>
        </div>

        {groupsError && <p className={styles.error}>{groupsError.message}</p>}
        {groupsLoading && <AdminLoadingBar label="Loading groups…" />}

        <div className={styles.groups}>
          {creatingGroup && (
            <NewGroupForm
              run={{ id: run.id, courseId: run.courseId, label: run.label }}
              runAction={runAction}
              onCreated={() => {
                setCreatingGroup(false);
                reloadGroups();
              }}
              onCancel={() => setCreatingGroup(false)}
            />
          )}

          {!groupsLoading && visibleGroups.length === 0 && !creatingGroup && (
            <p className={styles.hint}>
              No groups yet. Add one per weekly session — allocation places
              accepted applicants into these.
            </p>
          )}

          {visibleGroups.map((group) => (
            <GroupEditor
              key={group.id}
              group={group}
              members={members}
              runAction={runAction}
              onSaved={reloadGroups}
            />
          ))}
        </div>

        {groupsRefreshing && <span className={styles.muted}>Refreshing…</span>}
      </Card>

      {/* ---- Roles ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Roles</h3>
        <RolePickers
          runId={runId}
          admissionsReviewerUids={run.admissionsReviewerUids}
          trackLeadUids={run.trackLeadUids}
          runFacilitatorUids={run.runFacilitatorUids}
          members={members}
          membersLoading={membersLoading}
          runAction={runAction}
          onSaved={reload}
        />
      </Card>

      {/* ---- Archive + destroy ----
          Last on the page by design: the end-of-life controls sit after
          everything you might edit instead, and the destroy half is behind its
          own disclosure inside. `onArchived` re-reads the run; a DESTROY is
          deliberately not wired to `reload` — the run is gone, and refetching
          would replace the receipt with "Run not found". */}
      <RunDangerZone
        courseId={courseId}
        run={run}
        runAction={runAction}
        onRunChanged={reload}
      />

      <SaveTemplateDialog
        open={savingTemplate}
        onClose={() => setSavingTemplate(false)}
        run={{ label: run.label, courseTitle: run.courseTitle }}
        weekCount={weeks.length}
        saving={saving}
        onSave={saveAsTemplate}
      />

      {/* Deleting a snapshot is admin-only and irreversible, so it asks. It is
          NOT in the Danger zone below: that section is about ending this RUN,
          and a template belongs to the course rather than to any one delivery. */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        ariaLabel="Delete this template"
        width="sm"
      >
        <div className={pickerStyles.dialog}>
          <h2 className={pickerStyles.dialogTitle}>Delete this template?</h2>
          <p className={pickerStyles.dialogBody}>
            {deleteTarget
              ? `“${deleteTarget.label}” and its ${deleteTarget.weekCount} frozen week${
                  deleteTarget.weekCount === 1 ? "" : "s"
                } go for good.`
              : ""}{" "}
            Runs already started from it keep their weeks — a template is a copy
            source, not a live link — but their provenance will name a snapshot
            nobody can open again.
          </p>
          <div className={pickerStyles.dialogActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={confirmDeleteTemplate}
              disabled={saving}
            >
              Delete template
            </Button>
          </div>
        </div>
      </Modal>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
