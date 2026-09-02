"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ProgressBar from "@/components/ui/ProgressBar";
import Switch from "@/components/ui/Switch";
import {
  COURSE_RUN_STATUS_LABEL,
  type CourseRunDoc,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import { ALLOWED_TRANSITIONS } from "@/lib/courses/runStatus";
import { setRunStatus } from "./courseMutations";
import useDestroy, {
  countRows,
  sumCounts,
  type InterruptedDestroy,
  type UseDestroy,
} from "./useDestroy";
import styles from "./RunDangerZone.module.css";

/**
 * The run's end-of-life controls, and the home of the danger-zone vocabulary
 * both this surface and `CourseDangerZone` render.
 *
 * ── TWO PATHS, AND THEY ARE NOT NEIGHBOURS ──────────────────────────────────
 * ARCHIVE is the everyday one. It is a boolean on the run doc, it is
 * reversible, it destroys nothing, and it is therefore a plain toggle in a
 * plain card with copy that says exactly which surfaces stop showing the run.
 * It sits ABOVE the danger zone and outside it, because putting the safe path
 * behind the same disclosure as the unsafe one teaches people to open the
 * disclosure.
 *
 * DESTROY is not an intensified archive. It is a records-destruction
 * procedure, and it is built like one:
 *
 *   1. It is behind a disclosure, so it is never a mis-click away.
 *   2. It reads a LIVE manifest first and shows what dies as counts, not as an
 *      adjective. "38 enrolments, 412 progress rows, 96 exercise answers" is a
 *      sentence an admin can weigh; "all associated data" is not.
 *   3. It states what SURVIVES with the same weight — the delivery log stays,
 *      templates outlive their course — because a destroy that quietly leaves
 *      things behind is as bad a surprise as one that quietly takes them.
 *   4. It refuses to offer the button at all when the manifest reports a
 *      blocker. A disabled button invites hunting for the state that enables
 *      it; an absent one sends you to read the sentence.
 *   5. It takes a byte-equal typed confirmation of the run's own label.
 *   6. It cannot be dismissed while the cascade is running.
 *   7. It ends in a receipt naming the audit record, with no congratulation.
 *
 * ── THE INTERRUPTED CASE IS A FIRST-CLASS STATE ─────────────────────────────
 * The cascade is paged, so a destroy can be several requests long, and a closed
 * laptop lands squarely in the middle of one. The audit doc's `completedAt:
 * null` is the evidence, the manifest route reports it, and this component
 * surfaces it ABOVE the disclosure — not inside it. Someone returning to a
 * half-destroyed run should not have to open a collapsed panel to find that
 * out. Resuming is the same POST with the same body; the route reads its own
 * audit doc to know where it was.
 *
 * That is also why the two reads are split. The interrupted question is asked
 * on every visit (two document reads, `?probe=interrupted`) because the answer
 * has to reach someone who came here for something else entirely. The manifest
 * — ten live aggregation counts — waits until the disclosure is opened, which
 * is the first moment anybody has expressed interest in destroying anything.
 */

// ---------------------------------------------------------------------------
// Shared props / helpers
// ---------------------------------------------------------------------------

/** The page-level ActionToast driver, passed down like every other section. */
type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  courseId: string;
  run: CourseRunDoc;
  runAction: ToastRun;
  /**
   * Re-read the run doc. Called after archive and after cancel, NEVER after a
   * destroy: there is no doc left to read.
   */
  onRunChanged: () => void;
};

/**
 * `PATCH /api/courses/runs/[runId]/archive`. A route rather than a client-direct
 * write because archiving has consequences the rules can't express — it is what
 * drops the run out of the public catalogue and out of members' live sections —
 * and because the same flag is read by surfaces this admin can't see.
 */
async function setRunArchived(runId: string, archived: boolean): Promise<void> {
  const res = await fetch(`/api/courses/runs/${encodeURIComponent(runId)}/archive`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(
      body.error ?? (archived ? "Couldn't archive this run." : "Couldn't restore this run."),
    );
  }
}

/** Live-cohort statuses, where archiving is a bigger deal than usual. */
const LIVE_STATUSES: CourseRunStatus[] = ["applications-open", "running"];

