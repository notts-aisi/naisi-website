"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Switch from "@/components/ui/Switch";
import { COURSE_STATUS_LABEL, type CourseDoc } from "@/lib/firestore/courses";
import { updateCourse } from "./courseMutations";
import useDestroy, { type UseDestroy } from "./useDestroy";
import {
  BlockerList,
  DangerDisclosure,
  DestroyDialog,
  InterruptedBanner,
  UnfinishedNotice,
} from "./RunDangerZone";
// Two stylesheets, deliberately. `shared` is the danger-zone vocabulary the
// run zone owns and this surface renders verbatim — one set of rules for one
// set of components, so the two confirmations cannot drift visually. `styles`
// holds only what is peculiar to the course level.
import styles from "./CourseDangerZone.module.css";
import shared from "./RunDangerZone.module.css";

/**
 * The course's end-of-life controls — the same two paths as the run's, one
 * level up, and rendered with the same components on purpose: a destroy
 * confirmation that looks different depending on what it is destroying is a
 * confirmation people stop reading.
 *
 * ── WHAT IS DIFFERENT UP HERE ───────────────────────────────────────────────
 * ARCHIVE is not a new field. A course already has `status: "archived"` and
 * `updateCourse` already writes it under the `approveCourse` rule, so this
 * toggle drives the mechanism that exists rather than inventing a parallel
 * one. Restoring returns the course to DRAFT, not to published — the publish
 * route is the only thing that puts a course in front of the public, and
 * quietly re-listing a course because someone flipped a switch back would
 * route around it.
 *
 * DESTROY refuses while any run survives, and the refusal is the design, not a
 * limitation. Runs are where the people are: the applications, the enrolments,
 * the answers, the attendance. Destroying them one at a time means each cohort
 * gets its own manifest, its own typed confirmation and its own audit record,
 * and nobody ever authorises the removal of five cohorts by typing one course
 * title. By the time this button is reachable, the course is a title, a
 * tagline and some intro blocks.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  course: CourseDoc;
  runAction: ToastRun;
  /** Re-read the course. Called after archive — NEVER after a destroy. */
  onArchived: () => void;
};

