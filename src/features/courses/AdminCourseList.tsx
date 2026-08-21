"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collection, getDocs } from "firebase/firestore";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import {
  AdminListFooter,
  AdminLoadingBar,
  AdminPage,
  useClientPagination,
  useOneShotList,
} from "@/features/admin/adminList";
import { getClientDb } from "@/lib/firebase/client";
import {
  COURSE_FIELD_LIMITS,
  COURSE_RUN_STATUS_LABEL,
  COURSE_STATUS_LABEL,
  COURSE_TRACKS,
  COURSE_TRACK_LABELS,
  normalizeCourseRun,
  type CourseDoc,
  type CourseRunDoc,
  type CourseRunStatus,
  type CourseStatus,
  type CourseTrack,
} from "@/lib/firestore/courses";
import { createCourse } from "./courseMutations";
import { useCourses } from "./useAdminCourses";
import styles from "./adminCourses.module.css";

/**
 * `courses.level` is a free-text difficulty line in the data model (see
 * `CourseDoc`), but leaving it as a bare text input across a catalogue is how
 * you end up with five spellings of "beginner". These are the house options;
 * an existing value that isn't one of them is preserved and appended to the
 * list rather than silently rewritten (see `levelOptions`).
 *
 * Shared with CourseEditor — kept here rather than in a third module because
 * these two admin surfaces are the only consumers.
 */
export const COURSE_LEVEL_PRESETS = [
  "Open to all — no prior experience",
  "Some background helpful",
  "Technical background expected",
  "Advanced",
];

/** Preset levels plus `current`, so an off-list legacy value still round-trips. */
export function levelOptions(current: string): ResponsiveSelectOption[] {
  const values = COURSE_LEVEL_PRESETS.includes(current) || !current
    ? COURSE_LEVEL_PRESETS
    : [...COURSE_LEVEL_PRESETS, current];
  return [
    { value: "", label: "— pick a level —" },
    ...values.map((v) => ({ value: v, label: v })),
  ];
}

export const TRACK_OPTIONS: ResponsiveSelectOption<CourseTrack>[] = COURSE_TRACKS.map(
  (t) => ({ value: t, label: COURSE_TRACK_LABELS[t] }),
);

/** Draft and archived both read as "not live"; only published is a green light. */
export function courseStatusTone(status: CourseStatus): "neutral" | "success" {
  return status === "published" ? "success" : "neutral";
}

/**
 * Run status tone. Cancelled is the only danger case — a completed run is a
 * normal end state, not a failure. Shared with CourseEditor's runs section.
 */
