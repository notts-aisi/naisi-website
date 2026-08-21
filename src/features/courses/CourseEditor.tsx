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
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { AdminLoadingBar, AdminPage } from "@/features/admin/adminList";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import {
  COURSE_FIELD_LIMITS,
  COURSE_RUN_STATUS_LABEL,
  COURSE_STATUS_LABEL,
  COURSE_TRACK_LABELS,
  type CourseDoc,
  type CourseRunDoc,
  type CourseTrack,
} from "@/lib/firestore/courses";
import { ACADEMIC_YEAR_PATTERN, currentAcademicYear } from "@/lib/firestore/users";
import {
  TRACK_OPTIONS,
  courseStatusTone,
  formatCivilDate,
  levelOptions,
  runStatusTone,
  taughtWeekCount,
} from "./AdminCourseList";
import { createRun, publishCourse, updateCourse } from "./courseMutations";
import { useCourseRuns, useCourses } from "./useAdminCourses";
import styles from "./adminCourses.module.css";

/**
 * The editable half of a course doc. `weeklyHours` stays a string because it is
 * bound to a number input — the parse (and its error) belongs at save time, not
 * on every keystroke.
 */
type MetaDraft = {
  title: string;
  tagline: string;
  track: CourseTrack;
  level: string;
  weeklyHours: string;
  summaryBlocks: Block[];
};

function metaFromCourse(course: CourseDoc | null): MetaDraft {
  return {
    title: course?.title ?? "",
    tagline: course?.tagline ?? "",
    track: course?.track ?? "general",
    level: course?.level ?? "",
    weeklyHours:
      course?.estimatedWeeklyHours != null ? String(course.estimatedWeeklyHours) : "",
    summaryBlocks: course?.summaryBlocks ?? [],
  };
}

function sameMeta(a: MetaDraft, b: MetaDraft): boolean {
  return (
    a.title === b.title &&
    a.tagline === b.tagline &&
    a.track === b.track &&
    a.level === b.level &&
    a.weeklyHours === b.weeklyHours &&
    JSON.stringify(a.summaryBlocks) === JSON.stringify(b.summaryBlocks)
  );
}

