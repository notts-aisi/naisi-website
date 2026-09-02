"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import { AdminLoadingBar, AdminPage } from "@/features/admin/adminList";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import {
  COURSE_PAGE_LIMITS,
  isSafeCoverImageUrl,
  type CoursePageDoc,
} from "@/lib/firestore/coursePages";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import { cohortLabel } from "@/lib/courses/cohortLabel";
import type { CourseDoc } from "@/lib/firestore/courses";
import { formatCivilDate, taughtWeekCount } from "./AdminCourseList";
import TemplatePicker, { type TemplatePickerGroup } from "./TemplatePicker";
import { useCourseRuns, useCourses } from "./useAdminCourses";
import {
  formatWireStamp,
  useCourseTemplates,
} from "./useTemplates";
import {
  generateCoursePageThemes,
  saveCoursePage,
  useCoursePage,
  type CoursePagePayload,
  type ThemeGenerationReceipt,
} from "./useCoursePage";
import styles from "./CoursePageEditor.module.css";

/**
 * THE PUBLIC PAGE EDITOR: `/admin/courses/[courseId]/page`.
 *
 * One form for the whole of `coursePages/{courseId}`, saved by ONE button.
 *
 * ## One save, and why it is not several
 *
 * `PUT /api/courses/[courseId]/page` is a FULL REPLACE: the body it receives
 * IS the document. A per-section save would therefore have to send the other
 * sections too, so every section would be able to clobber every other one, and
 * the first author to open two tabs would find out. So the editor holds the
 * whole page in one draft and sends the whole page once.
 *
 * The corollary is the rule the route states in capitals and this file honours
 * in `toPayload`: **`weeklyThemes` is always sent**, including when it is
 * empty. There is no "leave the themes alone" body, and a save that dropped
 * the key because the themes section was collapsed would be a save that
 * cleared the themes.
 *
 * ## The one exception: generating themes
 *
 * "Generate themes from" posts to its own route, which writes the themes AND
 * their provenance immediately. Provenance is server-owned for the reason
 * `courseRuns.templateId` is (provenance the editor can also type is not
 * provenance), so it cannot ride along in the PUT body. The generate button
 * therefore SAVES the themes on its own, and the receipt says so: the rest of
 * the form is still unsaved at that point, which the dirty banner keeps
 * showing.
 *
 * ## Reads client-direct, writes through the route
 *
 * `coursePages` is `allow read: if isSignedIn(); allow write: if false`. See
 * `useCoursePage.ts` for why that asymmetry is the design and not an
 * oversight.
 */

type Props = { courseId: string };

/** React list keys. Not ids: nothing here is ever stored under one. */
let rowSeq = 0;
function rowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

type ThemeRow = { key: string; weekNumber: string; title: string; blurb: string };
type FaqRow = { key: string; q: string; a: string };
type JourneyRow = { key: string; label: string; detail: string; dateKey: string };

type PageDraft = {
  headline: string;
  pitchBlocks: Block[];
  whoItIsFor: string;
  howSelectionWorks: string;
  membershipExpectation: string;
  formatText: string;
  sessionsText: string;
  weeklyHoursText: string;
  themes: ThemeRow[];
  /** "" = no sample week. A string because it is bound to a select. */
  sampleWeekNumber: string;
  faq: FaqRow[];
  journey: JourneyRow[];
  coverImageUrl: string;
  coverAlt: string;
  visualSeed: string;
};

function draftFrom(page: CoursePageDoc | null): PageDraft {
  return {
    headline: page?.headline ?? "",
    pitchBlocks: page?.pitchBlocks ?? [],
    whoItIsFor: page?.whoItIsFor ?? "",
    howSelectionWorks: page?.howSelectionWorks ?? "",
    membershipExpectation: page?.membershipExpectation ?? "",
    formatText: page?.formatText ?? "",
    sessionsText: page?.sessionsText ?? "",
    weeklyHoursText: page?.weeklyHoursText ?? "",
    themes: (page?.weeklyThemes ?? []).map((t) => ({
      key: rowKey(),
      weekNumber: String(t.weekNumber),
      title: t.title,
      blurb: t.blurb,
    })),
    sampleWeekNumber:
      page?.sampleWeekNumber != null ? String(page.sampleWeekNumber) : "",
    faq: (page?.faq ?? []).map((f) => ({ key: rowKey(), q: f.q, a: f.a })),
    journey: (page?.journey ?? []).map((s) => ({
      key: rowKey(),
      label: s.label,
      detail: s.detail,
      dateKey: s.dateKey ?? "",
    })),
    coverImageUrl: page?.coverImageUrl ?? "",
    coverAlt: page?.coverAlt ?? "",
    visualSeed: page?.visualSeed ?? "",
  };
}

