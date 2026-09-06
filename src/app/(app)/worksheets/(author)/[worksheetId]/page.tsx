"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import Switch from "@/components/ui/Switch";
import { useAuth } from "@/auth/AuthProvider";
import { useDebouncedWrite } from "@/hooks/useDebouncedWrite";
import CirculateDialog from "@/features/worksheets/circulation/CirculateDialog";
import WorksheetEditor from "@/features/worksheets/editor/WorksheetEditor";
import { useWorksheet } from "@/features/worksheets/hooks/useWorksheet";
import { useWorksheetCirculations } from "@/features/worksheets/hooks/useWorksheetCirculations";
import { useWorksheetFolders } from "@/features/worksheets/hooks/useWorksheetFolders";
import CirculationRow from "@/features/worksheets/library/CirculationRow";
import { formatDay } from "@/features/worksheets/library/WorksheetRow";
// The circulation rows below are the library's rows, so they wear the
// library's stylesheet rather than a second copy of the same padding here
// (the danger-zone pair does the same, for the same reason).
import rowStyles from "@/features/worksheets/library/WorksheetLibrary.module.css";
import {
  deleteWorksheet,
  duplicateWorksheet,
  setWorksheetPrivate,
  updateWorksheet,
} from "@/features/worksheets/worksheetMutations";
import { canCirculateWorksheet } from "@/lib/firestore/users";
import {
  WORKSHEET_LIMITS,
  validateWorksheetItems,
  type WorksheetItem,
} from "@/lib/firestore/worksheets";
import styles from "./WorksheetEditorPage.module.css";

/**
 * /worksheets/{worksheetId}: write the questions, then send them.
 *
 * A CLIENT PAGE, so the route param comes from `useParams` rather than the
 * awaited `params` promise a server page gets in Next 16. Everything on this
 * screen moves under the reader (the document is live, the circulations list is
 * live, the editor autosaves), so there is nothing here for a server render to
 * do that the first snapshot would not immediately replace.
 *
 * ── THE LOCAL DRAFT ─────────────────────────────────────────────────────────
 * The document is hydrated into local state ONCE per worksheet id, and every
 * later snapshot is ignored. That is deliberate: the snapshot stream carries
 * back the writes this page just made, and re-seeding the boxes from it would
 * move the caret mid-word and undo a keystroke that had not been saved yet. The
 * cost is that a second editor's changes are not seen live. Two people editing
 * one library worksheet is already last-write-wins (only the author and admins
 * can write it at all), so what would be lost is the display of a conflict
 * rather than the conflict itself.
 *
 * ── AUTOSAVE ────────────────────────────────────────────────────────────────
 * Two debounced writers, not one. The header (title and description) and the
 * items are independent patches, and `useDebouncedWrite`'s queue is one slot
 * deep with newest-wins: pushing a `{ items }` and then a `{ title }` through a
 * single writer would drop whichever lost the race. The header writer always
 * pushes BOTH of its fields from current state, so coalescing two keystrokes in
 * different boxes cannot lose one.
 *
 * `keepalive` is accepted and ignored by both writers, unlike the fetch-backed
 * ones the hook was built for: a Firestore write is handed to the SDK's own
 * queue, and there is no request object to mark. A hard navigation during the
 * debounce window can still take an unsaved keystroke, which is why the fields
 * flush on blur.
 */

const NO_FOLDER = "";

