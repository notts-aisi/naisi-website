"use client";

import { useCallback, useEffect, useRef } from "react";
import { deleteField, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  useDebouncedWrite,
  type DebouncedWriteState,
} from "@/hooks/useDebouncedWrite";
import {
  CIRCULATIONS_COLLECTION,
  RESPONSES_SUBCOLLECTION,
} from "@/lib/firestore/circulations";
import {
  computeProgress,
  type WorksheetAnswer,
  type WorksheetItem,
} from "@/lib/firestore/worksheets";
import { claimPending, restorePending, shouldRemoveAnswer } from "./respondHelpers";

/**
 * The recipient's autosave: one debounced writer for the WHOLE response, and
 * the only client-direct write in the answering path.
 *
 * ── ONE WRITER, NOT ONE PER QUESTION ────────────────────────────────────────
 * A worksheet page can hold a dozen questions, and a recipient filling a form
 * moves through them faster than any debounce. A writer per field would put
 * twelve overlapping updates on the same document, and `useDebouncedWrite`'s
 * no-overlap guarantee is PER HOOK INSTANCE, so it would not order them: the
 * last write to land would be whichever request the network happened to
 * finish last, and Firestore's last-write-wins would keep it. So there is one
 * writer, the value it carries is the whole answers map, and the questions
 * touched since the last successful write are remembered beside it.
 *
 * ── WHY A PENDING SET RATHER THAN WRITING THE WHOLE MAP ─────────────────────
 * The patch names one field per changed question (`answers.<id>`) instead of
 * replacing `answers` wholesale. Two reasons, both real:
 *   1. staff may edit the circulation's copy of the questions mid-flight, and
 *      a whole-map write from a page holding the OLD copy would delete an
 *      answer the recipient gave to a question this browser has not seen yet
 *      (their own second tab, most plausibly);
 *   2. a cleared box has to REMOVE its key rather than store an empty answer,
 *      and `deleteField()` is per-field by construction.
 * A write CLAIMS its questions out of the set before it goes out and puts them
 * back if it fails (`claimPending` / `restorePending`, whose comment carries
 * the worked example). Clearing them on the way back instead would delete a
 * re-add made by a push that arrived mid-flight, and the edit that push was
 * carrying would then be in no document and in no queue while the debouncer
 * reported "saved".
 *
 * ── PROGRESS IS SENT EVERY TIME, AND IS COSMETIC ────────────────────────────
 * `progress` is recomputed from the whole answers map on every push, because
 * it is what the sender's board reads while people work. It is not trusted:
 * the submit route re-derives it from the circulation's own items, so a
 * client that lied here would gain a wrong progress bar and nothing else.
 *
 * ── KEEPALIVE IS NOT AVAILABLE HERE, AND THAT IS WHY SAVE EXISTS ────────────
 * `useDebouncedWrite` passes `{ keepalive }` on its unmount and page-hide
 * paths, which a `fetch` caller hands to the browser so the request outlives
 * the document. A client-direct Firestore write has no such flag: the SDK owns
 * the connection, and a write dispatched as the page tears down may or may not
 * reach the server. That is exactly why this surface has an explicit Save
 * button and flushes on blur and on every page change, rather than relying on
 * the teardown path the courses exercise answer can rely on.
 */

export type AnswerAutosave = {
  /**
   * Queue the whole answers map, naming the question that changed. Call it on
   * every edit: the caller's own state is the value being promised.
   */
  push: (answers: Record<string, WorksheetAnswer>, changedQuestionId: string) => void;
  /** Write anything pending now. Resolves once the queue has drained. */
  flush: () => Promise<void>;
  /** Drop a scheduled write. Never recalls one already on the wire. */
  cancel: () => void;
  /** Back to idle with no error, for a caller that stored the value itself. */
  reset: () => void;
  /**
   * Is anything the recipient typed still missing from the document?
   *
   * A FUNCTION, not a boolean, because the one caller that needs it reads it
   * after an `await`: `state` and `error` in a handler's closure are the
   * render-time snapshot, and `useDebouncedWrite`'s drain swallows the throw,
   * so an awaited `flush()` resolves the same way whether its write landed or
   * was refused. Submit asks this before it posts: freezing a response around
   * answers that are only on screen is the failure this surface must not have.
   */
  hasUnsavedChanges: () => boolean;
  state: DebouncedWriteState;
  error: Error | null;
};

