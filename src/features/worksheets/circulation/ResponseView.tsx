"use client";

import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@/auth/AuthProvider";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Drawer from "@/components/ui/Drawer";
import MemberName from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import {
  isTerminalResponseState,
  type CirculationDoc,
  type ResponseDoc,
} from "@/lib/firestore/circulations";
import {
  pagesOf,
  type WorksheetQuestion,
  type WorksheetSection,
} from "@/lib/firestore/worksheets";
import { maxWidth } from "@/theme/breakpoints";
import ActivityLine from "./ActivityLine";
import AnswerSummary from "./AnswerSummary";
import ReviewPanel from "./ReviewPanel";
import { responseStateLabel, responseStateTone } from "./circulationView";
import styles from "./ResponseView.module.css";

/**
 * One recipient's answers, and the staff review of them.
 *
 * Modal above --bp-md, Drawer below, which is the house pattern for a panel
 * that has to work at both widths (`SubtaskDetailModal`, `PersonSelector`).
 *
 * `closeAboveRem` is pushed out of reach on purpose. Drawer's own job is to
 * shut itself when a phone rotates into tablet width, because the nav it
 * usually holds has a desktop home to go back to. This one has a Modal to
 * become instead, and the swap below already happens at exactly that width, so
 * leaving Drawer's default in place would race the swap and close the whole
 * view on a rotate. Somebody reading an answer would simply lose it.
 *
 * ── WHO IS LOOKING IS DERIVED HERE, NOT PASSED IN ───────────────────────────
 * Staffness and adminness come from `useAuth` plus the circulation's own
 * `staffUids`, rather than arriving as props. The caller (the circulation page)
 * already computes the same two facts for itself, and threading them through
 * would mean two places that have to agree about who may review; more
 * practically, the review panel and the unlock button are this component's
 * business and a prop list is a poor place to keep an access rule. The rules
 * remain the guarantee either way: the review document is staff-read-only and
 * the unfreeze route refuses anybody but an admin.
 *
 * ANSWERS AND FEEDBACK ARE SEPARATE STACKS on purpose. The answers read top to
 * bottom as the recipient wrote them; the review sits underneath as one panel
 * covering the same questions in the same order. Interleaving a feedback box
 * under every answer was the alternative and was dropped: it doubles the length
 * of a panel staff scroll through many times a day, and it puts an editable
 * control between two things somebody is trying to read side by side.
 */

/**
 * A width no viewport reaches, so Drawer's auto-close never fires. Stated as a
 * named constant because a bare 999 in the JSX reads as a mistake.
 */
const NEVER_AUTO_CLOSE_REM = 999;

