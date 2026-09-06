"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { useAuth } from "@/auth/AuthProvider";
import SentList from "@/features/worksheets/library/SentList";
import WorksheetLibrary from "@/features/worksheets/library/WorksheetLibrary";
import styles from "./WorksheetsPage.module.css";

/**
 * /worksheets: the library.
 *
 * TWO TABS, ONE PAGE. "Library" is what exists to send; "Sent" is what has been
 * sent and is coming back. They are the same feature from either end, and a
 * separate route for the second would be a nav entry nobody reads and a back
 * button nobody wants.
 *
 * Neither tab is gated on `circulateWorksheet`. Reading and writing worksheets
 * is open to the whole committee, and the Sent tab lists the circulations the
 * viewer is STAFF on, which includes reviewers who hold no key at all. The key
 * gates the Circulate button on the editor page, where the sending happens.
 */

type Tab = "library" | "sent";

const TABS = [
  { value: "library" as const, label: "Library" },
  { value: "sent" as const, label: "Sent" },
];

export default function WorksheetsPage() {
  const { user, role } = useAuth();
  const [tab, setTab] = useState<Tab>("library");

  // The layout has already refused anyone who is not committee or admin; this
  // is the render-time equivalent, and it also covers the first paint before
  // the user document's snapshot has arrived.
  if (!user || !role) return null;

  return (
    <div>
      <div className={styles.headerRow}>
        <div className={styles.headerText}>
          <Badge tone="accent">Committee</Badge>
          <h1 className={styles.headerTitle}>Worksheets</h1>
          <p className={styles.subtitle}>
            Write a set of questions once, send it to people, and read what comes back.
          </p>
        </div>
      </div>

      <div className={styles.tabs}>
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={TABS}
          ariaLabel="Worksheets view"
        />
      </div>

      {tab === "library" ? (
        <WorksheetLibrary viewerUid={user.uid} isAdmin={role === "admin"} />
      ) : (
        <SentList viewerUid={user.uid} />
      )}
    </div>
  );
}
