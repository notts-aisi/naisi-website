"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ProgressBar from "@/components/ui/ProgressBar";
import useDestroy, {
  countRows,
  sumCounts,
  type CountRow,
  type DestroyKind,
  type UseDestroy,
} from "@/features/courses/useDestroy";
import styles from "./DestroyPanel.module.css";

/**
 * One destroy panel, for anything the deletion protocol covers.
 *
 * ── WHAT THIS IS, AND WHERE IT CAME FROM ────────────────────────────────────
 * It is the generic half of `src/features/courses/RunDangerZone.tsx`: the
 * disclosure, the live manifest table with its fates, the interrupted-destroy
 * banner, the typed confirmation dialog, the running total and the receipt.
 * The copy and the ordering are that file's, and the argument for each of them
 * is written out at length in its header, which is the place to read before
 * changing any of this.
 *
 * IT IS A COPY RATHER THAN AN IMPORT, deliberately, and the reason is a
 * dependency rather than laziness. RunDangerZone's shared pieces are typed
 * `noun: "run" | "course"`, they are styled from `RunDangerZone.module.css`,
 * and the module they live in also imports `courseMutations` and the run
 * status table. Importing them here would either widen a course type to name a
 * circulation and an admission round, or pull the course editor's mutation
 * layer into the worksheets page for the sake of a disclosure triangle. The
 * run and the course keep the surface they have; this one serves the two new
 * subjects and any that follow. If the two ever need to change together, the
 * merge is the obvious one: lift these pieces into this folder and have
 * RunDangerZone import them, which is a bigger diff than this wave should
 * make to a shipped course surface.
 *
 * ── ADMIN ONLY BY CONSTRUCTION ──────────────────────────────────────────────
 * Nothing here is a permission check. The caller mounts this only for an
 * admin, and both routes behind it re-decide that for themselves; a member who
 * reached this markup would get a 403 from the manifest and see the refusal
 * where the button would have been.
 *
 * ── WHY THE DIALOG IS NOT DISMISSIBLE MID-CASCADE ───────────────────────────
 * Losing the progress view would not stop the cascade, it would only hide it.
 * The pass keeps running server-side and the resume banner picks it up on the
 * next visit, but an operator who closed the dialog mid-pass would be told
 * nothing about what happened while it was shut.
 */

type Props = {
  kind: DestroyKind;
  targetId: string;
  /** The exact string that must be typed to confirm. */
  label: string;
  /** What the confirmation field asks for: "circulation title", "round label". */
  nameLabel: string;
  /** One line identifying the target, shown above the counts. */
  subtitle: string;
  /**
   * Called when the operator leaves the receipt. NOT called the moment the
   * cascade finishes: the receipt is the only place the totals and the audit
   * id are shown, and navigating out from under it would take that away before
   * anybody had read it.
   */
  onDestroyed: () => void;
};

/**
 * Per-subject vocabulary. `noun` is what the copy calls the thing, and
 * `auditPath` is where the record of the destroy lives, which the receipt
 * names so the fact of it outlives the data.
 */
const KIND_COPY: Record<DestroyKind, { noun: string; auditPath: string; body: ReactNode }> = {
  run: {
    noun: "run",
    auditPath: "courseDeletions",
    body: (
      <>
        Destroying removes the run and everything keyed to it. It cannot be
        undone, and what it removes is other people&apos;s work as much as
        yours.
      </>
    ),
  },
  course: {
    noun: "course",
    auditPath: "courseDeletions",
    body: (
      <>
        Destroying removes the course itself. It cannot be undone, and every run
        of it has to be destroyed first.
      </>
    ),
  },
  circulation: {
    noun: "circulation",
    auditPath: "destroyAudits",
    body: (
      <>
        Destroying removes this sending and everything people did with it: every
        recipient&apos;s answers, the uploads they made, the reviews and scores
        staff wrote about them, and the card this put on each of their boards
        with its comments and files. It cannot be undone, and most of what goes
        is other people&apos;s work. The library worksheet is a different
        document and is left alone, so the questions themselves survive and can
        be sent again.
      </>
    ),
  },
  "admission-round": {
    noun: "round",
    auditPath: "destroyAudits",
    body: (
      <>
        Destroying removes the round, its stages, the applications made to it
        and the reviews of them. It cannot be undone. What the committee keeps
        about each applicant is written to their member record first, so the
        record of who applied, for what, and how it went survives this.
      </>
    ),
  },
};