type Props = {
  circulation: CirculationDoc;
  response: ResponseDoc;
  /** Resolved display name for the recipient. */
  name: string;
  /**
   * The page's own uid-to-name resolver, for the ONE other person this panel
   * ever names: whoever returned the feedback. Optional, because the resolver
   * belongs to the circulation page rather than to this component, and a panel
   * mounted without one should say less rather than guess (see ReviewPanel's
   * `returnedByName`). It resolves staff, not recipients, so it hands out no
   * name this viewer could not already read off the recipient table.
   */
  nameOf?: (uid: string) => string;
  onClose: () => void;
};

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function ResponseView({
  circulation,
  response,
  name,
  nameOf,
  onClose,
}: Props) {
  const { user, role } = useAuth();
  const uid = user?.uid ?? null;
  const isAdmin = role === "admin";
  const isStaff = Boolean(uid && (isAdmin || circulation.staffUids.includes(uid)));

  const [unfreezing, setUnfreezing] = useState(false);
  const [unfreezeError, setUnfreezeError] = useState<string | null>(null);

  const mobileSubscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(maxWidth("md"));
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const isMobile = useSyncExternalStore(
    mobileSubscribe,
    () => window.matchMedia(maxWidth("md")).matches,
    () => false,
  );

  // Page breaks are separators, not content: `pagesOf` drops them, and the
  // read-only view has no reason to paginate. Sections survive as headings
  // because an answer without the heading it sat under can read as an answer
  // to the wrong question.
  //
  // The predicate is what tells the TYPE system that, since `pagesOf` returns
  // the wide `WorksheetItem[][]`. Without it the branch below narrows to
  // "question or page break" and every field read on a question is an error.
  const items = useMemo(
    () =>
      pagesOf(circulation.items)
        .flat()
        .filter(
          (item): item is WorksheetQuestion | WorksheetSection => item.kind !== "pageBreak",
        ),
    [circulation.items],
  );

  const label = `Answers from ${name}`;
  const frozen = isTerminalResponseState(response.state);
  // A closed circulation takes no further submissions, so unlocking a response
  // on one would give somebody their answers back and then refuse to accept
  // them. The route refuses it; the button says so before anybody presses it.
  const canUnfreeze = frozen && circulation.status === "open";

  /**
   * The consequence, in the sentence, because it is not the obvious one: the
   * feedback that was returned goes with the unlock. An admin who thinks they
   * are only reopening the boxes would otherwise discard a colleague's written
   * work as a side effect.
   */
  async function handleUnfreeze() {
    if (unfreezing) return;
    const returnedNote = response.returned
      ? " The feedback that was returned to them is cleared, and the reviewers write it again."
      : "";
    const confirmed = window.confirm(
      `Unlock this so ${name} can change their answers?${returnedNote} Their task goes back to In progress.`,
    );
    if (!confirmed) return;
    setUnfreezing(true);
    setUnfreezeError(null);
    try {
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulation.id)}/responses/${encodeURIComponent(response.uid)}/unfreeze`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setUnfreezeError(body?.error ?? `Couldn't unlock this (${res.status}).`);
      }
    } catch (err) {
      setUnfreezeError(err instanceof Error ? err.message : "Couldn't unlock this.");
    } finally {
      // The response listener moves the state under this panel on success, so
      // there is nothing to reset but the flag itself.
      setUnfreezing(false);
    }
  }

  const body: ReactNode = (
    <div className={styles.view}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          <MemberName name={name} />
        </h2>
        <div className={styles.meta}>
          <Chip size="sm" tone={responseStateTone(response.state)}>
            {responseStateLabel(response)}
          </Chip>
          {response.submittedAt && (
            <span className={styles.submitted}>
              Submitted {formatDay(response.submittedAt)}
            </span>
          )}
          {/* The record that feedback went back, beside the state it put the
              response into. Staff read this panel to answer "where is this
              one up to", and "reviewed" alone does not say when. */}
          {response.returned?.returnedAt && (
            <span className={styles.submitted}>
              Feedback returned {formatDay(response.returned.returnedAt)}
            </span>
          )}
        </div>
        <ActivityLine activity={response.activity} />
      </header>

      {items.length === 0 ? (
        <p className={styles.empty}>This worksheet has no questions.</p>
      ) : (
        <ol className={styles.items}>
          {items.map((item) =>
            item.kind === "section" ? (
              <li key={item.id} className={styles.section}>
                <h3 className={styles.sectionHeading}>{item.heading}</h3>
              </li>
            ) : (
              <li key={item.id} className={styles.item}>
                <h3 className={styles.question}>
                  {item.title}
                  {item.required && (
                    <span className={styles.required} title="Required question">
                      {" "}
                      required
                    </span>
                  )}
                </h3>
                <AnswerSummary question={item} answer={response.answers[item.id]} />
              </li>
            ),
          )}
        </ol>
      )}

      {/* Staff only, and the rules agree: a recipient who reached this
          component would have their review listen refused rather than shown an
          empty box. */}
      {isStaff && uid && (
        <ReviewPanel
          circulation={circulation}
          response={response}
          reviewerUid={uid}
          recipientName={name}
          returnedByName={
            response.returned?.returnedByUid
              ? nameOf?.(response.returned.returnedByUid)
              : undefined
          }
        />
      )}

      {unfreezeError && (
        <p className={styles.error} role="status">
          {unfreezeError}
        </p>
      )}

      <footer className={styles.footer}>
        {/* Admin only, and only on a response there is something to unlock.
            Secondary rather than danger: nothing is destroyed that the
            reviewers cannot write again, and a red button here would read as
            "delete this person's answers", which is the one thing it does
            not do. */}
        {isAdmin && frozen && (
          // A disabled button swallows its own mouse events in some browsers,
          // so the explanation rides on a wrapper rather than on the button.
          <span
            title={
              canUnfreeze
                ? undefined
                : "This circulation is closed, so nothing more can be submitted to it."
            }
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleUnfreeze()}
              disabled={unfreezing || !canUnfreeze}
            >
              {unfreezing ? "Unlocking…" : "Unlock for editing"}
            </Button>
          </span>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open onClose={onClose} ariaLabel={label} closeAboveRem={NEVER_AUTO_CLOSE_REM}>
        {body}
      </Drawer>
    );
  }

  return (
    <Modal open onClose={onClose} ariaLabel={label} width="md">
      {body}
    </Modal>
  );
}