export default function WorksheetEditorPage() {
  const params = useParams<{ worksheetId: string }>();
  const worksheetId = typeof params?.worksheetId === "string" ? params.worksheetId : null;
  const router = useRouter();

  const { user, role, permissions } = useAuth();
  const { worksheet, rawItems, loading, error } = useWorksheet(worksheetId);
  // A REFUSED LISTEN IS NEVER READ AS AN EMPTY ONE. Both of these can come back
  // permission-denied (a demoted account still holding the tab open, a rules
  // deploy that moved under this page), and a page that drops the error tells
  // somebody "no circulations" and "no folders" as statements of fact. That is
  // the #261 shape: the sender of a circulation that exists reading that their
  // worksheet has never been sent.
  const { folders, error: foldersError } = useWorksheetFolders();
  const { circulations, error: circulationsError } = useWorksheetCirculations(
    worksheetId,
    user?.uid ?? null,
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<WorksheetItem[]>([]);
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [circulating, setCirculating] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  // Hydrate once per document, during render rather than in an effect: an
  // effect would paint one frame of empty boxes over a worksheet that has
  // already arrived. `rawItems` rather than `worksheet.items`, because the
  // normalised copy has had every authored limit clamped into range and this is
  // the one place the array is read in order to be written back (see
  // `useWorksheet`).
  //
  // The router reuses this component across a change of `worksheetId` rather
  // than remounting it, so everything the previous worksheet left behind is
  // cleared here too: a stale `busy` would leave the buttons disabled for good,
  // and a stale confirmation string is a delete already half-armed.
  if (worksheet && hydratedId !== worksheet.id) {
    setHydratedId(worksheet.id);
    setTitle(worksheet.title);
    setDescription(worksheet.description);
    setItems(rawItems);
    setConfirmText("");
    setBusy(false);
    // Including the saved stamp, so a fresh copy does not wear the date of the
    // worksheet it was made from while its own `serverTimestamp()` resolves.
    setLastSavedAt(worksheet.updatedAt);
  }

  // The last time the STORE said it had this document, which is not the same as
  // the last snapshot: `serverTimestamp()` reads back as null in the
  // latency-compensated local echo, so the field is null for the round trip
  // after every autosave. Holding the previous value keeps the line from
  // reading "Last saved not yet saved" for a second at a time.
  if (worksheet?.updatedAt && worksheet.updatedAt.getTime() !== lastSavedAt?.getTime()) {
    setLastSavedAt(worksheet.updatedAt);
  }

  const saveHeader = useCallback(
    async (value: { title: string; description: string }) => {
      if (!worksheetId) return;
      await updateWorksheet(worksheetId, {
        title: value.title,
        description: value.description,
      });
    },
    [worksheetId],
  );
  const saveItems = useCallback(
    async (next: WorksheetItem[]) => {
      if (!worksheetId) return;
      await updateWorksheet(worksheetId, { items: next });
    },
    [worksheetId],
  );

  const headerSaver = useDebouncedWrite(saveHeader);
  const itemsSaver = useDebouncedWrite(saveItems);

  /**
   * One indicator for two writers. Error beats saving beats saved, so a refusal
   * on either patch is never hidden behind the other one's tick.
   */
  const saveState: SaveState =
    headerSaver.state === "error" || itemsSaver.state === "error"
      ? "error"
      : headerSaver.state === "saving" || itemsSaver.state === "saving"
        ? "saving"
        : headerSaver.state === "saved" || itemsSaver.state === "saved"
          ? "saved"
          : "idle";
  const saveError = headerSaver.error ?? itemsSaver.error;

  const problems = useMemo(() => validateWorksheetItems(items), [items]);

  const viewer =
    role && (role === "admin" || role === "committee" || role === "member")
      ? { role, permissions }
      : null;
  const isAdmin = role === "admin";
  const canCirculate = viewer ? canCirculateWorksheet(viewer) : false;
  const canEdit = Boolean(worksheet && (isAdmin || worksheet.authorUid === user?.uid));
  // COPYING A PRIVATE WORKSHEET IS AN ADMIN'S CALL. `private` is admin-only in
  // both directions, and the author of a worksheet an admin has made private is
  // routinely not an admin, so an unconditional "Make a copy" would be one
  // click from that author republishing every question of it into the library
  // the whole committee browses. `duplicateWorksheet` inherits the flag, so the
  // create rule refuses that copy anyway; hiding the button is so nobody meets
  // the refusal.
  const canCopy = Boolean(worksheet && (isAdmin || !worksheet.private));

  const folderOptions: ResponsiveSelectOption[] = [
    { value: NO_FOLDER, label: "No folder" },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  function handleTitle(next: string) {
    setTitle(next);
    headerSaver.push({ title: next, description });
  }

  function handleDescription(next: string) {
    setDescription(next);
    headerSaver.push({ title, description: next });
  }

  function handleItems(next: WorksheetItem[]) {
    setItems(next);
    itemsSaver.push(next);
  }

  async function handleFolder(next: string) {
    if (!worksheetId) return;
    setActionError(null);
    try {
      await updateWorksheet(worksheetId, { folderId: next || null });
    } catch (err) {
      setActionError(refusal(err, "Couldn't move that worksheet."));
    }
  }

  async function handlePrivate(next: boolean) {
    if (!worksheetId) return;
    setActionError(null);
    try {
      await setWorksheetPrivate(worksheetId, next);
    } catch (err) {
      setActionError(refusal(err, "Only an admin can make a worksheet private."));
    }
  }

  /**
   * The copy is taken from the LOCAL draft over the stored document, and the
   * pending writes go out first. Both halves are about the same four hundred
   * milliseconds: the snapshot this page holds lags a keystroke made inside the
   * debounce window, so copying `worksheet` alone would quietly drop the last
   * question from the copy, and flushing alone would not help because the echo
   * of that write has not arrived yet.
   */
  async function handleCopy() {
    if (!worksheet || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await Promise.all([headerSaver.flush(), itemsSaver.flush()]);
      const id = await duplicateWorksheet({ ...worksheet, title, description, items });
      router.push(`/worksheets/${id}`);
    } catch (err) {
      setActionError(refusal(err, "Couldn't copy that worksheet."));
    } finally {
      // Cleared even on the way out: the router reuses this component across
      // the id change, so leaving it true disables the buttons on the copy.
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!worksheetId || busy) return;
    setBusy(true);
    setActionError(null);
    // Pending autosaves are DROPPED rather than flushed. The document is about
    // to go, so a queued keystroke has nowhere to land: without this it is
    // written to a deleted document by the debounce timer or by the unmount
    // path, which sets the sticky error state and puts "that change is not
    // stored" on a page that is already navigating away.
    headerSaver.cancel();
    itemsSaver.cancel();
    try {
      await deleteWorksheet(worksheetId);
      router.push("/worksheets");
    } catch (err) {
      setActionError(refusal(err, "Only the author or an admin can delete this worksheet."));
      setBusy(false);
    }
  }

  /**
   * Everything typed but not yet written goes out BEFORE the dialog opens: the
   * circulate route copies the STORED worksheet, so a question added four
   * hundred milliseconds ago would otherwise be missing from the copy the
   * recipients answer.
   */
  async function openCirculate() {
    await Promise.all([headerSaver.flush(), itemsSaver.flush()]);
    setCirculating(true);
  }

  if (!worksheetId) return null;

  // A REFUSED READ AND A MISSING DOCUMENT ARE THE SAME SCREEN, because from
  // here they are the same fact. The worksheets read rule dereferences
  // `resource.data.private`, and on a document that does not exist `resource`
  // is null, so a committee member opening a deleted or mistyped id gets
  // permission-denied rather than an empty snapshot. Reporting that verbatim
  // would tell somebody their access was refused when the worksheet simply is
  // not there, and the page cannot tell the two apart.
  //
  // EVERY OTHER CODE KEEPS ITS OWN SENTENCE. Written as "no document yet, so
  // it must be missing" this branch swallowed the transient failures too: a
  // listen that never got its first snapshot because the device is offline, or
  // `unavailable`, would have read as "that worksheet is not here. It may have
  // been deleted", which is a claim about somebody's data rather than about
  // their connection.
  const code = (error as { code?: string } | null)?.code;
  const missing = code === "permission-denied" || code === "not-found";
  if (error && !missing) {
    return (
      <p className={styles.error}>
        Couldn&apos;t open that worksheet: {error.message}
      </p>
    );
  }
  if (loading && !error) return <p className={styles.hint}>Loading…</p>;
  if (!worksheet) {
    return (
      <div className={styles.page}>
        <p className={styles.hint}>
          That worksheet is not here. It may have been deleted, or it may be private.
        </p>
        <Link href="/worksheets" className={styles.back}>
          Back to the library
        </Link>
      </div>
    );
  }

  const expectedTitle = worksheet.title.trim();
  const confirmed = expectedTitle.length > 0 && confirmText.trim() === expectedTitle;

  return (
    <div className={styles.page}>
      <div className={styles.section}>
        <div className={styles.headerTop}>
          <Link href="/worksheets" className={styles.back}>
            Back to the library
          </Link>
          <div className={styles.headerStatus}>
            <SavedFlash state={saveState} />
          </div>
        </div>

        <Input
          className={styles.titleInput}
          value={title}
          aria-label="Worksheet title"
          placeholder="Untitled worksheet"
          maxLength={WORKSHEET_LIMITS.title}
          disabled={!canEdit}
          onChange={(e) => handleTitle(e.target.value)}
          onBlur={() => void headerSaver.flush()}
        />

        {saveState === "error" && saveError && (
          <p className={styles.error}>
            That change is not stored: {saveError.message}
          </p>
        )}
        {actionError && <p className={styles.error}>{actionError}</p>}

        {!canEdit && (
          <div className={styles.note}>
            <span>
              This one is somebody else&apos;s. You can read it and take a copy to work on;
              only its author and admins can change it.
            </span>
            {canCopy && (
              <Button type="button" size="sm" onClick={() => void handleCopy()} disabled={busy}>
                Make a copy
              </Button>
            )}
          </div>
        )}

        <div className={styles.description}>
          <Field
            id="worksheet-description"
            label="Description"
            hint="A line or two for the people you send it to."
          >
            <CountedTextarea
              id="worksheet-description"
              value={description}
              max={WORKSHEET_LIMITS.description}
              rows={3}
              disabled={!canEdit}
              onChange={(e) => handleDescription(e.target.value)}
              onBlur={() => void headerSaver.flush()}
            />
          </Field>
        </div>

        {foldersError && (
          <p className={styles.error}>
            Couldn&apos;t load the folders: {foldersError.message}
          </p>
        )}

        <div className={styles.settings}>
          <div className={styles.settingsField}>
            <Field id="worksheet-folder" label="Folder">
              <ResponsiveSelect
                id="worksheet-folder"
                value={worksheet.folderId ?? NO_FOLDER}
                onChange={(next) => void handleFolder(next)}
                options={folderOptions}
                ariaLabel="Folder"
                disabled={!canEdit}
              />
            </Field>
          </div>
          {isAdmin && (
            <div className={styles.settingsField}>
              <Switch
                checked={worksheet.private}
                onChange={(next) => void handlePrivate(next)}
                label="Private"
                description="Admins and the author only. Nobody else sees it in the library."
              />
            </div>
          )}
        </div>

        <div className={styles.metaRow}>
          <span>
            {items.length === 0
              ? "No questions yet."
              : problems.length === 0
                ? "Nothing to fix."
                : `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix`}
          </span>
          <span>{lastSavedAt ? `Last saved ${formatDay(lastSavedAt)}` : "Not saved yet"}</span>
        </div>

        {problems.length > 0 && (
          <ul className={styles.problemList}>
            {problems.slice(0, 5).map((problem, index) => (
              <li key={`${problem.itemId}-${index}`}>{problem.message}</li>
            ))}
          </ul>
        )}

        <div className={styles.actions}>
          {canCirculate && (
            <Button
              type="button"
              onClick={() => void openCirculate()}
              // A worksheet with a question missing its title, or an option
              // with no label, is one the recipients cannot answer. Sending it
              // and finding out afterwards costs a re-send and everybody's
              // attention, so the button waits.
              disabled={problems.length > 0 || items.length === 0}
              title={
                problems.length > 0
                  ? "Fix the problems above first."
                  : items.length === 0
                    ? "Add a question first."
                    : undefined
              }
            >
              Circulate
            </Button>
          )}
          {canCopy && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleCopy()}
              disabled={busy}
            >
              Make a copy
            </Button>
          )}
        </div>
      </div>

      <WorksheetEditor
        items={items}
        onChange={handleItems}
        storageOwnerId={worksheet.id}
        disabled={!canEdit}
      />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Circulations</h2>
        {circulationsError ? (
          <p className={styles.error}>
            Couldn&apos;t load the circulations of this worksheet: {circulationsError.message}
          </p>
        ) : circulations.length === 0 ? (
          <p className={styles.hint}>
            This worksheet has not been sent yet. Circulating it takes a copy of the questions,
            so you can keep editing this one afterwards.
          </p>
        ) : (
          <ul className={rowStyles.rows}>
            {circulations.map((circulation) => (
              <CirculationRow key={circulation.id} circulation={circulation} />
            ))}
          </ul>
        )}
      </div>

      {canEdit && (
        <div className={styles.danger}>
          <h2 className={styles.dangerTitle}>Delete this worksheet</h2>
          <p className={styles.dangerBody}>
            Anything already circulated keeps its own copy of the questions, its answers and
            its tasks, so deleting this document does not reach the people who have it. It
            cannot be undone.
          </p>
          {expectedTitle.length === 0 ? (
            <p className={styles.dangerBody}>
              This worksheet has no title, so there is nothing to type as confirmation. Give it
              one first.
            </p>
          ) : (
            <div className={styles.confirmRow}>
              <div className={styles.confirmField}>
                <Field
                  id="worksheet-delete-confirm"
                  label={`Type "${expectedTitle}" to confirm`}
                >
                  <Input
                    id="worksheet-delete-confirm"
                    value={confirmText}
                    autoComplete="off"
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="danger"
                onClick={() => void handleDelete()}
                disabled={!confirmed || busy}
              >
                {busy ? "Deleting…" : "Delete worksheet"}
              </Button>
            </div>
          )}
        </div>
      )}

      {circulating && (
        <CirculateDialog
          worksheet={worksheet}
          onClose={() => setCirculating(false)}
          onCreated={(circulationId) =>
            router.push(`/worksheets/${worksheet.id}/circulations/${circulationId}`)
          }
        />
      )}
    </div>
  );
}

/** Firestore's own words for a refused write say nothing anyone can act on. */
function refusal(err: unknown, sentence: string): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "permission-denied") return sentence;
  return err instanceof Error && err.message ? err.message : sentence;
}