export function useAnswerAutosave(args: {
  circulationId: string;
  /** Null until the auth state resolves; no write is attempted before then. */
  uid: string | null;
  /** The circulation's copy of the items, for the progress numbers. */
  items: WorksheetItem[];
  /** False once the response is frozen (submitted or reviewed) or closed to
   *  this viewer. Every write path checks it, so a late flush from a page
   *  being torn down cannot land on a document the rules would refuse. */
  enabled: boolean;
}): AnswerAutosave {
  const { circulationId, uid, items, enabled } = args;

  /**
   * The questions changed since the last successful write. A ref rather than
   * state: it is read inside the writer, which runs between renders, and a
   * re-render per keystroke to track it would buy nothing.
   */
  const pendingRef = useRef<Set<string>>(new Set());

  /**
   * The last answers map handed to the writer. Kept because a FAILED write
   * empties the debouncer's one value slot while leaving its questions pending
   * here, so a later Save would find nothing queued and report success by
   * saying nothing. `flush` re-queues this first. See the comment there.
   */
  const lastValueRef = useRef<Record<string, WorksheetAnswer> | null>(null);

  // Read inside the writer, which must see the CURRENT items and gate, not the
  // ones the closure was built with. Assigned in an effect rather than during
  // render, the idiom useDebouncedWrite itself uses for `writeRef`.
  const itemsRef = useRef(items);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const write = useCallback(
    async (next: Record<string, WorksheetAnswer>) => {
      if (!uid || !enabledRef.current) return;
      // Claimed BEFORE the await, and put back below if the write fails. A
      // push landing while this one is in flight re-adds its question to the
      // set, and that re-add has to survive this write finishing.
      const ids = claimPending(pendingRef.current);
      if (ids.length === 0) return;

      const patch: Record<string, unknown> = {
        progress: computeProgress(itemsRef.current, next),
        updatedAt: serverTimestamp(),
      };
      for (const id of ids) {
        patch[`answers.${id}`] = shouldRemoveAnswer(next[id]) ? deleteField() : next[id];
      }

      const ref = doc(
        getClientDb(),
        CIRCULATIONS_COLLECTION,
        circulationId,
        RESPONSES_SUBCOLLECTION,
        uid,
      );
      try {
        await updateDoc(ref, patch);
      } catch (err) {
        // Back in the queue so the next attempt carries them, which is the
        // whole of this hook's retry story. The throw is re-raised because
        // `useDebouncedWrite` reads a rejection as "not stored".
        restorePending(pendingRef.current, ids);
        throw err;
      }
    },
    [circulationId, uid],
  );

  const writer = useDebouncedWrite<Record<string, WorksheetAnswer>>(write);

  const { push: pushValue, cancel, flush: flushWriter, reset, state, error } = writer;

  const push = useCallback(
    (answers: Record<string, WorksheetAnswer>, changedQuestionId: string) => {
      if (!enabled || !uid) {
        // `useDebouncedWrite`'s rule for callers is absolute: every change
        // either pushes what the box now holds or cancels. Returning without
        // cancelling would leave a value scheduled from before the gate shut
        // (a response frozen in another tab while a draft was in the timer),
        // and the writer would land it a moment later against the rules.
        cancel();
        return;
      }
      pendingRef.current.add(changedQuestionId);
      lastValueRef.current = answers;
      pushValue(answers);
    },
    [cancel, enabled, pushValue, uid],
  );

  /**
   * Save, and RETRY. Questions still in the pending set with an empty value
   * slot behind them mean the last write did not land: the debouncer took its
   * value and threw. Without this re-queue, the Save button after a failed
   * autosave would drain an empty queue and change nothing while looking like
   * it had worked, which is the one thing that button must never do.
   *
   * Re-queuing when a write is merely SCHEDULED is harmless: it is the same
   * value, and the flush below stops the timer either way.
   */
  const flush = useCallback(async () => {
    if (pendingRef.current.size > 0 && lastValueRef.current) {
      pushValue(lastValueRef.current);
    }
    await flushWriter();
  }, [flushWriter, pushValue]);

  /**
   * Read AFTER an awaited `flush()`, when the drain has settled and nothing is
   * in flight: anything still in the set is a question whose write was refused
   * or never dispatched. See the type's comment for why the caller cannot use
   * `state` for this.
   */
  const hasUnsavedChanges = useCallback(() => pendingRef.current.size > 0, []);

  return { push, flush, cancel, reset, hasUnsavedChanges, state, error };
}

export default useAnswerAutosave;
