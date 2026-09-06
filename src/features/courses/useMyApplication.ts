"use client";

import { useCallback, useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";
import {
  courseApplicationId,
  normalizeCourseApplication,
  type CourseApplicationDoc,
} from "@/lib/firestore/courseApplications";

/**
 * The applicant's own row for one run, read straight from Firestore.
 *
 * One-shot, not `onSnapshot`: an application changes when its owner submits,
 * edits or withdraws it — all of which route through the API and are followed
 * by an explicit `reload()` — plus once more when a reviewer decides, hours or
 * days later. A standing listener would buy a live status flip nobody is
 * watching for, at the cost of an open channel on a PUBLIC page.
 *
 * Reading rather than trusting the POST response is deliberate: the row is the
 * only place `status` and `createdAt` come from (the route owns both), so the
 * status card can never drift from what admissions actually sees.
 *
 * Rules allow the own-row read (`resource.data.uid == request.auth.uid`), which
 * has one sharp edge worth naming: for a doc that does NOT exist, `resource` is
 * null and that expression ERRORS, so Firestore answers permission-denied
 * rather than an empty snapshot. "Denied" and "no application yet" are
 * therefore the same outcome here — both resolve to `application: null`, and
 * the apply route stays the actual boundary (its 409 catches the case where a
 * row exists but this read couldn't see it).
 */
export type MyApplication = {
  application: CourseApplicationDoc | null;
  /** True while a read is in flight, including a `reload()` after a write. */
  loading: boolean;
  reload: () => void;
};

export function useMyApplication(runId: string): MyApplication {
  const { user, loading: authLoading } = useAuth();
  const [application, setApplication] = useState<CourseApplicationDoc | null>(null);
  const [nonce, setNonce] = useState(0);
  // The nonce whose read has landed. Comparing the two (rather than a plain
  // `loading` boolean that only the FIRST read flips) means a post-submit
  // `reload()` shows "checking…" instead of flashing the empty form back at
  // someone who has just pressed Submit.
  const [settledNonce, setSettledNonce] = useState(-1);

  const uid = user?.uid ?? null;

  useEffect(() => {
    // Wait for Firebase Auth to answer: reading before it resolves is an
    // unauthenticated read, which is a guaranteed denial and would render
    // "no application" to someone who has one. Signed-out is handled by the
    // derivation below rather than by setState here — an effect body that
    // sets state synchronously is a cascading render (and a lint error).
    if (authLoading || !uid || !runId) return;
    let cancelled = false;
    getDoc(doc(getClientDb(), "courseApplications", courseApplicationId(runId, uid)))
      .then((snap) => {
        if (cancelled) return;
        setApplication(
          snap.exists() ? normalizeCourseApplication(snap.id, snap.data()) : null,
        );
      })
      .catch(() => {
        // Missing doc (see module comment), offline, or a rules deploy in
        // flight — all indistinguishable from here, and all mean "show them
        // the form". The route re-checks before it writes anything.
        if (!cancelled) setApplication(null);
      })
      .finally(() => {
        if (!cancelled) setSettledNonce(nonce);
      });
    return () => {
      cancelled = true;
    };
    // `nonce` is the refetch trigger (the `useCourseRun` idiom in RunEditor).
  }, [runId, uid, authLoading, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Derived, not stored: with no signed-in user there is nothing to read, and
  // a row left over from a previous uid (account switch without a remount)
  // must never be shown to whoever is signed in now — the stored `uid` field
  // is the check, never the doc id, which is construct-only.
  const mine = uid && application?.uid === uid ? application : null;
  const reading = authLoading || (Boolean(uid) && Boolean(runId) && settledNonce !== nonce);

  return { application: mine, loading: reading, reload };
}

export default useMyApplication;
