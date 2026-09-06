"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeResponse, type ResponseDoc } from "@/lib/firestore/circulations";

/**
 * One recipient's response, live.
 *
 * The document id IS the recipient's uid, so this is a get of a path built
 * from the caller's own identity when the recipient reads their own work, and
 * a get of a named path when staff read somebody else's. Both are allowed by
 * the same rule (`isOwner() || isParentStaff()`), so no branch is needed here.
 *
 * Both arguments are nullable because both arrive asynchronously on the
 * surfaces that use this: the respond page has a route param and an auth uid,
 * and neither is settled on the first render.
 */
export function useResponse(circulationId: string | null, uid: string | null) {
  const [response, setResponse] = useState<ResponseDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!circulationId || !uid) return;
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "circulations", circulationId, "responses", uid),
      (snap) => {
        setResponse(snap.exists() ? normalizeResponse(snap.id, snap.data()) : null);
        setLoading(false);
      },
      (err) => {
        console.error("useResponse:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [circulationId, uid]);

  const ready = Boolean(circulationId && uid);
  return {
    response: ready ? response : null,
    loading: ready ? loading : false,
    error,
  };
}
