"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "@/components/ui/EmptyState";
import { useTaskRoster } from "@/features/tasks/hooks/useTaskRoster";
import { useWorksheetFolders } from "@/features/worksheets/hooks/useWorksheetFolders";
import { useWorksheets } from "@/features/worksheets/hooks/useWorksheets";
import {
  createFolder,
  createWorksheet,
  deleteFolder,
  deleteWorksheet,
  duplicateWorksheet,
  renameFolder,
} from "@/features/worksheets/worksheetMutations";
import type { WorksheetDoc } from "@/lib/firestore/worksheets";
import FolderBar from "./FolderBar";
import NewWorksheetForm from "./NewWorksheetForm";
import WorksheetRow from "./WorksheetRow";
import styles from "./WorksheetLibrary.module.css";

/**
 * The library tab: shelves, a way to add a worksheet, and the worksheets
 * themselves.
 *
 * NAMES COME FROM `useTaskRoster`, NEVER FROM THE `users` COLLECTION. Member
 * PII is readable only by SU-recognised committee and admins, and this page is
 * open to every committee member, so a `users` read here would be a listen that
 * works for the people who tested it and is refused for half its audience. The
 * roster route answers with the people the viewer already shares a task with,
 * which covers most authors and degrades to "Committee member" for the rest.
 * That is a name missing from a grey line, not a broken page.
 *
 * A FOLDER ID THAT RESOLVES TO NOTHING READS AS "No folder". Deleting a shelf
 * re-files only the deleter's own worksheets off it (see `deleteFolder`: a
 * committee member may not write anybody else's, and a shelf only its sole user
 * can delete is not shared furniture), and rules cannot cascade, so a dangling
 * `folderId` is a state this list has to survive rather than trust.
 */

type Props = {
  viewerUid: string;
  isAdmin: boolean;
};

/**
 * The sentence to put in front of the reader. A refused write is the common
 * failure here and Firestore's own message for it says nothing anyone can act
 * on, so the caller supplies one that does.
 */
function messageFor(err: unknown, refusal: string): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "permission-denied") return refusal;
  return err instanceof Error && err.message ? err.message : refusal;
}

export default function WorksheetLibrary({ viewerUid, isAdmin }: Props) {
  const router = useRouter();
  const { worksheets, loading, error } = useWorksheets({ isAdmin });
  // The folders listen keeps its error rather than reading as "no shelves":
  // a refused listen and an empty collection look identical from here, and one
  // of them is a sentence somebody needs to see (the #261 shape).
  const { folders, error: foldersError } = useWorksheetFolders();
  const { users } = useTaskRoster();

  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const folderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders) map.set(folder.id, folder.name);
    return map;
  }, [folders]);

  const rows = useMemo(() => {
    if (!activeFolderId) return worksheets;
    return worksheets.filter((w) => w.folderId === activeFolderId);
  }, [worksheets, activeFolderId]);

  function nameFor(uid: string): string {
    if (uid === viewerUid) return "You";
    const match = users.find((u) => u.uid === uid);
    return match?.displayName || "Committee member";
  }

  async function handleCreate(input: { title: string; folderId: string | null }) {
    setActionError(null);
    try {
      const id = await createWorksheet(input);
      router.push(`/worksheets/${id}`);
    } catch (err) {
      setActionError(
        messageFor(err, "Couldn't create that worksheet. Only committee members and admins can."),
      );
    }
  }

  async function handleDuplicate(worksheet: WorksheetDoc) {
    setActionError(null);
    try {
      const id = await duplicateWorksheet(worksheet);
      router.push(`/worksheets/${id}`);
    } catch (err) {
      setActionError(messageFor(err, "Couldn't copy that worksheet."));
    }
  }

  async function handleDelete(worksheet: WorksheetDoc) {
    setActionError(null);
    try {
      await deleteWorksheet(worksheet.id);
    } catch (err) {
      setActionError(
        messageFor(err, "Only the worksheet's author or an admin can delete it."),
      );
    }
  }

  async function handleCreateFolder(name: string) {
    setActionError(null);
    // A COURTESY CHECK, NOT AN INVARIANT. Folder ids carry a random suffix, so
    // two shelves called "Fellowship" are two documents and the chip row shows
    // the same word twice with no way to tell which is which. Rules cannot
    // express uniqueness and two people can still race each other through this,
    // so it is worth exactly what it costs: the common case, caught in front of
    // the person about to make the mess.
    const clash = folders.find(
      (folder) => folder.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (clash) {
      setActionError(`There is already a folder called "${clash.name}".`);
      // Rejecting rather than returning quietly is this file's half of the
      // contract with the folder bar: a rejected change leaves the box open
      // with the typed name still in it, so the reader can fix the clash
      // instead of typing it again.
      throw new Error("Duplicate folder name");
    }
    try {
      await createFolder(name);
    } catch (err) {
      setActionError(messageFor(err, "Couldn't create that folder."));
      throw err;
    }
  }

  async function handleRenameFolder(id: string, name: string) {
    setActionError(null);
    try {
      await renameFolder(id, name);
    } catch (err) {
      setActionError(messageFor(err, "Couldn't rename that folder."));
      throw err;
    }
  }

  async function handleDeleteFolder(id: string) {
    setActionError(null);
    try {
      await deleteFolder(id);
    } catch (err) {
      setActionError(
        messageFor(err, "Couldn't delete that folder. Only committee members and admins can."),
      );
      // Rethrown so the bar knows the shelf is still there: it deselects the
      // chip on a delete that happened, and a chip that cleared itself while an
      // error sits above it would take the Delete button away with it.
      throw err;
    }
  }

  return (
    <div className={styles.section}>
      <FolderBar
        folders={folders}
        activeFolderId={activeFolderId}
        onSelect={setActiveFolderId}
        onCreate={handleCreateFolder}
        onRename={handleRenameFolder}
        onDelete={handleDeleteFolder}
      />

      <NewWorksheetForm
        folders={folders}
        defaultFolderId={activeFolderId}
        onCreate={handleCreate}
      />

      {foldersError && (
        <p className={styles.error}>
          Couldn&apos;t load the folders: {foldersError.message}
        </p>
      )}
      {actionError && <p className={styles.error}>{actionError}</p>}

      {error ? (
        <p className={styles.error}>Couldn&apos;t load the library: {error.message}</p>
      ) : loading ? (
        <p className={styles.hint}>Loading worksheets…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={activeFolderId ? "Nothing on this shelf yet." : "No worksheets yet."}
          body="Give one a name above and you will land straight in the editor."
        />
      ) : (
        <ul className={styles.rows}>
          {rows.map((worksheet) => (
            <WorksheetRow
              key={worksheet.id}
              worksheet={worksheet}
              folderName={
                worksheet.folderId ? folderNames.get(worksheet.folderId) ?? null : null
              }
              authorName={nameFor(worksheet.authorUid)}
              canDelete={isAdmin || worksheet.authorUid === viewerUid}
              onDuplicate={() => handleDuplicate(worksheet)}
              onDelete={() => handleDelete(worksheet)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