export function runStatusTone(
  status: CourseRunStatus,
): "neutral" | "accent" | "success" | "danger" {
  switch (status) {
    case "applications-open":
      return "accent";
    case "running":
      return "success";
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Which run a course row should advertise. A run being delivered beats one
 * taking applications beats one being drafted; ties break on the later start
 * date so last year's completed run never shadows this year's.
 */
const RUN_PRIORITY: Record<CourseRunStatus, number> = {
  running: 0,
  "applications-open": 1,
  "applications-closed": 2,
  draft: 3,
  completed: 4,
  cancelled: 5,
};

export function pickActiveRun(runs: CourseRunDoc[]): CourseRunDoc | null {
  let best: CourseRunDoc | null = null;
  for (const run of runs) {
    if (!best) {
      best = run;
      continue;
    }
    const delta = RUN_PRIORITY[run.status] - RUN_PRIORITY[best.status];
    if (delta < 0 || (delta === 0 && run.startDate > best.startDate)) best = run;
  }
  return best;
}

/** Taught weeks in a run's plan — breaks are calendar padding, not curriculum. */
export function taughtWeekCount(run: CourseRunDoc): number {
  return run.weekPlan.filter((e) => e.kind === "week").length;
}

/** "12 Oct 2026" from a civil "YYYY-MM-DD" key, read as UTC so it can't slip a day. */
export function formatCivilDate(key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "no start date";
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(ms)) return "no start date";
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function AdminCourseList() {
  const router = useRouter();
  const { toast, run: runAction, dismiss } = useActionToast();

  const { items: courses, loading, refreshing, error, reload } = useCourses();

  /**
   * Every run, in ONE query for the whole page — not one per row. A course row
   * shows its active run's label and week count, and `courseRuns` is a
   * top-level collection of tens of docs at NAISI scale, so a single unfiltered
   * read is cheaper than N scoped ones. (If runs ever grow past a few hundred
   * this becomes a paginated admin read — see the read-cost hardening backlog.)
   */
  const runsQuery = useOneShotList<CourseRunDoc>(async () => {
    const db = getClientDb();
    const snap = await getDocs(collection(db, "courseRuns"));
    return snap.docs.map((d) => normalizeCourseRun(d.id, d.data()));
  }, "admin-courses-runs");

  const runsByCourse = useMemo(() => {
    const map = new Map<string, CourseRunDoc[]>();
    for (const run of runsQuery.items) {
      const list = map.get(run.courseId);
      if (list) list.push(run);
      else map.set(run.courseId, [run]);
    }
    return map;
  }, [runsQuery.items]);

  const { shown, hasMore, loadMore, total, shownCount } = useClientPagination(
    courses,
    20,
  );

  // --- New course form ---
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [tagline, setTagline] = useState("");
  const [track, setTrack] = useState<CourseTrack>("general");
  const [level, setLevel] = useState("");
  const [weeklyHours, setWeeklyHours] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function resetForm() {
    setTitle("");
    setTagline("");
    setTrack("general");
    setLevel("");
    setWeeklyHours("");
    setFormError(null);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("A course needs a title.");
      return;
    }
    let hours: number | null = null;
    if (weeklyHours.trim()) {
      const parsed = Number(weeklyHours);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setFormError("Weekly hours must be a positive number (or left blank).");
        return;
      }
      hours = Math.round(parsed);
    }
    setFormError(null);
    setBusy(true);
    let newId = "";
    await runAction(
      async () => {
        newId = await createCourse({
          title: trimmedTitle,
          tagline: tagline.trim(),
          track,
          level,
          estimatedWeeklyHours: hours,
        });
      },
      { savingMessage: "Creating course…", successMessage: "Course created" },
    );
    setBusy(false);
    if (newId) {
      resetForm();
      setCreating(false);
      // Straight into the editor: a course with no summary or runs isn't
      // useful yet, and the editor is where both get authored.
      router.push(`/admin/courses/${encodeURIComponent(newId)}`);
    }
  }

  return (
    <AdminPage>
      <div className={styles.toolbar}>
        <p className={styles.toolbarText}>
          {loading
            ? "Loading courses…"
            : `${courses.length} course${courses.length === 1 ? "" : "s"}`}
        </p>
        <Button
          variant={creating ? "ghost" : "primary"}
          onClick={() => {
            setFormError(null);
            setCreating((c) => !c);
          }}
        >
          {creating ? "Cancel" : "New course"}
        </Button>
      </div>

      {creating && (
        <Card padding="lg">
          <h2 className={styles.emptyTitle}>New course</h2>
          <p className={styles.emptyBody}>
            Courses start as drafts. Add the curriculum and a run in the editor, then
            publish when it&apos;s ready for the public catalogue.
          </p>
          <form
            onSubmit={handleCreate}
            className={styles.form}
            style={{ marginTop: "var(--space-4)" }}
          >
            <div className={styles.formGrid}>
              <div className={styles.formSpan}>
                <Field id="course-title" label="Title">
                  <Input
                    id="course-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={COURSE_FIELD_LIMITS.title}
                    placeholder="e.g. AI Safety Fundamentals — Technical"
                    required
                  />
                </Field>
              </div>

              <div className={styles.formSpan}>
                <Field
                  id="course-tagline"
                  label="Tagline"
                  hint="One line, shown on the catalogue card."
                >
                  <CountedTextarea
                    id="course-tagline"
                    value={tagline}
                    onChange={(e) => setTagline(e.target.value)}
                    max={COURSE_FIELD_LIMITS.tagline}
                    rows={2}
                    placeholder="Eight weeks on the technical side of alignment, in small facilitated groups."
                  />
                </Field>
              </div>

              <Field id="course-track" label="Track">
                <ResponsiveSelect<CourseTrack>
                  value={track}
                  onChange={setTrack}
                  options={TRACK_OPTIONS}
                  ariaLabel="Track"
                />
              </Field>

              <Field id="course-level" label="Level">
                <ResponsiveSelect
                  value={level}
                  onChange={setLevel}
                  options={levelOptions(level)}
                  ariaLabel="Level"
                />
              </Field>

              <Field
                id="course-hours"
                label="Weekly hours"
                hint="Rough commitment. Leave blank if it varies."
              >
                <Input
                  id="course-hours"
                  type="number"
                  min={1}
                  max={40}
                  step={1}
                  value={weeklyHours}
                  onChange={(e) => setWeeklyHours(e.target.value)}
                  placeholder="5"
                />
              </Field>
            </div>

            {formError && <p className={styles.error}>{formError}</p>}

            <div className={styles.formActions}>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create course"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  resetForm();
                  setCreating(false);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {error && (
        <Card padding="md">
          <p className={styles.error}>Couldn&apos;t load courses: {error.message}</p>
        </Card>
      )}

      {runsQuery.error && !error && (
        <Card padding="sm">
          <p className={styles.status}>
            Runs couldn&apos;t be loaded, so the run column is blank:{" "}
            {runsQuery.error.message}
          </p>
        </Card>
      )}

      {loading && (
        <Card padding="md">
          <AdminLoadingBar label="Loading courses…" />
        </Card>
      )}

      {!loading && !error && courses.length === 0 && !creating && (
        <Card padding="lg">
          <h2 className={styles.emptyTitle}>No courses yet</h2>
          <p className={styles.emptyBody}>
            A course is the evergreen curriculum shell — fellowships, reading groups,
            the incubator. Each one gets runs (&ldquo;Autumn 2026&rdquo;) that carry the
            dates, applications and groups.
          </p>
        </Card>
      )}

      {!loading && !error && shown.length > 0 && (
        <ul className={styles.list}>
          {shown.map((course: CourseDoc) => {
            const runs = runsByCourse.get(course.id) ?? [];
            const active = pickActiveRun(runs);
            return (
              <li key={course.id}>
                <Link
                  href={`/admin/courses/${encodeURIComponent(course.id)}`}
                  className={styles.row}
                >
                  <div className={styles.rowHead}>
                    <h3 className={styles.rowTitle}>{course.title || "(untitled)"}</h3>
                    <Badge tone="accent">{COURSE_TRACK_LABELS[course.track]}</Badge>
                    <Badge tone={courseStatusTone(course.status)}>
                      {COURSE_STATUS_LABEL[course.status]}
                    </Badge>
                  </div>
                  {course.tagline && (
                    <p className={styles.rowTagline}>{course.tagline}</p>
                  )}
                  <div className={styles.rowMeta}>
                    <span>{course.level || "No level set"}</span>
                    {course.estimatedWeeklyHours != null && (
                      <span>{course.estimatedWeeklyHours} h/week</span>
                    )}
                    {active ? (
                      <>
                        <span>
                          <strong>{active.label || active.id}</strong>{" "}
                          {COURSE_RUN_STATUS_LABEL[active.status].toLowerCase()}
                        </span>
                        <span>{taughtWeekCount(active)} weeks</span>
                        {runs.length > 1 && <span>{runs.length} runs</span>}
                      </>
                    ) : (
                      <span>{runsQuery.loading ? "Loading runs…" : "No runs yet"}</span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && total > 0 && (
        <AdminListFooter
          shownCount={shownCount}
          total={total}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRefresh={() => {
            reload();
            runsQuery.reload();
          }}
          refreshing={refreshing || runsQuery.refreshing}
          noun="courses"
        />
      )}

      <ActionToast toast={toast} onDismiss={dismiss} />
    </AdminPage>
  );
}