export default function CourseDangerZone({ course, runAction, onArchived }: Props) {
  const state = useDestroy("course", course.id, course.title);
  const { manifestState, loadInterrupted, loadManifest, phase } = state;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [archiving, setArchiving] = useState(false);

  // The status we last wrote, so the toggle answers the tap rather than the
  // round trip; cleared by any fresh course doc (same rule as the run's).
  const [statusWritten, setStatusWritten] = useState<CourseDoc["status"] | null>(null);
  const [syncedCourse, setSyncedCourse] = useState<CourseDoc | null>(null);
  if (course !== syncedCourse) {
    setSyncedCourse(course);
    setStatusWritten(null);
  }
  const status = statusWritten ?? course.status;
  const archived = status === "archived";

  // The cheap probe on mount — what makes the interrupted banner appear
  // without anybody opening the disclosure. The manifest itself (the run
  // count, the blockers, the template count) is read when the disclosure
  // opens; see RunDangerZone's header for the split.
  useEffect(() => {
    void loadInterrupted();
  }, [loadInterrupted]);

  async function toggleArchived(next: boolean) {
    // The toast holds the screen but not the switch; two taps would race two
    // writes to opposite statuses.
    if (archiving) return;
    setArchiving(true);
    const target: CourseDoc["status"] = next ? "archived" : "draft";
    let ok = false;
    try {
      await runAction(
        async () => {
          await updateCourse(course.id, { status: target });
          ok = true;
        },
        {
          savingMessage: next ? "Archiving course…" : "Restoring course…",
          successMessage: next ? "Course archived" : "Course moved back to draft",
        },
      );
    } finally {
      setArchiving(false);
    }
    if (ok) {
      setStatusWritten(target);
      onArchived();
    }
  }

  function openDialog() {
    state.reset();
    setConfirmText("");
    setDialogOpen(true);
    void loadManifest();
  }

  function resumeDialog() {
    setDialogOpen(true);
    void loadManifest();
  }

  function closeDialog() {
    if (phase === "destroying") return;
    setDialogOpen(false);
  }

  const localBlockers = course.title
    ? []
    : ["This course has no title, so there is nothing to type as confirmation — give it one under Course details first."];

  const interrupted = phase === "idle" ? state.interrupted : null;

  return (
    <>
      <Card padding="lg">
        <h3 className={shared.sectionTitle}>Archive</h3>
        <p className={shared.hint}>
          Archiving retires a course without touching a row of it. It drops off
          the public catalogue, its public page and apply page stop resolving,
          and it stops being somewhere new runs are started from — while every
          run it has already had, and everyone&apos;s history on them, carries
          on exactly as before. It stays listed here in admin. Reversible.
        </p>

        <div className={shared.archiveRow}>
          <Switch
            checked={archived}
            onChange={toggleArchived}
            disabled={archiving}
            size="lg"
            label={archived ? "Archived" : "Not archived"}
            description={
              archived
                ? "Off the public catalogue. Existing runs and member history are untouched."
                : `Currently ${COURSE_STATUS_LABEL[status].toLowerCase()} — listed wherever a course of that status appears.`
            }
          />
        </div>

        {archived ? (
          <p className={shared.hint}>
            Restoring puts the course back in <strong>draft</strong>, not
            straight back on the catalogue — use Publish above to make it public
            again, so the decision to show it to the world is always the publish
            step.
          </p>
        ) : (
          status === "published" && (
            <p className={shared.warn}>
              This course is live on the catalogue. Archiving removes the public
              course page and its apply page immediately — anyone part-way
              through an application will find the form gone.
            </p>
          )
        )}
      </Card>

      <Card padding="lg" className={shared.zoneCard}>
        {interrupted && (
          <InterruptedBanner
            noun="course"
            interrupted={interrupted}
            onResume={() => {
              setConfirmText("");
              state.reset();
              resumeDialog();
            }}
          />
        )}

        {phase === "done" && (
          <CourseDestroyedNotice title={course.title || course.id} state={state} />
        )}

        {(phase === "failed" || phase === "stalled") && !dialogOpen && (
          <UnfinishedNotice state={state} noun="course" onResume={resumeDialog} />
        )}

        {phase !== "done" && (
          <DangerDisclosure title="Danger zone" onFirstOpen={loadManifest}>
            <h4 className={shared.dangerTitle}>Destroy this course</h4>
            <p className={shared.dangerBody}>
              Destroying removes the course document itself and anything that
              only it holds. It is the last step of a teardown, not the first:
              every run has to be destroyed on its own page first, each with its
              own manifest and its own confirmation, so that no cohort&apos;s
              records are ever removed by someone typing a course title.
            </p>
            <p className={shared.dangerBody}>
              Templates taken from this course are <strong>not</strong> deleted.
              They are frozen snapshots and they outlive their origin; they
              simply stop pointing at it.
            </p>
            <p className={shared.dangerBody}>
              Every destroy is recorded in <code>courseDeletions</code> — who
              started it, what the manifest said, and what actually went.
            </p>

            <CourseDestroyEntry
              state={state}
              extraBlockers={localBlockers}
              onOpen={openDialog}
            />
          </DangerDisclosure>
        )}
      </Card>

      <DestroyDialog
        open={dialogOpen}
        onClose={closeDialog}
        state={state}
        noun="course"
        nameLabel="course title"
        expectedName={course.title}
        subtitle={course.title || course.id}
        extraBlockers={localBlockers}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        manifestBusy={manifestState === "loading"}
        doneHref="/admin/courses"
        doneLabel="Back to all courses"
      />
    </>
  );
}

/**
 * The course zone's way in. Same rules as the run's — blockers replace the
 * button, an unreadable manifest offers nothing — but with its own copy,
 * because the overwhelmingly common blocker here ("destroy its runs first") is
 * an instruction rather than a wait.
 */
function CourseDestroyEntry({
  state,
  extraBlockers,
  onOpen,
}: {
  state: UseDestroy;
  extraBlockers: string[];
  onOpen: () => void;
}) {
  const blockers = [...extraBlockers, ...(state.manifest?.blockers ?? [])];
  const loading = state.manifestState === "loading" && !state.manifest;

  if (state.manifestState === "error") {
    return (
      <div className={shared.entry}>
        <p className={shared.error}>
          Couldn&apos;t read what this would destroy: {state.manifestError}
        </p>
        <Button type="button" variant="secondary" onClick={() => void state.loadManifest()}>
          Try again
        </Button>
      </div>
    );
  }

  if (blockers.length > 0) {
    return (
      <div className={shared.entry}>
        <BlockerList blockers={blockers} />
      </div>
    );
  }

  return (
    <div className={shared.entry}>
      <Button type="button" variant="danger" onClick={onOpen} disabled={loading}>
        {loading ? "Reading the manifest…" : "Destroy this course…"}
      </Button>
    </div>
  );
}

/**
 * Left behind on the page after the dialog closes, because the editor above it
 * is now describing a document that isn't there. Deliberately plain.
 */
function CourseDestroyedNotice({ title, state }: { title: string; state: UseDestroy }) {
  return (
    <div className={styles.destroyed}>
      <h4 className={styles.destroyedTitle}>Destroyed</h4>
      <p className={styles.destroyedBody}>
        “{title}” no longer exists. Everything above is a form over a document
        that has been removed — nothing you save here will land.
      </p>
      <p className={shared.auditLine}>
        Recorded in{" "}
        <code>courseDeletions/{state.auditId ?? "(no audit id was returned)"}</code>
      </p>
    </div>
  );
}
