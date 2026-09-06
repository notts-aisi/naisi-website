"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { WORKSHEET_LIMITS, type WorksheetFolderDoc } from "@/lib/firestore/worksheets";
import styles from "./WorksheetLibrary.module.css";

/**
 * Make a worksheet: a title and a shelf, and you are in the editor.
 *
 * The title is asked for here rather than defaulted to "Untitled" because it
 * becomes the document id (`slugId(title)`), and an id minted from a
 * placeholder is a Firebase console full of `untitled__a7f3k2m1`, which is
 * exactly what the slug convention exists to prevent.
 *
 * The folder defaults to whichever chip is selected: somebody filing a
 * worksheet has almost always just opened the shelf they want it on.
 */

const NO_FOLDER = "";

type Props = {
  folders: WorksheetFolderDoc[];
  /** The chip currently selected in the folder bar, or null for "All". */
  defaultFolderId: string | null;
  onCreate: (input: { title: string; folderId: string | null }) => Promise<void>;
};

export default function NewWorksheetForm({ folders, defaultFolderId, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? NO_FOLDER);
  const [busy, setBusy] = useState(false);

  // The chip moved under the form; follow it, but never overwrite a choice the
  // author has already made in the select.
  const [syncedDefault, setSyncedDefault] = useState<string | null>(defaultFolderId);
  if (defaultFolderId !== syncedDefault) {
    setSyncedDefault(defaultFolderId);
    setFolderId(defaultFolderId ?? NO_FOLDER);
  }

  const options: ResponsiveSelectOption[] = [
    { value: NO_FOLDER, label: "No folder" },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  async function submit() {
    const clean = title.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onCreate({ title: clean, folderId: folderId || null });
      setTitle("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.newWorksheet}>
      <div className={styles.newWorksheetTitle}>
        <Field id="new-worksheet-title" label="New worksheet">
          <Input
            id="new-worksheet-title"
            value={title}
            placeholder="What is it called?"
            maxLength={WORKSHEET_LIMITS.title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </Field>
      </div>
      <div className={styles.newWorksheetFolder}>
        <Field id="new-worksheet-folder" label="Folder">
          <ResponsiveSelect
            id="new-worksheet-folder"
            value={folderId}
            onChange={setFolderId}
            options={options}
            ariaLabel="Folder for the new worksheet"
          />
        </Field>
      </div>
      <Button type="button" onClick={() => void submit()} disabled={busy || !title.trim()}>
        {busy ? "Creating…" : "Create"}
      </Button>
    </div>
  );
}