/**
 * WORDING ONLY, per subject, over the shared vocabulary in `useDestroy`.
 *
 * Two kinds of entry live here. Most are keys `COUNT_META` does not carry at
 * all, because they belong to a worksheet circulation and a worksheet's
 * counters are nobody else's to name. The rest are keys it does carry, whose
 * shared sentence is about the wrong thing on this dialog: `schedulerMarkers`
 * talks about a run's groups, and the two retained log counters talk about "a
 * cohort" and "this run", which is the wrong noun in front of somebody
 * destroying a sending of a worksheet.
 *
 * THIS OVERLAY CANNOT CHANGE A FATE, and that is not a limitation to work
 * around: the fate decides which half of the dialog a row appears under, so it
 * belongs with the route's contract in `COUNT_META` where one decision serves
 * every screen. A counter naming something that SURVIVES therefore needs its
 * entry there, not here. See `describeRows` at the foot of this file.
 *
 * The wording is deliberately kind-neutral where a key can turn up under more
 * than one subject: a `reviews` row is written by staff about somebody's work
 * whether the work is a worksheet response or an application.
 */
const EXTRA_COUNT_COPY: Record<string, { label: string; note?: string }> = {
  responses: {
    label: "Responses",
    note: "Everything each recipient wrote or chose, including answers they had not submitted yet.",
  },
  reviews: {
    label: "Reviews",
    note: "The staff notes and scores written about each person's work, including feedback drafted but never returned.",
  },
  tasks: {
    label: "Recipient tasks",
    note: "The card this put on each recipient's board, with its comments, its activity log and any files attached to it.",
  },
  uploadedImages: {
    label: "Uploaded answer images",
    note: "The photographs and screenshots recipients uploaded as answers.",
  },
  questionImages: {
    label: "Question images",
    note: "The pictures in this circulation's own copy of the questions. The library worksheet's images are a separate folder and are untouched.",
  },
  schedulerMarkers: {
    label: "Scheduler send markers",
    note: "The dedupe rows recording which reminders have already gone out about this. No member work and no addresses, but they go with it: a marker left behind can suppress a real send later.",
  },
  circulation: {
    label: "The circulation itself",
    note: "The document that held the copy of the questions, the staff list and the counters.",
  },
  round: {
    label: "The round itself",
    note: "The document that held the dates, the stages, the reviewer list and the counters.",
  },
  // The two retained logs, reworded off the courses map for the reason in the
  // header: their shared notes name a run and a cohort, and neither word means
  // anything on a worksheet. The fate stays "retained", decided in COUNT_META.
  emailSendRows: {
    label: "Delivery-log rows",
    note: "KEPT. The append-only record of what NAISI put in somebody's inbox. Destroying what a message was about does not unsend the message, and this log is how a bounce or a complaint is answered later.",
  },
  dataExportRows: {
    label: "Download-log rows",
    note: "KEPT. The append-only record of which spreadsheets were downloaded from this and who asked for them. It holds no answers of its own, and destroying what a file described does not undo the download.",
  },
};

