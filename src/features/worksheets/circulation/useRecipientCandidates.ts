"use client";

import { useEffect, useState } from "react";

/**
 * The people a circulation can be sent to.
 *
 * ONE FETCH, NO FIRESTORE. `docs/worksheets.md` is explicit about this: the
 * picker must not read the `users` collection, because that collection is
 * readable only by SU-recognised committee and admins, and
 * `circulateWorksheet` is a permission an ordinary committee member can hold
 * without either. `GET /api/worksheets/recipients` checks the key server-side
 * and answers with uids, display names, photos and roles. No email addresses,
 * so the picker cannot become a way to read the membership.
 *
 * Fetched once on mount rather than kept live. The roster of committee members
 * does not change while somebody fills in a send dialog, and a listener would
 * be a second read of data this route already had to authorise.
 *
 * `enabled` exists because the circulation page uses this list for a SECOND
 * job: resolving the display names of people the task roster cannot answer for
 * (see the name comment in `CirculationPage`). That page is opened by staff who
 * may not hold `circulateWorksheet` at all, and the route answers them with a
 * 403, so the caller passes the permission in rather than this hook firing a
 * request it already knows will be refused.
 */

export type RecipientCandidate = {
  uid: string;
  displayName: string;
  photoURL: string | null;
  role: string;
  suRecognised: boolean;
};

export function useRecipientCandidates(enabled = true) {
  const [candidates, setCandidates] = useState<RecipientCandidate[]>([]);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/worksheets/recipients");
        const body = (await res.json().catch(() => null)) as
          | { members?: RecipientCandidate[]; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok) {
          // The route's own sentence wherever it sent one: a 403 here means
          // "you do not hold circulateWorksheet", which is a thing the person
          // can act on, and a generic failure message would send them looking
          // for a network problem instead.
          setError(body?.error ?? `Couldn't load the list of people (${res.status}).`);
          setSettled(true);
          return;
        }
        setCandidates(body?.members ?? []);
        setError(null);
        setSettled(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load the list of people.");
        setSettled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // DERIVED, not stored. Disabled is a settled state, not a pending one: a
  // caller that never turns this on must not be left holding a spinner that
  // resolves to nothing, and writing that with a `setLoading(false)` in the
  // effect body would be the cascading-render pattern the lint rule refuses.
  return { candidates, loading: enabled && !settled, error };
}
