"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WORKSHEET_LIMITS, type WorksheetFolderDoc } from "@/lib/firestore/worksheets";
import styles from "./WorksheetLibrary.module.css";

/**
 * The library's shelves, as chips.
 *
 * FOLDERS ARE SHARED FURNITURE, not owned documents: any committee member may
 * make one, rename one and delete one, because a shelf whose maker has left the
 * committee must not be a shelf nobody can tidy. The rules say the same thing
 * (no ownership gate on `worksheetFolders`), so there is nothing to hide here
 * per viewer.
 *
 * Rename and delete act on the ACTIVE chip rather than sitting on every chip.
 * Ten shelves with three buttons each is thirty controls in a row that has to
 * scroll on a phone; picking the shelf first is the same two taps and leaves
 * the bar readable.
 */

/**
 * The three change handlers REJECT when the change did not happen, and the
 * parent has already put the reason on the screen. That is what lets this bar
 * keep a half-typed name in its box and keep the shelf selected instead of
 * tidying itself up over an error nobody has read yet.
 */
type Props = {
  folders: WorksheetFolderDoc[];
  /** null is the "All" chip. */
  activeFolderId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export default function FolderBar({
  folders,
  activeFolderId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [busy, setBusy] = useState(false);

  const active = folders.find((f) => f.id === activeFolderId) ?? null;

  async function submitCreate() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate(name);
      setNewName("");
      setCreating(false);
    } catch {
      // The name stays in the box: the parent's sentence says what to change.
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    const name = renameName.trim();
    if (!active || !name || busy) return;
    setBusy(true);
    try {
      await onRename(active.id, name);
      setRenaming(false);
    } catch {
      // Same again: the box stays open with the new name still in it.
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!active || busy) return;
    // The sentence says where the worksheets go, because "delete folder" reads
    // like it takes the worksheets with it and it does not.
    const ok = window.confirm(
      `Delete the folder "${active.name}"? The worksheets in it move to the top level; nothing is deleted.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await onDelete(active.id);
      // Back to "All", but ONLY on a delete that happened: the parent rethrows
      // a refusal, and clearing the chip on one would take the Delete button
      // off the screen while the reason for the failure is still on it.
      onSelect(null);
    } catch {
      // The parent has already put the sentence in front of the reader.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.folderBar}>
      <div className={styles.folderScroll}>
        <button
          type="button"
          className={`${styles.chip} ${activeFolderId === null ? styles.chipActive : ""}`}
          aria-pressed={activeFolderId === null}
          onClick={() => onSelect(null)}
        >
          All
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={`${styles.chip} ${activeFolderId === folder.id ? styles.chipActive : ""}`}
            aria-pressed={activeFolderId === folder.id}
            onClick={() => onSelect(folder.id)}
          >
            {folder.name}
          </button>
        ))}
      </div>

      <div className={styles.folderTools}>
        {renaming && active ? (
          <div className={styles.inlineForm}>
            <Input
              className={styles.inlineInput}
              value={renameName}
              maxLength={WORKSHEET_LIMITS.folderName}
              aria-label="New name for this folder"
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
            <Button type="button" size="sm" onClick={() => void submitRename()} disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRenaming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        ) : creating ? (
          <div className={styles.inlineForm}>
            <Input
              className={styles.inlineInput}
              value={newName}
              placeholder="Folder name"
              maxLength={WORKSHEET_LIMITS.folderName}
              aria-label="New folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCreate();
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void submitCreate()}
              disabled={busy || !newName.trim()}
            >
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setNewName("");
                setCreating(true);
              }}
            >
              New folder
            </Button>
            {active && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenameName(active.name);
                    setRenaming(true);
                  }}
                  disabled={busy}
                >
                  Rename
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void confirmDelete()}
                  disabled={busy}
                >
                  Delete folder
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