/**
 * The dirty check. A JSON compare of the whole draft, deliberately: the draft
 * is a flat object of strings, small arrays and the block list, and a
 * field-by-field comparison here would be a second place to remember a new
 * field, which is exactly the kind of omission a dirty check hides rather than
 * reports.
 *
 * React keys are stripped first. They are minted fresh every time a draft is
 * seeded from a document, so a reload would otherwise make an untouched form
 * report unsaved changes: identical copy, different keys. Generating themes
 * does exactly that reload, so this is the difference between "saved" and a
 * banner that never goes away.
 */
function withoutKeys(draft: PageDraft): unknown {
  const strip = <T extends { key: string }>(rows: T[]) =>
    rows.map(({ key: _key, ...rest }) => rest);
  return {
    ...draft,
    themes: strip(draft.themes),
    faq: strip(draft.faq),
    journey: strip(draft.journey),
  };
}

function sameDraft(a: PageDraft, b: PageDraft): boolean {
  return JSON.stringify(withoutKeys(a)) === JSON.stringify(withoutKeys(b));
}

/** A new seed. Short, typeable, and visibly a seed rather than an id. */
function rollSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function CoursePageEditor({ courseId }: Props) {
  const { toast, run: runAction, dismiss } = useActionToast();
  const saving = toast?.phase === "saving";

  const { items: courses, loading: coursesLoading } = useCourses();
  const course = useMemo<CourseDoc | null>(
    () => courses.find((c) => c.id === courseId) ?? null,
    [courses, courseId],
  );

  const { items: pages, loading, error, reload } = useCoursePage(courseId);
  const stored = pages[0] ?? null;

  const runs = useCourseRuns(courseId);
  const templates = useCourseTemplates(courseId);

  // The saved baseline. Pinned to what we last SENT rather than to the fetched
  // document, because the read is one-shot: waiting for the doc to come back
  // would flicker the form to pre-save values and read dirty straight after a
  // save. (`CourseEditor` precedent.)
  const [saved, setSaved] = useState<PageDraft | null>(null);
  const base = useMemo(() => saved ?? draftFrom(stored), [saved, stored]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const page = draft ?? base;
  const dirty = !sameDraft(page, base);
  const patch = (p: Partial<PageDraft>) => setDraft({ ...page, ...p });

  const [formError, setFormError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [receipt, setReceipt] = useState<ThemeGenerationReceipt | null>(null);

  /**
   * The navigation guard. A tab closed or reloaded with unsaved copy in it
   * loses the copy, and this is the only warning the platform will give.
   * In-app links get their own confirm below; Next's App Router has no
   * route-change interception to hang one on.
   */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function confirmLeave(e: React.MouseEvent): void {
    if (!dirty) return;
    const ok = window.confirm(
      "You have unsaved changes on this page. Leave without saving?",
    );
    if (!ok) e.preventDefault();
  }

  // --- Row helpers, the MaterialListEditor idiom ---

  function moveRow<T>(rows: T[], index: number, dir: -1 | 1): T[] {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return rows;
    const next = rows.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  /**
   * Themes reorder by SWAPPING WEEK NUMBERS, not by swapping rows.
   *
   * The stored list is sorted by `weekNumber` at both ends (`sanitizeWeeklyThemes`
   * sorts, and the public list renders in that order), so moving a row without
   * moving its number would look right until the next save and then snap back.
   * Swapping the numbers is the move the author actually meant: "this theme is
   * week 3 now".
   */
  function moveTheme(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= page.themes.length) return;
    const rows = page.themes.slice();
    const a = rows[index];
    const b = rows[target];
    // Each row keeps its own content and takes the OTHER position's week
    // number, which is the same thing as swapping the two rows and then
    // swapping their numbers back, written once instead of twice.
    rows[index] = { ...b, weekNumber: a.weekNumber };
    rows[target] = { ...a, weekNumber: b.weekNumber };
    patch({ themes: rows });
  }

  function addTheme() {
    if (page.themes.length >= COURSE_PAGE_LIMITS.maxWeeklyThemes) return;
    // The next week number, so an author adding five rows does not type
    // 1..5 by hand and does not create five week ones (which the sanitiser
    // would silently deduplicate down to a single row).
    const used = page.themes
      .map((t) => Number(t.weekNumber))
      .filter((n) => Number.isFinite(n));
    const next = used.length > 0 ? Math.max(...used) + 1 : 1;
    patch({
      themes: [
        ...page.themes,
        { key: rowKey(), weekNumber: String(next), title: "", blurb: "" },
      ],
    });
  }

  // --- Save ---

  function toPayload(): CoursePagePayload | { error: string } {
    const themes: CoursePagePayload["weeklyThemes"] = [];
    const seen = new Set<number>();
    for (const row of page.themes) {
      const weekNumber = Number(row.weekNumber);
      if (!Number.isInteger(weekNumber) || weekNumber < 1
        || weekNumber > COURSE_PAGE_LIMITS.maxWeekNumber) {
        return {
          error: `Every theme needs a week number between 1 and ${COURSE_PAGE_LIMITS.maxWeekNumber}.`,
        };
      }
      // Checked HERE rather than left to the sanitiser: it drops the duplicate
      // silently, so the author would press Save, see success, and lose a row.
      if (seen.has(weekNumber)) {
        return { error: `Two themes are both week ${weekNumber}. Give each week one row.` };
      }
      seen.add(weekNumber);
      themes.push({ weekNumber, title: row.title, blurb: row.blurb });
    }

    for (const row of page.faq) {
      // Same reasoning: `sanitizeFaq` drops a question-less row.
      if (row.a.trim() && !row.q.trim()) {
        return { error: "An FAQ answer has no question. Add one, or remove the row." };
      }
    }

    const journey: CoursePagePayload["journey"] = [];
    for (const row of page.journey) {
      if (!row.label.trim()) {
        return { error: "Every journey step needs a label, or remove the row." };
      }
      if (row.dateKey && !isValidDateKey(row.dateKey)) {
        return { error: `"${row.dateKey}" is not a real date. Use YYYY-MM-DD.` };
      }
      const step: CoursePagePayload["journey"][number] = {
        label: row.label,
        detail: row.detail,
      };
      // ABSENT, never empty-string or null: `sanitizeJourney` only keeps a key
      // that is a real date, and the strip marks the current step by comparing
      // date keys.
      if (row.dateKey) step.dateKey = row.dateKey;
      journey.push(step);
    }

    const cover = page.coverImageUrl.trim();
    if (cover && !isSafeCoverImageUrl(cover)) {
      return { error: "A cover image must be an https link or a path on this site." };
    }
    if (cover && !page.coverAlt.trim()) {
      return { error: "A cover image needs a short description for screen readers." };
    }

    return {
      headline: page.headline,
      pitchBlocks: page.pitchBlocks,
      whoItIsFor: page.whoItIsFor,
      howSelectionWorks: page.howSelectionWorks,
      membershipExpectation: page.membershipExpectation,
      formatText: page.formatText,
      sessionsText: page.sessionsText,
      weeklyHoursText: page.weeklyHoursText,
      // ALWAYS sent. See the module comment.
      weeklyThemes: themes,
      sampleWeekNumber: page.sampleWeekNumber ? Number(page.sampleWeekNumber) : null,
      faq: page.faq.filter((f) => f.q.trim()).map((f) => ({ q: f.q, a: f.a })),
      journey,
      coverImageUrl: cover || null,
      coverAlt: page.coverAlt,
      visualSeed: page.visualSeed,
    };
  }

  async function handleSave() {
    const payload = toPayload();
    if ("error" in payload) {
      setFormError(payload.error);
      return;
    }
    setFormError(null);
    const sent = page;
    await runAction(
      async () => {
        await saveCoursePage(courseId, payload);
        setSaved(sent);
        setDraft(null);
      },
      { savingMessage: "Saving the page…", successMessage: "Page saved" },
    );
  }

  async function handleGenerate() {
    const source = selectedSource();
    if (!source) {
      setFormError("Pick a template or a run to generate the themes from.");
      return;
    }
    setFormError(null);
    await runAction(
      async () => {
        const result = await generateCoursePageThemes(courseId, {
          ...(source.kind === "template"
            ? { templateId: source.id }
            : { runId: source.id }),
          overwrite,
        });
        setReceipt(result);
        const themes = result.weeklyThemes.map((t) => ({
          key: rowKey(),
          weekNumber: String(t.weekNumber),
          title: t.title,
          blurb: t.blurb,
        }));
        // The route has ALREADY stored these themes, so they move on BOTH
        // sides at once: into the draft, so the form shows what is on the
        // document, and into the pinned baseline, so the dirty check stops
        // counting them.
        //
        // The baseline half is not cosmetic. Once any save has pinned a
        // baseline, `base` no longer follows the refetched document, so
        // without this the generated rows would read as unsaved for the rest
        // of the session: a banner that never clears, a navigation warning on
        // every link, and an author pressing Save to fix something that was
        // already saved. The rest of the form is untouched, so anything else
        // still unsaved stays unsaved, which is what the banner is for.
        setDraft({ ...page, themes });
        setSaved({ ...base, themes });
        reload();
      },
      { savingMessage: "Reading the curriculum…", successMessage: "Themes generated" },
    );
  }

  /** Turn the picker's prefixed id back into the source it names. */
  function selectedSource(): { kind: "template" | "run"; id: string } | null {
    if (sourceId.startsWith("t:")) return { kind: "template", id: sourceId.slice(2) };
    if (sourceId.startsWith("r:")) return { kind: "run", id: sourceId.slice(2) };
    return null;
  }

  const sourceGroups: TemplatePickerGroup[] = [
    {
      id: "templates",
      title: `Saved templates · ${course?.title || "this course"}`,
      rows: templates.templates.map((t) => ({
        id: `t:${t.id}`,
        kind: "template" as const,
        label: t.label || t.id,
        meta: [
          `saved ${formatWireStamp(t.savedAt)}`,
          `${t.weekCount} week${t.weekCount === 1 ? "" : "s"}`,
        ],
        hasRetrospective: t.retrospective !== null,
      })),
      emptyHint:
        "No snapshot of this course has been saved yet. Save one from a finished run and it becomes the master to generate from.",
    },
    {
      id: "runs",
      title: "Runs of this course",
      rows: runs.items.map((r) => ({
        id: `r:${r.id}`,
        kind: "run" as const,
        // The structured cohort where there is one; the admin label only as
        // the fallback, and only because this is an ADMIN surface. Nothing
        // from this picker reaches a visitor.
        label: cohortLabel(r) || r.label || r.id,
        meta: [
          r.academicYear || null,
          `starts ${formatCivilDate(r.startDate)}`,
          `${taughtWeekCount(r)} week${taughtWeekCount(r) === 1 ? "" : "s"}`,
          r.archived ? "archived" : null,
        ],
      })),
      emptyHint: "This course has no runs yet, so there are no live weeks to read.",
    },
  ];

  /**
   * The sample-week choices: one per theme row, plus whatever is already
   * stored even when no theme row claims that week.
   *
   * That last part is the whole point. `sampleWeekNumber` is authored against
   * a curriculum that is still being written and the themes are regenerated
   * from templates and runs, so week 6 routinely stops having a row. A select
   * whose value is not among its options renders as if nothing were selected,
   * so the author would see "No sample week", believe that, and clear a
   * setting the public page is still honouring: the page falls back to the
   * first published week only when the named one is not PUBLISHED, not when
   * its theme row is gone.
   *
   * So the stored week is appended as its own option, in week order, labelled
   * so the mismatch is visible rather than silently correct.
   */
  const sampleOptions = useMemo<ResponsiveSelectOption[]>(() => {
    const weeks = page.themes
      .map((t) => Number(t.weekNumber))
      .filter((n) => Number.isInteger(n) && n >= 1);
    const stored = Number(page.sampleWeekNumber);
    const orphan =
      page.sampleWeekNumber !== ""
      && Number.isInteger(stored)
      && stored >= 1
      && !weeks.includes(stored);
    const rows = [
      ...weeks.map((n) => ({ n, label: `Week ${n}` })),
      ...(orphan ? [{ n: stored, label: `Week ${stored} (no theme row)` }] : []),
    ].sort((a, b) => a.n - b.n);
    return [
      { value: "", label: "No sample week" },
      ...rows.map((r) => ({ value: String(r.n), label: r.label })),
    ];
  }, [page.themes, page.sampleWeekNumber]);

  if (loading || coursesLoading) {
    return (
      <AdminPage>
        <AdminLoadingBar label="Loading the page…" />
      </AdminPage>
    );
  }

  if (error) {
    return (
      <AdminPage>
        <Card padding="lg">
          <p className={styles.error}>Couldn&apos;t load the page: {error.message}</p>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </Card>
      </AdminPage>
    );
  }

  const previewHref = `/courses/${encodeURIComponent(courseId)}`;

  return (
    <AdminPage>
      <ActionToast toast={toast} onDismiss={dismiss} />

      <header className={styles.head}>
        <div>
          <p className={styles.crumb}>
            <Link
              href={`/admin/courses/${encodeURIComponent(courseId)}`}
              onClick={confirmLeave}
            >
              ← {course?.title || "Course"}
            </Link>
          </p>
          <h1 className={styles.title}>Public page</h1>
          <p className={styles.lede}>
            What a visitor reads before they apply. This is separate from the
            course&apos;s own introduction, and it is only live once the course
            itself is published.
          </p>
        </div>
        <div className={styles.headActions}>
          <Link
            href={previewHref}
            className={styles.preview}
            target="_blank"
            rel="noreferrer"
          >
            Preview
          </Link>
        </div>
      </header>

      {stored?.themesSourceLabel ? (
        <p className={styles.provenance}>
          Themes generated from <strong>{stored.themesSourceLabel}</strong>.
        </p>
      ) : null}

      {/* === The pitch === */}
      <Card padding="lg">
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>The pitch</h2>

          <Field
            id="page-headline"
            label="Headline"
            hint="One line under the course title. Replaces the course's tagline on the public page."
          >
            <Input
              id="page-headline"
              value={page.headline}
              maxLength={COURSE_PAGE_LIMITS.headline}
              onChange={(e) => patch({ headline: e.target.value })}
              placeholder="Seven weeks on how to tell whether a model is doing what you asked"
              disabled={saving}
            />
          </Field>

          <div>
            <h3 className={styles.subheading}>Body</h3>
            <p className={styles.hint}>
              The long pitch. Images upload to <code>course-images</code>.
            </p>
            <BlockEditor
              draftId={`${courseId}-page`}
              storagePrefix="course-images"
              blocks={page.pitchBlocks}
              onChange={(pitchBlocks) => patch({ pitchBlocks })}
              disabled={saving}
            />
          </div>
        </section>
      </Card>

      {/* === The essentials === */}
      <Card padding="lg">
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>The essentials</h2>
          <p className={styles.hint}>
            The facts rail. Dates are not typed here: they come from the
            admission round, or from the run.
          </p>

          <div className={styles.grid}>
            <Field id="page-format" label="Format" hint="e.g. In person, in small groups">
              <Input
                id="page-format"
                value={page.formatText}
                maxLength={COURSE_PAGE_LIMITS.formatText}
                onChange={(e) => patch({ formatText: e.target.value })}
                disabled={saving}
              />
            </Field>
            <Field id="page-sessions" label="Sessions" hint="e.g. 7 weekly sessions, 90 minutes">
              <Input
                id="page-sessions"
                value={page.sessionsText}
                maxLength={COURSE_PAGE_LIMITS.sessionsText}
                onChange={(e) => patch({ sessionsText: e.target.value })}
                disabled={saving}
              />
            </Field>
            <Field id="page-hours" label="Weekly hours" hint="e.g. 4 to 5 hours a week">
              <Input
                id="page-hours"
                value={page.weeklyHoursText}
                maxLength={COURSE_PAGE_LIMITS.weeklyHoursText}
                onChange={(e) => patch({ weeklyHoursText: e.target.value })}
                disabled={saving}
              />
            </Field>
          </div>

          <Field id="page-who" label="Who it is for">
            <CountedTextarea
              id="page-who"
              rows={5}
              value={page.whoItIsFor}
              max={COURSE_PAGE_LIMITS.whoItIsFor}
              onChange={(e) => patch({ whoItIsFor: e.target.value })}
              placeholder="No prerequisites beyond curiosity and the time. First years welcome."
              disabled={saving}
            />
          </Field>

          <Field id="page-selection" label="How we select">
            <CountedTextarea
              id="page-selection"
              rows={5}
              value={page.howSelectionWorks}
              max={COURSE_PAGE_LIMITS.howSelectionWorks}
              onChange={(e) => patch({ howSelectionWorks: e.target.value })}
              placeholder="Two reviewers read every application without names attached."
              disabled={saving}
            />
          </Field>

          <Field id="page-membership" label="Membership">
            <CountedTextarea
              id="page-membership"
              rows={4}
              value={page.membershipExpectation}
              max={COURSE_PAGE_LIMITS.membershipExpectation}
              onChange={(e) => patch({ membershipExpectation: e.target.value })}
              placeholder="We ask everyone who takes a place to join the society."
              disabled={saving}
            />
          </Field>
        </section>
      </Card>

      {/* === Weekly themes === */}
      <Card padding="lg">
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Week by week</h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={addTheme}
              disabled={saving || page.themes.length >= COURSE_PAGE_LIMITS.maxWeeklyThemes}
            >
              Add a week
            </Button>
          </div>
          <p className={styles.hint}>
            One line per week, written for someone deciding whether to apply.
            Generate them from the curriculum below, then edit.
          </p>

          {page.themes.length === 0 && (
            <p className={styles.empty}>
              No weekly themes yet. The public page hides the section entirely
              until there is at least one.
            </p>
          )}

          <ol className={styles.rows}>
            {page.themes.map((row, i) => (
              <li key={row.key}>
                <Card padding="md">
                  <div className={styles.rowHead}>
                    <div className={styles.weekField}>
                      <label className={styles.rowLabel} htmlFor={`theme-week-${row.key}`}>
                        Week
                      </label>
                      <Input
                        id={`theme-week-${row.key}`}
                        type="number"
                        min={1}
                        max={COURSE_PAGE_LIMITS.maxWeekNumber}
                        value={row.weekNumber}
                        onChange={(e) => {
                          const themes = page.themes.slice();
                          themes[i] = { ...row, weekNumber: e.target.value };
                          patch({ themes });
                        }}
                        disabled={saving}
                      />
                    </div>
                    <div className={styles.controls}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => moveTheme(i, -1)}
                        disabled={saving || i === 0}
                        aria-label={`Move theme ${i + 1} earlier`}
                        title="Move earlier"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => moveTheme(i, 1)}
                        disabled={saving || i === page.themes.length - 1}
                        aria-label={`Move theme ${i + 1} later`}
                        title="Move later"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        onClick={() =>
                          patch({ themes: page.themes.filter((t) => t.key !== row.key) })
                        }
                        disabled={saving}
                        aria-label={`Remove theme ${i + 1}`}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <Field id={`theme-title-${row.key}`} label="Title">
                    <Input
                      id={`theme-title-${row.key}`}
                      value={row.title}
                      maxLength={COURSE_PAGE_LIMITS.themeTitle}
                      onChange={(e) => {
                        const themes = page.themes.slice();
                        themes[i] = { ...row, title: e.target.value };
                        patch({ themes });
                      }}
                      disabled={saving}
                    />
                  </Field>
                  <Field id={`theme-blurb-${row.key}`} label="Blurb">
                    <CountedTextarea
                      id={`theme-blurb-${row.key}`}
                      rows={3}
                      value={row.blurb}
                      max={COURSE_PAGE_LIMITS.themeBlurb}
                      onChange={(e) => {
                        const themes = page.themes.slice();
                        themes[i] = { ...row, blurb: e.target.value };
                        patch({ themes });
                      }}
                      disabled={saving}
                    />
                  </Field>
                </Card>
              </li>
            ))}
          </ol>

          <div className={styles.generate}>
            <h3 className={styles.subheading}>Generate themes from</h3>
            <p className={styles.hint}>
              A saved template, or a run&apos;s published weeks. A theme you
              have already written a blurb for is kept, and a week the source
              does not have at all is kept too, unless you tick Replace.
              Generating SAVES the themes immediately; the rest of this form
              still needs the Save button.
            </p>

            {templates.error && (
              <p className={styles.error}>
                Couldn&apos;t load saved templates: {templates.error.message}
              </p>
            )}

            <TemplatePicker
              ariaLabel="Theme source"
              groups={sourceGroups}
              value={sourceId}
              onChange={setSourceId}
              loading={templates.loading || runs.loading}
              emptyState={
                <p className={styles.hint}>
                  Nothing to generate from yet: this course has no runs and no
                  saved templates.
                </p>
              }
            />

            <div className={styles.generateRow}>
              <Switch
                checked={overwrite}
                onChange={setOverwrite}
                label="Replace"
                description="overwrite blurbs you have edited, and drop weeks the source does not have"
              />
              <Button
                variant="secondary"
                onClick={handleGenerate}
                disabled={saving || !sourceId}
              >
                Generate themes
              </Button>
            </div>

            {receipt && (
              <div className={styles.receipt}>
                <p className={styles.receiptLine}>
                  {receipt.generated} week{receipt.generated === 1 ? "" : "s"} written
                  from {receipt.source.label || "the source"}.
                </p>
                {receipt.kept.length > 0 && (
                  <p className={styles.receiptLine}>
                    Kept your wording on{" "}
                    {receipt.kept.map((k) => `week ${k.weekNumber}`).join(", ")}.
                  </p>
                )}
                {receipt.carriedForward.length > 0 && (
                  <p className={styles.receiptLine}>
                    Carried forward (the source has no such week):{" "}
                    {receipt.carriedForward
                      .map((k) => `week ${k.weekNumber}`)
                      .join(", ")}
                    .
                  </p>
                )}
              </div>
            )}
          </div>

          <Field
            id="page-sample"
            label="Sample week"
            hint="Which week the public page shows in full. Falls back to the first published week when this one is not published yet."
          >
            <ResponsiveSelect
              value={page.sampleWeekNumber}
              onChange={(sampleWeekNumber) => patch({ sampleWeekNumber })}
              options={sampleOptions}
              ariaLabel="Sample week"
              disabled={saving}
            />
          </Field>
        </section>
      </Card>

      {/* === The journey === */}
      <Card padding="lg">
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>How the term goes</h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                patch({
                  journey: [
                    ...page.journey,
                    { key: rowKey(), label: "", detail: "", dateKey: "" },
                  ],
                })
              }
              disabled={saving || page.journey.length >= COURSE_PAGE_LIMITS.maxJourney}
            >
              Add a step
            </Button>
          </div>
          <p className={styles.hint}>
            Applications open, applications close, decisions, first session, last
            session. A step with a date is marked as the current one when that
            day arrives, in Nottingham time.
          </p>

          <ol className={styles.rows}>
            {page.journey.map((row, i) => (
              <li key={row.key}>
                <Card padding="md">
                  <div className={styles.rowHead}>
                    <span className={styles.rowIndex}>{i + 1}</span>
                    <div className={styles.controls}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => patch({ journey: moveRow(page.journey, i, -1) })}
                        disabled={saving || i === 0}
                        aria-label={`Move step ${i + 1} earlier`}
                        title="Move earlier"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => patch({ journey: moveRow(page.journey, i, 1) })}
                        disabled={saving || i === page.journey.length - 1}
                        aria-label={`Move step ${i + 1} later`}
                        title="Move later"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        onClick={() =>
                          patch({ journey: page.journey.filter((s) => s.key !== row.key) })
                        }
                        disabled={saving}
                        aria-label={`Remove step ${i + 1}`}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className={styles.grid}>
                    <Field id={`journey-label-${row.key}`} label="Step">
                      <Input
                        id={`journey-label-${row.key}`}
                        value={row.label}
                        maxLength={COURSE_PAGE_LIMITS.journeyLabel}
                        onChange={(e) => {
                          const journey = page.journey.slice();
                          journey[i] = { ...row, label: e.target.value };
                          patch({ journey });
                        }}
                        placeholder="Applications close"
                        disabled={saving}
                      />
                    </Field>
                    <Field
                      id={`journey-date-${row.key}`}
                      label="Date"
                      hint="YYYY-MM-DD, or blank"
                    >
                      <Input
                        id={`journey-date-${row.key}`}
                        value={row.dateKey}
                        onChange={(e) => {
                          const journey = page.journey.slice();
                          journey[i] = { ...row, dateKey: e.target.value.trim() };
                          patch({ journey });
                        }}
                        placeholder="2026-10-18"
                        disabled={saving}
                      />
                    </Field>
                  </div>
                  <Field id={`journey-detail-${row.key}`} label="Detail">
                    <Input
                      id={`journey-detail-${row.key}`}
                      value={row.detail}
                      maxLength={COURSE_PAGE_LIMITS.journeyDetail}
                      onChange={(e) => {
                        const journey = page.journey.slice();
                        journey[i] = { ...row, detail: e.target.value };
                        patch({ journey });
                      }}
                      placeholder="23:59, and we mean it"
                      disabled={saving}
                    />
                  </Field>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      </Card>

      {/* === FAQ === */}
      <Card padding="lg">
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Questions people ask</h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                patch({ faq: [...page.faq, { key: rowKey(), q: "", a: "" }] })
              }
              disabled={saving || page.faq.length >= COURSE_PAGE_LIMITS.maxFaq}
            >
              Add a question
            </Button>
          </div>

          <ol className={styles.rows}>
            {page.faq.map((row, i) => (
              <li key={row.key}>
                <Card padding="md">
                  <div className={styles.rowHead}>
                    <span className={styles.rowIndex}>{i + 1}</span>
                    <div className={styles.controls}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => patch({ faq: moveRow(page.faq, i, -1) })}
                        disabled={saving || i === 0}
                        aria-label={`Move question ${i + 1} earlier`}
                        title="Move earlier"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => patch({ faq: moveRow(page.faq, i, 1) })}
                        disabled={saving || i === page.faq.length - 1}
                        aria-label={`Move question ${i + 1} later`}
                        title="Move later"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        onClick={() =>
                          patch({ faq: page.faq.filter((f) => f.key !== row.key) })
                        }
                        disabled={saving}
                        aria-label={`Remove question ${i + 1}`}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <Field id={`faq-q-${row.key}`} label="Question">
                    <Input
                      id={`faq-q-${row.key}`}
                      value={row.q}
                      maxLength={COURSE_PAGE_LIMITS.faqQuestion}
                      onChange={(e) => {
                        const faq = page.faq.slice();
                        faq[i] = { ...row, q: e.target.value };
                        patch({ faq });
                      }}
                      disabled={saving}
                    />
                  </Field>
                  <Field id={`faq-a-${row.key}`} label="Answer">
                    <CountedTextarea
                      id={`faq-a-${row.key}`}
                      rows={4}
                      value={row.a}
                      max={COURSE_PAGE_LIMITS.faqAnswer}
                      onChange={(e) => {
                        const faq = page.faq.slice();
                        faq[i] = { ...row, a: e.target.value };
                        patch({ faq });
                      }}
                      disabled={saving}
                    />
                  </Field>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      </Card>

      {/* === Artwork === */}
      <Card padding="lg">
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Artwork</h2>
          <p className={styles.hint}>
            Every course gets a generated visual drawn from its seed and its
            track. A cover image replaces it entirely, on the course page and on
            the catalogue card.
          </p>

          <div className={styles.grid}>
            <Field
              id="page-seed"
              label="Visual seed"
              hint="Change it to redraw the generated artwork."
            >
              <Input
                id="page-seed"
                value={page.visualSeed}
                maxLength={COURSE_PAGE_LIMITS.visualSeed}
                onChange={(e) => patch({ visualSeed: e.target.value })}
                placeholder={courseId}
                disabled={saving}
              />
            </Field>
            <div className={styles.rerollCell}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patch({ visualSeed: rollSeed() })}
                disabled={saving}
              >
                Reroll
              </Button>
            </div>
          </div>

          <Field
            id="page-cover"
            label="Cover image URL"
            hint="An https link, or a path on this site. Leave blank for the generated visual."
          >
            <Input
              id="page-cover"
              value={page.coverImageUrl}
              maxLength={COURSE_PAGE_LIMITS.coverImageUrl}
              onChange={(e) => patch({ coverImageUrl: e.target.value })}
              disabled={saving}
            />
          </Field>

          <Field
            id="page-cover-alt"
            label="Cover image description"
            hint="Required when there is a cover image. What a screen reader announces."
          >
            <Input
              id="page-cover-alt"
              value={page.coverAlt}
              maxLength={COURSE_PAGE_LIMITS.coverAlt}
              onChange={(e) => patch({ coverAlt: e.target.value })}
              disabled={saving}
            />
          </Field>
        </section>
      </Card>

      {formError && <p className={styles.error}>{formError}</p>}

      <div className={styles.actions}>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save page"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(null);
            setFormError(null);
          }}
          disabled={saving || !dirty}
        >
          Revert
        </Button>
        {dirty ? (
          <span className={styles.dirty}>Unsaved changes.</span>
        ) : (
          <span className={styles.status}>No unsaved changes.</span>
        )}
      </div>
    </AdminPage>
  );
}