export default function DestroyPanel({
  kind,
  targetId,
  label,
  nameLabel,
  subtitle,
  onDestroyed,
}: Props) {
  const state = useDestroy(kind, targetId, label);
  const { loadInterrupted, loadManifest, manifestState, phase } = state;
  const copy = KIND_COPY[kind];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  /**
   * The interrupted PROBE on mount, and nothing else: two document reads, so a
   * cascade that died mid-page announces itself to whoever opens this page
   * next. The full manifest waits for the disclosure, because its aggregate
   * counts and bucket listings are the price of a decision nobody visiting has
   * made yet.
   */
  useEffect(() => {
    void loadInterrupted();
  }, [loadInterrupted]);

  // A target with no name cannot be confirmed by typing it. Stated the same
  // way the server's blockers are, because it is one: the route refuses it.
  const localBlockers = label
    ? []
    : [
        `This ${copy.noun} has no name, so there is nothing to type as confirmation. Give it one first.`,
      ];

  // Suppress the interrupted report once this session is mid-flight or
  // finished: from the moment `destroy()` is called the open audit row is
  // ours, and the banner would be describing the thing on screen.
  const interrupted = phase === "idle" ? state.interrupted : null;

  function openDialog() {
    state.reset();
    setConfirmText("");
    setDialogOpen(true);
    // Always a FRESH read at the moment of the decision: the mount read may be
    // an hour old, and the numbers are the whole argument.
    void loadManifest();
  }

  function resumeDialog() {
    // Deliberately no reset(): a resume carries the failure it is resuming
    // from, and the totals already reported.
    setDialogOpen(true);
    void loadManifest();
  }

  return (
    <Card padding="lg" className={styles.zoneCard}>
      <h2 className={styles.zoneTitle}>Danger zone</h2>

      {interrupted && (
        <div className={styles.interrupted}>
          <h3 className={styles.interruptedTitle}>
            A destroy of this {copy.noun} was interrupted
          </h3>
          <p className={styles.interruptedBody}>
            {interrupted.startedByName
              ? `${interrupted.startedByName} started it`
              : "It was started"}
            {interrupted.startedAt ? ` on ${formatStamp(interrupted.startedAt)}` : ""} and it
            never finished
            {sumCounts(interrupted.deleted) > 0
              ? `. ${sumCounts(interrupted.deleted).toLocaleString()} row${
                  sumCounts(interrupted.deleted) === 1 ? "" : "s"
                } had already been removed when it stopped.`
              : "."}{" "}
            This {copy.noun} is in a half-destroyed state until it is resumed: what has gone
            is gone, and what is left is no longer consistent with it.
          </p>
          <p className={styles.auditLine}>
            Audit record: <code>{copy.auditPath}/{interrupted.auditId}</code>
          </p>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setConfirmText("");
              state.reset();
              resumeDialog();
            }}
          >
            Resume the destroy…
          </Button>
        </div>
      )}

      {phase === "done" && (
        <Receipt
          state={state}
          noun={copy.noun}
          auditPath={copy.auditPath}
          name={label}
          onDone={onDestroyed}
        />
      )}

      {(phase === "failed" || phase === "stalled") && !dialogOpen && (
        <UnfinishedNotice
          state={state}
          noun={copy.noun}
          auditPath={copy.auditPath}
          onResume={resumeDialog}
        />
      )}

      {phase !== "done" && (
        <Disclosure title={`Destroy this ${copy.noun}`} onFirstOpen={loadManifest}>
          <p className={styles.dangerBody}>{copy.body}</p>
          <p className={styles.dangerBody}>
            Every destroy is recorded in <code>{copy.auditPath}</code>: who started it, what
            the manifest said, and what actually went. Nobody is emailed about it.
          </p>
          <Entry
            state={state}
            extraBlockers={localBlockers}
            buttonLabel={`Destroy this ${copy.noun}…`}
            onOpen={openDialog}
          />
        </Disclosure>
      )}

      <DestroyDialog
        open={dialogOpen}
        onClose={() => {
          if (phase === "destroying") return;
          setDialogOpen(false);
        }}
        state={state}
        noun={copy.noun}
        auditPath={copy.auditPath}
        nameLabel={nameLabel}
        expectedName={label}
        subtitle={subtitle}
        extraBlockers={localBlockers}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        manifestBusy={manifestState === "loading"}
        onDone={onDestroyed}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The collapsed red panel, closed by default, always. `onFirstOpen` fires the
 * first time it opens and never again: it is how the manifest read is deferred
 * until somebody has actually asked what a destroy would remove, without
 * turning a fidget into a bill.
 */
