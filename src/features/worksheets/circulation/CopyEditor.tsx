"use client";

import { useCallback, useMemo, useState } from "react";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useAuth } from "@/auth/AuthProvider";
import Button from "@/components/ui/Button";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import { useAdminPageLock } from "@/features/admin/useAdminLock";
import { useDebouncedWrite } from "@/hooks/useDebouncedWrite";
import { getClientDb } from "@/lib/firebase/client";
import type { CirculationDoc } from "@/lib/firestore/circulations";
import {
  answerIsEmpty,
  questionsOf,
  sanitizeItems,
  validateWorksheetItems,
  type WorksheetItem,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";
import WorksheetEditor from "../editor/WorksheetEditor";
import { useCirculationResponses } from "../hooks/useCirculationResponses";
import styles from "./CopyEditor.module.css";

/**
 * Editing the questions of a worksheet that is already out.
 *
 * ── WHY THIS IS ALLOWED AT ALL ──────────────────────────────────────────────
 * A circulation carries its OWN copy of the items, taken at send time, and the
 * library worksheet is never touched again. That copy is only semi-frozen on
 * purpose: the typo, the missing option, the question that turns out to ask two
 * things at once are all discovered by the first person who tries to answer,
 * and the alternative to fixing it in place is cancelling a send and doing it
 * again, which costs everybody their answers. `firestore.rules` allows staff to
 * write `items` here for exactly that reason and pins everything else.
 *
 * ── WHAT AN EDIT CANNOT BREAK ───────────────────────────────────────────────
 * Answers are keyed by question id, and choice answers store OPTION ids, so
 * rewording a question or fixing a label leaves every answer attached to the
 * thing it was given for. What an edit CAN do is orphan an answer, by removing
 * the question it belongs to: the answer stays on the response document and is
 * simply never rendered again. That is why the delete confirmation counts the
 * people affected rather than asking a generic "are you sure": the number is
 * the only part of it anybody can act on.
 *
 * ── TWO KINDS OF EDITOR, TWO KINDS OF COORDINATION ──────────────────────────
 * Admins get `useAdminPageLock`, the same one-at-a-time lease the admin console
 * uses, keyed on this circulation. Non-admin staff get a sentence instead,
 * because `adminLocks` is admin-only in the rules and a lease that fails open
 * for them would be a promise this component cannot keep. `docs/worksheets.md`
 * lists the shared edit lock as out of scope in v1 for the same reason, so the
 * honest thing is to say last-write-wins out loud rather than imply a lock.
 *
 * ── THE MESSAGE IS A SEPARATE PRESS, AND ONCE PER CHANGE ────────────────────
 * Saving does not tell anybody. The editor autosaves every few hundred
 * milliseconds, so "notify on change" would be a message per keystroke; the
 * button below is a person deciding, once, that this change was the kind other
 * people need to hear about. It flushes the pending write first, so the message
 * is never about an edit that is still in a debounce timer.
 *
 * ONCE, because the route is not idempotent and cannot be: two presses are two
 * mails to the same people, and nothing on the server can tell a duplicate from
 * a second real change ten minutes later. So the button retires itself after a
 * send and comes back when the questions are edited again, which is the only
 * moment there is anything new to say. It guards against the double press
 * rather than against a determined sender, who can always edit and send again.
 *
 * ── A CLOSED CIRCULATION STILL EDITS, BUT TELLS NOBODY ──────────────────────
 * Editing stays open after a circulation closes: fixing a typo in a question
 * staff are reading alongside the answers is still worth doing, and the rules
 * allow it. The message does not, because it asks people to look again before
 * they submit and nobody can submit any more. The route refuses it with a 409
 * and this button says so before anybody presses it.
 */

type Props = {
  circulation: CirculationDoc;
};

export default function CopyEditor({ circulation }: Props) {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  // Null for anybody but an admin: the lease is admin-only in `firestore.rules`
  // and fails open, so asking for it as a non-admin would attach a listener
  // that is refused and report "off" anyway. Saying so with the argument keeps
  // the console clean and the intent readable.
  const lock = useAdminPageLock(isAdmin ? `circulation__${circulation.id}` : null);
  const lockedOut = lock.status === "waiting";

  // The recipients, for the delete confirmation's headcount. The page above is
  // already holding this listen; Firestore shares the underlying stream between
  // identical queries, so a second subscriber costs a callback rather than a
  // round trip, and taking it as a prop would have put a headcount in the
  // agreed prop shape of a component whose subject is the questions.
  const { responses } = useCirculationResponses(circulation.id);

  const [items, setItems] = useState<WorksheetItem[]>([]);
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [telling, setTelling] = useState(false);
  /** True once a message has gone out about the edit currently on screen. */
  const [told, setTold] = useState(false);

  const save = useCallback(
    async (next: WorksheetItem[]) => {
      await updateDoc(doc(getClientDb(), "circulations", circulation.id), {
        // `clampLimits: false` on the SAVING path, as the library editor does:
        // an out-of-range number is stored as typed and reported under the row
        // by `validateWorksheetItems`, rather than changed under the author.
        items: sanitizeItems(next, { clampLimits: false }),
        // The stamp the "tell them" message hangs off, and the only record that
        // the copy diverged from the worksheet it came from.
        itemsEditedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    },
    [circulation.id],
  );
  // 900ms, the shared autosave beat (`DEFAULT_WRITE_DEBOUNCE_MS`).
  const saver = useDebouncedWrite(save);

  // Hydrated ONCE per circulation, during render rather than in an effect, and
  // every later snapshot is ignored: the stream carries back this editor's own
  // writes, and re-seeding from it would move the caret mid-word.
  //
  // The honest caveat, since the library editor keeps a raw copy for this and
  // there is none here: `circulation.items` has been through `sanitizeItems`
  // with clamping on, so a limit stored out of range arrives clamped and the
  // next save stores the clamped number. The circulate route copies a worksheet
  // that has already been validated, so the only way to author one is to type
  // it here, where the row says it is out of range before it is ever reloaded.
  if (hydratedId !== circulation.id) {
    setHydratedId(circulation.id);
    setItems(circulation.items);
    setNotice(null);
    setTelling(false);
    setTold(false);
  }

  const problems = useMemo(() => validateWorksheetItems(items), [items]);
  const startedCount = responses.filter((response) => response.state === "started").length;
  const tellsAnybody = circulation.notifications.copyEdited.email;

  /**
   * Why the message cannot go, or null when it can. One string rather than
   * three booleans at the call site: it is both the reason the button is dead
   * and the sentence printed under it, and those two must not be able to
   * disagree. Ordered by the fact a sender can do least about.
   */
  const tellBlocked: string | null = !tellsAnybody
    ? "The “Questions edited” message is switched off for this circulation, so this would reach nobody. Turn it on under Notifications first."
    : circulation.status !== "open"
      ? "This circulation is closed, so nobody can answer it any more and there is nothing for them to do about a change."
      : told
        ? "You have already told them about this change. Edit the questions again if there is something new to say."
        : null;

  /** How many people have given a real answer to one question. */
  const answerCountOf = useCallback(
    (questionId: string) =>
      responses.filter((response) => {
        const answer = response.answers[questionId];
        return answer !== undefined && !answerIsEmpty(answer);
      }).length,
    [responses],
  );

  /**
   * The confirmation for a removal, or null when nothing needs one.
   *
   * It is computed from the DIFF rather than hooked onto the editor's delete
   * button, because the editor hands back a whole array and knows nothing about
   * answers. Reordering, duplicating and editing all produce arrays too; only a
   * question that has left the list, and that somebody has answered, is worth
   * stopping for.
   */
  function removalWarning(next: WorksheetItem[]): string | null {
    const nextIds = new Set(questionsOf(next).map((question) => question.id));
    const removed: { question: WorksheetQuestion; count: number }[] = [];
    for (const question of questionsOf(items)) {
      if (nextIds.has(question.id)) continue;
      const count = answerCountOf(question.id);
      if (count > 0) removed.push({ question, count });
    }
    if (removed.length === 0) return null;
    const lines = removed
      .map(
        ({ question, count }) =>
          `${count} ${count === 1 ? "person has" : "people have"} answered "${
            question.title || "this question"
          }"`,
      )
      .join("; ");
    return `${lines}; their answers stay stored but will not be shown. Remove it anyway?`;
  }

  function handleItems(next: WorksheetItem[]) {
    const warning = removalWarning(next);
    // Declining leaves `items` exactly where it was, and the editor is
    // controlled, so the row simply comes back.
    if (warning && !window.confirm(warning)) return;
    setItems(next);
    setNotice(null);
    // There is something new to say again, so the button comes back.
    setTold(false);
    saver.push(next);
  }

  async function tellRecipients() {
    if (telling) return;
    setTelling(true);
    setNotice(null);
    try {
      // The edit goes out first: a message about a change still sitting in a
      // debounce timer is a message about nothing.
      await saver.flush();
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulation.id)}/notify-copy-edited`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { sent?: number; optedOut?: number; error?: string }
        | null;
      if (!res.ok) {
        setNotice(body?.error ?? `Couldn't send that message (${res.status}).`);
        return;
      }
      const sent = body?.sent ?? 0;
      const optedOut = body?.optedOut ?? 0;
      // Retired either way: a zero means the message reached nobody by email,
      // and pressing it again a second later would reach nobody a second time.
      setTold(true);
      // TWO DIFFERENT ZEROES, and only one of them is about the worksheet.
      // Nobody part-way through is a fact about the circulation. Everybody
      // part-way through having switched worksheet email off is a fact about
      // the people, and saying the first when the second is true tells a
      // staff member something false about their own recipients.
      setNotice(
        sent > 0
          ? `Told ${sent} ${sent === 1 ? "person" : "people"}.`
          : optedOut === 0
            ? "Nobody was told: nobody is part-way through this worksheet right now."
            : optedOut === 1
              ? "Nobody was emailed: the one person part-way through has turned worksheet email off."
              : `Nobody was emailed: all ${optedOut} people part-way through have turned worksheet email off.`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't send that message.");
    } finally {
      setTelling(false);
    }
  }

  const saveState: SaveState = saver.state;

  return (
    <section className={styles.editor} aria-label="The questions as they were sent">
      <header className={styles.head}>
        <h2 className={styles.title}>The questions as they were sent</h2>
        <SavedFlash state={saveState} />
      </header>

      <p className={styles.note}>
        This is the circulation&apos;s own copy. Editing it changes what everyone who has
        this worksheet sees, now, and leaves the library worksheet alone. Answers already
        given stay attached to their question.
      </p>

      {lockedOut && (
        <p className={styles.lock} role="status">
          {lock.holderName} is editing these questions. You will get them back the moment
          they leave, and nothing you type until then would be saved.
        </p>
      )}

      {!isAdmin && (
        <p className={styles.note}>
          Edits save as you make them. If somebody else is editing at the same time, the
          last save wins.
        </p>
      )}

      {saveState === "error" && saver.error && (
        <p className={styles.error} role="status">
          That change is not stored: {saver.error.message}
        </p>
      )}

      {problems.length > 0 && (
        <ul className={styles.problems}>
          {problems.slice(0, 5).map((problem, index) => (
            <li key={`${problem.itemId}-${index}`}>{problem.message}</li>
          ))}
        </ul>
      )}

      <WorksheetEditor
        items={items}
        onChange={handleItems}
        // Images added mid-flight belong to the circulation, not to the library
        // worksheet: `worksheet-images/{ownerId}` takes either id, and filing
        // them under the worksheet would leave them behind when it is deleted.
        storageOwnerId={circulation.id}
        disabled={lockedOut}
      />

      <div className={styles.tell}>
        {/* A disabled button swallows its own mouse events in some browsers, so
            the explanation rides on a wrapper. */}
        <span title={tellBlocked ?? undefined}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void tellRecipients()}
            disabled={telling || tellBlocked !== null}
          >
            {telling ? "Sending…" : "Tell recipients about this change"}
          </Button>
        </span>
        <p className={styles.tellNote}>
          {tellBlocked ??
            `Goes to the ${startedCount} ${
              startedCount === 1 ? "person" : "people"
            } who have started and not submitted. Nobody else is told.`}
        </p>
        {notice && (
          <p className={styles.tellNote} role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
