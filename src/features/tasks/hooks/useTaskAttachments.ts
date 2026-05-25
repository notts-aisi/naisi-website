"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeAttachment,
  type AttachmentDoc,
} from "@/lib/firestore/taskAttachments";

export function useTaskAttachments(taskId: string | null) {
  const [attachments, setAttachments] = useState<AttachmentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!taskId) return;
    if (bypass.isActive) {
      // No attachment fixtures: empty list, stop loading.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    const db = getClientDb();
    const q = query(
      collection(db, "tasks", taskId, "attachments"),
      orderBy("uploadedAt", "desc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAttachments(snap.docs.map((d) => normalizeAttachment(d.id, d.data())));
        setLoading(false);
      },
      (err) => {
        console.error("useTaskAttachments:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [taskId]);

  return { attachments, loading, error };
}
