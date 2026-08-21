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
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import { getClientDb } from "@/lib/firebase/client";
import { AdminLoadingBar } from "@/features/admin/adminList";
import { useMembers } from "@/features/admin/useMembers";
import { ACADEMIC_YEAR_PATTERN } from "@/lib/firestore/users";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import {
  COURSE_FIELD_LIMITS,
  COURSE_RUN_STATUSES,
  COURSE_RUN_STATUS_LABEL,
  normalizeCourseRun,
  type CourseRunDoc,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import { setRunStatus, updateRun } from "./courseMutations";
import { useCourseGroups } from "./useAdminCourses";
import GroupEditor, { NewGroupForm } from "./GroupEditor";
import RolePickers from "./RolePickers";
import WeekPlanBuilder from "./WeekPlanBuilder";
import styles from "./RunEditor.module.css";

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

/**
 * Which status changes are offered from where. This is UX only — the status
 * route is the authority and re-validates every transition server-side. The
 * disallowed options stay visible but disabled so the shape of the lifecycle
 * is legible rather than hidden.
 */
const RUN_STATUS_TRANSITIONS: Record<CourseRunStatus, CourseRunStatus[]> = {
  draft: ["applications-open", "cancelled"],
  "applications-open": ["applications-closed", "running", "cancelled"],
  "applications-closed": ["applications-open", "running", "cancelled"],
  running: ["completed", "cancelled"],
  // Terminal: a finished run is re-run by creating a new one, never by
  // rewinding this one (progress and enrolments are keyed to it).
  completed: [],
  cancelled: ["draft"],
};

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
  const allowedStatuses = RUN_STATUS_TRANSITIONS[currentStatus];
  const visibleGroups = groups.filter((g) => (showArchived ? true : !g.archived));
  const counts = run.applicationCounts;

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
        </div>
        {/* Application figures come from the run's server-owned counters. The
            group figure deliberately does NOT: `groupCount` only moves on the
            server (recount / allocation), so it lags a group created here,
            and the fetched list is the honest number. */}
        <span className={styles.muted}>
          {counts.pending} pending · {counts.accepted} accepted ·{" "}
          {counts.waitlisted} waitlisted · {groups.length} group
          {groups.length === 1 ? "" : "s"}
        </span>
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
          Status drives who can see and apply to this run. Transitions that
          aren&apos;t available from <strong>{COURSE_RUN_STATUS_LABEL[run.status]}</strong>{" "}
          are listed but disabled.
        </p>
        <div className={styles.statusRow}>
          <ResponsiveSelect
            value={run.status}
            onChange={(next) => changeStatus(next as CourseRunStatus)}
            options={COURSE_RUN_STATUSES.map((s) => ({
              value: s,
              label: COURSE_RUN_STATUS_LABEL[s],
              disabled: s !== run.status && !allowedStatuses.includes(s),
            }))}
            ariaLabel="Run status"
          />
          {allowedStatuses.length === 0 && (
            <span className={styles.muted}>
              This run is finished — start a new run to deliver the course again.
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

      {/* ---- Week plan ---- */}
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Week plan</h3>
        <WeekPlanBuilder
          runId={runId}
          startDate={run.startDate}
          weekPlan={run.weekPlan}
          runAction={runAction}
          onSaved={reload}
        />
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

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