export default function CourseEditor({ courseId }: { courseId: string }) {
  const router = useRouter();
  const { toast, run: runAction, dismiss } = useActionToast();
  const saving = toast?.phase === "saving";

  // The course list is a single one-shot read of a tens-of-docs collection, so
  // picking this course out of it costs nothing extra and keeps the hook
  // surface to the four in useAdminCourses.
  const { items: courses, loading, error, reload } = useCourses();
  const runs = useCourseRuns(courseId);

  const course = useMemo(
    () => courses.find((c: CourseDoc) => c.id === courseId) ?? null,
    [courses, courseId],
  );

  // --- Meta form: local edits layered over the fetched doc ---
  const [draft, setDraft] = useState<Partial<MetaDraft>>({});
  /**
   * What we last wrote, used as the dirty-check baseline. The list is one-shot
   * rather than an onSnapshot, so a save can't wait for the doc to come back —
   * pinning the baseline to the payload we sent stops the form flickering back
   * to pre-save values and stops it reading dirty straight after a save.
   */
  const [saved, setSaved] = useState<MetaDraft | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const base = useMemo(() => saved ?? metaFromCourse(course), [saved, course]);
  const meta = useMemo<MetaDraft>(() => ({ ...base, ...draft }), [base, draft]);
  const dirty = !sameMeta(meta, base);
  const patch = (p: Partial<MetaDraft>) => setDraft((d) => ({ ...d, ...p }));

  // --- Publish control ---
  const [showcaseChoice, setShowcaseChoice] = useState<string | null>(null);
  const showcase = showcaseChoice ?? course?.showcaseRunId ?? "";

  const showcaseOptions = useMemo<ResponsiveSelectOption[]>(() => {
    // Draft runs are excluded on purpose: the showcase run is what the PUBLIC
    // course page renders its curriculum from, and a draft is by definition
    // not ready to be the shop window.
    const opts: ResponsiveSelectOption[] = [
      { value: "", label: "— no curriculum preview —" },
      ...runs.items
        .filter((r: CourseRunDoc) => r.status !== "draft")
        .map((r: CourseRunDoc) => ({
          value: r.id,
          label: `${r.label || r.id} · ${COURSE_RUN_STATUS_LABEL[r.status]}`,
        })),
    ];
    // A run that has since gone back to draft would otherwise vanish from the
    // control while still being the stored value.
    if (showcase && !opts.some((o) => o.value === showcase)) {
      opts.push({ value: showcase, label: `${showcase} (not published)` });
    }
    return opts;
  }, [runs.items, showcase]);

  // --- New run form ---
  const [addingRun, setAddingRun] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [runYear, setRunYear] = useState(() => currentAcademicYear());
  const [runStart, setRunStart] = useState("");
  const [runError, setRunError] = useState<string | null>(null);

  async function handleSave() {
    if (!course) return;
    const title = meta.title.trim();
    if (!title) {
      setMetaError("A course needs a title.");
      return;
    }
    let hours: number | null = null;
    if (meta.weeklyHours.trim()) {
      const parsed = Number(meta.weeklyHours);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMetaError("Weekly hours must be a positive number (or left blank).");
        return;
      }
      hours = Math.round(parsed);
    }
    const tagline = meta.tagline.trim();
    setMetaError(null);
    await runAction(
      async () => {
        await updateCourse(courseId, {
          title,
          tagline,
          track: meta.track,
          level: meta.level,
          estimatedWeeklyHours: hours,
          summaryBlocks: meta.summaryBlocks,
        });
        setSaved({
          title,
          tagline,
          track: meta.track,
          level: meta.level,
          weeklyHours: hours == null ? "" : String(hours),
          summaryBlocks: meta.summaryBlocks,
        });
        setDraft({});
        reload();
      },
      { savingMessage: "Saving course…", successMessage: "Course saved" },
    );
  }

  async function handlePublish() {
    if (!course) return;
    const target = showcase || null;
    const published = course.status === "published";
    const question = published
      ? `Update the public curriculum preview for “${course.title}”?`
      : `Publish “${course.title}” to the public catalogue? The course page becomes visible to everyone, signed in or not.`;
    // window.confirm on purpose: the shared Modal primitive lands with the
    // learning space (P7), and a destructive-ish admin confirm doesn't justify
    // building it early.
    if (!window.confirm(question)) return;
    await runAction(
      async () => {
        await publishCourse(courseId, target);
        setShowcaseChoice(null);
        reload();
      },
      {
        savingMessage: published ? "Updating…" : "Publishing…",
        successMessage: published ? "Showcase updated" : "Course published",
      },
    );
  }

  async function handleCreateRun(e: React.FormEvent) {
    e.preventDefault();
    if (!course) return;
    const label = runLabel.trim();
    if (!label) {
      setRunError("Give the run a label, e.g. “Autumn 2026”.");
      return;
    }
    if (!ACADEMIC_YEAR_PATTERN.test(runYear)) {
      setRunError("Academic year must look like 2026/27.");
      return;
    }
    if (!isValidDateKey(runStart)) {
      setRunError("Pick the date week 1 starts.");
      return;
    }
    setRunError(null);
    let newRunId = "";
    await runAction(
      async () => {
        // courseTitle is denormalised onto the run, so it takes the SAVED
        // title — an unsaved rename in the form above must not leak into it.
        newRunId = await createRun(
          { id: course.id, title: course.title },
          { label, academicYear: runYear, startDate: runStart },
        );
      },
      { savingMessage: "Creating run…", successMessage: "Run created" },
    );
    if (newRunId) {
      router.push(
        `/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(newRunId)}`,
      );
    }
  }

  if (loading) {
    return (
      <AdminPage>
        <Card padding="md">
          <AdminLoadingBar label="Loading course…" />
        </Card>
      </AdminPage>
    );
  }

  if (error) {
    return (
      <AdminPage>
        <Link href="/admin/courses" className={styles.backLink}>
          ← All courses
        </Link>
        <Card padding="md">
          <p className={styles.error}>Couldn&apos;t load this course: {error.message}</p>
        </Card>
      </AdminPage>
    );
  }

  if (!course) {
    return (
      <AdminPage>
        <Link href="/admin/courses" className={styles.backLink}>
          ← All courses
        </Link>
        <Card padding="lg">
          <h2 className={styles.emptyTitle}>Course not found</h2>
          <p className={styles.emptyBody}>
            No course with the id <code>{courseId}</code>. It may have been deleted, or
            the link may be stale.
          </p>
        </Card>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <div className={styles.wrap}>
        <Link href="/admin/courses" className={styles.backLink}>
          ← All courses
        </Link>

        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{course.title || "(untitled course)"}</h1>
            <p className={styles.subtitle}>
              {COURSE_TRACK_LABELS[course.track]} · {course.level || "no level set"} ·{" "}
              {runs.loading
                ? "loading runs…"
                : `${runs.items.length} run${runs.items.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className={styles.formActions}>
            {dirty && <Badge tone="warning">Unsaved changes</Badge>}
            <Badge tone={courseStatusTone(course.status)}>
              {COURSE_STATUS_LABEL[course.status]}
            </Badge>
          </div>
        </header>

        {/* === Meta === */}
        <Card padding="lg">
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Course details</h2>
              <p className={styles.sectionHint}>Shown on the public catalogue card.</p>
            </div>

            <div className={styles.form}>
              <div className={styles.formGrid}>
                <div className={styles.formSpan}>
                  <Field id="course-title" label="Title">
                    <Input
                      id="course-title"
                      value={meta.title}
                      onChange={(e) => patch({ title: e.target.value })}
                      maxLength={COURSE_FIELD_LIMITS.title}
                      disabled={saving}
                    />
                  </Field>
                </div>

                <div className={styles.formSpan}>
                  <Field
                    id="course-tagline"
                    label="Tagline"
                    hint="One line, shown under the title on the catalogue card."
                  >
                    <CountedTextarea
                      id="course-tagline"
                      value={meta.tagline}
                      onChange={(e) => patch({ tagline: e.target.value })}
                      max={COURSE_FIELD_LIMITS.tagline}
                      rows={2}
                      disabled={saving}
                    />
                  </Field>
                </div>

                <Field id="course-track" label="Track">
                  <ResponsiveSelect<CourseTrack>
                    value={meta.track}
                    onChange={(track) => patch({ track })}
                    options={TRACK_OPTIONS}
                    ariaLabel="Track"
                    disabled={saving}
                  />
                </Field>

                <Field id="course-level" label="Level">
                  <ResponsiveSelect
                    value={meta.level}
                    onChange={(level) => patch({ level })}
                    options={levelOptions(meta.level)}
                    ariaLabel="Level"
                    disabled={saving}
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
                    value={meta.weeklyHours}
                    onChange={(e) => patch({ weeklyHours: e.target.value })}
                    disabled={saving}
                  />
                </Field>
              </div>

              <div>
                <h3 className={styles.subheading}>Introduction</h3>
                <p className={styles.subheadingHint}>
                  The intro shown on the public course page, above the curriculum.
                </p>
                {/*
                  Same wiring as the email-designs editor: BlockEditor owns a
                  Block[] field and hands the whole array back on change.
                  `storagePrefix` needs a matching storage.rules block for
                  `course-images/{courseId}/**` — image uploads fail closed
                  without one (see the application-emails comment in
                  storage.rules for the last time that bit).
                */}
                <BlockEditor
                  draftId={courseId}
                  storagePrefix="course-images"
                  blocks={meta.summaryBlocks}
                  onChange={(summaryBlocks) => patch({ summaryBlocks })}
                  disabled={saving}
                />
              </div>

              {metaError && <p className={styles.error}>{metaError}</p>}

              <div className={styles.formActions}>
                <Button onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft({});
                    setMetaError(null);
                  }}
                  disabled={saving || !dirty}
                >
                  Revert
                </Button>
                {!dirty && <span className={styles.status}>No unsaved changes.</span>}
              </div>
            </div>
          </section>
        </Card>

        {/* === Publish === */}
        <Card padding="lg">
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Publishing</h2>
              <p className={styles.sectionHint}>
                {course.status === "published"
                  ? "Live on the public catalogue."
                  : "Not visible to the public yet."}
              </p>
            </div>

            <div className={styles.form}>
              <div className={styles.formGrid}>
                <Field
                  id="course-showcase"
                  label="Showcase run"
                  hint="Whose curriculum the public course page displays."
                >
                  <ResponsiveSelect
                    value={showcase}
                    onChange={setShowcaseChoice}
                    options={showcaseOptions}
                    ariaLabel="Showcase run"
                    disabled={saving}
                  />
                </Field>
              </div>

              {showcaseOptions.length === 1 && (
                <p className={styles.status}>
                  No run is out of draft yet, so there is nothing to preview publicly.
                  Move a run to applications-open (or later) from its own page first.
                </p>
              )}

              <div className={styles.formActions}>
                <Button onClick={handlePublish} disabled={saving}>
                  {course.status === "published" ? "Update showcase run" : "Publish course"}
                </Button>
                {dirty && (
                  <span className={styles.status}>
                    Save your edits first — publishing doesn&apos;t include them.
                  </span>
                )}
              </div>
            </div>
          </section>
        </Card>

        {/* === Runs === */}
        <Card padding="lg">
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Runs</h2>
              <Button
                variant={addingRun ? "ghost" : "secondary"}
                size="sm"
                onClick={() => {
                  setRunError(null);
                  setAddingRun((a) => !a);
                }}
              >
                {addingRun ? "Cancel" : "New run"}
              </Button>
            </div>
            <p className={styles.sectionHint}>
              One delivery of this course — its dates, applications, weeks and groups.
            </p>

            {addingRun && (
              <form onSubmit={handleCreateRun} className={styles.form}>
                <div className={styles.formGrid}>
                  <Field id="run-label" label="Label">
                    <Input
                      id="run-label"
                      value={runLabel}
                      onChange={(e) => setRunLabel(e.target.value)}
                      maxLength={COURSE_FIELD_LIMITS.runLabel}
                      placeholder="Autumn 2026"
                      required
                    />
                  </Field>

                  <Field
                    id="run-year"
                    label="Academic year"
                    hint="Format 2026/27. Matches the paid-membership tag."
                  >
                    <Input
                      id="run-year"
                      value={runYear}
                      onChange={(e) => setRunYear(e.target.value)}
                      maxLength={COURSE_FIELD_LIMITS.academicYear}
                      placeholder={currentAcademicYear()}
                      required
                    />
                  </Field>

                  <Field
                    id="run-start"
                    label="Week 1 starts"
                    hint="A civil date — every week rolls on this weekday."
                  >
                    <Input
                      id="run-start"
                      type="date"
                      value={runStart}
                      onChange={(e) => setRunStart(e.target.value)}
                      required
                    />
                  </Field>
                </div>

                {runError && <p className={styles.error}>{runError}</p>}

                <div className={styles.formActions}>
                  <Button type="submit" disabled={saving}>
                    {saving ? "Creating…" : "Create run"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setAddingRun(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {runs.loading && <AdminLoadingBar label="Loading runs…" />}

            {runs.error && (
              <p className={styles.error}>
                Couldn&apos;t load runs: {runs.error.message}
              </p>
            )}

            {!runs.loading && !runs.error && runs.items.length === 0 && (
              <p className={styles.emptyBody}>
                No runs yet. A course needs at least one before anyone can apply.
              </p>
            )}

            {runs.items.length > 0 && (
              <ul className={styles.list}>
                {runs.items.map((run: CourseRunDoc) => (
                  <li key={run.id}>
                    <Link
                      href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(run.id)}`}
                      className={styles.row}
                    >
                      <div className={styles.rowHead}>
                        <h3 className={styles.rowTitle}>{run.label || run.id}</h3>
                        <Badge tone={runStatusTone(run.status)}>
                          {COURSE_RUN_STATUS_LABEL[run.status]}
                        </Badge>
                        {course.showcaseRunId === run.id && (
                          <Badge tone="accent">Showcased</Badge>
                        )}
                      </div>
                      <div className={styles.rowMeta}>
                        <span>{run.academicYear || "no year set"}</span>
                        <span>Starts {formatCivilDate(run.startDate)}</span>
                        <span>{taughtWeekCount(run)} weeks</span>
                        <span>
                          {run.groupCount} group{run.groupCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {!runs.loading && runs.items.length > 0 && (
              <div className={styles.formActions}>
                <span className={styles.status}>
                  {runs.refreshing ? "Refreshing…" : `${runs.items.length} run${runs.items.length === 1 ? "" : "s"}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => runs.reload()}
                  disabled={runs.refreshing}
                >
                  Refresh
                </Button>
              </div>
            )}
          </section>
        </Card>
      </div>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </AdminPage>
  );
}