// ---------------------------------------------------------------------------
// RunDangerZone
// ---------------------------------------------------------------------------

export default function RunDangerZone({ courseId, run, runAction, onRunChanged }: Props) {
  const state = useDestroy("run", run.id, run.label);
  const { manifestState, loadInterrupted, loadManifest, phase } = state;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [archiving, setArchiving] = useState(false);

  const cancelConfirmId = useId();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelText, setCancelText] = useState("");
  const [cancelling, setCancelling] = useState(false);

  /**
   * The archived value we last wrote, so the switch answers the tap rather
   * than the round trip. Cleared whenever a fresh run doc arrives — that doc,
   * not this, is the truth, and a flag that failed to stick SHOULD snap back.
   */
  const [archivedWritten, setArchivedWritten] = useState<boolean | null>(null);
  const [syncedRun, setSyncedRun] = useState<CourseRunDoc | null>(null);
  if (run !== syncedRun) {
    setSyncedRun(run);
    setArchivedWritten(null);
  }
  // `archived` is a real field on CourseRunDoc (orthogonal to the status
  // union: it is not a point in the application → running → completed
  // lifecycle, it is a decision to stop showing a run that may be at any
  // point in it), and the normaliser defaults a run predating it to false.
  const archived = archivedWritten ?? run.archived;

  /**
   * The INTERRUPTED PROBE on mount — two document reads — and nothing else.
   * It is what makes the banner appear on a run whose destroy died mid-page
   * without anyone opening anything.
   *
   * The full manifest is NOT read here: its ten aggregation queries are the
   * price of a decision nobody on this page has made yet, and most visits to
   * a run editor never touch the danger zone at all. It is loaded when the
   * disclosure opens (below) and re-read fresh when the dialog opens.
   */
  useEffect(() => {
    void loadInterrupted();
  }, [loadInterrupted]);

  async function toggleArchived(next: boolean) {
    // The toast holds the screen but not the switch, and a double-tap would
    // send two PATCHes racing each other to set opposite values.
    if (archiving) return;
    setArchiving(true);
    let ok = false;
    try {
      await runAction(
        async () => {
          await setRunArchived(run.id, next);
          ok = true;
        },
        {
          savingMessage: next ? "Archiving run…" : "Restoring run…",
          successMessage: next ? "Run archived" : "Run restored",
        },
      );
    } finally {
      setArchiving(false);
    }
    if (ok) {
      setArchivedWritten(next);
      onRunChanged();
    }
  }

  /**
   * Cancelling calls the SAME status route the editor's dropdown uses. It is
   * here, not there, because it is the one status move that cannot be walked
   * back: the lifecycle table makes `cancelled` terminal, so a mis-tap in a
   * select would permanently kill a cohort's run. The typed confirmation is
   * the destroy dialog's, deliberately: same shape, same exactness, so the
   * gesture reads as "this is the irreversible kind of button".
   *
   * No cascade, and no email. Nothing is deleted: applications, enrolments and
   * everything the cohort produced stay exactly where they are, which is why
   * this is not in the danger zone proper. Telling the cohort is still a
   * manual job today; a cohort cancellation notice is a later change.
   */
  async function cancelRun() {
    if (cancelling || cancelText !== run.label || !run.label) return;
    setCancelling(true);
    let ok = false;
    try {
      await runAction(
        async () => {
          await setRunStatus(run.id, "cancelled");
          ok = true;
        },
        {
          savingMessage: "Cancelling cohort…",
          successMessage: "Cohort cancelled",
        },
      );
    } finally {
      setCancelling(false);
    }
    if (ok) {
      setCancelOpen(false);
      setCancelText("");
      onRunChanged();
    }
  }

  function openDialog() {
    state.reset();
    setConfirmText("");
    setDialogOpen(true);
    // Always a FRESH read at the moment of the decision. The mount read may be
    // an hour old, and the numbers in this dialog are the whole argument.
    void loadManifest();
  }

  function resumeDialog() {
    // Deliberately no `reset()`: a resume carries the failure it is resuming
    // from, and the totals already reported.
    setDialogOpen(true);
    void loadManifest();
  }

  function closeDialog() {
    if (phase === "destroying") return;
    setDialogOpen(false);
  }

  // The server's own table decides whether cancelling is even on the menu, so
  // this card disappears on a run that is already finished or cancelled rather
  // than offering a button the route would refuse.
  //
  // Read straight off the table, NOT through `canTransition`: that helper
  // answers true for a same-status move (the route treats a re-send as an
  // idempotent no-op), so asking it "can a cancelled run be cancelled" got a
  // yes and drew the whole danger card on a cohort that was already called off.
  const canCancel = ALLOWED_TRANSITIONS[run.status].includes("cancelled");
  const cancelMatches = cancelText === run.label && run.label.length > 0;
  const cancelWhitespaceOnly =
    !cancelMatches && cancelText.length > 0 && cancelText.trim() === run.label.trim();

  // A run with no label can't be confirmed by typing it. Local, and stated the
  // same way the server's blockers are.
  const localBlockers = run.label
    ? []
    : ["This run has no label, so there is nothing to type as confirmation — give it one under Run details first."];

  // Suppress the interrupted report while this session is mid-flight or
  // finished: from the moment `destroy()` is called the open audit doc is
  // OURS, and the banner would be describing the thing on screen.
  const interrupted = phase === "idle" ? state.interrupted : null;

  return (
    <>
      <Card padding="lg">
        <h3 className={styles.sectionTitle}>Archive</h3>
        <p className={styles.hint}>
          Archiving takes a finished run out of the way without touching a row
          of it. It drops out of the admin list&apos;s default view, out of the
          public catalogue, out of members&apos; live sections on /learn, and
          out of any application window — while everyone who took it keeps their
          history, their progress and their answers exactly as they left them.
          Reversible at any time.
        </p>

        <div className={styles.archiveRow}>
          <Switch
            checked={archived}
            onChange={toggleArchived}
            disabled={archiving}
            size="lg"
            label={archived ? "Archived" : "Not archived"}
            description={
              archived
                ? "Hidden from the catalogue and from live sections. Member history still reads."
                : "Listed wherever this run would normally appear."
            }
          />
        </div>

        {!archived && LIVE_STATUSES.includes(run.status) && (
          <p className={styles.warn}>
            This run is {COURSE_RUN_STATUS_LABEL[run.status].toLowerCase()}.
            Archiving it now takes it off the catalogue and out of the cohort&apos;s
            live sections immediately — they keep access through their history,
            but the run stops being the thing their dashboard points at.
          </p>
        )}
      </Card>

      {canCancel && (
        <Card padding="lg">
          <h3 className={styles.sectionTitle}>Cancel this cohort</h3>
          <p className={styles.hint}>
            Cancelling calls the run off. It stops being applicable to and stops
            being a live cohort on /learn, and it cannot be undone: a cancelled
            run never moves back to draft or running. Nothing is deleted, so
            every application, enrolment and answer stays readable as history.
            Use archive instead if you only want the run out of the way.
          </p>
          <p className={styles.warn}>
            Nobody is emailed. If this cohort has been meeting, tell them
            yourself before or straight after you cancel.
          </p>
          <div className={styles.archiveRow}>
            <Button
              type="button"
              variant="danger"
              disabled={cancelling}
              onClick={() => {
                setCancelText("");
                setCancelOpen(true);
              }}
            >
              Cancel this cohort…
            </Button>
          </div>
        </Card>
      )}

      <Card padding="lg" className={styles.zoneCard}>
        {interrupted && (
          <InterruptedBanner
            noun="run"
            interrupted={interrupted}
            onResume={() => {
              setConfirmText("");
              state.reset();
              resumeDialog();
            }}
          />
        )}

        {phase === "done" && (
          <DestroyReceipt
            state={state}
            noun="run"
            name={run.label || run.id}
            doneHref={`/admin/courses/${encodeURIComponent(courseId)}`}
            doneLabel="Back to the course"
          />
        )}

        {(phase === "failed" || phase === "stalled") && !dialogOpen && (
          <UnfinishedNotice state={state} noun="run" onResume={resumeDialog} />
        )}

        {phase !== "done" && (
          // The manifest is read when this OPENS, not on mount — see the
          // probe note above.
          <DangerDisclosure title="Danger zone" onFirstOpen={loadManifest}>
            <h4 className={styles.dangerTitle}>Destroy this run</h4>
            <p className={styles.dangerBody}>
              Destroying removes the run and everything keyed to it — its weeks,
              its groups, every application and enrolment, and the progress,
              answers, attendance and mirrored tasks the cohort produced. It
              cannot be undone, it is not what you want for a finished cohort
              (archive is), and what it removes is other people&apos;s work as
              much as yours. Use it for runs created in error, test cohorts, and
              data you have decided must not be retained.
            </p>
            <p className={styles.dangerBody}>
              Every destroy is recorded in <code>courseDeletions</code> — who
              started it, what the manifest said, and what actually went.
            </p>

            <DestroyEntry
              state={state}
              extraBlockers={localBlockers}
              buttonLabel="Destroy this run…"
              onOpen={openDialog}
            />
          </DangerDisclosure>
        )}
      </Card>

      <Modal
        open={cancelOpen}
        onClose={cancelling ? () => {} : () => setCancelOpen(false)}
        ariaLabel="Cancel this cohort"
        width="sm"
      >
        <div className={styles.dialog}>
          <header className={styles.dialogHead}>
            <h2 className={styles.dialogTitle}>Cancel this cohort</h2>
            <p className={styles.dialogSubtitle}>
              {run.courseTitle
                ? `${run.courseTitle} · ${run.label || run.id}`
                : run.label || run.id}
            </p>
          </header>

          <p className={styles.dangerBody}>
            The run moves to <strong>Cancelled</strong> and stays there. It
            leaves the public catalogue and the cohort&apos;s live sections,
            applications stop being accepted, and no weekly mail goes out.
            Everything already recorded is kept.
          </p>

          {run.label ? (
            <section className={styles.confirmBlock}>
              <Field
                id={cancelConfirmId}
                label="Type the run label to confirm"
                hint={
                  cancelWhitespaceOnly
                    ? "That matches apart from leading or trailing spaces. The check is exact."
                    : `Exactly “${run.label}”. Nothing is trimmed or corrected.`
                }
              >
                <Input
                  id={cancelConfirmId}
                  value={cancelText}
                  onChange={(e) => setCancelText(e.target.value)}
                  className={styles.confirmInput}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={run.label}
                />
              </Field>
            </section>
          ) : (
            <BlockerList blockers={localBlockers} />
          )}

          <div className={styles.dialogActions}>
            <Button
              type="button"
              variant="ghost"
              disabled={cancelling}
              onClick={() => setCancelOpen(false)}
            >
              Keep this cohort
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={!cancelMatches || cancelling}
              onClick={() => void cancelRun()}
            >
              Cancel this cohort
            </Button>
          </div>
        </div>
      </Modal>

      <DestroyDialog
        open={dialogOpen}
        onClose={closeDialog}
        state={state}
        noun="run"
        nameLabel="run label"
        expectedName={run.label}
        subtitle={run.courseTitle ? `${run.courseTitle} · ${run.label || run.id}` : run.label || run.id}
        extraBlockers={localBlockers}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        manifestBusy={manifestState === "loading"}
        doneHref={`/admin/courses/${encodeURIComponent(courseId)}`}
        doneLabel="Back to the course"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared danger-zone pieces
// ---------------------------------------------------------------------------

/*
 * Everything below is rendered by BOTH danger zones and lives here rather than
 * in a third module because the ownership of this feature is one PR and the
 * two confirmations must not drift apart — the same argument
 * `StaffEmailComposer` makes for keeping its two send lanes in one file. The
 * run is the primary case, so the shared vocabulary lives with it; the course
 * zone imports it.
 */

/**
 * The collapsed red panel. Closed by default, always.
 *
 * `onFirstOpen` fires the first time it is opened and never again — it is how
 * both zones defer their manifest read (ten-ish aggregation queries) until
 * somebody has actually asked what a destroy would remove. Once, not on every
 * toggle: re-reading on each open would turn a fidget into a bill, and the
 * dialog takes its own fresh read at the moment of the decision anyway.
 */
export function DangerDisclosure({
  title,
  children,
  onFirstOpen,
}: {
  title: string;
  children: ReactNode;
  onFirstOpen?: () => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  return (
    <div className={styles.disclosure}>
      <button
        type="button"
        className={styles.disclosureButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
          if (!opened.current) {
            opened.current = true;
            onFirstOpen?.();
          }
        }}
      >
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>
          ›
        </span>
        {title}
      </button>
      <div id={panelId} className={`${styles.panel} ${open ? styles.panelOpen : ""}`}>
        {/* `inert` while closed so the collapsed content is out of the tab
            order and out of the accessibility tree — the grid track hides it
            visually but would otherwise leave a focusable Destroy button in a
            panel nobody can see. Same guard Modal uses. */}
        <div className={styles.panelInner} inert={!open}>
          <div className={styles.panelBody}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The way in — or the reason there isn't one. Blockers replace the button
 * rather than disabling it (see the header note).
 */
function DestroyEntry({
  state,
  extraBlockers,
  buttonLabel,
  onOpen,
}: {
  state: UseDestroy;
  extraBlockers: string[];
  buttonLabel: string;
  onOpen: () => void;
}) {
  const blockers = [...extraBlockers, ...(state.manifest?.blockers ?? [])];
  const loading = state.manifestState === "loading" && !state.manifest;

  if (state.manifestState === "error") {
    return (
      <div className={styles.entry}>
        <p className={styles.error}>
          Couldn&apos;t read what this would destroy: {state.manifestError}
        </p>
        <p className={styles.hint}>
          Nothing is offered until the manifest can be read — a destroy whose
          scope is unknown is not a destroy anybody should be pressing.
        </p>
        <Button type="button" variant="secondary" onClick={() => void state.loadManifest()}>
          Try again
        </Button>
      </div>
    );
  }

  if (blockers.length > 0) {
    return (
      <div className={styles.entry}>
        <BlockerList blockers={blockers} />
      </div>
    );
  }

  return (
    <div className={styles.entry}>
      <Button type="button" variant="danger" onClick={onOpen} disabled={loading}>
        {loading ? "Reading the manifest…" : buttonLabel}
      </Button>
    </div>
  );
}

/**
 * Why the blockers REPLACE the destroy button instead of disabling it: a
 * disabled control is a puzzle ("what enables this?"), and the answer to that
 * puzzle is usually "keep clicking things until it lights up". A sentence
 * where the button would have been is the answer.
 */
export function BlockerList({ blockers }: { blockers: string[] }) {
  return (
    <div className={styles.blockers}>
      <h5 className={styles.blockersTitle}>This can&apos;t be destroyed yet</h5>
      <ul className={styles.blockerItems}>
        {blockers.map((b, i) => (
          <li key={`${i}-${b}`}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

/** Surfaced above the disclosure — see the header note on the interrupted case. */
export function InterruptedBanner({
  noun,
  interrupted,
  onResume,
}: {
  noun: "run" | "course";
  interrupted: InterruptedDestroy;
  onResume: () => void;
}) {
  const already = sumCounts(interrupted.deleted);
  return (
    <div className={styles.interrupted}>
      <h4 className={styles.interruptedTitle}>
        A destroy of this {noun} was interrupted
      </h4>
      <p className={styles.interruptedBody}>
        {interrupted.startedByName
          ? `${interrupted.startedByName} started it`
          : "It was started"}
        {interrupted.startedAt ? ` on ${formatStamp(interrupted.startedAt)}` : ""} and it
        never finished
        {already > 0
          ? `. ${already.toLocaleString()} row${already === 1 ? "" : "s"} had already been removed when it stopped.`
          : "."}{" "}
        The {noun} is in a half-destroyed state until it is resumed — what has
        gone is gone, and what is left is no longer consistent with it.
      </p>
      <p className={styles.auditLine}>
        Audit record: <code>courseDeletions/{interrupted.auditId}</code>
      </p>
      <Button type="button" variant="danger" onClick={onResume}>
        Resume the destroy…
      </Button>
    </div>
  );
}

/**
 * A pass failed or the loop stopped, and the operator closed the dialog on it.
 *
 * The two cases are NOT described the same way, for the reason
 * `StaffEmailComposer` separates refused from unknown: a refusal is decided
 * before the cascade touches anything, so nothing moved and there is no
 * half-destroyed anything. Only a pass that may have run leaves the target in a
 * state worth warning about — and this component must not claim rows are gone
 * when none are.
 */
export function UnfinishedNotice({
  state,
  noun,
  onResume,
}: {
  state: UseDestroy;
  noun: "run" | "course";
  onResume: () => void;
}) {
  const started = state.deletedTotal > 0;
  const refused = state.failure?.kind === "refused";
  return (
    <div className={styles.interrupted}>
      <h4 className={styles.interruptedTitle}>
        {refused && !started ? "The destroy was refused" : "This destroy did not finish"}
      </h4>
      <p className={styles.interruptedBody}>{state.failure?.message}</p>
      <p className={styles.interruptedBody}>
        {started
          ? `${state.deletedTotal.toLocaleString()} row${state.deletedTotal === 1 ? " was" : "s were"} removed before it stopped, so this ${noun} is half-destroyed. Resuming is the only way to finish it.`
          : refused
            ? `Nothing was removed — this ${noun} is exactly as it was.`
            : `No rows were reported removed, but the attempt may not have been clean. Resuming re-reads the audit record and carries on from wherever it actually got to.`}
      </p>
      {state.auditId && (
        <p className={styles.auditLine}>
          Audit record: <code>courseDeletions/{state.auditId}</code>
        </p>
      )}
      <Button type="button" variant="danger" onClick={onResume}>
        {refused && !started ? "Try again…" : "Resume the destroy…"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export type DestroyDialogProps = {
  open: boolean;
  onClose: () => void;
  state: UseDestroy;
  noun: "run" | "course";
  /** What the confirmation field asks for: "run label" / "course title". */
  nameLabel: string;
  /** The exact string that must be typed. Compared byte for byte. */
  expectedName: string;
  /** One line identifying the target, above the counts. */
  subtitle: string;
  extraBlockers: string[];
  confirmText: string;
  onConfirmTextChange: (next: string) => void;
  manifestBusy: boolean;
  doneHref: string;
  doneLabel: string;
};

export function DestroyDialog({
  open,
  onClose,
  state,
  noun,
  nameLabel,
  expectedName,
  subtitle,
  extraBlockers,
  confirmText,
  onConfirmTextChange,
  manifestBusy,
  doneHref,
  doneLabel,
}: DestroyDialogProps) {
  const confirmId = useId();
  const { phase, manifest } = state;
  const busy = phase === "destroying";
  const resuming = manifest?.interrupted != null && phase === "idle";

  // Byte equality, no trimming: the point of the ritual is that the operator
  // typed this exact string. The hint below tells a near-miss why it failed
  // rather than leaving a dead button to explain itself.
  const matches = confirmText === expectedName && expectedName.length > 0;
  const whitespaceOnly =
    !matches && confirmText.length > 0 && confirmText.trim() === expectedName.trim();

  const blockers = [...extraBlockers, ...(manifest?.blockers ?? [])];
  const rows = manifest ? countRows(manifest.counts) : [];
  const dying = rows.filter((r) => r.fate === "destroyed");
  const surviving = rows.filter((r) => r.fate !== "destroyed");
  const dyingTotal = dying.reduce((sum, r) => sum + r.value, 0);

  return (
    <Modal
      open={open}
      // Mid-cascade the dialog is not dismissible: Esc and the scrim both land
      // here, and both are ignored while a pass is in flight. Losing the
      // progress view wouldn't stop the cascade, it would just hide it.
      onClose={busy ? () => {} : onClose}
      ariaLabel={`Destroy this ${noun}`}
      width="md"
    >
      <div className={styles.dialog}>
        <header className={styles.dialogHead}>
          <h2 className={styles.dialogTitle}>
            {phase === "done"
              ? `This ${noun} has been destroyed`
              : resuming
                ? `Resume destroying this ${noun}`
                : `Destroy this ${noun}`}
          </h2>
          <p className={styles.dialogSubtitle}>{subtitle}</p>
        </header>

        {phase === "destroying" && <DestroyProgress state={state} />}

        {phase === "done" && (
          <>
            <DestroyReceipt
              state={state}
              noun={noun}
              name={expectedName}
              doneHref={doneHref}
              doneLabel={doneLabel}
            />
            <div className={styles.dialogActions}>
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}

        {(phase === "failed" || phase === "stalled") && (
          <>
            <div className={styles.failure}>
              <h3 className={styles.failureTitle}>
                {state.failure?.kind === "refused"
                  ? "The destroy was refused"
                  : "The destroy stopped part-way"}
              </h3>
              <p className={styles.failureBody}>{state.failure?.message}</p>
              <p className={styles.failureBody}>
                {state.failure?.kind === "refused"
                  ? "Refusals are decided before the cascade touches anything, so nothing moved on this attempt."
                  : `${state.deletedTotal.toLocaleString()} row${state.deletedTotal === 1 ? "" : "s"} have been removed so far. Resuming continues from there — the audit record is the cursor, so nothing is repeated and nothing is skipped.`}
              </p>
              {state.auditId && (
                <p className={styles.auditLine}>
                  Audit record: <code>courseDeletions/{state.auditId}</code>
                </p>
              )}
            </div>
            <div className={styles.dialogActions}>
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={!matches}
                onClick={() => void state.destroy(confirmText)}
              >
                {state.failure?.kind === "refused" ? "Try again" : "Resume the destroy"}
              </Button>
            </div>
            {!matches && (
              <p className={styles.hint}>
                Retype the {nameLabel} above to re-enable the button.
              </p>
            )}
          </>
        )}

        {phase === "idle" && (
          <>
            {manifestBusy && !manifest && (
              <p className={styles.loading} role="status">
                Reading what this would destroy…
              </p>
            )}

            {state.manifestState === "error" && (
              <div className={styles.failure}>
                <h3 className={styles.failureTitle}>The manifest couldn&apos;t be read</h3>
                <p className={styles.failureBody}>{state.manifestError}</p>
                <p className={styles.failureBody}>
                  Nothing is offered from here until it can be: the counts are
                  the argument for pressing the button, and a destroy with no
                  stated scope is one nobody should be authorising.
                </p>
              </div>
            )}

            {manifest && (
              <>
                {manifest.interrupted && (
                  <p className={styles.resumeNote}>
                    This resumes an earlier destroy that never finished
                    {sumCounts(manifest.interrupted.deleted) > 0
                      ? ` — ${sumCounts(manifest.interrupted.deleted).toLocaleString()} rows are already gone`
                      : ""}
                    . The counts below are what is still there.
                  </p>
                )}

                <section className={styles.countsBlock}>
                  <h3 className={styles.blockTitle}>
                    What this removes{manifestBusy ? " (refreshing…)" : ""}
                  </h3>
                  <p className={styles.blockHint}>
                    Counted live, just now. Nothing here can be recovered
                    afterwards.
                  </p>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <tbody>
                        {dying.map((row) => (
                          <tr key={row.key}>
                            <th scope="row" className={styles.rowLabel}>
                              {row.label}
                              {row.note && <span className={styles.rowNote}>{row.note}</span>}
                            </th>
                            <td className={styles.rowValue}>{row.value.toLocaleString()}</td>
                          </tr>
                        ))}
                        <tr className={styles.totalRow}>
                          <th scope="row" className={styles.rowLabel}>
                            Rows in total
                          </th>
                          <td className={styles.rowValue}>{dyingTotal.toLocaleString()}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>

                {surviving.length > 0 && (
                  <section className={styles.keptBlock}>
                    <h3 className={styles.blockTitle}>What survives</h3>
                    <ul className={styles.keptItems}>
                      {surviving.map((row) => (
                        <li key={row.key}>
                          <strong>
                            {row.value.toLocaleString()} {row.label.toLowerCase()}
                          </strong>
                          {row.note ? ` — ${row.note}` : ""}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {blockers.length > 0 ? (
                  <BlockerList blockers={blockers} />
                ) : (
                  <section className={styles.confirmBlock}>
                    <Field
                      id={confirmId}
                      label={`Type the ${nameLabel} to confirm`}
                      hint={
                        whitespaceOnly
                          ? "That matches apart from leading or trailing spaces. The check is exact."
                          : `Exactly “${expectedName}”. Nothing is trimmed or corrected.`
                      }
                    >
                      <Input
                        id={confirmId}
                        value={confirmText}
                        onChange={(e) => onConfirmTextChange(e.target.value)}
                        className={styles.confirmInput}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder={expectedName}
                      />
                    </Field>
                  </section>
                )}
              </>
            )}

            <div className={styles.dialogActions}>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              {manifest && blockers.length === 0 && (
                <Button
                  type="button"
                  variant="danger"
                  disabled={!matches || manifestBusy}
                  onClick={() => void state.destroy(confirmText)}
                >
                  Destroy this {noun} permanently
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Mid-cascade. Driven entirely by the resume loop's reports. */
function DestroyProgress({ state }: { state: UseDestroy }) {
  return (
    <section className={styles.progressBlock} role="status" aria-live="polite">
      <p className={styles.progressLine}>
        Deleting… {state.deletedTotal.toLocaleString()} of ~
        {state.estimatedTotal.toLocaleString()} rows
      </p>
      <ProgressBar
        value={state.deletedTotal}
        max={Math.max(1, state.estimatedTotal)}
        tone="danger"
        ariaLabel="Rows removed"
      />
      <p className={styles.progressHint}>
        Pass {state.passes + 1}. The cascade runs in pages, so this may take
        several round trips. Leaving this page stops it between passes —
        nothing already removed comes back, and the run keeps its record of
        where it got to, so this page will offer to resume from there.
      </p>
    </section>
  );
}

/**
 * The receipt. Deliberately flat: no tick, no colour, no "successfully". What
 * happened here is that records were destroyed, and the only useful things to
 * say are what went and where it is written down.
 */
function DestroyReceipt({
  state,
  noun,
  name,
  doneHref,
  doneLabel,
}: {
  state: UseDestroy;
  noun: "run" | "course";
  name: string;
  doneHref: string;
  doneLabel: string;
}) {
  const rows = countRows(state.deleted);
  const total = state.deletedTotal;
  // The manifest's estimate can exceed what the passes reported — a row deleted
  // by something else in between, or a counter this client doesn't know how to
  // read. Say so rather than quietly presenting the smaller number as the
  // whole story.
  const shortfall = state.estimatedTotal > total;

  return (
    <section className={styles.receipt}>
      <h3 className={styles.receiptTitle}>Destroyed</h3>
      <p className={styles.receiptBody}>
        {name ? `“${name}”` : `This ${noun}`} and the records listed below no
        longer exist. This page is showing a {noun} that is gone.
      </p>

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className={styles.rowLabel}>
                    {row.label}
                  </th>
                  <td className={styles.rowValue}>{row.value.toLocaleString()}</td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <th scope="row" className={styles.rowLabel}>
                  Rows removed
                </th>
                <td className={styles.rowValue}>{total.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.auditLine}>
        Recorded in{" "}
        <code>courseDeletions/{state.auditId ?? "(no audit id was returned)"}</code>
        {state.passes > 1 ? ` · ${state.passes} passes` : ""}
      </p>
      {shortfall && (
        <p className={styles.receiptCaveat}>
          The manifest counted about {state.estimatedTotal.toLocaleString()} rows
          before the cascade began, which is more than the passes reported
          removing. Where the two differ the audit record is the authority.
        </p>
      )}

      <div className={styles.receiptActions}>
        <Link href={doneHref} className={styles.receiptLink}>
          {doneLabel}
        </Link>
      </div>
    </section>
  );
}

/** ISO → something readable, without pulling a date library into this file. */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