function Disclosure({
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
            order and out of the accessibility tree: the grid track hides it
            visually but would otherwise leave a focusable Destroy button in a
            panel nobody can see. */}
        <div className={styles.panelInner} inert={!open}>
          <div className={styles.panelBody}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The way in, or the reason there isn't one. Blockers REPLACE the button
 * rather than disabling it: a disabled control is a puzzle whose usual answer
 * is "keep clicking things until it lights up", and a sentence where the
 * button would have been is the answer instead.
 */
function Entry({
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
        <p className={styles.dangerBody}>
          Nothing is offered until the manifest can be read: a destroy whose scope is
          unknown is not one anybody should be pressing.
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

function BlockerList({ blockers }: { blockers: string[] }) {
  return (
    <div className={styles.blockers}>
      <h4 className={styles.blockersTitle}>This can&apos;t be destroyed yet</h4>
      <ul className={styles.blockerItems}>
        {blockers.map((b, i) => (
          <li key={`${i}-${b}`}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A pass failed or the loop stopped, and the operator closed the dialog on it.
 * The two cases are NOT described the same way: a refusal is decided before
 * the cascade touches anything, so nothing moved and there is no
 * half-destroyed anything to warn about.
 */
function UnfinishedNotice({
  state,
  noun,
  auditPath,
  onResume,
}: {
  state: UseDestroy;
  noun: string;
  auditPath: string;
  onResume: () => void;
}) {
  const started = state.deletedTotal > 0;
  const refused = state.failure?.kind === "refused";
  return (
    <div className={styles.interrupted}>
      <h3 className={styles.interruptedTitle}>
        {refused && !started ? "The destroy was refused" : "This destroy did not finish"}
      </h3>
      <p className={styles.interruptedBody}>{state.failure?.message}</p>
      <p className={styles.interruptedBody}>
        {started
          ? `${state.deletedTotal.toLocaleString()} row${
              state.deletedTotal === 1 ? " was" : "s were"
            } removed before it stopped, so this ${noun} is half-destroyed. Resuming is the only way to finish it.`
          : refused
            ? `Nothing was removed: this ${noun} is exactly as it was.`
            : "No rows were reported removed, but the attempt may not have been clean. Resuming re-reads the audit record and carries on from wherever it actually got to."}
      </p>
      {state.auditId && (
        <p className={styles.auditLine}>
          Audit record: <code>{auditPath}/{state.auditId}</code>
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

function DestroyDialog({
  open,
  onClose,
  state,
  noun,
  auditPath,
  nameLabel,
  expectedName,
  subtitle,
  extraBlockers,
  confirmText,
  onConfirmTextChange,
  manifestBusy,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  state: UseDestroy;
  noun: string;
  auditPath: string;
  nameLabel: string;
  expectedName: string;
  subtitle: string;
  extraBlockers: string[];
  confirmText: string;
  onConfirmTextChange: (next: string) => void;
  manifestBusy: boolean;
  onDone: () => void;
}) {
  const confirmId = useId();
  const { manifest, phase } = state;
  const busy = phase === "destroying";
  const resuming = manifest?.interrupted != null && phase === "idle";

  // Byte equality, no trimming: the point of the ritual is that the operator
  // typed this exact string. The hint tells a near-miss why it failed rather
  // than leaving a dead button to explain itself.
  const matches = confirmText === expectedName && expectedName.length > 0;
  const whitespaceOnly =
    !matches && confirmText.length > 0 && confirmText.trim() === expectedName.trim();

  const blockers = [...extraBlockers, ...(manifest?.blockers ?? [])];
  const rows = manifest ? describeRows(countRows(manifest.counts)) : [];
  const dying = rows.filter((r) => r.fate === "destroyed");
  const surviving = rows.filter((r) => r.fate !== "destroyed");
  const dyingTotal = dying.reduce((sum, r) => sum + r.value, 0);

  return (
    <Modal
      open={open}
      // Mid-cascade the dialog is not dismissible: Esc and the scrim both land
      // here, and both are ignored while a pass is in flight.
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

        {phase === "destroying" && (
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
            <p className={styles.dangerBody}>
              Pass {state.passes + 1}. The cascade runs in pages, so this may take several
              round trips. Leaving this page stops it between passes: nothing already
              removed comes back, and the record of where it got to means this page will
              offer to resume from there.
            </p>
          </section>
        )}

        {phase === "done" && (
          <>
            <Receipt
              state={state}
              noun={noun}
              auditPath={auditPath}
              name={expectedName}
              onDone={onDone}
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
                  : `${state.deletedTotal.toLocaleString()} row${
                      state.deletedTotal === 1 ? " has" : "s have"
                    } been removed so far. Resuming continues from there: the audit record is the cursor, so nothing is repeated and nothing is skipped.`}
              </p>
              {state.auditId && (
                <p className={styles.auditLine}>
                  Audit record: <code>{auditPath}/{state.auditId}</code>
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
              <p className={styles.dangerBody}>
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
                  Nothing is offered from here until it can be: the counts are the argument
                  for pressing the button, and a destroy with no stated scope is one nobody
                  should be authorising.
                </p>
              </div>
            )}

            {manifest && (
              <>
                {manifest.interrupted && (
                  <p className={styles.resumeNote}>
                    This resumes an earlier destroy that never finished
                    {sumCounts(manifest.interrupted.deleted) > 0
                      ? `, and ${sumCounts(
                          manifest.interrupted.deleted,
                        ).toLocaleString()} rows are already gone`
                      : ""}
                    . The counts below are what is still there.
                  </p>
                )}

                <section className={styles.countsBlock}>
                  <h3 className={styles.blockTitle}>
                    What this removes{manifestBusy ? " (refreshing…)" : ""}
                  </h3>
                  <p className={styles.blockHint}>
                    Counted live, just now. Nothing here can be recovered afterwards.
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
                          {row.note ? `. ${row.note}` : ""}
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

/**
 * The receipt. Deliberately flat: no tick, no colour, no "successfully". What
 * happened here is that records were destroyed, and the only useful things to
 * say are what went and where it is written down.
 */
function Receipt({
  state,
  noun,
  auditPath,
  name,
  onDone,
}: {
  state: UseDestroy;
  noun: string;
  auditPath: string;
  name: string;
  onDone: () => void;
}) {
  const rows = describeRows(countRows(state.deleted));
  const total = state.deletedTotal;
  // The manifest's estimate can exceed what the passes reported: a row deleted
  // by something else in between, or a counter this client cannot read. Say so
  // rather than presenting the smaller number as the whole story.
  const shortfall = state.estimatedTotal > total;

  return (
    <section className={styles.receipt}>
      <h3 className={styles.receiptTitle}>Destroyed</h3>
      <p className={styles.receiptBody}>
        {name ? `“${name}”` : `This ${noun}`} and the records listed below no longer exist.
        This page is showing a {noun} that is gone.
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
        <code>
          {auditPath}/{state.auditId ?? "(no audit id was returned)"}
        </code>
        {state.passes > 1 ? ` · ${state.passes} passes` : ""}
      </p>
      {shortfall && (
        <p className={styles.receiptCaveat}>
          The manifest counted about {state.estimatedTotal.toLocaleString()} rows before the
          cascade began, which is more than the passes reported removing. Where the two
          differ the audit record is the authority.
        </p>
      )}

      <div className={styles.receiptActions}>
        <Button type="button" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

/**
 * Apply this file's copy over the vocabulary `countRows` produced, key by key.
 * The FATE is never touched: what happens to a row is the route's contract and
 * `countMeta` is where it is decided, so this overlay may change the words and
 * nothing else. A row whose key is not in the overlay is returned as it came.
 */
function describeRows(rows: CountRow[]): CountRow[] {
  return rows.map((row) => {
    const extra = EXTRA_COUNT_COPY[row.key];
    return extra ? { ...row, label: extra.label, note: extra.note } : row;
  });
}

/** ISO to something readable, without pulling a date library into this file. */
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
